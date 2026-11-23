// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { onRequest as importDiagnosticsOnRequest } from '../../../functions/api/gradebook/import-diagnostics';
import type { RuntimeEnv } from '../../../server/env';
import { createRelationalCouncilV3 } from '../../../server/gradebook/application/council/relational-council-v3';
import { replaceGradebookImportDiagnosticsSnapshotV1 } from '../../../server/gradebook/application/import/import-diagnostics-snapshot-v1';
import { createPerformanceTermComparisonV4 } from '../../../server/gradebook/application/read-models/performance/performance-term-comparison-v4';
import {
  createGradebookPostgresDatabaseV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresScalarV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { assertDisposableRecoveryTargetV2 } from '../../../server/gradebook/recovery/logical-backup-recovery-v2';
import type {
  RelationalCouncilRequestV3,
  RelationalCouncilResponseV3,
} from '../../../shared/gradebook-contracts/council/relational-council-v3';
import type {
  GradebookImportDiagnosticsAuditListResponseV1,
  GradebookImportDiagnosticsAuditRequestV1,
} from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';

// Only HTTP environment/session boundaries are synthetic; the current GET and SQL run unchanged.
vi.mock('../../../server/env', () => ({ validateEnv: (env: unknown) => env }));
vi.mock('../../../server/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/auth/session')>()),
  requireAuth: async () => ({ oid: '11111111-1111-4111-8111-111111111111' }),
}));
vi.mock('../../../server/gradebook/authorization-v1', () => ({
  authorizeGradebookRuntimeV1: () => ({}),
}));
vi.mock('../../../server/gradebook/persistence/postgres/official-gradebook-database-v1', () => ({
  withOfficialGradebookDatabaseV1: async (
    env: RuntimeEnv,
    operation: (env: RuntimeEnv) => Promise<Response | null>,
  ) => operation(env),
}));

const CONNECTION_STRING = process.env.GRADEBOOK_RECOVERY_DATABASE_URL ?? '';
const integration = CONNECTION_STRING.length > 0 ? describe : describe.skip;
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const DIAGNOSTIC_FILE = 'recovery-rehearsal-662.xlsx';
const DIAGNOSTIC_HASH_A = 'a'.repeat(64);
const DIAGNOSTIC_HASH_B = 'b'.repeat(64);
const COUNCIL_KEY_PREFIX = 'recovery662:contention';
const ALL_STATUSES = [null, 1, 2, 3, 4, 5, 7] as const;

type Row = Record<string, unknown>;

let databaseA: GradebookPostgresDatabaseV1;
let databaseB: GradebookPostgresDatabaseV1;

async function rows(
  database: GradebookPostgresDatabaseV1,
  query: string,
  values: readonly GradebookPostgresScalarV1[] = [],
): Promise<readonly Row[]> {
  return database.query<Row>(query, values);
}

function diagnosticRequest(
  hash: string,
  marker: 'a' | 'b',
): GradebookImportDiagnosticsAuditRequestV1 {
  return {
    version: 1,
    academicYear: 2026,
    fileName: DIAGNOSTIC_FILE,
    sha256: hash,
    diagnostics: [1, 2].map((index) => ({
      key: `${marker}-${String(index)}`,
      severity: 'blocking-error' as const,
      code: 'invalid-text' as const,
      message: 'Diagnóstico sintético acionável do ensaio local.',
      recommendedAction: 'Nenhuma ação; massa descartável de contenção.',
      fieldKind: 'file' as const,
    })),
  };
}

async function removeSyntheticDiagnostics(): Promise<void> {
  await databaseA.executeNative(
    `DELETE FROM gradebook.importacao_diagnostico
      WHERE arquivo=$1 OR hash IN (decode($2,'hex'),decode($3,'hex'))`,
    [DIAGNOSTIC_FILE, DIAGNOSTIC_HASH_A, DIAGNOSTIC_HASH_B],
  );
}

async function removeSyntheticCouncil(classId: number): Promise<void> {
  await databaseA.transaction(async (transaction) => {
    await transaction.executeNative(
      'DELETE FROM gradebook.conselho_votacao WHERE ano=$1 AND turma_id=$2',
      [2026, classId],
    );
    await transaction.executeNative(
      'DELETE FROM gradebook.conselho_idempotencia WHERE chave LIKE $1',
      [`${COUNCIL_KEY_PREFIX}:%`],
    );
    // The synthetic decisions carry the prefix as their justification.
    await transaction.executeNative(
      'DELETE FROM gradebook.conselho_decisao WHERE justificativa=$1',
      [COUNCIL_KEY_PREFIX],
    );
    await transaction.executeNative(
      'DELETE FROM gradebook.conselho_sessao WHERE ano=$1 AND turma_id=$2',
      [2026, classId],
    );
  });
}

async function readCurrentDiagnostics(limit: number) {
  const response = await importDiagnosticsOnRequest({
    request: new Request(
      `https://school.test/api/gradebook/import-diagnostics?ano=2026&limit=${String(limit)}`,
    ),
    env: { OFFICIAL_ORIGIN: 'https://school.test', GRADEBOOK_DATABASE: databaseA },
  } as unknown as Parameters<typeof importDiagnosticsOnRequest>[0]);
  expect(response.status).toBe(200);
  const audit = (await response.json()) as GradebookImportDiagnosticsAuditListResponseV1;
  expect(audit).toMatchObject({ version: 1, state: 'ready' });
  if (audit.state !== 'ready') throw new Error('recovery-current-audit-not-ready');
  return audit;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

integration('relational recovery and contention V2 on disposable PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRecoveryTargetV2(CONNECTION_STRING);
    databaseA = await createGradebookPostgresDatabaseV1(CONNECTION_STRING, {
      maximumConnections: 2,
      statementTimeoutMilliseconds: 120_000,
      lockTimeoutMilliseconds: 30_000,
    });
    databaseB = await createGradebookPostgresDatabaseV1(CONNECTION_STRING, {
      maximumConnections: 2,
      statementTimeoutMilliseconds: 120_000,
      lockTimeoutMilliseconds: 30_000,
    });
  }, 30_000);

  afterAll(async () => {
    await removeSyntheticDiagnostics().catch(() => undefined);
    await Promise.all([databaseA?.close(), databaseB?.close()]);
  });

  it('serves recovered classes, T2 versus T1, audit and Council', async () => {
    const [firstClass] = await rows(
      databaseA,
      'SELECT id FROM gradebook.turma WHERE ano=$1 ORDER BY id LIMIT 1',
      [2026],
    );
    expect(firstClass).toBeDefined();
    const classId = Number(firstClass!.id);

    const performance = await createPerformanceTermComparisonV4(databaseA).execute({
      transportVersion: 4,
      operation: 'term-comparison',
      year: 2026,
      classId,
      period: 2,
      mode: 'regular',
      statuses: [...ALL_STATUSES],
      lens: 'result',
      offerId: null,
      referencePeriod: 1,
    });
    expect(performance.state).toBe('ready');

    // Exercise the current Audit/Import GET on the restored database, including an empty backup.
    const recoveredDiagnostics = await rows(
      databaseA,
      'SELECT id FROM gradebook.importacao_diagnostico WHERE ano=$1 ORDER BY ultimo_em DESC,id DESC LIMIT 6',
      [2026],
    );
    const audit = await readCurrentDiagnostics(5);
    expect(audit.items.map((item) => item.id)).toEqual(
      recoveredDiagnostics.slice(0, 5).map((row) => Number(row.id)),
    );
    expect(audit.nextOffset).toBe(recoveredDiagnostics.length > 5 ? 5 : null);
    expect(audit.items.every((item) => item.academicYear === 2026)).toBe(true);

    const council = await createRelationalCouncilV3(databaseA, ACTOR_ID).execute({
      contractVersion: 3,
      operation: 'workspace',
      year: 2026,
      classId,
    });
    expect(council.state).toBe('ready');
  }, 120_000);

  it('blocks a competing diagnostic replacement and keeps only one complete last commit', async () => {
    await removeSyntheticDiagnostics();
    const acquired = deferred();
    const release = deferred();
    const sourceKey = `gradebook-import-diagnostics-source:${JSON.stringify([2026, DIAGNOSTIC_FILE])}`;
    const blocker = databaseA.transaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 629)) AS locked', [
        sourceKey,
      ]);
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;

    const waitingWrite = replaceGradebookImportDiagnosticsSnapshotV1(
      databaseB,
      diagnosticRequest(DIAGNOSTIC_HASH_A, 'a'),
    );
    const settlement = await Promise.race([
      waitingWrite.then(
        () => 'settled',
        () => 'failed',
      ),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ]);
    expect(settlement).toBe('waiting');
    release.resolve();
    await blocker;
    await expect(waitingWrite).resolves.toBeGreaterThan(0);

    await Promise.all([
      replaceGradebookImportDiagnosticsSnapshotV1(
        databaseA,
        diagnosticRequest(DIAGNOSTIC_HASH_A, 'a'),
      ),
      replaceGradebookImportDiagnosticsSnapshotV1(
        databaseB,
        diagnosticRequest(DIAGNOSTIC_HASH_B, 'b'),
      ),
    ]);
    const finalRows = await rows(
      databaseA,
      `SELECT chave,encode(hash,'hex') AS hash FROM gradebook.importacao_diagnostico
       WHERE arquivo=$1 ORDER BY chave`,
      [DIAGNOSTIC_FILE],
    );
    expect(finalRows).toHaveLength(2);
    const markers = new Set(finalRows.map((row) => String(row.chave).slice(0, 1)));
    const hashes = new Set(finalRows.map((row) => row.hash));
    expect(markers.size).toBe(1);
    expect(hashes.size).toBe(1);

    // Reuse this test's synthetic committed observation to prove a nonempty current read.
    const audit = await readCurrentDiagnostics(200);
    expect(
      audit.items
        .filter((item) => item.fileName === DIAGNOSTIC_FILE)
        .map((item) => item.key)
        .sort(),
    ).toEqual(finalRows.map((row) => String(row.chave)));

    const beforeRollback = finalRows.map((row) => `${String(row.chave)}:${String(row.hash)}`);
    await expect(
      databaseA.transaction(async (transaction) => {
        await transaction.executeNative(
          'DELETE FROM gradebook.importacao_diagnostico WHERE arquivo=$1',
          [DIAGNOSTIC_FILE],
        );
        throw new Error('synthetic-recovery-rollback');
      }),
    ).rejects.toThrow('synthetic-recovery-rollback');
    const afterRollback = await rows(
      databaseA,
      `SELECT chave,encode(hash,'hex') AS hash FROM gradebook.importacao_diagnostico
       WHERE arquivo=$1 ORDER BY chave`,
      [DIAGNOSTIC_FILE],
    );
    expect(afterRollback.map((row) => `${String(row.chave)}:${String(row.hash)}`)).toEqual(
      beforeRollback,
    );
    await removeSyntheticDiagnostics();
  }, 120_000);

  it('serializes stale Council commands with CAS and keeps the winner idempotent', async () => {
    const councilA = createRelationalCouncilV3(databaseA, ACTOR_ID);
    const councilB = createRelationalCouncilV3(databaseB, ACTOR_ID);
    const classes = await councilA.execute({
      contractVersion: 3,
      operation: 'classes',
      year: 2026,
      offset: 0,
      limit: 100,
    });
    if (classes.state !== 'ready' || classes.operation !== 'classes') {
      throw new Error('recovery-council-classes-not-ready');
    }

    // Closing needs a class with no eligible student pending. Nothing records a decision for now,
    // so the class with the fewest pending gets synthetic ones, removed with the session below.
    let candidate: { readonly classId: number; readonly pending: readonly number[] } | null = null;
    for (const classGroup of classes.classes) {
      const workspace = await councilA.execute({
        contractVersion: 3,
        operation: 'workspace',
        year: 2026,
        classId: classGroup.id,
      });
      if (workspace.state !== 'ready' || workspace.operation === 'classes') continue;
      const pending = workspace.workspace.students
        .filter((student) => student.eligibility.eligible && student.decision === null)
        .map((student) => student.id);
      if (candidate === null || pending.length < candidate.pending.length)
        candidate = { classId: classGroup.id, pending };
      if (pending.length === 0) break;
    }
    expect(candidate).not.toBeNull();
    if (candidate === null) throw new Error('recovery-council-candidate-missing');
    await removeSyntheticCouncil(candidate.classId);
    await databaseA.transaction(async (transaction) => {
      for (const studentId of candidate.pending)
        await transaction.executeNative(
          'INSERT INTO gradebook.conselho_decisao (aluno_id,decisao,justificativa,registrado_por) VALUES ($1, 1, $2, $3)',
          [studentId, COUNCIL_KEY_PREFIX, ACTOR_ID],
        );
    });

    const opened = await councilA.execute({
      contractVersion: 3,
      operation: 'open',
      year: 2026,
      classId: candidate.classId,
      expectedVersion: 0,
      idempotencyKey: `${COUNCIL_KEY_PREFIX}:open`,
    });
    expect(opened.state).toBe('ready');
    if (opened.state !== 'ready' || opened.operation === 'classes') {
      throw new Error('recovery-council-open-not-ready');
    }

    const close = (key: string): RelationalCouncilRequestV3 => ({
      contractVersion: 3,
      operation: 'close',
      year: 2026,
      classId: candidate.classId,
      expectedVersion: 1,
      idempotencyKey: `${COUNCIL_KEY_PREFIX}:${key}`,
      reviewReference: opened.workspace.session.reviewReference,
    });
    const commands = [close('close-a'), close('close-b')] as const;

    const settled = await Promise.allSettled([
      councilA.execute(commands[0]),
      councilB.execute(commands[1]),
    ]);
    expect(settled.every((item) => item.status === 'fulfilled')).toBe(true);
    const responses = settled
      .filter(
        (item): item is PromiseFulfilledResult<RelationalCouncilResponseV3> =>
          item.status === 'fulfilled',
      )
      .map((item) => item.value);
    expect(responses.map((response) => response.state).sort()).toEqual([
      'ready',
      'version-conflict',
    ]);
    const winnerIndex = responses.findIndex((response) => response.state === 'ready');
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const retry = await councilB.execute(commands[winnerIndex]);
    expect(retry.state).toBe('ready');
    if (retry.state !== 'ready' || retry.operation === 'classes') {
      throw new Error('recovery-council-idempotent-retry-failed');
    }
    expect(retry.workspace.session.version).toBe(2);
    await removeSyntheticCouncil(candidate.classId);
  }, 120_000);
});
