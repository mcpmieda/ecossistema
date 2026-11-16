// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import {
  portalHistoryRpcV1,
  portalHistoryScheduledV1,
} from '../../server/student-portal/composition/health-history-v1';
import { portalDatabaseV1 } from '../../server/student-portal/composition/database-v1';
import {
  portalKeysV1,
  type PortalCompositionEnvV1,
} from '../../server/student-portal/composition/config-v1';
import {
  cleanupPortalHistoryV1,
  readPortalHistoryV1,
  recordPortalHistoryV1,
} from '../../server/student-portal/observability/health-history-v1';
import { historyFixtureV1, HISTORY_NOW_V1 } from './history-fixtures-v1';
vi.mock('../../server/student-portal/composition/database-v1', () => ({
  portalDatabaseV1: vi.fn(),
}));
vi.mock('../../server/student-portal/composition/config-v1', () => ({ portalKeysV1: vi.fn() }));
vi.mock('../../server/student-portal/observability/health-history-v1', () => ({
  cleanupPortalHistoryV1: vi.fn(),
  readPortalHistoryV1: vi.fn(),
  recordPortalHistoryV1: vi.fn(),
}));
const tenant = '22222222-2222-4222-8222-222222222222';
const environment = () =>
  ({
    PORTAL_ENVIRONMENT: 'production',
    PORTAL_ADMIN_TENANT_ID: tenant,
    PORTAL_SERVING_ENABLED: 'true',
    PORTAL_DB: {},
  }) as unknown as PortalCompositionEnvV1;
const context = () => ({
  actorId: '11111111-1111-4111-8111-111111111111',
  tenantId: tenant,
  requestId: '33333333-3333-4333-8333-333333333333',
  authenticatedAt: new Date().toISOString(),
  capability: 'platform.settings.read',
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(portalDatabaseV1).mockImplementation(async (_env, _op, run) =>
    run({} as Parameters<Parameters<typeof portalDatabaseV1>[2]>[0]),
  );
  vi.mocked(readPortalHistoryV1).mockResolvedValue(historyFixtureV1());
});
it.each([
  { tenantId: '44444444-4444-4444-8444-444444444444' },
  { capability: 'student.read' },
  { authenticatedAt: '2020-01-01T00:00:00.000Z' },
  { authenticatedAt: '2099-01-01T00:00:00.000Z' },
  { name: 'extra' },
])('checks private authority before SQL', async (overrides) => {
  await expect(
    portalHistoryRpcV1(environment(), { ...context(), ...overrides }, null),
  ).rejects.toThrow('portal-monitor-forbidden');
  expect(portalDatabaseV1).not.toHaveBeenCalled();
});
it('reads only the authorized history and sanitizes database failure', async () => {
  expect(await portalHistoryRpcV1(environment(), context(), null)).toEqual(historyFixtureV1());
  expect(readPortalHistoryV1).toHaveBeenCalledWith({}, null);
  vi.mocked(portalDatabaseV1).mockRejectedValue(new Error('synthetic-private-error'));
  const result = await portalHistoryRpcV1(environment(), context(), null);
  expect(result).toMatchObject({ state: 'unavailable', points: [] });
  expect(JSON.stringify(result)).not.toContain('synthetic-private-error');
});
it('continues retention with serving disabled, and collects only every five scheduled minutes', async () => {
  const env = environment();
  env.PORTAL_SERVING_ENABLED = 'false';
  for (let minute = 0; minute < 5; minute++)
    await portalHistoryScheduledV1(env, HISTORY_NOW_V1 - 60_000 + minute * 60_000);
  expect(cleanupPortalHistoryV1).toHaveBeenCalledTimes(1);
  expect(recordPortalHistoryV1).toHaveBeenCalledTimes(1);
  expect(recordPortalHistoryV1).toHaveBeenCalledWith(
    {},
    { servingEnabled: false, credentialsConfigured: true },
  );
  expect(vi.mocked(cleanupPortalHistoryV1).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(recordPortalHistoryV1).mock.invocationCallOrder[0]!,
  );
});
it('does not open a database from preview or invalid schedules', async () => {
  const env = environment();
  env.PORTAL_ENVIRONMENT = 'preview';
  await portalHistoryScheduledV1(env, HISTORY_NOW_V1 - 60_000);
  await portalHistoryScheduledV1(environment(), NaN);
  expect(portalDatabaseV1).not.toHaveBeenCalled();
});
it('records absent credential configuration without copying secrets and leaves failed collection as a gap', async () => {
  vi.mocked(portalKeysV1).mockImplementation(() => {
    throw new Error('synthetic-secret');
  });
  vi.mocked(recordPortalHistoryV1).mockRejectedValue(new Error('synthetic-sql-error'));
  await portalHistoryScheduledV1(environment(), HISTORY_NOW_V1 - 60_000);
  expect(cleanupPortalHistoryV1).toHaveBeenCalledTimes(1);
  expect(recordPortalHistoryV1).toHaveBeenCalledWith(
    {},
    { servingEnabled: true, credentialsConfigured: false },
  );
});
