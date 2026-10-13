import type {
  ReconciliationContextV1,
  ReconciliationPrepareV1,
  ReconciliationResponseV1,
  ReconciliationValidationErrorV1,
} from '../../../shared/student-identity/reconciliation-v1';
import {
  classifyReportClassV1,
  normalizeStudentNameV1,
  normalizeInepV1,
  parseCivilDateV1,
  reportClassReferenceV1,
  type ReportClassClassificationV1,
} from '../../../shared/student-identity/reconciliation-normalization-v1';
import {
  planStudentReconciliationV1,
  reportContentV1,
  reportRowContentV1,
  type ReconciliationRowPlanV1,
} from './domain-v1';
import {
  academicRevisionV1,
  advanceV1,
  assertContextV1,
  clockV1,
  contextV1,
  digestV1,
  loadDomainV1,
  ReconciliationConflictV1,
  savePendingV1,
  scalarTextV1,
  type DbRowV1,
  type PreparedRowV1,
  type TxV1,
} from './storage-v1';

export const classReferenceV1 = reportClassReferenceV1;

type ReportRowInputV1 = ReconciliationPrepareV1['rows'][number];
type ClassLinkV1 = ReconciliationPrepareV1['classLinks'][number];
type DomainV1 = Awaited<ReturnType<typeof loadDomainV1>>;
type PlanV1 = ReturnType<typeof planStudentReconciliationV1>;
type ClockV1 = Awaited<ReturnType<typeof clockV1>>;
interface RowInputV1 {
  readonly request: ReconciliationPrepareV1;
  readonly context: ReconciliationContextV1;
  readonly classes: readonly DbRowV1[];
  readonly mapping: ReadonlyMap<string, ClassLinkV1>;
  readonly clock: ClockV1;
  readonly errors: ReconciliationValidationErrorV1[];
}

const DAY_MS_V1 = 86_400_000;
const BIRTH_REASON_V1 = {
  missing: 'nascimento ausente.',
  future: 'nascimento no futuro.',
  invalid: 'nascimento inválido.',
} as const;

function invalidV1(): ReconciliationConflictV1 {
  return new ReconciliationConflictV1('invalid-request');
}

function assertReportYearAndRowsV1(request: ReconciliationPrepareV1): void {
  const otherYear = request.sourceYear !== null && request.sourceYear !== request.academicYear;
  const unconfirmedYear = request.sourceYear === null && !request.confirmYear;
  const repeatedRow = new Set(request.rows.map((r) => r.sourceRow)).size !== request.rows.length;
  if (otherYear || unconfirmedYear || repeatedRow) throw invalidV1();
}

function classMappingV1(
  request: ReconciliationPrepareV1,
  classes: readonly DbRowV1[],
): ReadonlyMap<string, ClassLinkV1> {
  const mapping = new Map(
    request.classLinks.map((m) => [classReferenceV1(m.classLabel, m.shift, m.stageLabel), m]),
  );
  const unknownClass = [...mapping.values()].some(
    (m) => m.gradebookClassId !== null && !classes.some((c) => c.id === m.gradebookClassId),
  );
  if (mapping.size !== request.classLinks.length || unknownClass) throw invalidV1();
  return mapping;
}

/** Scope comes first: excluded modalities and unlinked classes leave before any personal cell is validated. */
function rowInScopeV1(
  row: ReportRowInputV1,
  classification: ReportClassClassificationV1,
  link: ClassLinkV1 | undefined,
  input: RowInputV1,
): boolean {
  if (classification.kind === 'excluded') return false;
  if (
    classification.kind === 'regular' &&
    classification.academicYear !== input.request.academicYear
  )
    throw invalidV1();
  if (input.context.relationAvailable && link?.gradebookClassId === null) return false;
  // Unknown modality has no inferred eligibility. Only an explicit operator classification can admit it.
  if (classification.kind === 'unknown' && (!link?.confirmRegular || !link.gradebookClassId)) {
    input.errors.push({ ...errorIdentityV1(row), field: 'class', reason: 'Confira a turma.' });
    return false;
  }
  return !(input.context.relationAvailable && !link?.gradebookClassId);
}

/** Every invalid cell of an eligible row is reported; one of them rejects the whole report (C3). */
function rowValuesV1(row: ReportRowInputV1, input: RowInputV1) {
  const { request, clock, errors } = input;
  const error = (field: ReconciliationValidationErrorV1['field'], reason: string) =>
    errors.push({ ...errorIdentityV1(row), field, reason });
  const birth = parseCivilDateV1(row.birthDate, request.date1904, clock.today, true);
  const enrolled = parseCivilDateV1(row.enrolledAt, request.date1904, clock.today, false);
  const transferred = parseCivilDateV1(row.transferredAt, request.date1904, clock.today, false);
  const inep = normalizeInepV1(row.inep);
  if (!birth.ok) error('birthDate', BIRTH_REASON_V1[birth.reason]);
  if (!enrolled.ok) error('enrolledAt', 'data de matrícula inválida.');
  if (!transferred.ok) error('transferredAt', 'data de transferência inválida.');
  if (!inep.ok) error('inep', 'INEP inválido.');
  if (!row.name.trim() || !row.enrollmentHash.trim()) throw invalidV1();
  if (!birth.ok || birth.value === null || !enrolled.ok || !transferred.ok || !inep.ok) return null;
  return {
    birthDate: birth.value,
    enrolledAt: enrolled.value,
    transferredAt: transferred.value,
    inep,
  };
}

function rowStageV1(
  classification: ReportClassClassificationV1,
  link: ClassLinkV1 | undefined,
  classes: readonly DbRowV1[],
): number {
  const linkedStage = classes.find((c) => c.id === link?.gradebookClassId)?.etapa;
  const stage = classification.kind === 'regular' ? classification.stage : Number(linkedStage);
  const linked = link?.gradebookClassId !== null && link?.gradebookClassId !== undefined;
  if (linked && linkedStage !== stage) throw invalidV1();
  return stage;
}

function preparedRowV1(row: ReportRowInputV1, input: RowInputV1): PreparedRowV1 | null {
  const classification = classifyReportClassV1(row.classLabel, row.stageLabel, row.shift);
  const link = input.mapping.get(classReferenceV1(row.classLabel, row.shift, row.stageLabel));
  if (!rowInScopeV1(row, classification, link, input)) return null;
  const values = rowValuesV1(row, input);
  if (!values) return null;
  const stage = rowStageV1(classification, link, input.classes);
  return {
    sourceRow: row.sourceRow,
    name: row.name.trim(),
    nameKey: normalizeStudentNameV1(row.name),
    birthDate: values.birthDate,
    filiation1: row.filiation1?.trim() || null,
    filiation1Key: row.filiation1?.trim() ? normalizeStudentNameV1(row.filiation1) : null,
    inep: values.inep.value,
    inepKey: values.inep.key,
    enrollmentHash: row.enrollmentHash.trim(),
    classLabel: row.classLabel.trim(),
    classKey: normalizeStudentNameV1(row.classLabel),
    shift: row.shift.trim(),
    shiftKey: normalizeStudentNameV1(row.shift),
    stage,
    stageLabel: row.stageLabel.trim(),
    status: row.status.trim(),
    statusKey: normalizeStudentNameV1(row.status),
    enrolledAt: values.enrolledAt,
    transferredAt: values.transferredAt,
    classId: input.context.relationAvailable ? (link?.gradebookClassId ?? null) : null,
    targetSourceId: crypto.randomUUID(),
    targetObservationId: crypto.randomUUID(),
    targetUid: null,
    targetRule: null,
    pendingReason: 'awaiting_relation',
    selectedProfile: false,
  };
}

function unchangedOriginV1(
  planned: ReconciliationRowPlanV1,
  domain: DomainV1,
  rows: readonly PreparedRowV1[],
): boolean {
  const source = domain.sources.find((s) => s.sourceId === planned.sourceId);
  const row = rows.find((r) => r.sourceRow === planned.sourceRow)!;
  return Boolean(
    source &&
    !source.reviewRequired &&
    reportRowContentV1(source.current) === reportRowContentV1(row),
  );
}

function profileSelectionV1(plan: PlanV1, domain: DomainV1, rows: readonly PreparedRowV1[]) {
  const selectedRows = new Set(
    plan.profiles.flatMap((p) => (p.selectedSourceRow === null ? [] : [p.selectedSourceRow])),
  );
  const conflicting = plan.profiles.filter((p) => p.reason === 'profile_conflict');
  const profileConflicts = new Set(conflicting.map((p) => p.studentUid));
  // An unchanged report preserves an observation already chosen by the operator.
  // A changed or additional origin must be reviewed again as a complete profile.
  for (const profile of conflicting) {
    const group = plan.rows.filter((p) => p.studentUid === profile.studentUid);
    const unchanged = group.every((p) => unchangedOriginV1(p, domain, rows));
    const selected = group.find((p) =>
      domain.sources.some((s) => s.sourceId === p.sourceId && s.profileSelected),
    );
    if (unchanged && selected) {
      selectedRows.add(selected.sourceRow);
      profileConflicts.delete(profile.studentUid);
    }
  }
  return { selectedRows, profileConflicts };
}

function pendingReasonV1(
  planned: ReconciliationRowPlanV1,
  relationAvailable: boolean,
  profileConflicts: ReadonlySet<string>,
): string | null {
  if (!relationAvailable) return 'awaiting_relation';
  if (planned.reason) return planned.reason;
  return planned.studentUid && profileConflicts.has(planned.studentUid) ? 'profile_conflict' : null;
}

function applyPlanV1(
  rows: readonly PreparedRowV1[],
  plan: PlanV1,
  domain: DomainV1,
  relationAvailable: boolean,
): void {
  const { selectedRows, profileConflicts } = profileSelectionV1(plan, domain, rows);
  for (const row of rows) {
    const planned = plan.rows.find((p) => p.sourceRow === row.sourceRow)!;
    if (planned.sourceId) {
      row.targetSourceId = planned.sourceId;
      const old = domain.observations.find(
        (o) => o.source_id === planned.sourceId && o.id === o.current_observation_id,
      );
      const source = domain.sources.find((s) => s.sourceId === planned.sourceId)!;
      if (old && reportRowContentV1(source.current) === reportRowContentV1(row))
        row.targetObservationId = scalarTextV1(old.id);
    }
    row.targetUid = planned.studentUid;
    row.targetRule = planned.rule;
    row.pendingReason = pendingReasonV1(planned, relationAvailable, profileConflicts);
    row.selectedProfile = selectedRows.has(row.sourceRow);
  }
}

function sourceOrderDifferenceV1(incoming: string | null, current: unknown): string | null {
  if (!incoming || !current) return 'Data do relatório não confirmada. Confira as alterações.';
  return new Date(incoming) < new Date(scalarTextV1(current))
    ? 'Relatório anterior ao vigente. Confira as alterações.'
    : null;
}

/** A changed report must be conferred when origins or classes disappear or its date cannot order it. */
function reportDifferencesV1(
  current: DbRowV1 | undefined,
  contentDigest: string,
  request: ReconciliationPrepareV1,
  domain: DomainV1,
  rows: readonly PreparedRowV1[],
): string[] {
  if (!current || current.digest === contentDigest) return [];
  const differences: string[] = [];
  const missing = domain.sources.filter(
    (s) => !rows.some((r) => r.targetSourceId === s.sourceId),
  ).length;
  if (missing) differences.push(`${missing} origem(ns) não encontrada(s) no relatório.`);
  const oldClasses = new Set(domain.sources.map((s) => s.current.classKey));
  const missingClasses = [...oldClasses].filter((k) => !rows.some((r) => r.classKey === k)).length;
  if (missingClasses) differences.push(`${missingClasses} turma(s) ausente(s) ou alterada(s).`);
  const order = sourceOrderDifferenceV1(request.sourceGeneratedAt, current.source_generated_at);
  if (order) differences.push(order);
  return differences;
}

function batchStateV1(relationAvailable: boolean, differences: number) {
  if (!relationAvailable) return 'awaiting_relation';
  return differences ? 'review_required' : 'preparing';
}

/** PostgreSQL text[] literal of the fixed difference sentences. */
function textArrayLiteralV1(values: readonly string[]): string {
  const quoted = values.map((value) => '"' + value.replaceAll('"', String.raw`\"`) + '"');
  return '{' + quoted.join(',') + '}';
}

export async function prepareReportV1(
  tx: TxV1,
  actorId: string,
  request: ReconciliationPrepareV1,
  context: ReconciliationContextV1,
): Promise<ReconciliationResponseV1> {
  const requestDigest = await digestV1({
    ...request,
    rows: [...request.rows].sort((a, b) => a.sourceRow - b.sourceRow),
    classLinks: [...request.classLinks].sort((a, b) =>
      classReferenceV1(a.classLabel, a.shift, a.stageLabel).localeCompare(
        classReferenceV1(b.classLabel, b.shift, b.stageLabel),
      ),
    ),
  });
  const [receipt] = await tx.query(
    `SELECT * FROM gradebook.student_report_batch_v1
    WHERE academic_year=$1 AND generation=$2::uuid AND actor_id=$3::uuid AND idempotency_key=$4::uuid`,
    [request.academicYear, request.generation, actorId, request.idempotencyKey],
  );
  if (receipt) {
    if (receipt.request_digest !== requestDigest) throw new ReconciliationConflictV1();
    return preparedResponseV1(tx, scalarTextV1(receipt.id), context);
  }
  assertContextV1(context, request);
  assertReportYearAndRowsV1(request);
  const clock = await clockV1(tx);
  if (request.sourceGeneratedAt && new Date(request.sourceGeneratedAt) > clock.now)
    throw invalidV1();
  const classes = await tx.query(`SELECT id,etapa FROM gradebook.turma WHERE ano=$1`, [
    request.academicYear,
  ]);
  const errors: ReconciliationValidationErrorV1[] = [];
  const input: RowInputV1 = {
    request,
    context,
    classes,
    mapping: classMappingV1(request, classes),
    clock,
    errors,
  };
  const rows = request.rows.flatMap((row) => {
    const prepared = preparedRowV1(row, input);
    return prepared ? [prepared] : [];
  });
  if (errors.length) return { contractVersion: 1, state: 'validation-failed', errors };
  if (!rows.length) throw invalidV1();
  // No batch, row, link or credential has been written before complete C3 validation.
  const domain = await loadDomainV1(tx, request.academicYear);
  applyPlanV1(
    rows,
    planStudentReconciliationV1({ rows, ...domain }),
    domain,
    context.relationAvailable,
  );
  const [current] = await tx.query(
    `SELECT b.* FROM gradebook.student_report_batch_v1 b JOIN gradebook.student_reconciliation_scope_v1 s ON s.current_batch_id=b.id WHERE s.academic_year=$1`,
    [request.academicYear],
  );
  const contentDigest = await digestV1(reportContentV1(rows));
  const differences = reportDifferencesV1(current, contentDigest, request, domain, rows);
  const id = crypto.randomUUID();
  const expiresAt = new Date(
    clock.now.getTime() + (context.relationAvailable ? 1 : 30) * DAY_MS_V1,
  ).toISOString();
  await advanceV1(tx, request.academicYear);
  await tx.executeNative(
    `INSERT INTO gradebook.student_report_batch_v1
    (id,academic_year,generation,actor_id,source_generated_at,source_evidence,normalization_version,digest,request_digest,idempotency_key,
     base_revision,base_academic_revision,state,expires_at,differences,class_links)
    VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::timestamptz,$6,1,$7,$8,$9::uuid,$10,$11,$12,$13::timestamptz,$14::text[],$15::text::jsonb)`,
    [
      id,
      request.academicYear,
      context.generation,
      actorId,
      request.sourceGeneratedAt,
      request.sourceGeneratedAt ? 'declared' : 'unknown',
      contentDigest,
      requestDigest,
      request.idempotencyKey,
      context.revision + 1,
      await academicRevisionV1(tx, request.academicYear),
      batchStateV1(context.relationAvailable, differences.length),
      expiresAt,
      textArrayLiteralV1(differences),
      JSON.stringify(request.classLinks),
    ],
  );
  await savePendingV1(tx, id, request.academicYear, rows);
  return preparedResponseV1(tx, id, await contextV1(tx, request.academicYear));
}
function errorIdentityV1(row: { sourceRow: number; name: string; classLabel: string }) {
  return { sourceRow: row.sourceRow, name: row.name, classLabel: row.classLabel };
}
export async function preparedResponseV1(
  tx: TxV1,
  batchId: string,
  context: ReconciliationContextV1,
): Promise<ReconciliationResponseV1> {
  const [r] = await tx.query(
    `SELECT b.*, (SELECT count(*)::integer FROM gradebook.student_report_pending_row_v1 WHERE batch_id=b.id) AS rows,
    (SELECT count(*)::integer FROM gradebook.student_report_pending_row_v1 WHERE batch_id=b.id AND target_uid IS NOT NULL) AS linked,
    expires_at>clock_timestamp() AS usable FROM gradebook.student_report_batch_v1 b WHERE id=$1::uuid`,
    [batchId],
  );
  if (!r) throw new ReconciliationConflictV1('expired');
  if (r.generation !== context.generation) throw new ReconciliationConflictV1();
  if (r.applied_revision !== null)
    return { contractVersion: 1, state: 'committed', context, operationId: batchId };
  if (!r.usable || r.state === 'expired') throw new ReconciliationConflictV1('expired');
  if (!['awaiting_relation', 'review_required', 'preparing'].includes(String(r.state)))
    throw new ReconciliationConflictV1();
  if (r.state !== 'awaiting_relation' && Number(r.base_revision) !== context.revision)
    throw new ReconciliationConflictV1();
  return {
    contractVersion: 1,
    state: 'ready',
    operation: 'prepare',
    context,
    batchId,
    batchState: r.state as 'preparing' | 'review_required' | 'awaiting_relation',
    expiresAt: new Date(String(r.expires_at)).toISOString(),
    differences: r.differences as string[],
    counts: {
      rows: Number(r.rows),
      linked: Number(r.linked),
      pending: Number(r.rows) - Number(r.linked),
    },
    credentialsReady: false,
  };
}
