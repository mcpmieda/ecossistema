import {
  buildHealthReviewV1,
  emptyHealthReviewV1,
  reviewWindowV1,
  type HealthReviewV1,
} from '../../../shared/health-review-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
/** Two bounded reads of operational aggregates only; no academic, account or audit tables. */
export async function readHealthReviewV1(sql: StudentPortalPostgresSqlV1): Promise<HealthReviewV1> {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await tx.unsafe("SET LOCAL statement_timeout = '1500ms'");
    await tx.unsafe("SET LOCAL lock_timeout = '250ms'");
    const clock =
      await tx.unsafe(`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
      to_regclass('system_health.portal_sample_v1') IS NOT NULL AND to_regclass('system_health.portal_signal_v1') IS NOT NULL AS available`);
    const now = clock[0]?.now;
    if (typeof now !== 'string' || !Number.isFinite(Date.parse(now)))
      throw new Error('review-clock-unavailable');
    if (clock[0]?.available !== true) return emptyHealthReviewV1('unconfigured', Date.parse(now));
    const range = reviewWindowV1(Date.parse(now)),
      args = [range.from, range.to];
    const rows = await tx.unsafe(
      `SELECT jsonb_build_object(
      'bucketAt',to_char(bucket_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'observedAt',to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'servingEnabled',serving_enabled,'credentialsConfigured',credentials_configured,
      'maintenanceState',maintenance_state,'publicationDue',publication_due,'livePending',live_pending,
      'waitingConnections',waiting_connections,'readDurationMs',read_duration_ms) AS point
      FROM system_health.portal_sample_v1 WHERE bucket_at >= $1::timestamptz AND bucket_at < $2::timestamptz
      ORDER BY bucket_at LIMIT 289`,
      args,
    );
    const operations = await tx.unsafe(
      `SELECT source,outcome,sum(samples)::integer AS samples,max(max_ms)::integer AS "maxMs",
      sum(slow)::integer AS slow,bool_or(capped) AS capped FROM system_health.portal_signal_v1
      WHERE bucket_at >= $1::timestamptz AND bucket_at < $2::timestamptz
      GROUP BY source,outcome ORDER BY source,outcome LIMIT 33`,
      args,
    );
    return buildHealthReviewV1(
      now,
      rows.map((r) => r.point),
      Array.from(operations),
    );
  });
}
