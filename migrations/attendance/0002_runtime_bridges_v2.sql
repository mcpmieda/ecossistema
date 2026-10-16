-- #1289. Scaffold: 20261014162122_attendance_runtime_bridges_v2.sql. Candidate only.
BEGIN;
CREATE FUNCTION gradebook.reconciliation_evidence_valid_v2(p_year smallint,p_uid uuid,p_class integer,p_sources jsonb,p_observations jsonb)
 RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT p_year=2026 AND p_uid IS NOT NULL AND jsonb_typeof(p_sources)='array' AND jsonb_typeof(p_observations)='array'
  AND jsonb_array_length(p_sources)>0 AND jsonb_array_length(p_observations)>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_sources) i
   LEFT JOIN gradebook.student_source_record_v1 r ON r.id=i.value::uuid AND r.academic_year=p_year
   LEFT JOIN gradebook.student_source_link_v1 l ON l.source_id=r.id AND l.academic_year=r.academic_year
   WHERE r.id IS NULL OR r.review_required OR l.student_uid IS DISTINCT FROM p_uid OR l.review_required)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_observations) i
   LEFT JOIN gradebook.student_source_observation_v1 o ON o.id=i.value::uuid AND o.academic_year=p_year
   LEFT JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id AND c.academic_year=o.academic_year
   WHERE o.id IS NULL OR c.gradebook_class_id IS DISTINCT FROM p_class OR c.review_required
    OR NOT p_sources @> jsonb_build_array(o.source_id::text));
 $$;
REVOKE ALL ON FUNCTION gradebook.reconciliation_evidence_valid_v2(smallint,uuid,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated,student_portal_app,collector_runtime;
GRANT EXECUTE ON FUNCTION gradebook.reconciliation_evidence_valid_v2(smallint,uuid,integer,jsonb,jsonb) TO gradebook_app;
GRANT USAGE ON SCHEMA attendance,student_portal TO frequency_bridge_v2;
GRANT SELECT(academic_year,reset_generation,reset_counter) ON student_portal.academic_revision TO frequency_bridge_v2;
GRANT UPDATE(reset_counter,updated_at) ON student_portal.academic_revision TO frequency_bridge_v2;
CREATE POLICY frequency_reset_bridge_v2 ON student_portal.academic_revision TO frequency_bridge_v2
 USING(academic_year=2026) WITH CHECK(academic_year=2026);
CREATE FUNCTION attendance.record_reset_write_v2(p_year smallint) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_version text; BEGIN
  IF p_year<>2026 OR p_year IS NULL THEN RAISE EXCEPTION 'frequency-year-invalid' USING ERRCODE='22023'; END IF;
  PERFORM student_portal.assert_year_reset_locks_v1(p_year,false);
  UPDATE student_portal.academic_revision SET reset_counter=reset_counter+1,updated_at=clock_timestamp()
   WHERE academic_year=p_year RETURNING reset_generation||':'||reset_counter::text INTO v_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'frequency-reset-state-missing' USING ERRCODE='55000'; END IF;
  RETURN v_version;
 END $$;
GRANT EXECUTE ON FUNCTION student_portal.assert_year_reset_locks_v1(smallint,boolean) TO frequency_bridge_v2;
REVOKE ALL ON FUNCTION attendance.record_reset_write_v2(smallint) FROM PUBLIC,anon,authenticated,student_portal_app,collector_runtime;
GRANT EXECUTE ON FUNCTION attendance.record_reset_write_v2(smallint) TO gradebook_app;
GRANT CREATE ON SCHEMA attendance TO frequency_bridge_v2;
GRANT frequency_bridge_v2 TO CURRENT_USER;
ALTER FUNCTION attendance.record_reset_write_v2(smallint) OWNER TO frequency_bridge_v2;
REVOKE CREATE ON SCHEMA attendance FROM frequency_bridge_v2;
REVOKE frequency_bridge_v2 FROM CURRENT_USER;
COMMIT;
