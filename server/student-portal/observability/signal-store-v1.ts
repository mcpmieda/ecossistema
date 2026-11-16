import { emptyPortalSignalsV1, isPortalSignalsPageV1, portalSignalBatchV1, SIGNAL_BUFFER_MS_V1,
  type PortalSignalsPageV1 } from '../../../shared/portal-signals-v1';
import { isHistoryBeforeV1 } from '../../../shared/system-health-history-v1';
import type { StudentPortalPostgresQueryV1, StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
const instant = (name: 'transaction_timestamp()' | 'bucket_at') =>
  `to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** Health writes and reads never wait long on the database or on a lock. */
export async function boundedHealthTransactionV1(tx: StudentPortalPostgresQueryV1): Promise<void> {
  await tx.unsafe("SET LOCAL statement_timeout = '1500ms'");
  await tx.unsafe("SET LOCAL lock_timeout = '250ms'");
}
async function available(tx: StudentPortalPostgresQueryV1): Promise<boolean> {
  const rows = await tx.unsafe("SELECT to_regclass('system_health.portal_signal_v1') IS NOT NULL AS available");
  return rows[0]?.available === true;
}
export async function cleanupPortalSignalsV1(sql: StudentPortalPostgresSqlV1): Promise<void> {
  await sql.begin(async (tx) => {
    await boundedHealthTransactionV1(tx); if (!await available(tx)) return;
    await tx.unsafe(`DELETE FROM system_health.portal_signal_v1 WHERE (bucket_at,source,outcome) IN (
      SELECT bucket_at,source,outcome FROM system_health.portal_signal_v1
      WHERE bucket_at <= statement_timestamp() - interval '720 hours'
      ORDER BY bucket_at,source,outcome LIMIT 500)
      AND bucket_at <= statement_timestamp() - interval '720 hours'`);
  });
}
/** Absolute counters and monotone replacement make cron retries idempotent. No student data is read. */
export async function savePortalSignalsV1(sql: StudentPortalPostgresSqlV1, input: unknown): Promise<void> {
  const batch = portalSignalBatchV1.parse(input);
  const generated = Date.parse(batch.generatedAt);
  const seen = new Set<string>();
  for (const point of batch.points) {
    const at = Date.parse(point.bucketAt), key = `${point.bucketAt}|${point.source}|${point.outcome}`;
    if (at > generated || at <= generated - SIGNAL_BUFFER_MS_V1 || seen.has(key)) throw new Error('signal-invalid-batch');
    seen.add(key);
  }
  await sql.begin(async (tx) => {
    await boundedHealthTransactionV1(tx); if (!await available(tx)) return;
    const clock = await tx.unsafe(`SELECT abs(extract(epoch FROM (statement_timestamp() - $1::timestamptz))) < 60 AS fresh`, [batch.generatedAt]);
    if (clock[0]?.fresh !== true) throw new Error('signal-stale-batch');
    if (!batch.points.length) return;
    // Text on the wire prevents the driver's JSONB serializer from encoding JSON twice.
    await tx.unsafe(`INSERT INTO system_health.portal_signal_v1 AS old
      (bucket_at,source,outcome,samples,total_ms,max_ms,slow,capped)
      SELECT p."bucketAt"::timestamptz,p.source,p.outcome,p.samples,p."totalMs",p."maxMs",p.slow,p.capped
      FROM jsonb_to_recordset($1::text::jsonb) AS p("bucketAt" text,source text,outcome text,samples integer,"totalMs" integer,"maxMs" integer,slow integer,capped boolean)
      WHERE p."bucketAt"::timestamptz <= statement_timestamp()
        AND p."bucketAt"::timestamptz > statement_timestamp() - interval '20 minutes'
      ON CONFLICT (bucket_at,source,outcome) DO UPDATE SET samples=excluded.samples,
        total_ms=excluded.total_ms,max_ms=excluded.max_ms,slow=excluded.slow,capped=old.capped OR excluded.capped
      WHERE excluded.samples >= old.samples AND excluded.total_ms >= old.total_ms
        AND excluded.max_ms >= old.max_ms AND excluded.slow >= old.slow
        AND (excluded.samples > old.samples OR (excluded.capped AND NOT old.capped))`, [JSON.stringify(batch.points)]);
  });
}
export async function readPortalSignalsV1(sql: StudentPortalPostgresSqlV1, before: string | null): Promise<PortalSignalsPageV1> {
  if (!isHistoryBeforeV1(before)) throw new Error('signal-invalid-cursor');
  return sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'); await boundedHealthTransactionV1(tx);
    const clock = await tx.unsafe(`SELECT ${instant('transaction_timestamp()')} AS now`);
    const generatedAt = clock[0]?.now;
    if (typeof generatedAt !== 'string') throw new Error('signal-clock-unavailable');
    if (!await available(tx)) return emptyPortalSignalsV1('unconfigured', generatedAt);
    const rows = await tx.unsafe(`WITH windows AS (
      SELECT DISTINCT bucket_at FROM system_health.portal_signal_v1
      WHERE bucket_at > transaction_timestamp() - interval '720 hours' AND bucket_at <= transaction_timestamp()
        AND ($1::timestamptz IS NULL OR bucket_at < $1::timestamptz)
      ORDER BY bucket_at DESC LIMIT 13)
      SELECT jsonb_build_object('bucketAt',${instant('bucket_at')},'source',source,'outcome',outcome,
        'samples',samples,'totalMs',total_ms,'maxMs',max_ms,'slow',slow,'capped',capped) AS point
      FROM system_health.portal_signal_v1 WHERE bucket_at IN (SELECT bucket_at FROM windows)
      ORDER BY bucket_at DESC,source,outcome LIMIT 416`, [before]);
    const all = rows.map((row) => row.point);
    const windows = [...new Set(all.map((point) => (point as { bucketAt: string }).bucketAt))];
    const kept = new Set(windows.slice(0, 12));
    const result = { version: 1, generatedAt, retentionDays: 30, coverage: 'partial', state: 'ok',
      points: all.filter((point) => kept.has((point as { bucketAt: string }).bucketAt)),
      nextBefore: windows.length > 12 ? windows[11] : null };
    if (!isPortalSignalsPageV1(result)) throw new Error('signal-invalid-page');
    return result;
  });
}
