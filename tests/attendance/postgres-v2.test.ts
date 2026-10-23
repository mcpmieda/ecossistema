// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import {
  createFrequencyServiceV2,
  resetFrequencyYearV2,
  frequencyYearCountsV2,
} from '../../server/attendance/service-v2';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../server/gradebook/persistence/postgres/postgres-database-v1';
import type {
  FrequencyCollectionV2,
  FrequencyActorV2,
  FrequencyStatusV2,
  FrequencySummaryV2,
} from '../../shared/attendance-contracts/frequency-v2';
import {
  frequencySyntheticSetupSqlV2,
  FREQUENCY_SYNTHETIC_SEED_SQL_V2,
} from './synthetic-fixture-v2';
import { recordFrequencyFailureV2 } from '../../server/attendance/failure-log-v2';
import { frequencyContentHashV2 } from '../../shared/attendance-contracts/frequency-v2';
const uid = '10000000-0000-4000-8000-000000000001';
const admin: FrequencyActorV2 = {
  actorId: '20000000-0000-4000-8000-000000000001',
  tenantId: '90000000-0000-4000-8000-000000000001',
  mode: 'admin',
};
const actor: FrequencyActorV2 = {
  ...admin,
  mode: 'device',
  deviceId: '30000000-0000-4000-8000-000000000001',
  deviceGeneration: 1,
  keyThumbprint: 'synthetic-key',
};
const next: FrequencyActorV2 = { ...actor, deviceId: '30000000-0000-4000-8000-000000000002' };
const id = () => crypto.randomUUID();
interface TestPg {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(operation: (tx: Pick<TestPg, 'query'>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
let pg: TestPg;
let nativeClient: ReturnType<typeof postgres> | undefined;
let failMarks = false,
  expireAfterSource = false;
let service: ReturnType<typeof createFrequencyServiceV2>;
let database: ReturnType<typeof createGradebookPostgresDatabaseFromSqlV1>;
let token: number;
function collection(overrides: Partial<FrequencyCollectionV2> = {}): FrequencyCollectionV2 {
  return {
    operation: 'collect',
    academicYear: 2026,
    requestId: id(),
    fencingToken: token,
    classId: 101,
    expectedRevision: 0,
    sourceVersion: `sha256:${'a'.repeat(64)}`,
    sourceClassId: '123',
    sourceClassLabel: '6A',
    observedAt: '2026-01-10T12:00:00Z',
    rosterComplete: true,
    records: [{ recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' }],
    coverage: [{ recordKey: 'r1', date: '2026-01-05', slots: [1, 2, 3, 4, 5, 6], complete: true }],
    marks: [{ recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'X' }],
    ...overrides,
  };
}
async function execute(operation: string, fields: Record<string, unknown> = {}, who = admin) {
  return service.execute({ operation, academicYear: 2026, requestId: id(), ...fields }, who);
}
async function status() {
  return service.execute(
    { operation: 'status', academicYear: 2026 },
    admin,
  ) as Promise<FrequencyStatusV2>;
}
async function summary() {
  return service.summary(2026, uid, '2026-01', async () => true);
}
beforeAll(async () => {
  const connection = process.env.ATTENDANCE_TEST_POSTGRES_URL;
  if (connection) {
    const url = new URL(connection);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' ||
      !/^\/attendance_ephemeral_[a-f0-9]{32}$/u.test(url.pathname) ||
      url.username !== 'attendance_ephemeral' ||
      url.password ||
      !url.port ||
      url.search ||
      url.hash ||
      !process.env.ATTENDANCE_TEST_POSTGRES_MARKER ||
      !process.env.ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY
    )
      throw new Error('frequency-native-target-not-disposable');
    nativeClient = postgres(connection, { max: 1, prepare: false });
    const [marker] = await nativeClient.unsafe(
      'SELECT marker::text FROM public.attendance_test_sandbox_v1',
    );
    const [directory] = await nativeClient.unsafe('SHOW data_directory');
    if (
      marker?.marker !== process.env.ATTENDANCE_TEST_POSTGRES_MARKER ||
      String(directory?.data_directory).replaceAll('\\', '/').toLowerCase() !==
        process.env.ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY.replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('frequency-native-sandbox-proof-invalid');
    const adapter = (client: GradebookPostgresQuerySqlV1): Pick<TestPg, 'query'> => ({
      async query<T extends Record<string, unknown>>(sql: string, parameters: unknown[] = []) {
        const rows = await client.unsafe(sql, parameters);
        return { rows: [...rows] as T[], affectedRows: rows.count ?? 0 };
      },
    });
    pg = {
      ...adapter(nativeClient as unknown as GradebookPostgresQuerySqlV1),
      exec: (sql) => nativeClient!.unsafe(sql),
      transaction: (operation) =>
        nativeClient!.begin((tx) =>
          operation(adapter(tx as unknown as GradebookPostgresQuerySqlV1)),
        ) as Promise<Awaited<ReturnType<typeof operation>>>,
      close: () => nativeClient!.end(),
    };
  } else pg = new PGlite();
  for (const sql of frequencySyntheticSetupSqlV2()) await pg.exec(sql);
  const port = (client: Pick<TestPg, 'query'>): GradebookPostgresQuerySqlV1 => ({
    async unsafe(sql, params = []) {
      if (failMarks && sql.includes('INSERT INTO attendance.source_mark_v2')) {
        failMarks = false;
        await client.query('SELECT 1/0');
      }
      const r = await client.query<Record<string, unknown>>(sql, [...params]);
      if (expireAfterSource && sql.includes('INSERT INTO attendance.source_row_v2')) {
        expireAfterSource = false;
        if (nativeClient) {
          await client.query(
            "UPDATE attendance.school_state_v2 SET lease_until=clock_timestamp()+interval '0.10 seconds'",
          );
          await client.query('SELECT pg_sleep(0.20)');
        } else
          await client.query(
            "UPDATE attendance.school_state_v2 SET lease_until=clock_timestamp()-interval '1 second'",
          );
      }
      return Object.assign(r.rows, { count: r.affectedRows });
    },
  });
  const sql: GradebookPostgresSqlV1 = {
    ...port(pg),
    begin: (operation) =>
      pg.transaction(async (tx) => {
        await tx.query('SET LOCAL ROLE gradebook_app');
        return operation(port(tx));
      }),
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
  service = createFrequencyServiceV2(database);
}, 30000);
beforeEach(async () => {
  failMarks = false;
  expireAfterSource = false;
  await pg.exec(FREQUENCY_SYNTHETIC_SEED_SQL_V2);
  const lease = await execute('lease', { durationSeconds: 300 }, actor);
  token = Number((lease as Record<string, unknown>).fencingToken);
});
afterAll(async () => {
  await pg?.close();
});
describe('frequency V2 private PostgreSQL service', () => {
  it('uses the configured school timezone to reject or admit a civil collection date', async () => {
    const [clock] = (await pg.query<{ base: string; ahead: string; behind: string }>(
      `SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS base,
        (clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS ahead,
        (clock_timestamp() AT TIME ZONE 'Pacific/Pago_Pago')::date::text AS behind`,
    )).rows;
    const ahead = clock!.ahead > clock!.base;
    const zone = ahead ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
    expect(ahead || clock!.behind < clock!.base).toBe(true);
    await execute('save-settings', {
      expectedRevision: 0,
      schedule: {
        timezone: zone,
        rules: Array.from({ length: 14 }, (_, i) => ({
          weekday: Math.floor(i / 2),
          shift: i % 2 === 0 ? 'matutino' : 'vespertino',
          enabled: false, times: [], recheck: null,
        })),
      },
    }, actor);
    const testDate = ahead ? clock!.ahead : clock!.base;
    const input = collection({
      observedAt: new Date(Date.now() - 5000).toISOString(),
      rosterComplete: false,
      coverage: [{ recordKey: 'r1', date: testDate, slots: [1], complete: false }],
      marks: [],
    });
    if (ahead)
      await expect(service.execute(input, actor)).resolves.toMatchObject({ state: 'committed' });
    else
      await expect(service.execute(input, actor)).rejects.toMatchObject({ code: 'source-invalid' });
  });
  it('accepts small client clock skew, rejects larger future timestamps',async()=>{
    const [clock]=(await pg.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows;
    const near=new Date(new Date(clock!.now).getTime()+2000).toISOString();
    await expect(service.execute(collection({observedAt:near}),actor))
      .resolves.toMatchObject({state:'committed'});
    const tooFar=new Date(Date.now()+30000).toISOString();
    await expect(service.execute(collection({observedAt:tooFar,expectedRevision:1}),actor))
      .rejects.toMatchObject({code:'source-invalid',detail:'observed-in-future'});
  });
  it('rejects marks from a civil day after the snapshot capture, even if already past today', async () => {
    await expect(service.execute(collection({
      observedAt: '2026-01-05T12:00:00Z',
      coverage: [{ recordKey: 'r1', date: '2026-01-06', slots: [1], complete: false }],
      marks: [{ recordKey: 'r1', date: '2026-01-06', slot: 1, mark: 'X' }],
    }), actor)).rejects.toMatchObject({ code: 'source-invalid' });
    expect((await database.transaction((tx) => frequencyYearCountsV2(tx, 2026))).batch_v2).toBe(0);
  });
  it('physical rollback removes batches, class state, evidence and receipt after a late SQL failure', async () => {
    failMarks = true;
    const input = collection();
    await expect(service.execute(input, actor)).rejects.toBeDefined();
    const counts = await database.transaction((tx) => frequencyYearCountsV2(tx, 2026));
    for (const name of [
      'class_state_v2',
      'batch_v2',
      'source_row_v2',
      'source_mark_v2',
      'origin_v2',
    ])
      expect(counts[name]).toBe(0);
    expect(
      (await execute('receipt', { requestId: input.requestId }, actor)) as Record<string, unknown>,
    ).toMatchObject({ result: null });
  });
  it('a lease that expires after database work fences the final commit and rolls back evidence', async () => {
    expireAfterSource = true;
    await expect(service.execute(collection(), actor)).rejects.toMatchObject({
      code: 'lease-fenced',
    });
    expect((await database.transaction((tx) => frequencyYearCountsV2(tx, 2026))).batch_v2).toBe(0);
    expect((await status()).lease?.fencingToken).toBe(token);
  });
  it('counts complete Smecel lesson days like the Smecel and keeps a partial day without totals', async () => {
    // Owner decision 20/10/2026: the positions of a complete day are its lessons. One X in a
    // six-lesson day is 1 absence in 6 lessons: 100 × (6 − 1) / 6 = 83,3%.
    const complete = await service.execute(collection(), actor);
    expect(complete).toMatchObject({ state: 'committed', resolvedRecords: 1, conflicts: 0 });
    expect(await summary()).toMatchObject({
      coverage: 'reliable',
      absences: 1,
      justified: 0,
      denominator: 6,
      percentage: 83.3,
      days: [{ date: '2026-01-05', shift: 'MATUTINO', slots: [1, 2, 3, 4, 5, 6], complete: true }],
    });
  });
  it('keeps sparse marks partial; a partial day never becomes presence or consolidated totals', async () => {
    const r = await service.execute(
      collection({ coverage: [{ recordKey: 'r1', date: '2026-01-05', slots: [1], complete: false }] }),
      actor,
    );
    expect(r).toMatchObject({
      contractVersion: 2,
      state: 'committed',
      revision: 1,
      resolvedRecords: 1,
      unresolvedRecords: 0,
      conflicts: 0,
    });
    const s = await summary();
    expect(s).toMatchObject({
      coverage: 'incomplete',
      absences: null,
      justified: null,
      denominator: null,
      percentage: null,
    });
    expect(s.marks).toHaveLength(1);
    expect(s.marks[0]).toMatchObject({ slot: 1, mark: 'X', classLabels: ['6A'] });
    expect((await status()).classes).toHaveLength(2);
    expect((await status()).classes.every((c) => c.shift === 'matutino')).toBe(true);
  });
  it('idempotency and receipt survive lost responses and expired fence without rewriting', async () => {
    const input = collection();
    const r = await service.execute(input, actor);
    await pg.exec(
      "UPDATE attendance.school_state_v2 SET lease_until=clock_timestamp()-interval '1 second'",
    );
    expect(await service.execute(input, actor)).toEqual(r);
    expect(await execute('receipt', { requestId: input.requestId }, actor)).toMatchObject({
      result: r,
    });
    expect(await execute('receipt', {}, actor)).toMatchObject({ result: null });
    await expect(service.execute({ ...input, marks: [] }, actor)).rejects.toMatchObject({
      code: 'revision-conflict',
    });
    await expect(execute('receipt', { requestId: input.requestId }, next)).rejects.toMatchObject({
      code: 'not-authorized',
    });
  });
  it('school-wide lease, monotonic renewal, takeover, heartbeat, release and pause', async () => {
    await expect(execute('lease', { durationSeconds: 300 }, next)).rejects.toMatchObject({
      code: 'lease-busy',
    });
    const hb = await execute(
      'heartbeat',
      { fencingToken: token, status: 'collecting', classId: 101, code: null },
      actor,
    );
    expect(hb).toMatchObject({ state: 'committed', fencingToken: token });
    const expires = (hb as Record<string, unknown>).expiresAt;
    const hb2 = await execute(
      'heartbeat',
      { fencingToken: token, status: 'ready', classId: null, code: null },
      actor,
    );
    expect((hb2 as Record<string, unknown>).expiresAt).toEqual(expires);
    const renewed = await execute('lease', { durationSeconds: 300 }, actor);
    expect(Number((renewed as Record<string, unknown>).fencingToken)).toBeGreaterThan(token);
    await expect(service.execute(collection(), actor)).rejects.toMatchObject({
      code: 'lease-fenced',
    });
    token = Number((renewed as Record<string, unknown>).fencingToken);
    await execute('release', { fencingToken: token, code: null }, actor);
    const takeover = await execute('lease', { durationSeconds: 300 }, next);
    expect(Number((takeover as Record<string, unknown>).fencingToken)).toBeGreaterThan(token);
    await execute('set-paused', { expectedRevision: 0, paused: true });
    await expect(execute('lease', { durationSeconds: 300 }, next)).rejects.toMatchObject({
      code: 'paused',
    });
    await execute('set-paused', { expectedRevision: 1, paused: false });
  });
  it('a reserve computer status poll refreshes presence without overwriting its leader state', async () => {
    expect((await status()).devices.find((d) => d.deviceId === next.deviceId)?.state).toBe(
      'offline',
    );
    const reserve = (await service.execute(
      { operation: 'status', academicYear: 2026 },
      next,
    )) as FrequencyStatusV2;
    expect(reserve.devices.find((d) => d.deviceId === next.deviceId)?.state).toBe('reserve');
    await execute(
      'heartbeat',
      { fencingToken: token, status: 'collecting', classId: 101, code: null },
      actor,
    );
    const leader = (await service.execute(
      { operation: 'status', academicYear: 2026 },
      actor,
    )) as FrequencyStatusV2;
    expect(leader.devices.find((d) => d.deviceId === actor.deviceId)?.state).toBe('collecting');
  });
  it('a Smecel label spaced differently still matches the Centro class and lists unknown students', async () => {
    await pg.exec(
      `UPDATE gradebook.student_report_class_v1 SET label='8D 2026 -VESPERTINO',class_key='8D 2026 -VESPERTINO' WHERE id='40000000-0000-4000-8000-000000000001'`,
    );
    const label = '8D 2026 - VESPERTINO';
    const result = await service.execute(
      collection({
        sourceClassLabel: label,
        records: [
          { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: label },
          { recordKey: 'r9', originalName: 'ALUNO NOVO INVENTADO', originalClass: label },
        ],
        coverage: [
          { recordKey: 'r1', date: '2026-01-05', slots: [1], complete: false },
          { recordKey: 'r9', date: '2026-01-06', slots: [2], complete: false },
        ],
        marks: [
          { recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'X' },
          { recordKey: 'r9', date: '2026-01-06', slot: 2, mark: 'J' },
        ],
      }),
      actor,
    );
    expect(result).toMatchObject({ resolvedRecords: 1, unresolvedRecords: 1 });
    expect((await summary()).marks).toMatchObject([{ date: '2026-01-05', slot: 1, mark: 'X' }]);
    expect((await status()).unresolved).toEqual([
      expect.objectContaining({ classId: 101, classLabel: label, name: 'ALUNO NOVO INVENTADO', reason: 'not_found', marks: 1 }),
    ]);
    await expect(
      service.execute(
        collection({
          sourceClassLabel: '8E 2026 - VESPERTINO',
          records: [{ recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '8E 2026 - VESPERTINO' }],
          expectedRevision: 1,
          observedAt: '2026-01-11T12:00:00Z',
        }),
        actor,
      ),
    ).rejects.toMatchObject({ code: 'identity-review', detail: 'class-not-linked' });
  });
  it('the seven-day failure trail keeps computer reports and collapses repeats', async () => {
    const report = (status: string, code: string | null) =>
      execute('heartbeat', { fencingToken: token, status, classId: null, code }, actor);
    await report('login-required', 'SOURCE_LOGIN_REQUIRED');
    await report('login-required', 'SOURCE_LOGIN_REQUIRED');
    await report('error', 'SOURCE_CLASS_UNAVAILABLE');
    await pg.exec(
      `INSERT INTO attendance.failure_v2(origin,operation,code,fingerprint,first_at,last_at) VALUES('admin','status','unavailable','old',clock_timestamp()-interval '9 days',clock_timestamp()-interval '8 days')`,
    );
    for (let i = 0; i < 2; i++)
      await recordFrequencyFailureV2(database, {
        origin: 'collector',
        operation: 'collect',
        code: 'source-invalid',
        detail: 'observed-in-future',
        deviceId: actor.deviceId,
        classId: 101,
      });
    const failures = (await status()).failures;
    expect(failures.map((f) => [f.origin, f.code, f.occurrences])).toEqual([
      ['collector', 'source-invalid', 2],
      ['device-report', 'SOURCE_CLASS_UNAVAILABLE', 1],
      ['device-report', 'SOURCE_LOGIN_REQUIRED', 1],
    ]);
    expect(failures[0]).toMatchObject({ detail: 'observed-in-future', deviceId: actor.deviceId, classId: 101 });
    expect((await status()).failures.some((f) => f.code === 'unavailable')).toBe(false);
  });
  it('heartbeat expires old failures and operational receipts but keeps batch receipts', async () => {
    const batch = collection();
    await service.execute(batch, actor);
    await pg.exec(
      `INSERT INTO attendance.failure_v2(origin,operation,code,fingerprint,first_at,last_at) VALUES('admin','status','unavailable','old',clock_timestamp()-interval '9 days',clock_timestamp()-interval '8 days');
      INSERT INTO attendance.receipt_v2(academic_year,generation,request_id,actor_id,payload_hash,result_json,recorded_at)
      SELECT academic_year,generation,'${id()}'::uuid,actor_id,'old','{}',clock_timestamp()-interval '9 days' FROM attendance.receipt_v2 LIMIT 1;
      UPDATE attendance.receipt_v2 SET recorded_at=clock_timestamp()-interval '9 days' WHERE request_id='${batch.requestId}'`,
    );
    const before = (await pg.query<{ n: number }>('SELECT count(*)::integer AS n FROM attendance.receipt_v2')).rows[0]!.n;
    await execute('heartbeat', { fencingToken: token, status: 'ready', classId: null, code: null }, actor);
    const receipts = (await pg.query<{ request_id: string }>('SELECT request_id::text FROM attendance.receipt_v2')).rows;
    expect(receipts).toHaveLength(before);
    expect(receipts.some((r) => r.request_id === batch.requestId)).toBe(true);
    expect((await pg.query('SELECT 1 FROM attendance.failure_v2')).rows).toHaveLength(0);
  });
  it('N source rows to one central UID deduplicate and preserve origins', async () => {
    const input = collection({
      records: [
        { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
        { recordKey: 'r2', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
      ],
      coverage: [
        { recordKey: 'r1', date: '2026-01-05', slots: [1], complete: true },
        { recordKey: 'r2', date: '2026-01-05', slots: [1], complete: true },
      ],
      marks: [
        { recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'X' },
        { recordKey: 'r2', date: '2026-01-05', slot: 1, mark: 'X' },
      ],
    });
    expect(await service.execute(input, actor)).toMatchObject({ resolvedRecords: 2, conflicts: 0 });
    expect((await summary()).marks).toHaveLength(1);
    expect(
      (await pg.query('SELECT count(*)::integer AS n FROM attendance.origin_v2')).rows,
    ).toEqual([{ n: 2 }]);
  });
  it('homonyms without unique central identity remain unassigned', async () => {
    await pg.exec(
      "UPDATE gradebook.student_source_observation_v1 SET name_key='ALUNA SINTETICA UM' WHERE name_key='ALUNO SINTETICO DOIS'",
    );
    expect(await service.execute(collection(), actor)).toMatchObject({
      resolvedRecords: 0,
      unresolvedRecords: 1,
    });
    expect((await summary()).marks).toEqual([]);
    expect(
      (await pg.query('SELECT resolution,student_uid FROM attendance.source_row_v2')).rows,
    ).toEqual([{ resolution: 'ambiguous', student_uid: null }]);
  });
  it('an absence later justified in the source (X then J) is accepted without review', async () => {
    await service.execute(collection(), actor);
    expect(
      await service.execute(
        collection({
          sourceVersion: `sha256:${'b'.repeat(64)}`,
          expectedRevision: 1,
          marks: [{ recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'J' }],
        }),
        actor,
      ),
    ).toMatchObject({ conflicts: 0 });
    expect((await summary()).marks[0]?.mark).toBe('J');
    expect((await status()).conflicts).toEqual([]);
    expect(
      (await pg.query('SELECT before_mark,after_mark,reason FROM attendance.correction_v2')).rows,
    ).toEqual([{ before_mark: 'X', after_mark: 'J', reason: 'Falta justificada no Smecel' }]);
  });
  it("the source's latest reading always prevails: J then X, and an absence removed", async () => {
    // Owner decision 23/10/2026: no review; the Smecel's last update wins.
    const coverage = [{ recordKey: 'r1', date: '2026-01-05', slots: [1, 2, 3, 4, 5], complete: true }];
    await service.execute(collection({ coverage, marks: [{ recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'J' }] }), actor);
    await service.execute(
      collection({
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        expectedRevision: 1,
        coverage,
        marks: [{ recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'X' }],
      }),
      actor,
    );
    expect((await summary()).marks[0]?.mark).toBe('X');
    expect((await status()).conflicts).toEqual([]);
    await service.execute(
      collection({ sourceVersion: `sha256:${'c'.repeat(64)}`, expectedRevision: 2, coverage, marks: [] }),
      actor,
    );
    expect((await summary()).marks).toEqual([]);
    expect((await status()).conflicts).toEqual([]);
    expect(
      (await pg.query('SELECT before_mark,after_mark,reason FROM attendance.correction_v2 ORDER BY recorded_at')).rows,
    ).toEqual([
      { before_mark: 'J', after_mark: 'X', reason: 'Falta marcada no Smecel' },
      { before_mark: 'X', after_mark: null, reason: 'Falta apagada no Smecel' },
    ]);
  });
  it('daily pruning keeps official marks and only the evidence the next collection needs', async () => {
    const count = async (table: string) =>
      Number((await pg.query<{ n: number }>(`SELECT count(*)::integer AS n FROM attendance.${table}`)).rows[0]!.n);
    const prune = async () =>
      (await pg.query<{ r: Record<string, number> }>('SELECT attendance.prune_superseded_evidence_v2() AS r')).rows[0]!.r;
    await service.execute(collection(), actor);
    await service.execute(
      collection({
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        expectedRevision: 1,
        coverage: [{ recordKey: 'r1', date: '2026-01-05', slots: [1, 2, 3, 4, 5], complete: true }],
        marks: [{ recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'J' }],
      }),
      actor,
    );
    expect(await count('batch_v2')).toBe(2);
    expect(await prune()).toMatchObject({ batches: 1 });
    expect(await count('batch_v2')).toBe(1);
    expect(await count('origin_v2')).toBe(1);
    expect((await summary()).marks[0]?.mark).toBe('J');
    expect(await prune()).toMatchObject({ origins: 0, marks: 0, coverage: 0, sourceRows: 0, batches: 0 });
    // Two fichas of the student disagreeing in the same reading: the only case left to a person.
    await service.execute(
      collection({
        sourceVersion: `sha256:${'c'.repeat(64)}`,
        expectedRevision: 2,
        records: [
          { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
          { recordKey: 'r2', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
        ],
        coverage: [
          { recordKey: 'r1', date: '2026-01-05', slots: [1, 2, 3, 4, 5], complete: true },
          { recordKey: 'r2', date: '2026-01-05', slots: [1, 2, 3, 4, 5], complete: true },
        ],
        marks: [
          { recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'X' },
          { recordKey: 'r2', date: '2026-01-05', slot: 1, mark: 'J' },
        ],
      }),
      actor,
    );
    expect((await status()).conflicts).toHaveLength(1);
    // Evidence behind an open conflict is never pruned.
    await prune();
    expect(await count('origin_v2')).toBe(3);
    expect((await status()).conflicts).toHaveLength(1);
  });
  it('pruning removes, traceably, an absence left under the other ficha of the same student', async () => {
    const prune = async (dryRun = false) =>
      (
        await pg.query<{ r: Record<string, unknown> }>(
          'SELECT attendance.prune_superseded_evidence_v2($1) AS r',
          [dryRun],
        )
      ).rows[0]!.r;
    const origins = async () =>
      (
        await pg.query<{ record_key: string }>(
          'SELECT record_key FROM attendance.origin_v2 ORDER BY record_key',
        )
      ).rows.map((row) => row.record_key);
    const records = [
      { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
      { recordKey: 'r2', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
    ];
    // Two fichas of one student (a re-enrolment). An early reading swapped them: the old ficha's
    // lesson and absence of the 5th came under r2, the new ficha's day under r1.
    await service.execute(
      collection({
        records,
        coverage: [
          { recordKey: 'r1', date: '2026-01-06', slots: [1, 2], complete: true },
          { recordKey: 'r2', date: '2026-01-05', slots: [1, 2], complete: true },
        ],
        marks: [{ recordKey: 'r2', date: '2026-01-05', slot: 1, mark: 'X' }],
      }),
      actor,
    );
    // The next reading is right: r1 is the old ficha (the 5th, with its absence), r2 the new one.
    await service.execute(
      collection({
        records,
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        expectedRevision: 1,
        coverage: [
          { recordKey: 'r1', date: '2026-01-05', slots: [1, 2], complete: true },
          { recordKey: 'r2', date: '2026-01-06', slots: [1, 2], complete: true },
        ],
        marks: [{ recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'X' }],
      }),
      actor,
    );
    expect((await status()).conflicts).toHaveLength(0);
    expect(await origins()).toEqual(['r1', 'r2']);

    // A simulation counts and records itself, and removes nothing.
    expect(await prune(true)).toMatchObject({ dryRun: true, recordWithoutLesson: 1, origins: 1 });
    expect(await origins()).toEqual(['r1', 'r2']);
    expect(
      (await pg.query('SELECT dry_run FROM attendance.prune_run_v2 ORDER BY id')).rows,
    ).toEqual([{ dry_run: true }]);

    // The real run copies the stray line first, then removes it; the absence keeps r1's evidence.
    expect(await prune()).toMatchObject({
      dryRun: false,
      recordWithoutLesson: 1,
      checks: { occurrencesWithoutEvidence: 0, unprovenRecordWithoutLesson: 0 },
    });
    expect(await origins()).toEqual(['r1']);
    expect(
      (
        await pg.query(
          'SELECT reason,record_key,mark,date::text,slot,student_uid::text FROM attendance.pruned_origin_v2',
        )
      ).rows,
    ).toEqual([
      { reason: 'record-without-lesson', record_key: 'r2', mark: 'X', date: '2026-01-05', slot: 1, student_uid: uid },
    ]);
    expect((await summary()).marks).toEqual([expect.objectContaining({ date: '2026-01-05', slot: 1, mark: 'X' })]);
    // Healthy: nothing for the panel's failure trail.
    expect((await status()).failures).toEqual([]);
    // The archive goes with its school year.
    expect((await database.transaction((tx) => frequencyYearCountsV2(tx, 2026))).pruned_origin_v2).toBe(1);
    await database.transaction((tx) => resetFrequencyYearV2(tx, 2026));
    expect(
      (await pg.query('SELECT count(*)::integer AS n FROM attendance.pruned_origin_v2')).rows,
    ).toEqual([{ n: 0 }]);
  });
  it('pruning never removes evidence it cannot prove elsewhere and reports it on the panel', async () => {
    await service.execute(collection(), actor);
    // The only ficha holding the absence no longer has that lesson (nothing else proves it).
    await pg.exec(`UPDATE attendance.coverage_v2 SET slots_json='[2,3,4,5,6]'::jsonb`);
    // And an absence with no evidence at all.
    await pg.exec(
      `INSERT INTO attendance.occurrence_v2(id,academic_year,student_uid,date,shift,slot,mark)
       VALUES(gen_random_uuid(),2026,'${uid}','2026-01-07','MATUTINO',2,'X')`,
    );
    const result = (
      await pg.query<{ r: Record<string, unknown> }>(
        'SELECT attendance.prune_superseded_evidence_v2() AS r',
      )
    ).rows[0]!.r;
    expect(result).toMatchObject({
      origins: 0,
      checks: { occurrencesWithoutEvidence: 1, unprovenRecordWithoutLesson: 1 },
    });
    expect(
      (await pg.query('SELECT count(*)::integer AS n FROM attendance.origin_v2')).rows,
    ).toEqual([{ n: 1 }]);
    const failures = (await status()).failures;
    expect(failures.map((failure) => failure.code).sort()).toEqual([
      'EVIDENCE_UNPROVEN',
      'EVIDENCE_WITHOUT_ORIGIN',
    ]);
    expect(failures.every((failure) => failure.operation === 'evidence-pruning')).toBe(true);
    expect(failures.map((failure) => failure.detail)).toEqual([
      'Revisar 1 registro(s) no banco.',
      'Revisar 1 registro(s) no banco.',
    ]);
  });
  it('an unchanged diary only moves freshness; what the server cannot confirm asks for the whole diary', async () => {
    const input = collection();
    await service.execute(input, actor);
    const contentHash = await frequencyContentHashV2(input);
    const unchanged = (fields: Record<string, unknown> = {}) => ({
      operation: 'collect-unchanged',
      academicYear: 2026,
      requestId: id(),
      fencingToken: token,
      classId: 101,
      expectedRevision: 1,
      sourceVersion: `sha256:${'b'.repeat(64)}`,
      sourceClassId: '123',
      sourceClassLabel: '6A',
      observedAt: '2026-01-11T12:00:00Z',
      rosterComplete: true,
      records: input.records,
      contentHash,
      ...fields,
    });
    const counts = async () => database.transaction((tx) => frequencyYearCountsV2(tx, 2026));
    const before = await counts();
    // No coverage, no marks: only the receipt and the freshness move.
    expect(await service.execute(unchanged(), actor)).toMatchObject({
      operation: 'collect-unchanged',
      classId: 101,
      revision: 2,
      resolvedRecords: 1,
      conflicts: 0,
    });
    const after = await counts();
    for (const name of ['batch_v2', 'source_row_v2', 'coverage_v2', 'source_mark_v2', 'occurrence_v2', 'origin_v2'])
      expect(after[name]).toBe(before[name]);
    expect((await status()).collections[0]?.observedAt).toBe('2026-01-11T12:00:00.000Z');
    expect((await summary()).marks).toHaveLength(1);
    // Content the server does not hold (the collector's copy is wrong, or the server lost it).
    await expect(
      service.execute(
        unchanged({ expectedRevision: 2, observedAt: '2026-01-12T12:00:00Z', contentHash: 'A'.repeat(43) }),
        actor,
      ),
    ).rejects.toMatchObject({ code: 'payload-required' });
    // A link changed in the Centro since the last batch changes the evidence too.
    await pg.exec(
      "UPDATE gradebook.student_source_observation_v1 SET name_key='ALUNA SINTETICA UM' WHERE name_key='ALUNO SINTETICO DOIS'",
    );
    await expect(
      service.execute(unchanged({ expectedRevision: 2, observedAt: '2026-01-12T12:00:00Z' }), actor),
    ).rejects.toMatchObject({ code: 'payload-required' });
    // The usual guards stay: an older capture, a stale revision, an administrator.
    await pg.exec(
      "UPDATE gradebook.student_source_observation_v1 SET name_key='ALUNO SINTETICO DOIS' WHERE id='60000000-0000-4000-8000-000000000002'",
    );
    await expect(
      service.execute(unchanged({ expectedRevision: 2, observedAt: '2026-01-10T11:00:00Z' }), actor),
    ).rejects.toMatchObject({ code: 'source-invalid' });
    await expect(service.execute(unchanged({ expectedRevision: 1 }), actor)).rejects.toMatchObject({
      code: 'revision-conflict',
    });
    await expect(service.execute(unchanged({ expectedRevision: 2 }), admin)).rejects.toMatchObject({
      code: 'not-authorized',
    });
  });
  it('the weekly grid keeps one version per change and only freshness otherwise', async () => {
    const grid = (lessons: { weekday: number; slot: number; subject: string }[], fields: Record<string, unknown> = {}) => ({
      operation: 'schedule-collect',
      academicYear: 2026,
      requestId: id(),
      fencingToken: token,
      sourceVersion: `sha256:${'d'.repeat(64)}`,
      observedAt: '2026-01-10T12:00:00Z',
      classes: [{ classId: 101, sourceClassId: '123', sourceClassLabel: '6A', lessons }],
      ...fields,
    });
    const first = [
      { weekday: 1, slot: 1, subject: 'LINGUA PORTUGUESA' },
      { weekday: 1, slot: 2, subject: 'MATEMATICA' },
      { weekday: 2, slot: 6, subject: 'ARTE' },
    ];
    const versions = async () =>
      (
        await pg.query<{ lessons_json: unknown }>(
          'SELECT lessons_json FROM attendance.schedule_version_v2 ORDER BY received_at,id',
        )
      ).rows;
    expect(await service.execute(grid(first), actor)).toMatchObject({
      operation: 'schedule-collect',
      classes: [{ classId: 101, changed: true }],
    });
    // The same grid in another order is the same grid: freshness only.
    expect(
      await service.execute(grid([...first].reverse(), { observedAt: '2026-01-11T12:00:00Z' }), actor),
    ).toMatchObject({ classes: [{ classId: 101, changed: false }] });
    expect(await versions()).toHaveLength(1);
    expect(
      (await pg.query('SELECT last_observed_at::text AS at FROM attendance.schedule_state_v2')).rows,
    ).toEqual([{ at: expect.stringMatching(/^2026-01-11 /u) }]);
    // A change adds a version; the history stays and the class points at the new one.
    const second = [...first.slice(0, 2), { weekday: 2, slot: 6, subject: 'MATEMATICA' }];
    expect(
      await service.execute(grid(second, { observedAt: '2026-01-12T12:00:00Z' }), actor),
    ).toMatchObject({ classes: [{ classId: 101, changed: true }] });
    expect(await versions()).toHaveLength(2);
    expect(
      (
        await pg.query(
          'SELECT v.lessons_json->2->>\'subject\' AS subject FROM attendance.schedule_state_v2 s JOIN attendance.schedule_version_v2 v ON v.id=s.current_version_id',
        )
      ).rows,
    ).toEqual([{ subject: 'MATEMATICA' }]);
    // Guards: an older capture, a class not linked in the Centro, a lesson twice, an administrator.
    await expect(
      service.execute(grid(first, { observedAt: '2026-01-10T13:00:00Z' }), actor),
    ).rejects.toMatchObject({ code: 'source-invalid' });
    await expect(
      service.execute(
        grid(first, {
          observedAt: '2026-01-13T12:00:00Z',
          classes: [{ classId: 101, sourceClassId: '123', sourceClassLabel: '9Z', lessons: first }],
        }),
        actor,
      ),
    ).rejects.toMatchObject({ code: 'identity-review' });
    await expect(
      service.execute(grid([...first, first[0]!], { observedAt: '2026-01-13T12:00:00Z' }), actor),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      service.execute(grid(first, { observedAt: '2026-01-13T12:00:00Z' }), admin),
    ).rejects.toMatchObject({ code: 'not-authorized' });
    // The grids go with their school year.
    await database.transaction((tx) => resetFrequencyYearV2(tx, 2026));
    expect(await versions()).toHaveLength(0);
  });
  it('two fichas disagreeing (J/X) in one reading require an audited admin choice, CAS, and no last writer', async () => {
    await service.execute(
      collection({
        records: [
          { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
          { recordKey: 'r2', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
        ],
        coverage: [
          { recordKey: 'r1', date: '2026-01-05', slots: [1], complete: true },
          { recordKey: 'r2', date: '2026-01-05', slots: [1], complete: true },
        ],
        marks: [
          { recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'J' },
          { recordKey: 'r2', date: '2026-01-05', slot: 1, mark: 'X' },
        ],
      }),
      actor,
    );
    let s = await status();
    expect(s.conflicts).toHaveLength(1);
    const deviceStatus = (await service.execute(
      { operation: 'status', academicYear: 2026 }, actor,
    )) as FrequencyStatusV2;
    expect(deviceStatus.conflicts).toEqual([]);
    expect(deviceStatus.classes).toEqual(s.classes);
    expect(deviceStatus.settings).toEqual(s.settings);
    expect(deviceStatus.lease).toEqual(s.lease);
    expect((await summary()).marks).toEqual([]);
    const conflict = s.conflicts[0]!;
    await expect(
      execute('resolve-conflict', {
        conflictId: conflict.id,
        expectedRevision: 999,
        mark: 'J',
        reason: 'Correção sintética',
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    await expect(
      execute(
        'resolve-conflict',
        {
          conflictId: conflict.id,
          expectedRevision: conflict.revision,
          mark: 'J',
          reason: 'Correção sintética',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'not-authorized' });
    await execute('resolve-conflict', {
      conflictId: conflict.id,
      expectedRevision: conflict.revision,
      mark: 'J',
      reason: 'Correção sintética',
    });
    expect((await summary()).marks[0]?.mark).toBe('J');
    s = await status();
    expect(s.conflicts).toEqual([]);
    expect((await pg.query('SELECT reason FROM attendance.correction_v2')).rows).toEqual([
      { reason: 'Correção sintética' },
    ]);
  });
  it('partial sources keep history; complete disappearance removes the absence', async () => {
    await service.execute(collection(), actor);
    await service.execute(
      collection({
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        expectedRevision: 1,
        coverage: [{ recordKey: 'r1', date: '2026-01-05', slots: [1], complete: false }],
        marks: [],
      }),
      actor,
    );
    expect((await summary()).marks).toHaveLength(1);
    await service.execute(
      collection({ sourceVersion: `sha256:${'c'.repeat(64)}`, expectedRevision: 2, marks: [] }),
      actor,
    );
    // Owner decision 23/10/2026: removed in the source, removed here, without review.
    expect((await status()).conflicts).toEqual([]);
    expect((await summary()).marks).toEqual([]);
  });
  it('central corrections block earlier evidence and never silently reassign history', async () => {
    await service.execute(collection(), actor);
    await pg.exec(
      "UPDATE gradebook.student_source_link_v1 SET student_uid='10000000-0000-4000-8000-000000000002' WHERE student_uid='10000000-0000-4000-8000-000000000001'",
    );
    expect((await summary()).marks).toEqual([]);
    const other = await service.summary(
      2026,
      '10000000-0000-4000-8000-000000000002',
      '2026-01',
      async () => true,
    );
    expect(other.marks).toEqual([]);
  });
  it('a transfer preserves UID history in previous and current classes', async () => {
    await service.execute(collection(), actor);
    await pg.exec(
      "UPDATE gradebook.student_source_observation_v1 SET transferred_at='2026-01-06' WHERE name_key='ALUNA SINTETICA UM'; INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,report_class_id,name_key,birth_date,enrolled_at) VALUES('60000000-0000-4000-8000-000000000003',2026,'50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','ALUNA SINTETICA UM','2014-01-01','2026-01-07')",
    );
    await service.execute(
      collection({
        classId: 102,
        sourceClassLabel: '6B',
        sourceClassId: '124',
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        records: [{ recordKey: 'new', originalName: 'ALUNA SINTETICA UM', originalClass: '6B' }],
        coverage: [{ recordKey: 'new', date: '2026-01-08', slots: [1], complete: true }],
        marks: [{ recordKey: 'new', date: '2026-01-08', slot: 1, mark: 'J' }],
      }),
      actor,
    );
    expect((await summary()).marks.map((m) => [m.date, m.classLabels])).toEqual([
      ['2026-01-05', ['6A']],
      ['2026-01-08', ['6B']],
    ]);
  });
  it('rejects future/year/slot/membership/duplicate and proven enrollment violations atomically', async () => {
    for (const input of [
      collection({ marks: [{ recordKey: 'r1', date: '2026-01-05', slot: 7 as 1, mark: 'X' }] }),
      collection({ marks: [{ recordKey: 'wrong', date: '2026-01-05', slot: 1, mark: 'X' }] }),
      collection({ observedAt: '2099-01-01T00:00:00Z' }),
      collection({
        coverage: [{ recordKey: 'r1', date: '2027-01-01', slots: [1], complete: true }],
        marks: [],
      }),
      collection({
        records: [
          { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
          { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
        ],
      }),
    ])
      await expect(service.execute(input, actor)).rejects.toBeDefined();
    await pg.exec("UPDATE gradebook.student_source_observation_v1 SET enrolled_at='2026-01-06'");
    await expect(service.execute(collection(), actor)).rejects.toMatchObject({
      code: 'source-invalid',
    });
    expect((await pg.query('SELECT count(*)::integer AS n FROM attendance.batch_v2')).rows).toEqual(
      [{ n: 0 }],
    );
  });
  it('source versions and revisions guard equivalence and class evidence', async () => {
    await service.execute(collection(), actor);
    await expect(
      service.execute(collection({ sourceVersion: `sha256:${'b'.repeat(64)}` }), actor),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    expect(await service.execute(collection({ expectedRevision: 1 }), actor)).toMatchObject({
      revision: 1,
    });
    await expect(
      service.execute(collection({ expectedRevision: 1, marks: [] }), actor),
    ).rejects.toMatchObject({ code: 'source-invalid' });
    await pg.exec('UPDATE gradebook.student_report_class_v1 SET review_required=true');
    await expect(
      service.execute(
        collection({ expectedRevision: 1, sourceVersion: `sha256:${'c'.repeat(64)}` }),
        actor,
      ),
    ).rejects.toMatchObject({ code: 'identity-review' });
    expect((await summary()).marks).toEqual([]);
  });
  it('settings CAS, device naming/revocation and current auth lock operate privately', async () => {
    const schedule = {
      timezone: 'America/Sao_Paulo',
      rules: Array.from({ length: 14 }, (_, i) => ({
        weekday: Math.floor(i / 2),
        shift: i % 2 ? 'vespertino' : 'matutino',
        enabled: false,
        times: [],
        recheck: null,
      })),
    };
    await execute('save-settings', { expectedRevision: 0, schedule });
    await expect(execute('save-settings', { expectedRevision: 0, schedule })).rejects.toMatchObject(
      { code: 'revision-conflict' },
    );
    await execute('rename-device', { deviceId: actor.deviceId, label: 'Máquina sintética' });
    expect((await status()).devices.find((d) => d.deviceId === actor.deviceId)?.label).toBe(
      'Máquina sintética',
    );
    await execute('revoke-device', { deviceId: actor.deviceId });
    await expect(service.execute(collection(), actor)).rejects.toMatchObject({
      code: 'not-authorized',
    });
    expect((await status()).devices.find((d) => d.deviceId === actor.deviceId)?.state).toBe(
      'revoked',
    );
  });
  it('authorized institutional devices share schedule/pause and rename only themselves', async () => {
    const schedule = {
      timezone: 'America/Sao_Paulo',
      rules: Array.from({ length: 14 }, (_, i) => ({
        weekday: Math.floor(i / 2),
        shift: i % 2 ? 'vespertino' : 'matutino',
        enabled: false,
        times: [],
        recheck: null,
      })),
    };
    expect(await execute('save-settings', { expectedRevision: 0, schedule }, actor)).toMatchObject({
      settingsRevision: 1,
    });
    expect(await execute('set-paused', { expectedRevision: 1, paused: true }, actor)).toMatchObject(
      { settingsRevision: 2 },
    );
    await execute('rename-device', { deviceId: actor.deviceId, label: 'Meu computador' }, actor);
    await expect(
      execute('rename-device', { deviceId: next.deviceId, label: 'Outro computador' }, actor),
    ).rejects.toMatchObject({ code: 'not-authorized' });
    await expect(
      execute('revoke-device', { deviceId: actor.deviceId }, actor),
    ).rejects.toMatchObject({ code: 'not-authorized' });
    await expect(
      service.execute(
        { operation: 'monthly-summary', academicYear: 2026, studentUid: uid, month: '2026-01' },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'not-authorized' });
  });
  it('persists and returns 48 collections per rule (47 plus recheck), keeping the other pairs', async () => {
    const quarter = (count: number, start: number) =>
      Array.from({ length: count }, (_, i) => {
        const m = start + i * 15;
        return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      });
    const rules = Array.from({ length: 14 }, (_, i) => ({
      weekday: Math.floor(i / 2),
      shift: (i % 2 ? 'vespertino' : 'matutino') as 'matutino' | 'vespertino',
      // Monday morning: 48; Tuesday afternoon: 47 + recheck (one school day each).
      enabled: i === 2 || i === 5,
      times: i === 2 ? quarter(48, 6 * 60) : i === 5 ? quarter(47, 7 * 60) : [],
      recheck: i === 5 ? '23:45' : null,
    }));
    const schedule = { timezone: 'America/Bahia', rules };
    await execute('save-settings', { expectedRevision: 0, schedule }, actor);
    expect((await status()).settings.schedule).toEqual(schedule);
    const tooMany = {
      ...schedule,
      rules: rules.map((r, i) => (i === 2 ? { ...r, times: quarter(49, 6 * 60) } : r)),
    };
    await expect(
      execute('save-settings', { expectedRevision: 1, schedule: tooMany }, actor),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    const after = await status();
    expect(after.settings.schedule).toEqual(schedule);
    expect(after.settings.revision).toBe(1);
  });
  it('summary revalidates authorization before and after read and isolates months', async () => {
    await service.execute(collection(), actor);
    let calls = 0;
    await expect(
      service.summary(2026, uid, '2026-01', async () => ++calls === 1),
    ).rejects.toMatchObject({ code: 'not-authorized' });
    expect(calls).toBe(2);
    await expect(service.summary(2026, uid, '2026-01', async () => false)).rejects.toMatchObject({
      code: 'not-authorized',
    });
    expect(
      (
        (await service.execute(
          { operation: 'monthly-summary', academicYear: 2026, studentUid: uid, month: '2026-02' },
          admin,
        )) as FrequencySummaryV2
      ).marks,
    ).toEqual([]);
  });
  it('reset explicitly deletes dependents, retains identity and fences old requests', async () => {
    const input = collection();
    await service.execute(input, actor);
    const counts = await database.transaction((tx) => frequencyYearCountsV2(tx, 2026));
    expect(counts.batch_v2).toBe(1);
    await database.transaction((tx) => resetFrequencyYearV2(tx, 2026));
    expect((await summary()).marks).toEqual([]);
    await expect(service.execute(input, actor)).rejects.toMatchObject({
      code: 'revision-conflict',
    });
    expect((await status()).settings.paused).toBe(true);
    expect(
      (await pg.query('SELECT count(*)::integer AS n FROM gradebook.student_identity')).rows,
    ).toEqual([{ n: 2 }]);
  });
  it('unchanged annual diaries update freshness without growing personal evidence or event copies', async () => {
    await service.execute(collection(), actor);
    const counts = await database.transaction((tx) => frequencyYearCountsV2(tx, 2026));
    await service.execute(
      collection({
        expectedRevision: 1,
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        observedAt: '2026-01-11T12:00:00Z',
      }),
      actor,
    );
    const updated = await database.transaction((tx) => frequencyYearCountsV2(tx, 2026));
    for (const name of [
      'batch_v2',
      'source_row_v2',
      'coverage_v2',
      'source_mark_v2',
      'occurrence_v2',
      'origin_v2',
    ])
      expect(updated[name]).toBe(counts[name]);
    expect((await status()).collections[0]?.observedAt).toBe('2026-01-11T12:00:00.000Z');
    expect((await summary()).observedAt).toBe('2026-01-11T12:00:00.000Z');
  });
  it('partial snapshots do not advance freshness of an omitted student', async () => {
    await service.execute(collection(), actor);
    await service.execute(
      collection({
        expectedRevision: 1,
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        observedAt: '2026-01-11T12:00:00Z',
        rosterComplete: false,
        records: [{ recordKey: 'r2', originalName: 'ALUNO SINTETICO DOIS', originalClass: '6A' }],
        coverage: [{ recordKey: 'r2', date: '2026-01-05', slots: [1], complete: false }],
        marks: [],
      }),
      actor,
    );
    expect((await summary()).marks).toHaveLength(1);
    expect((await summary()).observedAt).toBe('2026-01-10T12:00:00.000Z');
  });
  it('a changed annual diary stores only changed coverage, marks and source evidence', async () => {
    await service.execute(collection(), actor);
    const counts = await database.transaction((tx) => frequencyYearCountsV2(tx, 2026));
    await service.execute(
      collection({
        expectedRevision: 1,
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        observedAt: '2026-01-11T12:00:00Z',
        marks: [
          { recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'X' },
          { recordKey: 'r1', date: '2026-01-05', slot: 2, mark: 'J' },
        ],
      }),
      actor,
    );
    const after = await database.transaction((tx) => frequencyYearCountsV2(tx, 2026));
    expect(after.coverage_v2).toBe(counts.coverage_v2);
    expect(after.source_mark_v2).toBe(counts.source_mark_v2! + 1);
    expect(after.origin_v2).toBe(counts.origin_v2! + 1);
    expect((await summary()).marks).toHaveLength(2);
  });
  it('a day a record no longer has gets a tombstone, so an old partial row stops withholding totals', async () => {
    // The Smecel lists a student twice (two enrolments) and may swap the rows between captures, or
    // turn the old enrolment's days into "fora do período de matrícula". The record is still in the
    // collection, but no longer has those days: they must not stay incomplete from an older batch.
    const records = [
      { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
      { recordKey: 'r2', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
    ];
    const full = [1, 2, 3, 4, 5, 6];
    await service.execute(
      collection({
        records,
        coverage: [
          { recordKey: 'r1', date: '2026-01-05', slots: full, complete: true },
          { recordKey: 'r2', date: '2026-01-06', slots: [1, 2], complete: false },
        ],
        marks: [{ recordKey: 'r1', date: '2026-01-05', slot: 1, mark: 'X' }],
      }),
      actor,
    );
    expect(await summary()).toMatchObject({ coverage: 'incomplete', denominator: null });
    const swapped = {
      records,
      expectedRevision: 1,
      coverage: [
        { recordKey: 'r1', date: '2026-01-06', slots: full, complete: true },
        { recordKey: 'r2', date: '2026-01-05', slots: full, complete: true },
      ],
      marks: [{ recordKey: 'r2', date: '2026-01-05', slot: 1, mark: 'X' as const }],
    };
    await service.execute(
      collection({ ...swapped, sourceVersion: `sha256:${'b'.repeat(64)}`, observedAt: '2026-01-11T12:00:00Z' }),
      actor,
    );
    expect(await summary()).toMatchObject({
      coverage: 'reliable',
      absences: 1,
      denominator: 12,
      conflicts: 0,
      days: [
        { date: '2026-01-05', slots: full, complete: true },
        { date: '2026-01-06', slots: full, complete: true },
      ],
    });
    const latest = async () =>
      (
        await pg.query<{ record_key: string; date: string; slots_json: number[]; complete: boolean }>(
          `SELECT DISTINCT ON(c.record_key,c.date) c.record_key,c.date::text,c.slots_json,c.complete FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id ORDER BY c.record_key,c.date,b.received_at DESC,b.id DESC`,
        )
      ).rows;
    expect(await latest()).toEqual([
      { record_key: 'r1', date: '2026-01-05', slots_json: [], complete: true },
      { record_key: 'r1', date: '2026-01-06', slots_json: full, complete: true },
      { record_key: 'r2', date: '2026-01-05', slots_json: full, complete: true },
      { record_key: 'r2', date: '2026-01-06', slots_json: [], complete: true },
    ]);
    // A tombstone is stored once: the next unchanged capture adds no coverage rows.
    const counts = await database.transaction((tx) => frequencyYearCountsV2(tx, 2026));
    await service.execute(
      collection({
        ...swapped,
        expectedRevision: 2,
        sourceVersion: `sha256:${'c'.repeat(64)}`,
        observedAt: '2026-01-12T12:00:00Z',
      }),
      actor,
    );
    expect((await database.transaction((tx) => frequencyYearCountsV2(tx, 2026))).coverage_v2).toBe(
      counts.coverage_v2,
    );
    expect((await status()).conflicts).toEqual([]);
  });
  it('a record left out of a collection keeps its days without tombstones', async () => {
    await service.execute(
      collection({
        records: [
          { recordKey: 'r1', originalName: 'ALUNA SINTETICA UM', originalClass: '6A' },
          { recordKey: 'r2', originalName: 'ALUNO SINTETICO DOIS', originalClass: '6A' },
        ],
        coverage: [
          { recordKey: 'r1', date: '2026-01-05', slots: [1, 2, 3, 4, 5, 6], complete: true },
          { recordKey: 'r2', date: '2026-01-05', slots: [1], complete: false },
        ],
      }),
      actor,
    );
    await service.execute(
      collection({
        expectedRevision: 1,
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        observedAt: '2026-01-11T12:00:00Z',
        rosterComplete: false,
        records: [{ recordKey: 'r2', originalName: 'ALUNO SINTETICO DOIS', originalClass: '6A' }],
        coverage: [{ recordKey: 'r2', date: '2026-01-05', slots: [1], complete: false }],
        marks: [],
      }),
      actor,
    );
    expect(await summary()).toMatchObject({ coverage: 'reliable', denominator: 6, absences: 1 });
    const empty = await pg.query(
      "SELECT 1 FROM attendance.coverage_v2 WHERE slots_json='[]'::jsonb",
    );
    expect(empty.rows).toEqual([]);
  });
  it('another enrollment for the same UID preserves old provenance without silent reassociation', async () => {
    await service.execute(collection(), actor);
    await pg.exec(`INSERT INTO gradebook.student_source_record_v1(id,academic_year) VALUES('50000000-0000-4000-8000-000000000003',2026);
      INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,report_class_id,name_key,birth_date,enrolled_at) VALUES('60000000-0000-4000-8000-000000000003',2026,'50000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000001','ALUNA SINTETICA UM','2014-01-01','2026-01-07');
      INSERT INTO gradebook.student_source_link_v1(source_id,academic_year,student_uid) VALUES('50000000-0000-4000-8000-000000000003',2026,'${uid}');`);
    expect((await summary()).marks).toHaveLength(1);
    await service.execute(
      collection({
        expectedRevision: 1,
        sourceVersion: `sha256:${'b'.repeat(64)}`,
        observedAt: '2026-01-11T12:00:00Z',
      }),
      actor,
    );
    expect((await summary()).marks).toHaveLength(1);
    expect((await database.transaction((tx) => frequencyYearCountsV2(tx, 2026))).batch_v2).toBe(2);
  });
  it('private schema denies public/Portal direct access and immutable evidence cannot update', async () => {
    await service.execute(collection(), actor);
    for (const role of ['anon', 'authenticated', 'student_portal_app'])
      await expect(
        pg.transaction(async (tx) => {
          await tx.query(`SET LOCAL ROLE ${role}`);
          return tx.query('SELECT * FROM attendance.source_mark_v2');
        }),
      ).rejects.toBeDefined();
    await expect(
      database.executeNative("UPDATE attendance.source_mark_v2 SET mark='J'", []),
    ).rejects.toBeDefined();
  });
});
