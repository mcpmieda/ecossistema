-- Supabase-only pg_cron: every day at midnight in Bahia (03:00 UTC), remove
-- frequency evidence a newer collection already replaced (see
-- migrations/attendance/0007_superseded_evidence_pruning_v2.sql). Official
-- marks, the newest evidence of each key, open conflicts and decisions stay.
-- Its run history is pruned with the other collector jobs (0008 list updated).
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT cron.schedule(
  'attendance-evidence-pruning-v2',
  '0 3 * * *',
  $task$ SELECT attendance.prune_superseded_evidence_v2(); $task$
);
SELECT cron.schedule(
  'collector-frequency-cron-history-v2',
  '5 2 * * *',
  $task$
  DELETE FROM cron.job_run_details WHERE runid IN (
    SELECT d.runid FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid=d.jobid
    WHERE j.jobname IN ('collector-frequency-retention-v2',
                        'collector-frequency-cron-history-v2',
                        'attendance-evidence-pruning-v2')
      AND d.end_time<clock_timestamp()-interval '7 days'
    ORDER BY d.end_time LIMIT 2500 FOR UPDATE OF d SKIP LOCKED
  );
  $task$
);
COMMIT;
