import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../../functions/api/gradebook/import-persistence';
import * as contract from '../../../shared/gradebook-contracts/imports/import-commit-diagnostics-v1';
import * as observations from '../../../server/gradebook/persistence/postgres/import-performance-observer-v1';
import type { RuntimeEnv } from '../../../server/env';
import { testEnv } from '../../fixtures';
import type { GradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  execute: vi.fn(),
  close: vi.fn(),
  database: null as unknown,
}));
vi.mock('../../../server/auth/session', async (original) => ({
  ...(await original<typeof import('../../../server/auth/session')>()),
  requireAuth: mocks.auth,
}));
vi.mock('../../../server/gradebook/persistence/postgres/official-gradebook-database-v1', () => ({
  withOfficialGradebookDatabaseV1: async (
    env: RuntimeEnv,
    run: (env: RuntimeEnv) => Promise<Response>,
  ) => {
    try {
      return await run({ ...env, GRADEBOOK_DATABASE: mocks.database });
    } finally {
      await mocks.close();
    }
  },
}));
vi.mock('../../../server/gradebook/application/import/import-relational-service-v11', () => ({
  createGradebookRelationalImportServiceV11: (database: unknown, _observer: unknown, actorId: string) => ({
    execute: (request: unknown) => mocks.execute(database, request, actorId),
  }),
}));

const body = {
  transportVersion: 9,
  operation: 'persist-relacao',
  ano: 2026,
  manifest: {
    fileName: 'PRIVATE-SYNTHETIC-FILE.xlsx',
    sha256: 'a'.repeat(64),
    parserVersion: 'synthetic',
  },
  turmas: [
    {
      codigo: 'SYN-A',
      nome: 'PRIVATE-SYNTHETIC-CLASS',
      etapa: 6,
      turno: 'Matutino',
      alunos: [[1, 'PRIVATE-SYNTHETIC-STUDENT', 0]],
    },
  ],
};
const summary = {
  assessmentDefinitions: { total: 0, resolved: 0, blocked: 0 },
  assessmentComponents: { unchanged: 0, new: 0, changed: 0, blocked: 0 },
  academicRecords: { unchanged: 0, new: 0, changed: 0, missingFromNewSource: 0, blocked: 0 },
  plannedWrites: {
    logicalSources: 0,
    sourceFileVersions: 0,
    importBatchVersions: 0,
    assessmentComponentVersions: 0,
    academicRecordVersions: 1,
    logicalSourceRecordAssociationVersions: 0,
    total: 1,
  },
  committedWrites: {
    logicalSources: 0,
    sourceFileVersions: 0,
    importBatchVersions: 0,
    assessmentComponentVersions: 0,
    academicRecordVersions: 1,
    logicalSourceRecordAssociationVersions: 0,
    total: 1,
  },
};
const applied = { transportVersion: 9, state: 'applied', summary };
let physical: ReturnType<typeof vi.fn>;
let database: GradebookPostgresDatabaseV1;
function context(origin = testEnv.OFFICIAL_ORIGIN) {
  return {
    env: testEnv,
    request: new Request(testEnv.OFFICIAL_ORIGIN + '/api/gradebook/import-persistence', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    waitUntil: vi.fn(),
  } as unknown as Parameters<typeof onRequest>[0];
}
function header(response: Response) {
  return contract.parseImportCommitDiagnosticsHeaderV1(
    response.headers.get(contract.IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1),
  );
}
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.auth.mockReset().mockResolvedValue({
    oid: '11111111-1111-4111-8111-111111111111',
    name: 'Synthetic',
    roles: ['ADMINISTRADOR'],
    exp: 4102444800,
  });
  mocks.close.mockReset().mockResolvedValue(undefined);
  physical = vi.fn(async () => ({ rows: [{ private: 'PRIVATE-DATABASE-RESULT' }], changes: 1 }));
  database = {
    query: vi.fn(async () => []),
    executeNative: physical,
    transaction: async (run) => run(database),
    lastFailure: () => null,
    close: mocks.close,
  } as GradebookPostgresDatabaseV1;
  mocks.database = database;
  mocks.execute.mockReset().mockImplementation(async (wrapped: GradebookPostgresDatabaseV1) => {
    await wrapped.transaction(async (tx) => {
      await tx.executeNative('UPDATE gradebook.professor SET nome=$1 WHERE id=$2', [
        'PRIVATE-TEACHER',
        999,
      ]);
    });
    return applied;
  });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('optional diagnostics after the official wrapper close boundary', () => {
  it('binds a private movement preview to the authenticated actor without reporting a commit', async () => {
    const review = { transportVersion: 9, state: 'review-required', reason: 'Confira os pares.', movementReview: {
      digest: 'd'.repeat(64), groups: [{ origins: [{ classCode: '6A', number: 1, name: 'ORIGEM SINTETICA' }],
        destinations: [{ classCode: '6B', number: 2, name: 'DESTINO SINTETICO' }] }],
    } };
    mocks.execute.mockResolvedValue(review);
    const result = await onRequest(context());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(review);
    expect(result.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate, private');
    expect(mocks.execute.mock.calls[0]![2]).toBe((await mocks.auth.mock.results[0]!.value).oid);
    expect(physical).not.toHaveBeenCalled();
    expect(header(result)?.confirmed ?? null).toBeNull();
  });
  it('adds only the optional header after commit/close; academic body, status, guards and physical calls stay intact', async () => {
    const result = await onRequest(context());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(applied);
    expect(result.headers.get('Cache-Control')).toBe(
      'no-store, no-cache, must-revalidate, private',
    );
    expect(header(result)).toMatchObject({
      scope: 'direct-import-statements',
      coverage: 'complete',
      transaction: 'committed',
      attempted: { professor: { update: 1 } },
      confirmed: { professor: { update: 1 } },
      excludedEffects: 'sql-functions-triggers-portal',
    });
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(physical).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    const diagnostic = result.headers.get(contract.IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1)!;
    expect(diagnostic.length).toBeLessThanOrEqual(2_048);
    expect(diagnostic + JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(
      /PRIVATE|a{64}|SET nome|WHERE id/u,
    );
    const logged = vi
      .mocked(console.info)
      .mock.calls.map(([raw]) => JSON.parse(String(raw)) as unknown);
    expect(JSON.stringify(logged)).not.toMatch(/"(?:studentId|aluno_id|parameters|sql|nome)"\s*:/u);
  });
  it('withholds confirmation if close fails after a known commit, preserving the existing error response and close attempt', async () => {
    mocks.close.mockRejectedValue(new Error('PRIVATE-CLOSE-FAILURE'));
    const result = await onRequest(context());
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ transportVersion: 9, state: 'unavailable' });
    expect(header(result)).toMatchObject({
      transaction: 'committed',
      attempted: { professor: { update: 1 } },
      confirmed: null,
    });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
  });
  it('keeps rollback attempts visible but never confirmed, without changing a refusal or its HTTP status', async () => {
    const refused = { transportVersion: 9, state: 'blocked', reason: 'synthetic' };
    mocks.execute.mockImplementation(async (wrapped: GradebookPostgresDatabaseV1) => {
      try {
        await wrapped.transaction(async (tx) => {
          await tx.executeNative('UPDATE gradebook.nota SET valor=$1 WHERE aluno_id=$2', [99, 999]);
          throw new Error('PRIVATE-ROLLBACK');
        });
      } catch {
        return refused;
      }
    });
    const result = await onRequest(context());
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual(refused);
    expect(header(result)).toMatchObject({
      transaction: 'rejected',
      attempted: { nota: { update: 1 } },
      confirmed: null,
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('publishes zero only for measured stable no-changes after a complete transaction', async () => {
    const source = {
      transportVersion: 9,
      state: 'no-changes',
      summary: {
        ...summary,
        committedWrites: { ...summary.committedWrites, academicRecordVersions: 0, total: 0 },
      },
    };
    mocks.execute.mockImplementation(async (wrapped: GradebookPostgresDatabaseV1) => {
      await wrapped.transaction((tx) => tx.query('SELECT id FROM gradebook.professor', []));
      return source;
    });
    const result = await onRequest(context());
    expect(await result.json()).toEqual(source);
    expect(header(result)?.confirmed).toEqual(contract.emptyImportCommitAffectedRowsV1());
    expect(physical).not.toHaveBeenCalled();
  });
  it('isolates a diagnostic serialization failure from the already committed academic response', async () => {
    vi.spyOn(contract, 'serializeImportCommitDiagnosticsHeaderV1').mockImplementation(() => {
      throw new Error('PRIVATE-DIAGNOSTIC-ERROR');
    });
    const result = await onRequest(context());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(applied);
    expect(result.headers.get(contract.IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1)).toBeNull();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('keeps the existing origin rejection and does not emit a diagnostic or execute persistence', async () => {
    const result = await onRequest(context('https://untrusted.example'));
    expect(result.status).toBe(403);
    expect(result.headers.get(contract.IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1)).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(physical).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('does not change an academic confirmation when the diagnostic builder or logger throws', async () => {
    const create = observations.createImportPerformanceObserverV1;
    vi.spyOn(observations, 'createImportPerformanceObserverV1').mockImplementation(() => ({
      ...create(),
      commitDiagnostics() {
        throw new Error('PRIVATE-OBSERVER-FAILURE');
      },
    }));
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error('PRIVATE-LOGGER-FAILURE');
    });
    const result = await onRequest(context());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(applied);
    expect(result.headers.get(contract.IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1)).toBeNull();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
