// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { portalMonitoringRpcV1 } from '../../server/student-portal/composition/monitoring-v1';
import { portalMaintenanceHealthV1 } from '../../server/student-portal/observability/maintenance-health-v1';
import { portalDatabaseV1 } from '../../server/student-portal/composition/database-v1';
import { portalKeysV1, type PortalCompositionEnvV1 } from '../../server/student-portal/composition/config-v1';
import type { PortalMaintenanceSampleV1 } from '../../shared/system-health-v1';

vi.mock('../../server/student-portal/composition/database-v1', () => ({ portalDatabaseV1: vi.fn() }));
vi.mock('../../server/student-portal/composition/config-v1', () => ({ portalKeysV1: vi.fn() }));
vi.mock('../../server/student-portal/observability/maintenance-health-v1', () => ({ portalMaintenanceHealthV1: vi.fn() }));
const tenant = '22222222-2222-4222-8222-222222222222';
function context() {
  return { actorId: '11111111-1111-4111-8111-111111111111', tenantId: tenant,
    requestId: '33333333-3333-4333-8333-333333333333', authenticatedAt: new Date().toISOString(), capability: 'platform.settings.read' };
}
function env() {
  return { PORTAL_ENVIRONMENT: 'production', PORTAL_ADMIN_TENANT_ID: tenant,
    PORTAL_SERVING_ENABLED: 'true', PORTAL_DB: {} } as unknown as PortalCompositionEnvV1;
}
const healthy: PortalMaintenanceSampleV1 = { status: 'normal', liveOutboxAvailable: true,
  expiredIp: 0, expiredAudit: 0, backlog: false, exhausted: false, publicationDue: 0,
  oldestPublicationDueMs: 0, liveBacklog: false, livePending: 0, liveRetrying: 0,
  oldestLiveDueMs: 0, waitingConnections: 0, oldestWaitingQueryMs: 0 };
beforeEach(() => vi.resetAllMocks());
describe('private Portal monitoring RPC', () => {
  it.each([
    { tenantId: '44444444-4444-4444-8444-444444444444' },
    { authenticatedAt: '2020-01-01T00:00:00.000Z' },
    { authenticatedAt: '2099-01-01T00:00:00.000Z' },
    { capability: 'student.read' }, { rawError: 'extra' },
  ])('rejects invalid private authority before keys or SQL', async (overrides) => {
    await expect(portalMonitoringRpcV1(env(), { ...context(), ...overrides })).rejects.toThrow('portal-monitor-forbidden');
    expect(portalDatabaseV1).not.toHaveBeenCalled(); expect(portalKeysV1).not.toHaveBeenCalled();
  });
  it('reads existing maintenance aggregates in a bounded, read-only transaction', async () => {
    const tx = { unsafe: vi.fn<(sql: string) => Promise<never[]>>().mockResolvedValue([]) };
    vi.mocked(portalMaintenanceHealthV1).mockResolvedValue(healthy);
    vi.mocked(portalDatabaseV1).mockImplementation(async (_env, _operation, run) => run({
      begin: (operation: (query: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as Parameters<Parameters<typeof portalDatabaseV1>[2]>[0]));
    const result = await portalMonitoringRpcV1(env(), context());
    expect(result.database).toBe('ok'); expect(result.maintenance).toEqual(healthy);
    expect(tx.unsafe.mock.calls.map(([sql]) => sql)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      "SET LOCAL statement_timeout = '1500ms'", "SET LOCAL lock_timeout = '250ms'",
    ]);
    expect(portalMaintenanceHealthV1).toHaveBeenCalledWith(tx);
  });
  it('does not require cryptographic secrets to diagnose missing configuration', async () => {
    const configuration = env(); delete configuration.PORTAL_DB;
    vi.mocked(portalKeysV1).mockImplementation(() => { throw Error('SECRET-MUST-NOT-LEAK'); });
    const result = await portalMonitoringRpcV1(configuration, context());
    expect(result.database).toBe('unconfigured'); expect(result.credentialsConfigured).toBe(false);
    expect(result.maintenance).toBeNull(); expect(portalDatabaseV1).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('SECRET-MUST-NOT-LEAK');
  });
  it('does not reclassify an SQL failure as zero counters or a provider diagnosis', async () => {
    vi.mocked(portalDatabaseV1).mockRejectedValue(Error('private-sql-message'));
    const result = await portalMonitoringRpcV1(env(), context());
    expect(result.database).toBe('unavailable'); expect(result.maintenance).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-sql-message');
  });
});
