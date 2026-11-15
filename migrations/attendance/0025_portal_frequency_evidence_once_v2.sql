-- Issue #1450, finding 11 (15/11/2026): read_portal_frequency_v4 called the identity-evidence check
-- gradebook.reconciliation_evidence_valid_v2 once per row (hundreds per student: ~400 ms per Portal
-- entry). The rows of a student carry very few distinct (class, sources, observations) keys, so each
-- key is now checked once and joined back. Same rows, same order, same answer: compared in production
-- for all 383 students of 2026 before this migration (origins and lesson days identical). Same
-- signature, owner and grants (CREATE OR REPLACE as the readers' owner, as in 0013).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
GRANT CREATE ON SCHEMA attendance TO frequency_portal_bridge_v2;
GRANT frequency_portal_bridge_v2 TO CURRENT_USER;
SELECT set_config('attendance.migration_role',current_user,true);
SET LOCAL ROLE frequency_portal_bridge_v2;

CREATE OR REPLACE FUNCTION attendance.read_portal_frequency_v4(p_account uuid,p_session uuid,p_from text,p_to text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_from date;v_until date;v_origins jsonb;v_days jsonb;v_today text;v_read text; BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from!~'^2026-(0[1-9]|1[0-2])$' OR p_to!~'^2026-(0[1-9]|1[0-2])$' OR p_from>p_to THEN RETURN NULL; END IF;
  v_from:=(p_from||'-01')::date;
  v_until:=(p_to||'-01')::date+interval '1 month';
  SELECT a.student_uid INTO v_uid FROM student_portal.account a JOIN student_portal.session s ON s.account_id=a.id
   WHERE a.id=p_account AND s.id=p_session AND a.academic_year=2026 AND a.gradebook_student_id IS NOT NULL
    AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible'
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.security_version=a.security_version;
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  -- Marks: the v3 reader over the range, with each evidence key checked once.
  WITH r AS MATERIALIZED (
   SELECT o.id,o.date,o.slot,o.shift,o.mark,c.id AS cid,b.source_class_label,b.id AS bid,b.observed_at,b.received_at,
     cs.last_batch_id,cs.last_observed_at,cs.last_received_at,b.academic_year,s.student_uid,b.class_id,s.source_ids_json,s.observation_ids_json
   FROM attendance.occurrence_v2 o JOIN attendance.origin_v2 p ON p.occurrence_id=o.id
   JOIN attendance.source_row_v2 s ON s.batch_id=p.batch_id AND s.record_key=p.record_key
   JOIN attendance.batch_v2 b ON b.id=p.batch_id
   LEFT JOIN attendance.class_state_v2 cs ON cs.academic_year=b.academic_year AND cs.class_id=b.class_id
   LEFT JOIN attendance.conflict_v2 c ON c.occurrence_id=o.id AND c.state='open'
   WHERE o.academic_year=2026 AND o.student_uid=v_uid AND o.date>=v_from AND o.date<v_until),
  k AS MATERIALIZED (SELECT DISTINCT academic_year,student_uid,class_id,source_ids_json,observation_ids_json FROM r),
  v AS MATERIALIZED (SELECT k.*,gradebook.reconciliation_evidence_valid_v2(k.academic_year,k.student_uid,k.class_id,k.source_ids_json,k.observation_ids_json) AS ok FROM k)
  SELECT coalesce(jsonb_agg(to_jsonb(data)),'[]'::jsonb) INTO v_origins FROM (
   SELECT r.id::text AS occurrence_id,r.date::text,r.slot,r.shift,r.mark,r.cid::text AS conflict_id,r.source_class_label,
    max(CASE WHEN r.last_batch_id=r.bid THEN r.last_observed_at ELSE r.observed_at END)::text AS observed_at,
    max(CASE WHEN r.last_batch_id=r.bid THEN r.last_received_at ELSE r.received_at END)::text AS received_at,
    bool_and(v.ok) AS mapping_valid
   FROM r JOIN v ON v.academic_year=r.academic_year AND v.student_uid IS NOT DISTINCT FROM r.student_uid AND v.class_id=r.class_id
     AND v.source_ids_json IS NOT DISTINCT FROM r.source_ids_json AND v.observation_ids_json IS NOT DISTINCT FROM r.observation_ids_json
   GROUP BY r.id,r.date,r.slot,r.shift,r.mark,r.cid,r.source_class_label ORDER BY r.date,r.shift,r.slot,r.source_class_label
  ) data;
  -- Lesson days: the latest coverage of each class/ficha/day, then each evidence key checked once.
  WITH latest AS MATERIALIZED (
   SELECT DISTINCT ON(b.class_id,c.record_key,c.date) c.date,b.shift,c.slots_json,c.complete,
     b.academic_year,s.student_uid,b.class_id,s.source_ids_json,s.observation_ids_json
   FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id
   JOIN attendance.source_row_v2 s ON s.batch_id=c.batch_id AND s.record_key=c.record_key
   WHERE b.academic_year=2026 AND s.student_uid=v_uid AND c.date>=v_from AND c.date<v_until
   ORDER BY b.class_id,c.record_key,c.date,b.received_at DESC,b.id DESC),
  k AS MATERIALIZED (SELECT DISTINCT academic_year,student_uid,class_id,source_ids_json,observation_ids_json FROM latest),
  v AS MATERIALIZED (SELECT k.*,gradebook.reconciliation_evidence_valid_v2(k.academic_year,k.student_uid,k.class_id,k.source_ids_json,k.observation_ids_json) AS ok FROM k)
  SELECT coalesce(jsonb_agg(to_jsonb(data) ORDER BY data.date,data.shift),'[]'::jsonb) INTO v_days FROM (
   SELECT l.date::text,l.shift,l.slots_json,l.complete FROM latest l JOIN v ON v.academic_year=l.academic_year
     AND v.student_uid IS NOT DISTINCT FROM l.student_uid AND v.class_id=l.class_id
     AND v.source_ids_json IS NOT DISTINCT FROM l.source_ids_json AND v.observation_ids_json IS NOT DISTINCT FROM l.observation_ids_json
   WHERE v.ok
  ) data;
  SELECT (clock_timestamp() AT TIME ZONE COALESCE(schedule_json->>'timezone','America/Bahia'))::date::text INTO v_today
   FROM attendance.school_state_v2 WHERE academic_year=2026;
  v_today:=coalesce(v_today,(clock_timestamp() AT TIME ZONE 'America/Bahia')::date::text);
  -- The diary of the student's class(es) as last read: every class whose current roster lists them.
  SELECT max(cs.last_observed_at)::text INTO v_read FROM attendance.portal_current_rows_v1(v_uid) r
   JOIN attendance.class_state_v2 cs ON cs.academic_year=r.academic_year AND cs.class_id=r.class_id;
  -- Recheck with the database clock after the read; a long wait never extends a session.
  IF NOT EXISTS(SELECT 1 FROM student_portal.session s JOIN student_portal.account a ON a.id=s.account_id
   WHERE s.id=p_session AND a.id=p_account AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND s.security_version=a.security_version AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible') THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('origins',v_origins,'days',v_days,'today',v_today,'lastReadAt',v_read,'now',clock_timestamp()::text);
 END $$;

DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('attendance.migration_role')); END $$;
REVOKE CREATE ON SCHEMA attendance FROM frequency_portal_bridge_v2;
REVOKE frequency_portal_bridge_v2 FROM CURRENT_USER;
COMMIT;
