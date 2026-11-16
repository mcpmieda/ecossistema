import {
  emptyPortalHistoryV1,
  isHistoryBeforeV1,
  type PortalHistoryV1,
} from '../../../shared/system-health-history-v1';
import {
  cleanupPortalHistoryV1,
  readPortalHistoryV1,
  recordPortalHistoryV1,
} from '../observability/health-history-v1';
import { portalDatabaseV1 } from './database-v1';
import { portalKeysV1, type PortalCompositionEnvV1 } from './config-v1';
import { assertPortalMonitoringContextV1 } from './monitoring-v1';

/** Separate RPC preserves the exact V1 snapshot during backend-first deployments. */
export async function portalHistoryRpcV1(
  env: PortalCompositionEnvV1,
  context: unknown,
  before: unknown,
): Promise<PortalHistoryV1> {
  assertPortalMonitoringContextV1(env, context);
  if (!isHistoryBeforeV1(before)) throw new Error('health-history-invalid-request');
  if (!env.PORTAL_DB) return emptyPortalHistoryV1('unconfigured');
  try {
    return await portalDatabaseV1(env, 'admin-query', (sql) => readPortalHistoryV1(sql, before));
  } catch {
    return emptyPortalHistoryV1('unavailable');
  }
}
/** Reuses the existing minute cron, but adds work only at five-minute boundaries. */
export async function portalHistoryScheduledV1(
  env: PortalCompositionEnvV1,
  scheduledTime: number,
): Promise<void> {
  if (
    env.PORTAL_ENVIRONMENT !== 'production' ||
    !env.PORTAL_DB ||
    !Number.isFinite(scheduledTime) ||
    Math.floor(scheduledTime / 60_000) % 5 !== 0
  )
    return;
  let credentialsConfigured = false;
  try {
    portalKeysV1(env);
    credentialsConfigured = true;
  } catch {
    /* Only the boolean is stored. */
  }
  try {
    await portalDatabaseV1(env, 'cleanup', async (sql) => {
      await cleanupPortalHistoryV1(sql);
      await recordPortalHistoryV1(sql, {
        servingEnabled: env.PORTAL_SERVING_ENABLED === 'true',
        credentialsConfigured,
      });
    });
  } catch {
    /* The wrapper emits a sanitized failure; missing samples remain gaps, not Normal. */
  }
}
