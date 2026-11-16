// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { portalSignalsRpcV1, portalSignalsScheduledV1 } from '../../server/student-portal/composition/signals-v1';
import { portalDatabaseV1 } from '../../server/student-portal/composition/database-v1';
import { cleanupPortalSignalsV1, savePortalSignalsV1 } from '../../server/student-portal/observability/signal-store-v1';
import type { PortalCompositionEnvV1 } from '../../server/student-portal/composition/config-v1';
vi.mock('../../server/student-portal/composition/database-v1', () => ({ portalDatabaseV1: vi.fn() }));
vi.mock('../../server/student-portal/observability/signal-store-v1', () => ({ cleanupPortalSignalsV1: vi.fn(), savePortalSignalsV1: vi.fn(), readPortalSignalsV1: vi.fn() }));
const tenant = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const operationalSignals = vi.fn(async () => ({ version: 1, generatedAt: new Date().toISOString(), points: [] }));
  const env = { PORTAL_ENVIRONMENT: 'production', PORTAL_ADMIN_TENANT_ID: tenant, PORTAL_DB: {}, PORTAL_SERVING_ENABLED: 'false',
    PORTAL_LIVE: { idFromName: () => 'synthetic', get: () => ({ operationalSignals }) } } as unknown as PortalCompositionEnvV1;
  return { env, operationalSignals };
}
beforeEach(() => vi.resetAllMocks());
it('rejects invalid RPC authority before SQL and does not turn missing configuration into successful data', async () => {
  const { env } = fixture();
  await expect(portalSignalsRpcV1(env, {}, null)).rejects.toThrow();
  expect(portalDatabaseV1).not.toHaveBeenCalled();
  delete env.PORTAL_DB;
  const context = { actorId: '11111111-1111-4111-8111-111111111111', tenantId: tenant, requestId: '33333333-3333-4333-8333-333333333333',
    authenticatedAt: new Date().toISOString(), capability: 'platform.settings.read' };
  expect(await portalSignalsRpcV1(env, context, null)).toMatchObject({ state: 'unconfigured', points: [] });
});
it('cleans up with student serving disabled and still cleans when the accumulator is unavailable', async () => {
  const { env, operationalSignals } = fixture();
  const sql = {} as Parameters<Parameters<typeof portalDatabaseV1>[2]>[0];
  vi.mocked(portalDatabaseV1).mockImplementation(async (_env, _operation, run) => run(sql));
  await portalSignalsScheduledV1(env, 300_000);
  expect(cleanupPortalSignalsV1).toHaveBeenCalledWith(sql); expect(savePortalSignalsV1).toHaveBeenCalledTimes(1);
  operationalSignals.mockRejectedValue(Error('private'));
  await portalSignalsScheduledV1(env, 600_000);
  expect(cleanupPortalSignalsV1).toHaveBeenCalledTimes(2); expect(savePortalSignalsV1).toHaveBeenCalledTimes(1);
});
it('does no extra work between five-minute boundaries or in preview', async () => {
  const { env, operationalSignals } = fixture();
  await portalSignalsScheduledV1(env, 60_000); env.PORTAL_ENVIRONMENT = 'preview'; await portalSignalsScheduledV1(env, 300_000);
  expect(operationalSignals).not.toHaveBeenCalled(); expect(portalDatabaseV1).not.toHaveBeenCalled();
});
