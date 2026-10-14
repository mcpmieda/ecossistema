import {
  attendanceRequestV1,
  type AttendanceCollectionV1,
  type AttendanceConfigurationV1,
  type AttendanceRelationStudentV1,
  type AttendanceRequestV1,
  type AttendanceScopeV1,
  type AttendanceSourceRecordV1,
} from '../../shared/attendance-contracts/attendance-v1';
import { studentUidV1 } from '../../shared/student-identity/student-identity-v1';
import { authorizeGradebookRuntimeV1 } from '../gradebook/authorization-v1';
import type { Session } from '../auth/session';
import type {
  GradebookPostgresDatabaseV1,
  GradebookPostgresTransactionV1,
} from '../gradebook/persistence/postgres/postgres-database-v1';
import {
  AttendanceErrorV1,
  attendanceCandidatesV1,
  attendanceFingerprintV1,
  attendanceMonthlySummaryV1,
  validateAttendanceCollectionV1,
  type StoredAttendanceDecisionV1,
} from './domain-v1';

type Tx = GradebookPostgresTransactionV1;
type Row = Record<string, unknown>;
const truth = (v: unknown) => v === true || v === 1;
const text = (v: unknown) => String(v);
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
function fail(code: string, status = 409): never {
  throw new AttendanceErrorV1(code, status);
}

async function relation(tx: Tx, scope: AttendanceScopeV1): Promise<AttendanceRelationStudentV1[]> {
  const rows = await tx.query<Row>(
    `SELECT a.student_uid::text,a.nome,t.codigo,t.id AS class_id,v.situacao,v.turma_relacionada_id
    FROM gradebook.vinculo v JOIN gradebook.aluno a ON a.id=v.aluno_id AND a.ano=v.ano
    JOIN gradebook.turma t ON t.id=v.turma_id AND t.ano=v.ano
    WHERE v.ano=$1 AND t.id=$2 AND v.situacao IS DISTINCT FROM 6 ORDER BY a.student_uid,v.numero`,
    [scope.academicYear, scope.classId],
  );
  return rows.map((r) => ({
    studentUid: text(r.student_uid),
    originalName: text(r.nome),
    originalClass: text(r.codigo),
    classId: Number(r.class_id),
    enrollmentState: r.situacao === null ? null : Number(r.situacao),
    relatedClassId: r.turma_relacionada_id === null ? null : Number(r.turma_relacionada_id),
  }));
}

async function scopeRow(tx: Tx, scope: AttendanceScopeV1, create = false): Promise<Row> {
  // Coordinate with canonical Relação writers without changing their contracts.
  // Table SHARE locks also protect against writes which do not take the annual advisory lock.
  await tx.executeNative(
    'LOCK TABLE gradebook.aluno,gradebook.turma,gradebook.vinculo IN SHARE MODE',
    [],
  );
  const exists = await tx.query('SELECT id FROM gradebook.turma WHERE id=$1 AND ano=$2', [
    scope.classId,
    scope.academicYear,
  ]);
  if (!exists.length) fail('class-not-in-relation', 404);
  if (create)
    await tx.executeNative(
      `INSERT INTO attendance.scope (academic_year,class_id)
    VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [scope.academicYear, scope.classId],
    );
  const rows = await tx.query<Row>(
    `SELECT *,clock_timestamp()::text AS server_time,
    (lease_until>clock_timestamp()) AS lease_live FROM attendance.scope
    WHERE academic_year=$1 AND class_id=$2 FOR UPDATE`,
    [scope.academicYear, scope.classId],
  );
  return rows[0] ?? fail('scope-not-configured', 404);
}

async function collection(
  tx: Tx,
  row: Row,
  scope: AttendanceScopeV1,
): Promise<{
  input: AttendanceCollectionV1;
  batch: Row;
  records: AttendanceSourceRecordV1[];
} | null> {
  if (!row.current_batch) return null;
  const id = text(row.current_batch);
  const batches = await tx.query<Row>('SELECT * FROM attendance.batch WHERE id=$1::uuid', [id]);
  const batch = batches[0]!;
  const records = (
    await tx.query<Row>(
      `SELECT record_key,original_name,original_class,identity_basis
    FROM attendance.source_record WHERE batch_id=$1::uuid ORDER BY record_key`,
      [id],
    )
  ).map((r) => ({
    recordKey: text(r.record_key),
    originalName: text(r.original_name),
    originalClass: text(r.original_class),
    identityBasis: text(r.identity_basis) as 'durable' | 'report-local',
  }));
  const coverage = (
    await tx.query<Row>(
      `SELECT record_key,date::text,slots,complete
    FROM attendance.coverage WHERE batch_id=$1::uuid ORDER BY record_key,date`,
      [id],
    )
  ).map((r) => ({
    recordKey: text(r.record_key),
    date: text(r.date),
    slots: json<number[]>(r.slots),
    complete: truth(r.complete),
  }));
  const marks = (
    await tx.query<Row>(
      `SELECT record_key,date::text,slot,mark
    FROM attendance.mark WHERE batch_id=$1::uuid ORDER BY record_key,date,slot`,
      [id],
    )
  ).map((r) => ({
    recordKey: text(r.record_key),
    date: text(r.date),
    slot: Number(r.slot),
    mark: text(r.mark) as 'X' | 'J',
  }));
  return {
    batch,
    records,
    input: {
      operation: 'collect',
      scope,
      requestId: id,
      expectedRevision: Number(row.revision),
      collectorId: text(row.lease_holder),
      fencingToken: Number(row.fencing_token),
      sourceVersion: text(batch.source_version),
      reportIdentity: text(batch.report_identity),
      observedAt: new Date(text(batch.observed_at)).toISOString(),
      reportKind: 'annual-detailed-collective',
      rosterComplete: truth(batch.roster_complete),
      records,
      coverage,
      marks,
    },
  };
}

async function review(tx: Tx, row: Row, scope: AttendanceScopeV1) {
  const students = await relation(tx, scope);
  const relationFingerprint = await attendanceFingerprintV1(students);
  const collected = await collection(tx, row, scope);
  const history = await tx.query<Row>(
    `SELECT d.*,b.source_version FROM attendance.decision d
    JOIN attendance.batch b ON b.id=d.batch_id WHERE d.academic_year=$1 AND d.class_id=$2
    ORDER BY d.revision`,
    [scope.academicYear, scope.classId],
  );
  const decisions: StoredAttendanceDecisionV1[] = history.map((d) => ({
    studentUid: text(d.student_uid),
    evidenceFingerprint: text(d.evidence_fingerprint),
    decision: text(d.decision) as StoredAttendanceDecisionV1['decision'],
    revision: Number(d.revision),
    canConfirm: d.batch_id === row.current_batch,
  }));
  const current = collected?.batch.relation_fingerprint === relationFingerprint;
  const candidates = collected
    ? await attendanceCandidatesV1(scope, collected.input, collected.records, students, decisions)
    : [];
  return {
    revision: Number(row.revision),
    relationFingerprint,
    students,
    collected,
    sourceCurrent: Boolean(current),
    candidates: current
      ? candidates
      : candidates.map((c) => ({
          ...c,
          state: 'needs-review' as const,
          studentUid: null,
        })),
    history,
  };
}

async function insertConfiguration(
  tx: Tx,
  input: AttendanceConfigurationV1,
  actor: string,
  fingerprint: string,
) {
  const days = new Set(input.calendar.map((d) => d.date));
  if (
    days.size !== input.calendar.length ||
    input.calendar.some((d) => Number(d.date.slice(0, 4)) !== input.scope.academicYear)
  ) {
    fail('invalid-calendar', 400);
  }
  const students = await relation(tx, input.scope);
  for (const enrollment of input.enrollments) {
    if (
      !students.some((s) => s.studentUid === enrollment.studentUid) ||
      Number(enrollment.startsOn.slice(0, 4)) !== input.scope.academicYear ||
      (enrollment.endsOn !== null &&
        (enrollment.endsOn < enrollment.startsOn ||
          Number(enrollment.endsOn.slice(0, 4)) !== input.scope.academicYear))
    )
      fail('invalid-enrollment', 400);
    if (
      input.enrollments.some(
        (e) =>
          e !== enrollment &&
          e.studentUid === enrollment.studentUid &&
          e.startsOn <= (enrollment.endsOn ?? '9999-12-31') &&
          enrollment.startsOn <= (e.endsOn ?? '9999-12-31'),
      )
    )
      fail('overlapping-enrollment', 400);
  }
  await tx.executeNative(
    `INSERT INTO attendance.configuration
    (id,academic_year,class_id,relation_fingerprint,actor) VALUES ($1::uuid,$2,$3,$4,$5::uuid)`,
    [input.requestId, input.scope.academicYear, input.scope.classId, fingerprint, actor],
  );
  await tx.executeNative(
    `INSERT INTO attendance.calendar SELECT $1::uuid,x.date,x.eligible,x.slots
    FROM jsonb_to_recordset($2::text::jsonb) AS x(date date,eligible boolean,slots smallint[])`,
    [input.requestId, JSON.stringify(input.calendar)],
  );
  await tx.executeNative(
    `INSERT INTO attendance.enrollment SELECT $1::uuid,x."studentUid",x."startsOn",x."endsOn"
    FROM jsonb_to_recordset($2::text::jsonb) AS x("studentUid" uuid,"startsOn" date,"endsOn" date)`,
    [input.requestId, JSON.stringify(input.enrollments)],
  );
  await tx.executeNative(
    `UPDATE attendance.scope SET current_configuration=$3::uuid
    WHERE academic_year=$1 AND class_id=$2`,
    [input.scope.academicYear, input.scope.classId, input.requestId],
  );
}

async function insertCollection(
  tx: Tx,
  input: AttendanceCollectionV1,
  actor: string,
  row: Row,
  fingerprint: string,
) {
  validateAttendanceCollectionV1(input);
  const lease = (
    await tx.query<Row>(
      `SELECT lease_until>clock_timestamp() AS lease_live
    FROM attendance.scope WHERE academic_year=$1 AND class_id=$2`,
      [input.scope.academicYear, input.scope.classId],
    )
  )[0]!;
  if (
    !truth(lease.lease_live) ||
    row.lease_holder !== input.collectorId ||
    row.lease_actor !== actor ||
    Number(row.fencing_token) !== input.fencingToken
  )
    fail('lease-fenced');
  if (new Date(input.observedAt).getTime() > new Date(text(row.server_time)).getTime())
    fail('future-observation', 400);
  const previous = row.current_batch
    ? (
        await tx.query<Row>('SELECT observed_at FROM attendance.batch WHERE id=$1::uuid', [
          text(row.current_batch),
        ])
      )[0]
    : null;
  if (
    previous &&
    new Date(text(previous.observed_at)).getTime() > new Date(input.observedAt).getTime()
  )
    fail('stale-source');
  const contentFingerprint = await attendanceFingerprintV1({
    sourceVersion: input.sourceVersion,
    reportIdentity: input.reportIdentity,
    observedAt: input.observedAt,
    rosterComplete: input.rosterComplete,
    records: input.records,
    coverage: input.coverage,
    marks: input.marks,
  });
  const snapshots = await tx.query<Row>(
    `SELECT id,content_fingerprint,relation_fingerprint FROM attendance.batch
    WHERE academic_year=$1 AND class_id=$2 AND source_version=$3`,
    [input.scope.academicYear, input.scope.classId, input.sourceVersion],
  );
  if (snapshots.some((snapshot) => snapshot.content_fingerprint !== contentFingerprint))
    fail('source-version-conflict');
  const existing = snapshots.find((snapshot) => snapshot.relation_fingerprint === fingerprint);
  if (existing) {
    if (
      existing.content_fingerprint !== contentFingerprint ||
      existing.relation_fingerprint !== fingerprint
    )
      fail('source-version-conflict');
    if (row.current_batch !== existing.id) fail('stale-source');
    return false;
  }
  await tx.executeNative(
    `INSERT INTO attendance.batch
    (id,academic_year,class_id,source_version,report_identity,observed_at,relation_fingerprint,roster_complete,content_fingerprint,actor)
    VALUES ($1::uuid,$2,$3,$4,$5,$6::timestamptz,$7,$8::integer::boolean,$9,$10::uuid)`,
    [
      input.requestId,
      input.scope.academicYear,
      input.scope.classId,
      input.sourceVersion,
      input.reportIdentity,
      input.observedAt,
      fingerprint,
      input.rosterComplete ? 1 : 0,
      contentFingerprint,
      actor,
    ],
  );
  await tx.executeNative(
    `INSERT INTO attendance.source_record SELECT $1::uuid,x."recordKey",x."originalName",x."originalClass",x."identityBasis"
    FROM jsonb_to_recordset($2::text::jsonb) AS x("recordKey" text,"originalName" text,"originalClass" text,"identityBasis" text)`,
    [input.requestId, JSON.stringify(input.records)],
  );
  await tx.executeNative(
    `INSERT INTO attendance.coverage SELECT $1::uuid,x."recordKey",x.date,x.slots,x.complete
    FROM jsonb_to_recordset($2::text::jsonb) AS x("recordKey" text,date date,slots smallint[],complete boolean)`,
    [input.requestId, JSON.stringify(input.coverage)],
  );
  await tx.executeNative(
    `INSERT INTO attendance.mark SELECT $1::uuid,x."recordKey",x.date,x.slot,x.mark
    FROM jsonb_to_recordset($2::text::jsonb) AS x("recordKey" text,date date,slot smallint,mark text)`,
    [input.requestId, JSON.stringify(input.marks)],
  );
  await tx.executeNative(
    `UPDATE attendance.scope SET current_batch=$3::uuid WHERE academic_year=$1 AND class_id=$2`,
    [input.scope.academicYear, input.scope.classId, input.requestId],
  );
  return true;
}

export function createAttendanceServiceV1(database: GradebookPostgresDatabaseV1) {
  return {
    async execute(
      payload: unknown,
      session: Pick<Session, 'oid' | 'roles'>,
    ): Promise<Record<string, unknown>> {
      authorizeGradebookRuntimeV1(session);
      const actor = studentUidV1.parse(session.oid);
      const input = attendanceRequestV1.parse(payload);
      return database.transaction(async (tx) => {
        const row = await scopeRow(tx, input.scope, input.operation !== 'review');
        if (input.operation === 'review') {
          const value = await review(tx, row, input.scope);
          return {
            revision: value.revision,
            sourceCurrent: value.sourceCurrent,
            students: value.students,
            candidates: value.candidates,
            history: value.history,
          };
        }
        const fingerprint = await attendanceFingerprintV1(input);
        const receipt = (
          await tx.query<Row>(
            `SELECT * FROM attendance.receipt
          WHERE academic_year=$1 AND class_id=$2 AND request_id=$3::uuid`,
            [input.scope.academicYear, input.scope.classId, input.requestId],
          )
        )[0];
        if (receipt) {
          if (receipt.actor !== actor || receipt.payload_fingerprint !== fingerprint)
            fail('idempotency-conflict');
          // Mutation receipts contain no academic data. Guardian reads never use this cache.
          return json<Record<string, unknown>>(receipt.result_json);
        }
        let result: Record<string, unknown>;
        if (input.operation === 'lease') {
          if (
            truth(row.lease_live) &&
            (row.lease_holder !== input.collectorId || row.lease_actor !== actor)
          )
            fail('lease-busy');
          const lease = await tx.query<Row>(
            `UPDATE attendance.scope SET lease_holder=$3::uuid,
            lease_actor=$4::uuid,lease_until=clock_timestamp()+$5::integer*interval '1 second',
            fencing_token=fencing_token+1 WHERE academic_year=$1 AND class_id=$2
            RETURNING fencing_token,lease_until::text`,
            [
              input.scope.academicYear,
              input.scope.classId,
              input.collectorId,
              actor,
              input.durationSeconds,
            ],
          );
          result = {
            revision: Number(row.revision),
            fencingToken: Number(lease[0]!.fencing_token),
            expiresAt: lease[0]!.lease_until,
          };
        } else {
          if (Number(row.revision) !== input.expectedRevision) fail('stale-revision');
          const value = await review(tx, row, input.scope);
          let changed = true;
          if (input.operation === 'configure')
            await insertConfiguration(tx, input, actor, value.relationFingerprint);
          if (input.operation === 'collect')
            changed = await insertCollection(tx, input, actor, row, value.relationFingerprint);
          if (input.operation === 'decide') {
            if (!value.sourceCurrent || !value.collected) fail('stale-relation');
            const candidate = value.candidates.find((c) => c.recordKey === input.recordKey);
            if (!candidate || candidate.evidenceFingerprint !== input.evidenceFingerprint)
              fail('stale-evidence');
            if (!value.students.some((s) => s.studentUid === input.studentUid))
              fail('student-not-in-relation', 400);
            if (
              input.decision === 'same-student' &&
              (value.candidates.some(
                (c) => c.recordKey !== input.recordKey && c.studentUid === input.studentUid,
              ) ||
                (candidate.studentUid && candidate.studentUid !== input.studentUid))
            ) {
              fail('identity-already-linked');
            }
            await tx.executeNative(
              `INSERT INTO attendance.decision
              (academic_year,class_id,revision,batch_id,record_key,student_uid,evidence_fingerprint,decision,reason,actor)
              VALUES ($1,$2,$3,$4::uuid,$5,$6::uuid,$7,$8,$9,$10::uuid)`,
              [
                input.scope.academicYear,
                input.scope.classId,
                Number(row.revision) + 1,
                text(row.current_batch),
                input.recordKey,
                input.studentUid,
                input.evidenceFingerprint,
                input.decision,
                input.reason,
                actor,
              ],
            );
          }
          if (changed)
            await tx.executeNative(
              `UPDATE attendance.scope SET revision=revision+1
            WHERE academic_year=$1 AND class_id=$2`,
              [input.scope.academicYear, input.scope.classId],
            );
          result = { revision: Number(row.revision) + (changed ? 1 : 0), changed };
        }
        await tx.executeNative(
          `INSERT INTO attendance.receipt VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6::text::jsonb)`,
          [
            input.scope.academicYear,
            input.scope.classId,
            input.requestId,
            actor,
            fingerprint,
            JSON.stringify(result),
          ],
        );
        return result;
      });
    },

    /** The embedding API must revalidate the existing responsible/student authorization on EVERY read. */
    async responsibleSummary(
      input: { scope: AttendanceScopeV1; studentUid: string; month: string },
      authorize: () => Promise<boolean>,
    ) {
      if (!(await authorize())) fail('not-authorized', 403);
      const scope = attendanceRequestV1.parse({ operation: 'review', scope: input.scope }).scope;
      const uid = studentUidV1.parse(input.studentUid);
      if (
        !/^\d{4}-(0[1-9]|1[0-2])$/u.test(input.month) ||
        Number(input.month.slice(0, 4)) !== scope.academicYear
      )
        fail('invalid-month', 400);
      return database.transaction(async (tx) => {
        const row = await scopeRow(tx, scope);
        const value = await review(tx, row, scope);
        const candidate = value.candidates.find((c) => c.studentUid === uid);
        if (!value.sourceCurrent || !candidate || !value.collected || !row.current_configuration)
          fail('not-visible', 404);
        const configuration = (
          await tx.query<Row>(
            'SELECT relation_fingerprint FROM attendance.configuration WHERE id=$1::uuid',
            [text(row.current_configuration)],
          )
        )[0]!;
        if (configuration.relation_fingerprint !== value.relationFingerprint)
          fail('enrollment-revalidation-required', 404);
        const calendar = (
          await tx.query<Row>(
            'SELECT date::text,eligible,slots FROM attendance.calendar WHERE configuration_id=$1::uuid',
            [text(row.current_configuration)],
          )
        ).map((d) => ({
          date: text(d.date),
          eligible: truth(d.eligible),
          slots: json<number[]>(d.slots),
        }));
        const enrollments = (
          await tx.query<Row>(
            `SELECT starts_on::text,ends_on::text FROM attendance.enrollment
          WHERE configuration_id=$1::uuid AND student_uid=$2::uuid`,
            [text(row.current_configuration), uid],
          )
        ).map((e) => ({
          startsOn: text(e.starts_on),
          endsOn: e.ends_on === null ? null : text(e.ends_on),
        }));
        if (!enrollments.length) fail('not-visible', 404);
        const now = (
          await tx.query<Row>(
            "SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today",
            [],
          )
        )[0]!;
        const summary = attendanceMonthlySummaryV1({
          month: input.month,
          today: text(now.today),
          recordKey: candidate.recordKey,
          calendar,
          enrollments,
          collection: value.collected.input,
        });
        if (!(await authorize())) fail('not-authorized', 403);
        return { revision: value.revision, studentUid: uid, summary };
      });
    },
  };
}

export type AttendanceServiceV1 = ReturnType<typeof createAttendanceServiceV1>;
export type { AttendanceRequestV1 };
