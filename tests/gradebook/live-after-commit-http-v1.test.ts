// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/api/gradebook/import-persistence';
import { createYearResetRequestHandlerV1 } from '../../server/gradebook/http/year-reset-routes-v1';
import { testEnv } from '../fixtures';
import type { RuntimeEnv } from '../../server/env';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), auth: vi.fn() }));
vi.mock('../../server/auth/session', async (original) => ({
  ...(await original<typeof import('../../server/auth/session')>()),
  requireAuth: mocks.auth,
}));
vi.mock('../../server/gradebook/persistence/postgres/official-gradebook-database-v1', () => ({
  withOfficialGradebookDatabaseV1: async (env: RuntimeEnv, run: (env: RuntimeEnv) => unknown) =>
    run({ ...env, GRADEBOOK_DATABASE: {} }),
}));
vi.mock('../../server/gradebook/application/import/import-service', () => ({
  createGradebookImportService: () => ({ execute: mocks.execute }),
}));
vi.mock(
  '../../shared/gradebook-contracts/imports/import-persistence-transport-v9',
  async (original) => ({
    ...(await original<
      typeof import('../../shared/gradebook-contracts/imports/import-persistence-transport-v9')
    >()),
    inspectGradebookImportPersistenceRequestV9: () => 'ready',
  }),
);
vi.mock('../../server/gradebook/application/settings/year-reset-v1', () => ({
  createYearResetServiceV1: () => ({ execute: mocks.execute }),
}));
const session = {
  oid: '11111111-1111-4111-8111-111111111111',
  name: 'Synthetic',
  roles: ['ADMINISTRADOR'],
  exp: 4102444800,
};
const request = (path: string, body: unknown) =>
  new Request(testEnv.OFFICIAL_ORIGIN + path, {
    method: 'POST',
    headers: { Origin: testEnv.OFFICIAL_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  mocks.execute.mockReset();
  mocks.auth.mockReset().mockResolvedValue(session);
});

describe('post-commit notifications at HTTP boundaries', () => {
  it('waits for import commit and does not delay its response on delivery', async () => {
    let commit!: (value: unknown) => void;
    mocks.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          commit = resolve;
        }),
    );
    const drainLive = vi.fn().mockResolvedValue(true),
      pending: Promise<unknown>[] = [];
    const result = onRequest({
      env: { ...testEnv, PORTAL_SERVICE: { drainLive } },
      request: request('/api/gradebook/import-persistence', {}),
      waitUntil: (work: Promise<unknown>) => pending.push(work),
    } as unknown as Parameters<typeof onRequest>[0]);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(drainLive).not.toHaveBeenCalled();
    commit({ transportVersion: 9, state: 'applied' });
    expect((await result).status).toBe(200);
    await Promise.all(pending);
    expect(drainLive).toHaveBeenCalledOnce();
  });
  it.each(['no-changes', 'conflict', 'blocked', 'unavailable'])(
    'does not notify an import with %s',
    async (state) => {
      mocks.execute.mockResolvedValue({ transportVersion: 9, state });
      const drainLive = vi.fn(),
        waitUntil = vi.fn();
      await onRequest({
        env: { ...testEnv, PORTAL_SERVICE: { drainLive } },
        request: request('/api/gradebook/import-persistence', {}),
        waitUntil,
      } as unknown as Parameters<typeof onRequest>[0]);
      expect(waitUntil).not.toHaveBeenCalled();
      expect(drainLive).not.toHaveBeenCalled();
    },
  );
  it.each(['preview', 'execute'])('notifies reset %s only after execution', async (operation) => {
    mocks.execute.mockResolvedValue({
      contractVersion: 1,
      state: 'ready',
      operation,
      year: 2025,
      deletedRows: 0,
    });
    const afterCommit = vi.fn();
    const response = await createYearResetRequestHandlerV1()(
      request('/api/gradebook/year-reset', { contractVersion: 1, operation, year: 2025 }),
      {
        ...testEnv,
        GRADEBOOK_STORAGE_PROVIDER: 'postgres',
        GRADEBOOK_PRODUCTION_ENABLED: 'true',
        GRADEBOOK_DATABASE: {},
      } as RuntimeEnv,
      afterCommit,
    );
    expect(response?.status).toBe(200);
    expect(afterCommit).toHaveBeenCalledTimes(operation === 'execute' ? 1 : 0);
  });
});
