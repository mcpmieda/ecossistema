-- Periodic retention, independent from any Windows PC, browser visit or error.
-- Only already-expired unclaimed authorization rows are retired; completed,
-- claimed devices and batch-backed academic receipts are never purged.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
SELECT cron.schedule(
  'collector-frequency-retention-v2',
  '*/15 * * * *',
  $task$
  WITH expired AS MATERIALIZED (
    SELECT id,device_id FROM collector_auth.pairings
    WHERE expires_at<=clock_timestamp() AND claimed_at IS NULL
      AND state IN ('pending','confirmed','exchanging','completed')
    ORDER BY expires_at LIMIT 50 FOR UPDATE SKIP LOCKED
  ),
  revoked AS (
    UPDATE collector_auth.devices d SET revoked_at=clock_timestamp(),generation=generation+1
    FROM expired p WHERE d.id=p.device_id AND d.revoked_at IS NULL
    RETURNING d.id,d.grant_id
  ),
  retired AS (
    UPDATE collector_auth.oauth_grants g
    SET state='revoked',revoked_at=clock_timestamp(),generation=generation+1,
        encrypted_refresh=NULL,directory_authorized=false,directory_checked_at=NULL,
        directory_valid_until=NULL,refresh_owner=NULL,refresh_until=NULL
    FROM revoked r WHERE g.id=r.grant_id
      AND NOT EXISTS(SELECT 1 FROM collector_auth.devices other
        WHERE other.grant_id=g.id AND other.id<>r.id AND other.revoked_at IS NULL)
    RETURNING g.id
  ),
  cancelled AS (
    UPDATE collector_auth.pairings p
    SET state='cancelled',oauth_state_hash=NULL,oauth_nonce_hash=NULL,
        device_id=NULL,claimed_at=NULL FROM expired e WHERE p.id=e.id RETURNING p.id
  ),
  challenge_cleanup AS (
    DELETE FROM collector_auth.challenges WHERE ctid IN (
      SELECT ctid FROM collector_auth.challenges
      WHERE expires_at<clock_timestamp()-interval '1 hour'
      ORDER BY expires_at LIMIT 500) RETURNING 1
  ),
  pairing_cleanup AS (
    DELETE FROM collector_auth.pairings WHERE ctid IN (
      SELECT ctid FROM collector_auth.pairings
      WHERE state='cancelled' AND device_id IS NULL
        AND expires_at<clock_timestamp()-interval '1 day'
      ORDER BY expires_at LIMIT 500) RETURNING 1
  ),
  receipt_cleanup AS (
    DELETE FROM attendance.receipt_v2 WHERE ctid IN (
      SELECT r.ctid FROM attendance.receipt_v2 r
      WHERE r.recorded_at<clock_timestamp()-interval '8 days'
        AND NOT EXISTS(SELECT 1 FROM attendance.batch_v2 b
          WHERE b.academic_year=r.academic_year AND b.id=r.request_id)
      ORDER BY r.recorded_at LIMIT 500) RETURNING 1
  ),
  failure_cleanup AS (
    DELETE FROM attendance.failure_v2 WHERE ctid IN (
      SELECT ctid FROM attendance.failure_v2
      WHERE last_at<clock_timestamp()-interval '7 days'
      ORDER BY last_at LIMIT 500) RETURNING 1
  ),
  budget_cleanup AS (
    DELETE FROM collector_auth.pairing_rate_v1 WHERE ctid IN (
      SELECT ctid FROM collector_auth.pairing_rate_v1
      WHERE scope<>'global' AND window_started_at<clock_timestamp()-interval '2 days'
      ORDER BY window_started_at LIMIT 500) RETURNING 1
  )
  SELECT (SELECT count(*) FROM cancelled)
       + (SELECT count(*) FROM challenge_cleanup)
       + (SELECT count(*) FROM pairing_cleanup)
       + (SELECT count(*) FROM receipt_cleanup)
       + (SELECT count(*) FROM failure_cleanup)
       + (SELECT count(*) FROM budget_cleanup) AS cleaned;
  $task$
);
COMMIT;
