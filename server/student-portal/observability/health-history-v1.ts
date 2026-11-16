import { emptyPortalHistoryV1, HEALTH_HISTORY_PAGE_SIZE_V1, isHistoryBeforeV1, isPortalHistoryV1,
  type PortalHistoryV1 } from '../../../shared/system-health-history-v1';
import { isPortalMaintenanceSampleV1 } from '../../../shared/system-health-v1';
import type { StudentPortalPostgresQueryV1, StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { portalMaintenanceHealthV1 } from './maintenance-health-v1';
import { boundedHealthTransactionV1 as timeouts } from './signal-store-v1';

const instantSql = (name: 'transaction_timestamp()' | 'bucket_at' | 'observed_at') =>
  `to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
async function available(tx: StudentPortalPostgresQueryV1): Promise<boolean> {
  const rows = await tx.unsafe("SELECT to_regclass('system_health.portal_sample_v1') IS NOT NULL AS available");
  return rows[0]?.available === true;
}
/** Bounded and independently committed: a failed new sample cannot undo retention. */
export async function cleanupPortalHistoryV1(sql: StudentPortalPostgresSqlV1): Promise<void> {
  await sql.begin(async (tx) => {
    await timeouts(tx);
    if (!await available(tx)) return;
    await tx.unsafe(`DELETE FROM system_health.portal_sample_v1
      WHERE bucket_at IN (SELECT bucket_at FROM system_health.portal_sample_v1
        WHERE observed_at <= statement_timestamp() - interval '720 hours'
        ORDER BY observed_at, bucket_at LIMIT 500)
      AND observed_at <= statement_timestamp() - interval '720 hours'`);
  });
}
export async function recordPortalHistoryV1(sql: StudentPortalPostgresSqlV1,
  config: { servingEnabled: boolean; credentialsConfigured: boolean },
  readMaintenance = portalMaintenanceHealthV1): Promise<void> {
  await sql.begin(async (tx) => {
    await timeouts(tx);
    if (!await available(tx)) return;
    const lock = await tx.unsafe('SELECT pg_try_advisory_xact_lock(969, 1091) AS acquired');
    if (lock[0]?.acquired !== true) return;
    const existing = await tx.unsafe(`SELECT 1 FROM system_health.portal_sample_v1
      WHERE bucket_at = date_bin(interval '5 minutes', statement_timestamp(), timestamptz '2000-01-01 00:00:00+00')`);
    if (existing.length) return;
    const started = Date.now();
    const maintenance = await readMaintenance(tx);
    if (!isPortalMaintenanceSampleV1(maintenance)) throw new Error('health-history-unavailable');
    const duration = Math.min(2_147_483_647, Math.max(0, Date.now() - started));
    await tx.unsafe(`INSERT INTO system_health.portal_sample_v1
      (serving_enabled, credentials_configured, maintenance_state, publication_due,
       live_pending, waiting_connections, read_duration_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (bucket_at) DO NOTHING`,
    [config.servingEnabled, config.credentialsConfigured, maintenance.status, maintenance.publicationDue,
      maintenance.liveOutboxAvailable ? maintenance.livePending : null, maintenance.waitingConnections, duration]);
  });
}
/** Private, read-only keyset pages. Expired rows are excluded even if cleanup is delayed. */
export async function readPortalHistoryV1(sql: StudentPortalPostgresSqlV1, before: string | null): Promise<PortalHistoryV1> {
  if (!isHistoryBeforeV1(before)) throw new Error('health-history-invalid-request');
  return sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await timeouts(tx);
    const clock = await tx.unsafe(`SELECT ${instantSql('transaction_timestamp()')} AS now`);
    const generatedAt = clock[0]?.now;
    if (typeof generatedAt !== 'string') throw new Error('health-history-unavailable');
    if (!await available(tx)) return emptyPortalHistoryV1('unconfigured', generatedAt);
    const rows = await tx.unsafe(`SELECT jsonb_build_object(
      'bucketAt', ${instantSql('bucket_at')}, 'observedAt', ${instantSql('observed_at')},
      'servingEnabled', serving_enabled, 'credentialsConfigured', credentials_configured,
      'maintenanceState', maintenance_state, 'publicationDue', publication_due,
      'livePending', live_pending, 'waitingConnections', waiting_connections,
      'readDurationMs', read_duration_ms) AS point
      FROM system_health.portal_sample_v1
      WHERE observed_at > transaction_timestamp() - interval '720 hours'
        AND observed_at <= transaction_timestamp() AND ($1::timestamptz IS NULL OR bucket_at < $1::timestamptz)
      ORDER BY bucket_at DESC LIMIT 49`, [before]);
    const points = rows.slice(0, HEALTH_HISTORY_PAGE_SIZE_V1).map((row) => row.point);
    const last = points.at(-1) as { bucketAt?: unknown } | undefined;
    const result = { schemaVersion: 1, generatedAt, retentionDays: 30, state: 'ok', points,
      nextBefore: rows.length > HEALTH_HISTORY_PAGE_SIZE_V1 ? last?.bucketAt : null };
    if (!isPortalHistoryV1(result)) throw new Error('health-history-unavailable');
    return result;
  });
}
