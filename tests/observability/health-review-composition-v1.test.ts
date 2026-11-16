// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { portalHealthReviewRpcV1 } from '../../server/student-portal/composition/health-review-v1';
import { portalDatabaseV1 } from '../../server/student-portal/composition/database-v1';
import { buildHealthReviewV1 } from '../../shared/health-review-v1';
import type { PortalCompositionEnvV1 } from '../../server/student-portal/composition/config-v1';
vi.mock('../../server/student-portal/composition/database-v1', () => ({ portalDatabaseV1: vi.fn() }));
const tenant = '10970000-0000-4000-8000-000000000002';
const context = () => ({ actorId: '10970000-0000-4000-8000-000000000001', tenantId: tenant,
  capability: 'platform.settings.read', authenticatedAt: new Date().toISOString(), requestId: crypto.randomUUID() });
const env = () => ({ PORTAL_ENVIRONMENT: 'production', PORTAL_ADMIN_TENANT_ID: tenant,
  PORTAL_DB: { connectionString: 'synthetic' }, PORTAL_SERVING_ENABLED: 'false' }) as unknown as PortalCompositionEnvV1;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(portalDatabaseV1).mockResolvedValue(buildHealthReviewV1(new Date().toISOString(), [], [])); });
it('reauthorizes before cache hits and absent configuration, with no dependence on student serving', async () => {
  const binding = env();
  await portalHealthReviewRpcV1(binding, context()); await portalHealthReviewRpcV1(binding, context());
  expect(portalDatabaseV1).toHaveBeenCalledTimes(1);
  for (const bad of [{}, { ...context(), tenantId: crypto.randomUUID() }, { ...context(), capability: 'platform.health.read' },
    { ...context(), authenticatedAt: '2000-01-01T00:00:00.000Z' }]) await expect(portalHealthReviewRpcV1(binding, bad)).rejects.toThrow();
  expect(portalDatabaseV1).toHaveBeenCalledTimes(1);
  delete binding.PORTAL_DB; await expect(portalHealthReviewRpcV1(binding, {})).rejects.toThrow();
  expect((await portalHealthReviewRpcV1(binding, context())).state).toBe('unconfigured');
});
it('does not keep a driver failure as a cached success or leak its contents', async () => {
  const binding = env(); vi.mocked(portalDatabaseV1).mockRejectedValueOnce(Error('SYNTHETIC-PRIVATE'));
  const first = await portalHealthReviewRpcV1(binding, context()); expect(first.state).toBe('unavailable');
  expect(JSON.stringify(first)).not.toContain('PRIVATE');
  expect((await portalHealthReviewRpcV1(binding, context())).state).toBe('ok');
});
