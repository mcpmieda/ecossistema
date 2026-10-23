-- Fix (23/10/2026): since the collector sends only what changed (attendance 0010, "sem
-- repetição"), a class's latest reading (class_state_v2.last_batch_id) stores source rows ONLY for the
-- students whose diary changed. The Horário (read_portal_schedule_v1) and the Frequência's "last
-- reading" (read_portal_frequency_v4) looked for the student in that latest reading alone, so a student
-- whose diary did not change in the last collection saw "no grid" and no "Atualizado em".
--
-- attendance.portal_current_rows_v1(student): the student's CURRENT row in each class, i.e. for each
-- (class, ficha) the student ever appeared under, the latest stored row of that ficha in that class,
-- kept only when it is still this student with valid identity evidence and an open enrolment. The same
-- rule the server uses for a class's roster (service-v2: the latest row of every record_key).
-- Both readers now use it; nothing else changes (same session checks, same answer shape, same grants).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
GRANT CREATE ON SCHEMA attendance TO frequency_portal_bridge_v2;
GRANT frequency_portal_bridge_v2 TO CURRENT_USER;
-- Create as the readers' owner; back to the migration's own role (saved here) before the grants.
SELECT set_config('attendance.migration_role',current_user,true);
SET LOCAL ROLE frequency_portal_bridge_v2;

CREATE FUNCTION attendance.portal_current_rows_v1(p_uid uuid)
 RETURNS TABLE(academic_year smallint,class_id integer,record_key text)
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT latest.academic_year,latest.class_id,latest.record_key FROM (
  SELECT DISTINCT ON(b.class_id,s.record_key) b.academic_year,b.class_id,s.record_key,s.student_uid,
   s.source_ids_json,s.observation_ids_json,s.eligibility_json
  FROM (SELECT DISTINCT b0.class_id,s0.record_key FROM attendance.source_row_v2 s0
         JOIN attendance.batch_v2 b0 ON b0.id=s0.batch_id WHERE b0.academic_year=2026 AND s0.student_uid=p_uid) mine
  JOIN attendance.batch_v2 b ON b.academic_year=2026 AND b.class_id=mine.class_id
  JOIN attendance.source_row_v2 s ON s.batch_id=b.id AND s.record_key=mine.record_key
  ORDER BY b.class_id,s.record_key,b.received_at DESC,b.id DESC
 ) latest
 WHERE latest.student_uid=p_uid
  AND gradebook.reconciliation_evidence_valid_v2(latest.academic_year,latest.student_uid,latest.class_id,latest.source_ids_json,latest.observation_ids_json)
  -- An enrolment that ended (transferred out of this class) before today no longer counts.
  AND attendance.portal_enrolment_open_v1(latest.eligibility_json,(clock_timestamp() AT TIME ZONE 'America/Bahia')::date) $$;

CREATE OR REPLACE FUNCTION attendance.read_portal_schedule_v1(p_account uuid,p_session uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_classes jsonb; BEGIN
  SELECT a.student_uid INTO v_uid FROM student_portal.account a JOIN student_portal.session s ON s.account_id=a.id
   WHERE a.id=p_account AND s.id=p_session AND a.academic_year=2026 AND a.gradebook_student_id IS NOT NULL
    AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible'
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.security_version=a.security_version;
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('label',data.label,'observedAt',data.observed_at,'lessons',data.lessons)
   ORDER BY data.label),'[]'::jsonb) INTO v_classes FROM (
   SELECT DISTINCT ON(r.class_id) v.source_class_label AS label,st.last_observed_at::text AS observed_at,v.lessons_json AS lessons
   FROM attendance.portal_current_rows_v1(v_uid) r
   JOIN attendance.schedule_state_v2 st ON st.academic_year=r.academic_year AND st.class_id=r.class_id
   JOIN attendance.schedule_version_v2 v ON v.id=st.current_version_id
   ORDER BY r.class_id
  ) data;
  -- Recheck with the database clock after the read; a long wait never extends a session.
  IF NOT EXISTS(SELECT 1 FROM student_portal.session s JOIN student_portal.account a ON a.id=s.account_id
   WHERE s.id=p_session AND a.id=p_account AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND s.security_version=a.security_version AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible') THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('classes',v_classes);
 END $$;

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
  -- Marks: exactly the v3 reader, over the range.
  SELECT coalesce(jsonb_agg(to_jsonb(data)),'[]'::jsonb) INTO v_origins FROM (
   SELECT o.id::text AS occurrence_id,o.date::text,o.slot,o.shift,o.mark,c.id::text AS conflict_id,b.source_class_label,
    max(CASE WHEN cs.last_batch_id=b.id THEN cs.last_observed_at ELSE b.observed_at END)::text AS observed_at,
    max(CASE WHEN cs.last_batch_id=b.id THEN cs.last_received_at ELSE b.received_at END)::text AS received_at,
    bool_and(gradebook.reconciliation_evidence_valid_v2(b.academic_year,s.student_uid,b.class_id,s.source_ids_json,s.observation_ids_json)) AS mapping_valid
   FROM attendance.occurrence_v2 o JOIN attendance.origin_v2 p ON p.occurrence_id=o.id
   JOIN attendance.source_row_v2 s ON s.batch_id=p.batch_id AND s.record_key=p.record_key
   JOIN attendance.batch_v2 b ON b.id=p.batch_id
   LEFT JOIN attendance.class_state_v2 cs ON cs.academic_year=b.academic_year AND cs.class_id=b.class_id
   LEFT JOIN attendance.conflict_v2 c ON c.occurrence_id=o.id AND c.state='open'
   WHERE o.academic_year=2026 AND o.student_uid=v_uid AND o.date>=v_from AND o.date<v_until
   GROUP BY o.id,c.id,b.source_class_label ORDER BY o.date,o.shift,o.slot,b.source_class_label
  ) data;
  -- Lesson days: exactly the v3 reader, over the range.
  SELECT coalesce(jsonb_agg(to_jsonb(data) ORDER BY data.date,data.shift),'[]'::jsonb) INTO v_days FROM (
   SELECT latest.date::text,latest.shift,latest.slots_json,latest.complete FROM (
    SELECT DISTINCT ON(b.class_id,c.record_key,c.date) c.date,b.shift,c.slots_json,c.complete,
     gradebook.reconciliation_evidence_valid_v2(b.academic_year,s.student_uid,b.class_id,s.source_ids_json,s.observation_ids_json) AS mapping_valid
    FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id
    JOIN attendance.source_row_v2 s ON s.batch_id=c.batch_id AND s.record_key=c.record_key
    WHERE b.academic_year=2026 AND s.student_uid=v_uid AND c.date>=v_from AND c.date<v_until
    ORDER BY b.class_id,c.record_key,c.date,b.received_at DESC,b.id DESC
   ) latest WHERE latest.mapping_valid
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
REVOKE ALL ON FUNCTION attendance.portal_current_rows_v1(uuid) FROM PUBLIC,anon,authenticated,gradebook_app,student_portal_app;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='collector_runtime') THEN
  REVOKE ALL ON FUNCTION attendance.portal_current_rows_v1(uuid) FROM collector_runtime;
 END IF;
END $$;
REVOKE CREATE ON SCHEMA attendance FROM frequency_portal_bridge_v2;
REVOKE frequency_portal_bridge_v2 FROM CURRENT_USER;
COMMIT;
