// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { portalCapacityRpcV1 } from '../../server/student-portal/composition/capacity-v1';
import { portalDatabaseV1 } from '../../server/student-portal/composition/database-v1';
import { emptyPortalCapacityV1 } from '../../shared/portal-capacity-v1';
import type { PortalCompositionEnvV1 } from '../../server/student-portal/composition/config-v1';
vi.mock('../../server/student-portal/composition/database-v1', () => ({ portalDatabaseV1: vi.fn() }));
const tenant = '10950000-0000-4000-8000-000000000001';
const context = () => ({ actorId: '10950000-0000-4000-8000-000000000002', requestId: crypto.randomUUID(),
  tenantId: tenant, capability: 'platform.settings.read', authenticatedAt: new Date().toISOString() });
const env = () => ({ PORTAL_ENVIRONMENT: 'production', PORTAL_ADMIN_TENANT_ID: tenant,
  PORTAL_DB: { connectionString: 'synthetic-test-binding' }, PORTAL_SERVING_ENABLED: 'false' }) as unknown as PortalCompositionEnvV1;
const sample = () => ({ version: 1, source: 'postgresql', state: 'ok', observedAt: new Date().toISOString(), metrics: {
  databaseBytes: 100, portalConnections: 1, portalActive: 1, portalWaiting: 0, portalConnectionLimit: null,
  serverMaxConnections: 60, serverReservedConnections: 3,
} });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(portalDatabaseV1).mockResolvedValue(sample()); });
it('reads with serving disabled, caches only aggregates and authorizes again on cache hits', async () => {
  const binding = env(); const valid = context();
  expect((await portalCapacityRpcV1(binding, valid)).state).toBe('ok');
  expect((await portalCapacityRpcV1(binding, context())).state).toBe('ok');
  expect(portalDatabaseV1).toHaveBeenCalledTimes(1);
  for (const bad of [{}, { ...valid, tenantId: crypto.randomUUID() }, { ...valid, capability: 'platform.health.read' },
    { ...valid, authenticatedAt: '2000-01-01T00:00:00.000Z' }, { ...valid, authenticatedAt: new Date(Date.now() + 60_000).toISOString() }])
    await expect(portalCapacityRpcV1(binding, bad)).rejects.toThrow('portal-monitor-forbidden');
  expect(portalDatabaseV1).toHaveBeenCalledTimes(1);
  await portalCapacityRpcV1(env(), context()); expect(portalDatabaseV1).toHaveBeenCalledTimes(2);
});
it('checks authority before reporting absent configuration and refuses preview runtime', async () => {
  const binding = env(); delete binding.PORTAL_DB;
  await expect(portalCapacityRpcV1(binding, {})).rejects.toThrow();
  expect((await portalCapacityRpcV1(binding, context())).state).toBe('unconfigured');
  binding.PORTAL_ENVIRONMENT = 'preview';
  await expect(portalCapacityRpcV1(binding, context())).rejects.toThrow();
  expect(portalDatabaseV1).not.toHaveBeenCalled();
});
it('never leaks SQL/driver failures and recovers on a later explicit call', async () => {
  const binding = env(); vi.mocked(portalDatabaseV1).mockRejectedValueOnce(Error('SYNTHETIC-PRIVATE-CONNECTION'));
  const first = await portalCapacityRpcV1(binding, context());
  expect(first.state).toBe('unavailable'); expect(first.metrics).toBeNull(); expect(JSON.stringify(first)).not.toContain('PRIVATE');
  expect((await portalCapacityRpcV1(binding, context())).state).toBe('ok');
});
it('keeps failure states uncacheable', async () => {
  const binding = env(); vi.mocked(portalDatabaseV1).mockResolvedValue(emptyPortalCapacityV1('unavailable'));
  await portalCapacityRpcV1(binding, context()); await portalCapacityRpcV1(binding, context());
  expect(portalDatabaseV1).toHaveBeenCalledTimes(2);
});
