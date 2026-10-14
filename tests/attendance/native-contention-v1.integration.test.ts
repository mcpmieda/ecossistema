// @vitest-environment node
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAttendanceServiceV1 } from '../../server/attendance/service-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../server/gradebook/persistence/postgres/postgres-database-v1';
import type {
  AttendanceCandidateV1,
  AttendanceCollectionV1,
} from '../../shared/attendance-contracts/attendance-v1';
import {
  attendanceSyntheticSetupSqlV1,
  ATTENDANCE_SYNTHETIC_RESET_SQL_V1,
} from './synthetic-fixture-v1';

const connection = process.env.ATTENDANCE_TEST_POSTGRES_URL ?? '';
const native = connection ? describe : describe.skip;
const scope = { academicYear: 2026, classId: 101 };
const uid = '10000000-0000-4000-8000-000000000001';
const collectorId = '30000000-0000-4000-8000-000000000001';
const nextCollector = '30000000-0000-4000-8000-000000000002';
const admin = { oid: '20000000-0000-4000-8000-000000000001', roles: ['ADMINISTRADOR' as const] };
const otherAdmin = { ...admin, oid: '20000000-0000-4000-8000-000000000002' };
type Client = ReturnType<typeof postgres>;
type Service = ReturnType<typeof createAttendanceServiceV1>;
type Hooks = {
  pid: number;
  sampledLeaseLive?: boolean;
  hold?: { acquired: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  failMarks?: boolean;
};
let owner: Client;
let clientA: Client;
let clientB: Client;
let serviceA: Service;
let serviceB: Service;
let hooksA: Hooks;
let hooksB: Hooks;
let fencingToken: number;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function safeDisposableConnection(): string {
  const target = new URL(connection);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    target.hostname !== '127.0.0.1' ||
    !/^\/attendance_ephemeral_[a-f0-9]{32}$/u.test(target.pathname) ||
    target.username !== 'attendance_ephemeral' ||
    target.password ||
    !target.port ||
    target.search ||
    target.hash ||
    !process.env.ATTENDANCE_TEST_POSTGRES_MARKER ||
    !process.env.ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY
  ) {
    throw new Error('attendance-native-test-target-not-disposable');
  }
  return target.toString();
}

function runtime(client: Client, hooks: Hooks): Service {
  const wrap = (tx: GradebookPostgresQuerySqlV1): GradebookPostgresQuerySqlV1 => ({
    async unsafe(query, parameters = []) {
      if (hooks.failMarks && query.includes('INSERT INTO attendance.mark')) {
        await tx.unsafe('SELECT 1/0'); // Real PostgreSQL error after earlier batch inserts.
      }
      const rows = await tx.unsafe(query, parameters);
      if (query.includes('FROM attendance.scope') && query.includes('FOR UPDATE') && hooks.hold) {
        hooks.sampledLeaseLive = rows[0]?.lease_live === true;
        const held = hooks.hold;
        hooks.hold = undefined;
        held.acquired.resolve();
        await held.release.promise;
      }
      return rows;
    },
  });
  const sql: GradebookPostgresSqlV1 = {
    unsafe: client.unsafe.bind(client) as GradebookPostgresQuerySqlV1['unsafe'],
    begin: (operation) =>
      client.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE gradebook_app');
        const rows = await tx.unsafe('SELECT pg_backend_pid() AS pid');
        hooks.pid = Number(rows[0]!.pid);
        return operation(wrap(tx as unknown as GradebookPostgresQuerySqlV1));
      }) as Promise<Awaited<ReturnType<typeof operation>>>,
  };
  return createAttendanceServiceV1(createGradebookPostgresDatabaseFromSqlV1(sql));
}

function batch(overrides: Partial<AttendanceCollectionV1> = {}): AttendanceCollectionV1 {
  return {
    operation: 'collect',
    scope,
    requestId: crypto.randomUUID(),
    expectedRevision: 1,
    collectorId,
    fencingToken,
    sourceVersion: 'synthetic-native-v1',
    reportIdentity: 'synthetic-native-report',
    reportKind: 'annual-detailed-collective',
    observedAt: '2026-01-10T12:00:00Z',
    rosterComplete: true,
    records: [
      {
        recordKey: 'synthetic-record-a',
        originalName: 'ALUNA SINTÉTICA UM',
        originalClass: '6A',
        identityBasis: 'durable',
      },
    ],
    coverage: [
      {
        recordKey: 'synthetic-record-a',
        date: '2026-01-05',
        slots: [1, 2, 3, 4, 5, 6],
        complete: true,
      },
    ],
    marks: [{ recordKey: 'synthetic-record-a', date: '2026-01-05', slot: 6, mark: 'X' }],
    ...overrides,
  };
}

async function current() {
  return (await serviceA.execute({ operation: 'review', scope }, admin)) as {
    revision: number;
    candidates: AttendanceCandidateV1[];
  };
}
const summary = (service = serviceA) =>
  service.responsibleSummary({ scope, studentUid: uid, month: '2026-01' }, async () => true);

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`attendance-native-timeout-${label}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

function holdA() {
  const held = { acquired: deferred(), release: deferred() };
  hooksA.hold = held;
  return held;
}

async function proveBlocked(blocked: Hooks, holder: Hooks) {
  await waitFor(async () => {
    if (!blocked.pid) return false;
    const rows = await owner.unsafe('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [
      blocked.pid,
      holder.pid,
    ]);
    return rows[0]!.blocked === true;
  }, 'physical-row-lock');
  expect(blocked.pid).not.toBe(holder.pid);
}

async function counts() {
  return (
    await owner.unsafe(`SELECT revision::int,current_batch::text,
    (SELECT count(*)::int FROM attendance.batch) AS batches,
    (SELECT count(*)::int FROM attendance.source_record) AS records,
    (SELECT count(*)::int FROM attendance.coverage) AS coverage,
    (SELECT count(*)::int FROM attendance.mark) AS marks,
    (SELECT count(*)::int FROM attendance.decision) AS decisions,
    (SELECT count(*)::int FROM attendance.receipt) AS receipts
    FROM attendance.scope WHERE academic_year=2026 AND class_id=101`)
  )[0]!;
}

native('attendance on explicitly disposable native PostgreSQL with separate connections', () => {
  beforeAll(async () => {
    const url = safeDisposableConnection();
    const options = {
      max: 1,
      idle_timeout: 0,
      ssl: false,
      onnotice: () => undefined,
      connection: {
        statement_timeout: 10_000,
        lock_timeout: 5_000,
        idle_in_transaction_session_timeout: 10_000,
      },
    } as const;
    owner = postgres(url, options);
    // Read-only attestation BEFORE any fixture DDL/reset; no arbitrary local database is accepted.
    const marker = await owner.unsafe(
      "SELECT marker::text,current_setting('data_directory') AS directory FROM public.attendance_test_sandbox_v1",
    );
    const normalizePath = (value: string) => value.replace(/\\/gu, '/').toLowerCase();
    expect(marker).toHaveLength(1);
    expect(marker[0]!.marker).toBe(process.env.ATTENDANCE_TEST_POSTGRES_MARKER);
    expect(normalizePath(String(marker[0]!.directory))).toBe(
      normalizePath(process.env.ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY!),
    );
    const existing = await owner.unsafe(
      "SELECT to_regnamespace('attendance') AS attendance,to_regnamespace('gradebook') AS gradebook",
    );
    expect(existing[0]).toMatchObject({ attendance: null, gradebook: null });
    for (const sql of attendanceSyntheticSetupSqlV1()) await owner.unsafe(sql);
    clientA = postgres(url, options);
    clientB = postgres(url, options);
  }, 30_000);
  beforeEach(async () => {
    await owner.unsafe(ATTENDANCE_SYNTHETIC_RESET_SQL_V1);
    hooksA = { pid: 0 };
    hooksB = { pid: 0 };
    serviceA = runtime(clientA, hooksA);
    serviceB = runtime(clientB, hooksB);
    await serviceA.execute(
      {
        operation: 'configure',
        scope,
        requestId: crypto.randomUUID(),
        expectedRevision: 0,
        calendar: [{ date: '2026-01-05', eligible: true, slots: [1, 2, 3, 4, 5, 6] }],
        enrollments: [{ studentUid: uid, startsOn: '2026-01-01', endsOn: null }],
      },
      admin,
    );
    const lease = await serviceA.execute(
      {
        operation: 'lease',
        scope,
        requestId: crypto.randomUUID(),
        collectorId,
        durationSeconds: 300,
      },
      admin,
    );
    fencingToken = Number(lease.fencingToken);
  });
  afterAll(async () => {
    await Promise.all([
      clientA?.end({ timeout: 1 }),
      clientB?.end({ timeout: 1 }),
      owner?.end({ timeout: 1 }),
    ]);
  });

  it('serializes simultaneous reviewers; only one expected revision is audited', async () => {
    await serviceA.execute(batch(), admin);
    const evidence = (await current()).candidates[0]!.evidenceFingerprint;
    const command = {
      operation: 'decide',
      scope,
      expectedRevision: 2,
      recordKey: 'synthetic-record-a',
      studentUid: uid,
      evidenceFingerprint: evidence,
      reason: 'DECISÃO SINTÉTICA CONCORRENTE',
    };
    const held = holdA();
    const first = serviceA.execute(
      { ...command, requestId: crypto.randomUUID(), decision: 'different-students' },
      admin,
    );
    await held.acquired.promise;
    const second = serviceB.execute(
      { ...command, requestId: crypto.randomUUID(), decision: 'same-student' },
      otherAdmin,
    );
    const secondResult = expect(second).rejects.toThrow('stale-revision');
    try {
      await proveBlocked(hooksB, hooksA);
    } finally {
      held.release.resolve();
    }
    await first;
    await secondResult;
    expect(await counts()).toMatchObject({ revision: 3, decisions: 1, receipts: 4 });
    await expect(summary()).rejects.toThrow('not-visible');
  });

  it('coalesces simultaneous identical requests after a physical lock wait', async () => {
    const input = batch();
    const held = holdA();
    const first = serviceA.execute(input, admin);
    await held.acquired.promise;
    const second = serviceB.execute(input, admin);
    try {
      await proveBlocked(hooksB, hooksA);
    } finally {
      held.release.resolve();
    }
    expect(await second).toEqual(await first);
    expect(await counts()).toMatchObject({
      revision: 2,
      batches: 1,
      records: 1,
      coverage: 1,
      marks: 1,
      receipts: 3,
    });
  });

  it('fences an old writer waiting behind a takeover of an expired lease', async () => {
    await owner.unsafe(
      "UPDATE attendance.scope SET lease_until=clock_timestamp()-interval '1 second'",
    );
    const held = holdA();
    const takeover = serviceA.execute(
      {
        operation: 'lease',
        scope,
        requestId: crypto.randomUUID(),
        collectorId: nextCollector,
        durationSeconds: 300,
      },
      otherAdmin,
    );
    await held.acquired.promise;
    const oldWriter = serviceB.execute(batch(), admin);
    const oldResult = expect(oldWriter).rejects.toThrow('lease-fenced');
    try {
      await proveBlocked(hooksB, hooksA);
    } finally {
      held.release.resolve();
    }
    const next = await takeover;
    await oldResult;
    expect(Number(next.fencingToken)).toBeGreaterThan(fencingToken);
    expect(await counts()).toMatchObject({ revision: 1, batches: 0, marks: 0 });
    await serviceB.execute(
      batch({ collectorId: nextCollector, fencingToken: Number(next.fencingToken) }),
      otherAdmin,
    );
    expect(await counts()).toMatchObject({ revision: 2, batches: 1 });
  });

  it('rechecks the database clock when a lease expires while a writer waits', async () => {
    await owner.unsafe(
      "UPDATE attendance.scope SET lease_until=clock_timestamp()+interval '300 milliseconds'",
    );
    const held = holdA();
    const reader = serviceA.execute({ operation: 'review', scope }, admin);
    await held.acquired.promise;
    const writer = serviceB.execute(batch(), admin);
    const writerResult = expect(writer).rejects.toThrow('lease-fenced');
    try {
      await proveBlocked(hooksB, hooksA);
      await waitFor(
        async () =>
          (
            await owner.unsafe(
              'SELECT lease_until<=clock_timestamp() AS expired FROM attendance.scope',
            )
          )[0]!.expired === true,
        'lease-expiry',
      );
    } finally {
      held.release.resolve();
    }
    await reader;
    await writerResult;
    expect(await counts()).toMatchObject({ revision: 1, batches: 0, marks: 0, receipts: 2 });
  });

  it('refuses a lease that expires after the writer already sampled it as live', async () => {
    await owner.unsafe(
      "UPDATE attendance.scope SET lease_until=clock_timestamp()+interval '2 seconds'",
    );
    const held = holdA();
    const writer = serviceA.execute(batch(), admin);
    const writerResult = expect(writer).rejects.toThrow('lease-fenced');
    await held.acquired.promise;
    try {
      expect(hooksA.sampledLeaseLive).toBe(true);
      await waitFor(
        async () =>
          (
            await owner.unsafe(
              'SELECT lease_until<=clock_timestamp() AS expired FROM attendance.scope',
            )
          )[0]!.expired === true,
        'live-snapshot-expiry',
      );
    } finally {
      held.release.resolve();
    }
    await writerResult;
    expect(await counts()).toMatchObject({ revision: 1, batches: 0, marks: 0, receipts: 2 });
  });
  it('rolls back all partial-batch writes and receipts on a real mid-transaction SQL error', async () => {
    const original = batch();
    await serviceA.execute(original, admin);
    const before = await counts();
    const partial = batch({
      expectedRevision: 2,
      sourceVersion: 'synthetic-native-partial-v2',
      rosterComplete: false,
      coverage: [
        { recordKey: 'synthetic-record-a', date: '2026-01-05', slots: [1], complete: false },
      ],
      marks: [{ recordKey: 'synthetic-record-a', date: '2026-01-05', slot: 1, mark: 'J' }],
    });
    hooksA.failMarks = true;
    await expect(serviceA.execute(partial, admin)).rejects.toThrow('division by zero');
    hooksA.failMarks = false;
    expect(await counts()).toEqual(before);
    expect((await summary()).summary).toMatchObject({
      absences: 1,
      denominator: 6,
      coverage: 'reliable',
    });
    await serviceB.execute(partial, admin); // Same requestId was not cached by the rolled-back transaction.
    expect(await counts()).toMatchObject({ revision: 3, batches: 2, marks: 2, receipts: 4 });
    // An incomplete roster cannot re-establish automatic identity on this snapshot.
    await expect(summary()).rejects.toThrow('not-visible');
  });

  it('blocks a canonical transfer during a summary and hides the old link on the next read', async () => {
    await serviceA.execute(batch(), admin);
    const held = holdA();
    const reading = summary();
    await held.acquired.promise;
    const writerHooks: Hooks = { pid: 0 };
    const moving = owner.begin(async (tx) => {
      writerHooks.pid = Number((await tx.unsafe('SELECT pg_backend_pid() AS pid'))[0]!.pid);
      await tx.unsafe('UPDATE gradebook.vinculo SET turma_id=102 WHERE aluno_id=1');
    });
    // Monitoring needs a fourth physical connection because the owner is pinned to the writer.
    const monitor = postgres(safeDisposableConnection(), { max: 1, ssl: false });
    try {
      await waitFor(
        async () =>
          writerHooks.pid > 0 &&
          (
            await monitor.unsafe('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [
              writerHooks.pid,
              hooksA.pid,
            ])
          )[0]!.blocked === true,
        'canonical-transfer-lock',
      );
      expect(writerHooks.pid).not.toBe(hooksA.pid);
    } finally {
      held.release.resolve();
      await monitor.end({ timeout: 1 });
    }
    expect((await reading).summary.coverage).toBe('reliable');
    await moving;
    await expect(summary(serviceB)).rejects.toThrow('not-visible');
    expect(await counts()).toMatchObject({ revision: 2, batches: 1, marks: 1 });
  });
});
