import { emptyPortalSignalsV1 } from '../../../shared/portal-signals-v1';
import { isHistoryBeforeV1 } from '../../../shared/system-health-history-v1';
import { healthDeadlineV1 } from '../../../shared/health-io-v1';
import { portalLiveStubV1 } from '../live/live-connect-v1';
import { cleanupPortalSignalsV1, readPortalSignalsV1, savePortalSignalsV1 } from '../observability/signal-store-v1';
import { assertPortalMonitoringContextV1 } from './monitoring-v1';
import { portalDatabaseV1 } from './database-v1';
import type { PortalCompositionEnvV1 } from './config-v1';
interface PortalSignalStubV1 {
  recordOperationalSignal(input: unknown): Promise<boolean>;
  operationalSignals(): Promise<unknown>;
}
export const portalSignalStubV1 = (env: PortalCompositionEnvV1) =>
  portalLiveStubV1(env, 'admin') as unknown as PortalSignalStubV1;
export async function portalSignalsRpcV1(env: PortalCompositionEnvV1, context: unknown, before: unknown) {
  assertPortalMonitoringContextV1(env, context);
  if (!isHistoryBeforeV1(before)) throw new Error('signal-invalid-cursor');
  if (!env.PORTAL_DB) return emptyPortalSignalsV1('unconfigured');
  try { return await portalDatabaseV1(env, 'admin-query', (sql) => readPortalSignalsV1(sql, before)); }
  catch { return emptyPortalSignalsV1('unavailable'); }
}
export async function portalSignalsScheduledV1(env: PortalCompositionEnvV1, scheduledTime: number): Promise<void> {
  if (env.PORTAL_ENVIRONMENT !== 'production' || !Number.isFinite(scheduledTime)
    || Math.floor(scheduledTime / 60_000) % 5 !== 0) return;
  let batch: unknown = null;
  try { batch = await healthDeadlineV1(() => portalSignalStubV1(env).operationalSignals(), 2000); }
  catch { /* Missing observations are never presented as successful requests. */ }
  if (!env.PORTAL_DB) return;
  try {
    await portalDatabaseV1(env, 'cleanup', async (sql) => {
      await cleanupPortalSignalsV1(sql);
      if (batch !== null) await savePortalSignalsV1(sql, batch);
    });
  } catch { /* Existing database wrapper emits only sanitized operation metrics. */ }
}
