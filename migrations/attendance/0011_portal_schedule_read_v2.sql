-- Owner decision 22/10/2026: the Portal's "Horário" tab shows the weekly grid of the student's own
-- class(es), as the collector read it from the Smecel (attendance 0010). Depends on 0010.
--
-- The student's classes are the ones whose CURRENT diary (class_state_v2.last_batch_id) lists the
-- student with valid identity evidence and an enrolment that has not ended (a student moved to
-- another class keeps the old diary row with a transfer date). A regular class plus a complementary
-- one (integral, AEE) gives two grids. The same session and identity checks as the frequency reader.
-- Additive: the bridge gains SELECT on the two grid tables only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['schedule_version_v2','schedule_state_v2'] LOOP
  EXECUTE format('GRANT SELECT ON attendance.%I TO frequency_portal_bridge_v2',item);
  EXECUTE format('CREATE POLICY frequency_portal_read_v2 ON attendance.%I FOR SELECT TO frequency_portal_bridge_v2 USING(true)',item);
 END LOOP;
END $$;

-- An enrolment in the class still open on p_today: no enrolment evidence at all (as the frequency's
-- outsideEnrollment), or one without a transfer date or transferred on/after p_today.
CREATE FUNCTION attendance.portal_enrolment_open_v1(p_eligibility jsonb,p_today date) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_array_length(p_eligibility)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_eligibility) e
  WHERE e->>'endsOn' IS NULL OR (e->>'endsOn')::date>=p_today) $$;

CREATE FUNCTION attendance.read_portal_schedule_v1(p_account uuid,p_session uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_today date;v_classes jsonb; BEGIN
  SELECT a.student_uid INTO v_uid FROM student_portal.account a JOIN student_portal.session s ON s.account_id=a.id
   WHERE a.id=p_account AND s.id=p_session AND a.academic_year=2026 AND a.gradebook_student_id IS NOT NULL
    AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible'
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.security_version=a.security_version;
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  v_today:=(clock_timestamp() AT TIME ZONE 'America/Bahia')::date;
  SELECT coalesce(jsonb_agg(jsonb_build_object('label',data.label,'observedAt',data.observed_at,'lessons',data.lessons)
   ORDER BY data.label),'[]'::jsonb) INTO v_classes FROM (
   SELECT DISTINCT ON(cs.class_id) v.source_class_label AS label,st.last_observed_at::text AS observed_at,v.lessons_json AS lessons
   FROM attendance.class_state_v2 cs
   JOIN attendance.source_row_v2 s ON s.batch_id=cs.last_batch_id
   JOIN attendance.batch_v2 b ON b.id=cs.last_batch_id
   JOIN attendance.schedule_state_v2 st ON st.academic_year=cs.academic_year AND st.class_id=cs.class_id
   JOIN attendance.schedule_version_v2 v ON v.id=st.current_version_id
   WHERE cs.academic_year=2026 AND s.student_uid=v_uid
    AND gradebook.reconciliation_evidence_valid_v2(b.academic_year,s.student_uid,b.class_id,s.source_ids_json,s.observation_ids_json)
    -- An enrolment that ended (transferred out of this class) before today no longer counts.
    AND attendance.portal_enrolment_open_v1(s.eligibility_json,v_today)
   ORDER BY cs.class_id
  ) data;
  -- Recheck with the database clock after the read; a long wait never extends a session.
  IF NOT EXISTS(SELECT 1 FROM student_portal.session s JOIN student_portal.account a ON a.id=s.account_id
   WHERE s.id=p_session AND a.id=p_account AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND s.security_version=a.security_version AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible') THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('classes',v_classes);
 END $$;
REVOKE ALL ON FUNCTION attendance.portal_enrolment_open_v1(jsonb,date) FROM PUBLIC,anon,authenticated,gradebook_app,student_portal_app;
REVOKE ALL ON FUNCTION attendance.read_portal_schedule_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,gradebook_app;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='collector_runtime') THEN
  REVOKE ALL ON FUNCTION attendance.read_portal_schedule_v1(uuid,uuid) FROM collector_runtime;
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION attendance.read_portal_schedule_v1(uuid,uuid) TO student_portal_app;
GRANT CREATE ON SCHEMA attendance TO frequency_portal_bridge_v2;
GRANT frequency_portal_bridge_v2 TO CURRENT_USER;
ALTER FUNCTION attendance.portal_enrolment_open_v1(jsonb,date) OWNER TO frequency_portal_bridge_v2;
ALTER FUNCTION attendance.read_portal_schedule_v1(uuid,uuid) OWNER TO frequency_portal_bridge_v2;
REVOKE CREATE ON SCHEMA attendance FROM frequency_portal_bridge_v2;
REVOKE frequency_portal_bridge_v2 FROM CURRENT_USER;
COMMIT;
