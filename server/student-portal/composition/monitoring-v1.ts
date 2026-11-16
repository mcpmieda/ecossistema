import { trustedAdminContextV1 } from '../../../shared/student-portal-contracts/admin-v1';
import {
  isPortalMonitorSampleV1,
  type PortalMonitorSampleV1,
} from '../../../shared/system-health-v1';
import { portalMaintenanceHealthV1 } from '../observability/maintenance-health-v1';
import { portalDatabaseV1 } from './database-v1';
import { portalKeysV1, type PortalCompositionEnvV1 } from './config-v1';

/** Shared authority boundary for the private current-sample and history RPCs. */
export function assertPortalMonitoringContextV1(env: PortalCompositionEnvV1, input: unknown): void {
  const parsed = trustedAdminContextV1.safeParse(input);
  if (!parsed.success) throw new Error('portal-monitor-forbidden');
  const context = parsed.data;
  const age = Date.now() - Date.parse(context.authenticatedAt);
  if (
    env.PORTAL_ENVIRONMENT !== 'production' ||
    age < 0 ||
    age > 300_000 ||
    context.tenantId.toLowerCase() !== env.PORTAL_ADMIN_TENANT_ID?.toLowerCase()
  )
    throw new Error('portal-monitor-forbidden');
}

/** Named ADM RPC only. No student endpoint, credential requirement or academic mutation. */
export async function portalMonitoringRpcV1(
  env: PortalCompositionEnvV1,
  input: unknown,
): Promise<PortalMonitorSampleV1> {
  assertPortalMonitoringContextV1(env, input);
  let credentialsConfigured = false;
  try {
    portalKeysV1(env);
    credentialsConfigured = true;
  } catch {
    /* Absence is a diagnostic, never a raw error. */
  }
  const started = Date.now();
  let database: PortalMonitorSampleV1['database'] = env.PORTAL_DB ? 'unavailable' : 'unconfigured';
  let maintenance: PortalMonitorSampleV1['maintenance'] = null;
  if (env.PORTAL_DB) {
    try {
      maintenance = await portalDatabaseV1(env, 'admin-query', (sql) =>
        sql.begin(async (tx) => {
          await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
          await tx.unsafe("SET LOCAL statement_timeout = '1500ms'");
          await tx.unsafe("SET LOCAL lock_timeout = '250ms'");
          return portalMaintenanceHealthV1(tx);
        }),
      );
      database = 'ok';
    } catch {
      database = 'unavailable';
      maintenance = null;
    }
  }
  const sample: PortalMonitorSampleV1 = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    servingEnabled: env.PORTAL_SERVING_ENABLED === 'true',
    credentialsConfigured,
    database,
    readDurationMs: Math.max(0, Date.now() - started),
    maintenance,
  };
  if (!isPortalMonitorSampleV1(sample)) throw new Error('portal-monitor-unavailable');
  return sample;
}
