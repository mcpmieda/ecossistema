-- Owner request of 09/11/2026: the every-minute retention took the 2026 year lock (613,2026) and
-- the reconciliation scope row even when no report batch had expired, which was almost always.
-- It now looks first and returns 0 without any lock when nothing expired. A batch that expires
-- just after the look is taken by the next minute. Same body otherwise; no data is changed.
-- Depends on 0025 (the bridge role owns the function and keeps owning it).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Only the owner may replace the function: borrow the bridge role, as 0025 did, and give it back.
GRANT student_reconciliation_bridge_v1 TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT CREATE ON SCHEMA student_portal TO student_reconciliation_bridge_v1;
DO $$ DECLARE migrator name := current_user; BEGIN
  SET LOCAL ROLE student_reconciliation_bridge_v1;
  CREATE OR REPLACE FUNCTION student_portal.cleanup_reconciliation_pending_v1(p_limit integer DEFAULT 100)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  DECLARE b record; v_count integer:=0;
  BEGIN
    IF p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'student-reconciliation-cleanup-limit'; END IF;
    -- Nothing expired: no lock, so ADM writes on 2026 never wait for an empty run.
    IF NOT EXISTS (SELECT 1 FROM gradebook.student_report_batch_v1 WHERE academic_year=2026
      AND state IN ('awaiting_relation','review_required','preparing') AND expires_at<=clock_timestamp()) THEN
      RETURN 0;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(613,0);
    PERFORM pg_advisory_xact_lock(613,2026);
    PERFORM academic_year FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026 FOR UPDATE;
    FOR b IN SELECT id FROM gradebook.student_report_batch_v1 WHERE academic_year=2026
      AND state IN ('awaiting_relation','review_required','preparing') AND expires_at<=clock_timestamp()
      ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
      DELETE FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=b.id;
      DELETE FROM student_portal.reconciliation_credential_attempt_v1 WHERE batch_id=b.id;
      DELETE FROM gradebook.student_report_pending_row_v1 WHERE batch_id=b.id;
      UPDATE gradebook.student_report_batch_v1 SET state='expired',class_links='[]'::jsonb WHERE id=b.id;
      v_count:=v_count+1;
    END LOOP;
    IF v_count>0 THEN
      UPDATE gradebook.student_reconciliation_scope_v1 SET revision=revision+1 WHERE academic_year=2026;
    END IF;
    RETURN v_count;
  END $fn$;
  EXECUTE format('SET LOCAL ROLE %I', migrator);
END $$;
REVOKE CREATE ON SCHEMA student_portal FROM student_reconciliation_bridge_v1;
REVOKE student_reconciliation_bridge_v1 FROM CURRENT_USER;
COMMIT;
