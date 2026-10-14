// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAttendanceServiceV1 } from '../../server/attendance/service-v1';
import { createAttendanceRequestHandlerV1 } from '../../server/attendance/http-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../server/gradebook/persistence/postgres/postgres-database-v1';
import type {
  AttendanceCollectionV1,
  AttendanceCandidateV1,
} from '../../shared/attendance-contracts/attendance-v1';
import type { RuntimeEnv } from '../../server/env';
import {
  attendanceSyntheticSetupSqlV1,
  ATTENDANCE_SYNTHETIC_RESET_SQL_V1,
} from './synthetic-fixture-v1';

const uid = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const admin = { oid: '20000000-0000-4000-8000-000000000001', roles: ['ADMINISTRADOR' as const] };
const scope = { academicYear: 2026, classId: 101 };
const requestId = () => crypto.randomUUID();
let pg: PGlite;
let service: ReturnType<typeof createAttendanceServiceV1>;
let fencingToken: number;
const collectorId = '30000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  pg = new PGlite();
  for (const sql of attendanceSyntheticSetupSqlV1()) await pg.exec(sql);
  const queryPort = (client: Pick<PGlite, 'query'>): GradebookPostgresQuerySqlV1 => ({
    async unsafe(sql, parameters = []) {
      const result = await client.query<Record<string, unknown>>(sql, [...parameters]);
      return Object.assign(result.rows, { count: result.affectedRows });
    },
  });
  const sql: GradebookPostgresSqlV1 = {
    ...queryPort(pg),
    begin: (operation) => pg.transaction((tx) => operation(queryPort(tx))),
  };
  service = createAttendanceServiceV1(createGradebookPostgresDatabaseFromSqlV1(sql));
}, 30_000);

beforeEach(async () => {
  await pg.exec(ATTENDANCE_SYNTHETIC_RESET_SQL_V1);
  await service.execute(
    {
      operation: 'configure',
      scope,
      requestId: requestId(),
      expectedRevision: 0,
      calendar: [{ date: '2026-01-05', eligible: true, slots: [1, 2, 3, 4, 5, 6] }],
      enrollments: [{ studentUid: uid, startsOn: '2026-01-01', endsOn: null }],
    },
    admin,
  );
  const lease = await service.execute(
    { operation: 'lease', scope, requestId: requestId(), collectorId, durationSeconds: 300 },
    admin,
  );
  fencingToken = Number(lease.fencingToken);
});
afterAll(async () => {
  await pg?.close();
});

function batch(overrides: Partial<AttendanceCollectionV1> = {}): AttendanceCollectionV1 {
  return {
    operation: 'collect',
    scope,
    requestId: requestId(),
    expectedRevision: 1,
    collectorId,
    fencingToken,
    sourceVersion: 'synthetic-v1',
    reportIdentity: 'synthetic-report',
    reportKind: 'annual-detailed-collective',
    observedAt: '2026-01-10T12:00:00Z',
    rosterComplete: true,
    records: [
      {
        recordKey: 'report-row-a',
        originalName: 'aluna sintetica um',
        originalClass: '6A',
        identityBasis: 'durable',
      },
    ],
    coverage: [
      { recordKey: 'report-row-a', date: '2026-01-05', slots: [1, 2, 3, 4, 5, 6], complete: true },
    ],
    marks: [{ recordKey: 'report-row-a', date: '2026-01-05', slot: 6, mark: 'X' }],
    ...overrides,
  };
}
async function review() {
  return (await service.execute({ operation: 'review', scope }, admin)) as {
    revision: number;
    candidates: AttendanceCandidateV1[];
    sourceCurrent: boolean;
    history: unknown[];
    students: { studentUid: string }[];
  };
}
async function decision(value: 'same-student' | 'different-students', expectedRevision?: number) {
  const current = await review();
  return {
    operation: 'decide',
    scope,
    requestId: requestId(),
    expectedRevision: expectedRevision ?? current.revision,
    recordKey: 'report-row-a',
    studentUid: uid,
    evidenceFingerprint: current.candidates[0]!.evidenceFingerprint,
    decision: value,
    reason: 'REVISÃO SINTÉTICA',
  };
}
const summary = () =>
  service.responsibleSummary({ scope, studentUid: uid, month: '2026-01' }, async () => true);

describe('attendance PostgreSQL candidate with synthetic fixtures', () => {
  it('persists sparse X and reliable coverage including the sixth slot', async () => {
    await service.execute(batch(), admin);
    expect((await review()).candidates[0]).toMatchObject({ state: 'identified', studentUid: uid });
    expect((await summary()).summary).toMatchObject({
      absences: 1,
      justified: 0,
      denominator: 6,
      coverage: 'reliable',
    });
    expect((await pg.query('SELECT * FROM attendance.mark')).rows).toHaveLength(1);
  });
  it('replays identical requests and refuses changed payloads under the same id', async () => {
    const input = batch();
    const first = await service.execute(input, admin);
    expect(await service.execute(input, admin)).toEqual(first);
    await expect(service.execute({ ...input, marks: [] }, admin)).rejects.toThrow(
      'idempotency-conflict',
    );
    expect(
      await service.execute({ ...input, requestId: requestId(), expectedRevision: 2 }, admin),
    ).toMatchObject({ revision: 2, changed: false });
    expect((await pg.query('SELECT * FROM attendance.batch')).rows).toHaveLength(1);
  });
  it('keeps all history on incomplete and empty collection attempts', async () => {
    await service.execute(batch(), admin);
    const partial = batch({
      requestId: requestId(),
      expectedRevision: 2,
      sourceVersion: 'synthetic-v2',
      coverage: [{ recordKey: 'report-row-a', date: '2026-01-05', slots: [1], complete: false }],
      marks: [],
    });
    await service.execute(partial, admin);
    expect((await summary()).summary).toMatchObject({
      absences: null,
      percentage: null,
      coverage: 'incomplete',
    });
    await expect(
      service.execute(
        { ...partial, requestId: requestId(), expectedRevision: 3, records: [] },
        admin,
      ),
    ).rejects.toThrow();
    expect((await pg.query('SELECT * FROM attendance.mark')).rows).toHaveLength(1);
    expect((await pg.query('SELECT * FROM attendance.batch')).rows).toHaveLength(2);
  });
  it('audits rejection and explicit reversal; stale reviewers conflict', async () => {
    await service.execute(batch(), admin);
    const reject = await decision('different-students', 2);
    const concurrent = await decision('same-student', 2);
    await service.execute(reject, admin);
    await expect(service.execute(concurrent, { ...admin, oid: other })).rejects.toThrow(
      'stale-revision',
    );
    expect((await review()).candidates[0]).toMatchObject({
      state: 'rejected',
      studentUid: null,
      candidateUids: [],
    });
    await expect(summary()).rejects.toThrow('not-visible');
    await service.execute(await decision('same-student'), admin);
    expect((await review()).candidates[0]!.state).toBe('human-confirmed');
    expect(
      (await pg.query('SELECT decision,actor,reason FROM attendance.decision ORDER BY revision'))
        .rows,
    ).toMatchObject([
      { decision: 'different-students', actor: admin.oid },
      { decision: 'same-student', actor: admin.oid },
    ]);
    await expect(summary()).resolves.toMatchObject({ studentUid: uid });
  });
  it('does not repeat a rejected durable source record after unrelated source revision', async () => {
    await service.execute(batch(), admin);
    await service.execute(await decision('different-students'), admin);
    await service.execute(
      batch({
        expectedRevision: 3,
        sourceVersion: 'synthetic-v2',
        observedAt: '2026-01-11T12:00:00Z',
      }),
      admin,
    );
    expect((await review()).candidates[0]).toMatchObject({ state: 'rejected', candidateUids: [] });
  });
  it('blocks homonyms and does not let a same-student choice invent enrollment', async () => {
    await pg.exec("UPDATE gradebook.aluno SET nome='ALUNA SINTÉTICA UM' WHERE id=2");
    await service.execute(batch(), admin);
    expect((await review()).candidates[0]!.studentUid).toBeNull();
    await service.execute(await decision('same-student'), admin);
    // Relação changed since configuration: identity decision cannot revalidate the enrollment.
    await expect(summary()).rejects.toThrow('enrollment-revalidation-required');
  });
  it('blocks old summaries after Relação changes and preserves earlier evidence', async () => {
    await service.execute(batch(), admin);
    await summary();
    await pg.exec('UPDATE gradebook.vinculo SET turma_id=102 WHERE aluno_id=1');
    expect((await review()).sourceCurrent).toBe(false);
    await expect(summary()).rejects.toThrow('not-visible');
    expect((await pg.query('SELECT * FROM attendance.mark')).rows).toHaveLength(1);
    await expect(
      service.execute({ ...(await decision('same-student')), expectedRevision: 2 }, admin),
    ).rejects.toThrow('stale-relation');
  });
  it('invalidates old visibility when enrollment state changes without moving the class', async () => {
    await service.execute(batch(), admin);
    await summary();
    await pg.exec('UPDATE gradebook.vinculo SET situacao=1 WHERE aluno_id=1');
    expect((await review()).sourceCurrent).toBe(false);
    await expect(summary()).rejects.toThrow('not-visible');
    await pg.exec(
      'UPDATE gradebook.vinculo SET situacao=6,turma_relacionada_id=102 WHERE aluno_id=1',
    );
    expect((await review()).sourceCurrent).toBe(false);
    expect((await review()).students.some((student) => student.studentUid === uid)).toBe(false);
    await expect(summary()).rejects.toThrow('not-visible');
  });
  it('revalidates unchanged source in a new Relação context without losing older snapshots', async () => {
    const source = batch();
    await service.execute(source, admin);
    await pg.exec("UPDATE gradebook.aluno SET nome='ALUNO SINTÉTICO DOIS ALTERADO' WHERE id=2");
    await expect(summary()).rejects.toThrow('not-visible');
    await expect(
      service.execute({ ...source, marks: [], requestId: requestId(), expectedRevision: 2 }, admin),
    ).rejects.toThrow('source-version-conflict');
    await service.execute(
      {
        operation: 'configure',
        scope,
        requestId: requestId(),
        expectedRevision: 2,
        calendar: [{ date: '2026-01-05', eligible: true, slots: [1, 2, 3, 4, 5, 6] }],
        enrollments: [{ studentUid: uid, startsOn: '2026-01-01', endsOn: null }],
      },
      admin,
    );
    await service.execute({ ...source, requestId: requestId(), expectedRevision: 3 }, admin);
    await expect(summary()).resolves.toMatchObject({ studentUid: uid });
    expect((await pg.query('SELECT * FROM attendance.batch')).rows).toHaveLength(2);
    expect((await pg.query('SELECT * FROM attendance.configuration')).rows).toHaveLength(2);
  });
  it('fences a collector after lease renewal/takeover and binds holder to actor', async () => {
    await expect(
      service.execute(
        {
          operation: 'lease',
          scope,
          requestId: requestId(),
          collectorId: other,
          durationSeconds: 30,
        },
        admin,
      ),
    ).rejects.toThrow('lease-busy');
    await service.execute(
      { operation: 'lease', scope, requestId: requestId(), collectorId, durationSeconds: 300 },
      admin,
    );
    await expect(service.execute(batch(), admin)).rejects.toThrow('lease-fenced');
    await pg.exec("UPDATE attendance.scope SET lease_until=clock_timestamp()-interval '1 second'");
    await expect(service.execute(batch(), admin)).rejects.toThrow('lease-fenced');
    const lease = await service.execute(
      {
        operation: 'lease',
        scope,
        requestId: requestId(),
        collectorId: other,
        durationSeconds: 300,
      },
      admin,
    );
    await expect(
      service.execute(batch({ collectorId: other, fencingToken: Number(lease.fencingToken) }), {
        ...admin,
        oid: other,
      }),
    ).rejects.toThrow('lease-fenced');
    await expect(
      service.execute(
        batch({ collectorId: other, fencingToken: Number(lease.fencingToken) }),
        admin,
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });
  it('refuses wrong year/class, unknown uid, stale source and altered source versions', async () => {
    await expect(
      service.execute(batch({ scope: { academicYear: 2027, classId: 101 } }), admin),
    ).rejects.toThrow('class-not-in-relation');
    await service.execute(batch(), admin);
    await expect(
      service.execute(
        batch({
          expectedRevision: 2,
          sourceVersion: 'synthetic-older',
          observedAt: '2026-01-09T12:00:00Z',
        }),
        admin,
      ),
    ).rejects.toThrow('stale-source');
    await expect(service.execute(batch({ expectedRevision: 2, marks: [] }), admin)).rejects.toThrow(
      'source-version-conflict',
    );
    await expect(
      service.execute({ ...(await decision('same-student')), studentUid: collectorId }, admin),
    ).rejects.toThrow('student-not-in-relation');
  });
  it('requires responsible permission on every read, including revalidation before response', async () => {
    await service.execute(batch(), admin);
    await expect(
      service.responsibleSummary({ scope, studentUid: uid, month: '2026-01' }, async () => false),
    ).rejects.toThrow('not-authorized');
    let calls = 0;
    await expect(
      service.responsibleSummary(
        { scope, studentUid: uid, month: '2026-01' },
        async () => ++calls === 1,
      ),
    ).rejects.toThrow('not-authorized');
    expect(calls).toBe(2);
    await expect(
      service.execute({ operation: 'review', scope }, { ...admin, roles: ['PROFESSOR'] }),
    ).rejects.toThrow();
  });
  it('exposes only private no-store responses and fails closed without responsible adapter', async () => {
    await service.execute(batch(), admin);
    const origin = 'https://synthetic.invalid';
    const handler = createAttendanceRequestHandlerV1({ service });
    const response = await handler(
      new Request(`${origin}/api/attendance/v1`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'monthly-summary',
          scope,
          studentUid: uid,
          month: '2026-01',
        }),
      }),
      { OFFICIAL_ORIGIN: origin } as RuntimeEnv,
    );
    expect(response!.status).toBe(403);
    expect(response!.headers.get('Cache-Control')).toContain('no-store');
    expect(await response!.json()).toEqual({
      contractVersion: 'attendance-v1',
      state: 'not-authorized',
    });
  });
  it('never returns an old summary through HTTP conditional headers after loss of eligibility', async () => {
    await service.execute(batch(), admin);
    const origin = 'https://synthetic.invalid';
    const handler = createAttendanceRequestHandlerV1({
      service,
      authorizeResponsible: async () => true,
    });
    const read = (studentUid = uid, classId = scope.classId) =>
      handler(
        new Request(`${origin}/api/attendance/v1`, {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            'If-None-Match': 'synthetic-old-etag',
            'If-Modified-Since': 'Thu, 01 Jan 2026 00:00:00 GMT',
          },
          body: JSON.stringify({
            operation: 'monthly-summary',
            scope: { ...scope, classId },
            studentUid,
            month: '2026-01',
          }),
        }),
        { OFFICIAL_ORIGIN: origin } as RuntimeEnv,
      );
    const reliable = await read();
    expect(reliable!.status).toBe(200);
    expect(await reliable!.json()).toMatchObject({ summary: { coverage: 'reliable' } });
    const assertHidden = async (response: Response | null, state: string) => {
      expect(response!.status).toBe(404);
      expect(response!.headers.get('Cache-Control')).toContain('no-store');
      expect(response!.headers.get('ETag')).toBeNull();
      expect(response!.headers.get('Last-Modified')).toBeNull();
      expect(await response!.json()).toEqual({ contractVersion: 'attendance-v1', state });
    };
    await assertHidden(await read(other), 'not-visible');
    await assertHidden(await read(uid, 9999), 'class-not-in-relation');
    await service.execute(await decision('different-students'), admin);
    await assertHidden(await read(), 'not-visible');
    await service.execute(await decision('same-student'), admin);
    expect((await read())!.status).toBe(200);
    await pg.exec('UPDATE gradebook.vinculo SET turma_id=102 WHERE aluno_id=1');
    await assertHidden(await read(), 'not-visible');
    expect((await pg.query('SELECT * FROM attendance.mark')).rows).toHaveLength(1);
  });
  it('denies public access and backend modification/deletion of history', async () => {
    await pg.exec('SET ROLE gradebook_app');
    await service.execute(batch(), admin);
    await expect(summary()).resolves.toMatchObject({ studentUid: uid });
    await pg.exec('RESET ROLE');
    for (const role of ['anon', 'authenticated', 'student_portal_app']) {
      await pg.exec(`SET ROLE ${role}`);
      await expect(pg.query('SELECT * FROM attendance.mark')).rejects.toThrow('permission denied');
      await pg.exec('RESET ROLE');
    }
    await pg.exec('SET ROLE gradebook_app');
    expect((await pg.query('SELECT * FROM attendance.mark')).rows).toHaveLength(1);
    await expect(pg.query("UPDATE attendance.mark SET mark='J'")).rejects.toThrow(
      'permission denied',
    );
    await expect(pg.query('DELETE FROM attendance.mark')).rejects.toThrow('permission denied');
    await expect(pg.query("UPDATE attendance.decision SET reason='tamper'")).rejects.toThrow(
      'permission denied',
    );
    await pg.exec('RESET ROLE');
  });
});
