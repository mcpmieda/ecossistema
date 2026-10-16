-- Additive, Supabase-only pg_cron maintenance: retain the operational audit
-- window without letting every 15-minute job run accumulate indefinitely.
-- Scope the deletion to the collector jobs; do not touch other applications.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT cron.schedule(
  'collector-frequency-cron-history-v2',
  '5 2 * * *',
  $task$
  DELETE FROM cron.job_run_details WHERE runid IN (
    SELECT d.runid FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid=d.jobid
    WHERE j.jobname IN ('collector-frequency-retention-v2',
                        'collector-frequency-cron-history-v2')
      AND d.end_time<clock_timestamp()-interval '7 days'
    ORDER BY d.end_time LIMIT 2500 FOR UPDATE OF d SKIP LOCKED
  );
  $task$
);
COMMIT;
