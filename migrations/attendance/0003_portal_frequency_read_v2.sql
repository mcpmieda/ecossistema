-- #1289. Supabase CLI scaffold portal_frequency_read_v2; repository slot 0003.
-- Candidate only. Portal app gets one owner/session-bound read function, never table access.
BEGIN;
CREATE ROLE frequency_portal_bridge_v2 NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA attendance,gradebook,student_portal TO frequency_portal_bridge_v2;
GRANT SELECT(id,academic_year,student_uid,gradebook_student_id,blocked,closed_at,eligibility,security_version) ON student_portal.account TO frequency_portal_bridge_v2;
GRANT SELECT(id,account_id,security_version,expires_at,revoked_at) ON student_portal.session TO frequency_portal_bridge_v2;
CREATE POLICY frequency_portal_accounts_v2 ON student_portal.account FOR SELECT TO frequency_portal_bridge_v2 USING(academic_year=2026);
CREATE POLICY frequency_portal_sessions_v2 ON student_portal.session FOR SELECT TO frequency_portal_bridge_v2
 USING(EXISTS(SELECT 1 FROM student_portal.account a WHERE a.id=account_id AND a.academic_year=2026));
GRANT SELECT ON gradebook.student_source_record_v1,gradebook.student_source_link_v1,gradebook.student_source_observation_v1,gradebook.student_report_class_v1 TO frequency_portal_bridge_v2;
CREATE POLICY frequency_portal_source_record_v2 ON gradebook.student_source_record_v1 FOR SELECT TO frequency_portal_bridge_v2 USING(academic_year=2026);
CREATE POLICY frequency_portal_source_link_v2 ON gradebook.student_source_link_v1 FOR SELECT TO frequency_portal_bridge_v2 USING(academic_year=2026);
CREATE POLICY frequency_portal_source_observation_v2 ON gradebook.student_source_observation_v1 FOR SELECT TO frequency_portal_bridge_v2 USING(academic_year=2026);
CREATE POLICY frequency_portal_source_class_v2 ON gradebook.student_report_class_v1 FOR SELECT TO frequency_portal_bridge_v2 USING(academic_year=2026);
GRANT EXECUTE ON FUNCTION gradebook.reconciliation_evidence_valid_v2(smallint,uuid,integer,jsonb,jsonb) TO frequency_portal_bridge_v2;
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['occurrence_v2','origin_v2','source_row_v2','batch_v2','class_state_v2','conflict_v2'] LOOP
  EXECUTE format('GRANT SELECT ON attendance.%I TO frequency_portal_bridge_v2',item);
  EXECUTE format('CREATE POLICY frequency_portal_read_v2 ON attendance.%I FOR SELECT TO frequency_portal_bridge_v2 USING(true)',item);
 END LOOP;
END $$;
CREATE FUNCTION attendance.read_portal_origins_v2(p_account uuid,p_session uuid,p_month text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_rows jsonb; BEGIN
  IF p_month IS NULL OR p_month!~'^2026-(0[1-9]|1[0-2])$' THEN RETURN NULL; END IF;
  SELECT a.student_uid INTO v_uid FROM student_portal.account a JOIN student_portal.session s ON s.account_id=a.id
   WHERE a.id=p_account AND s.id=p_session AND a.academic_year=2026 AND a.gradebook_student_id IS NOT NULL
    AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible'
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.security_version=a.security_version;
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(data)),'[]'::jsonb) INTO v_rows FROM (
   SELECT o.id::text AS occurrence_id,o.date::text,o.slot,o.shift,o.mark,c.id::text AS conflict_id,b.source_class_label,
    max(CASE WHEN cs.last_batch_id=b.id THEN cs.last_observed_at ELSE b.observed_at END)::text AS observed_at,
    max(CASE WHEN cs.last_batch_id=b.id THEN cs.last_received_at ELSE b.received_at END)::text AS received_at,
    bool_and(gradebook.reconciliation_evidence_valid_v2(b.academic_year,s.student_uid,b.class_id,s.source_ids_json,s.observation_ids_json)) AS mapping_valid
   FROM attendance.occurrence_v2 o JOIN attendance.origin_v2 p ON p.occurrence_id=o.id
   JOIN attendance.source_row_v2 s ON s.batch_id=p.batch_id AND s.record_key=p.record_key
   JOIN attendance.batch_v2 b ON b.id=p.batch_id
   LEFT JOIN attendance.class_state_v2 cs ON cs.academic_year=b.academic_year AND cs.class_id=b.class_id
   LEFT JOIN attendance.conflict_v2 c ON c.occurrence_id=o.id AND c.state='open'
   WHERE o.academic_year=2026 AND o.student_uid=v_uid AND o.date>=(p_month||'-01')::date
    AND o.date<((p_month||'-01')::date+interval '1 month')
   GROUP BY o.id,c.id,b.source_class_label ORDER BY o.date,o.shift,o.slot,b.source_class_label
  ) data;
  -- Recheck with the database clock after the read; a long wait never extends a session.
  IF NOT EXISTS(SELECT 1 FROM student_portal.session s JOIN student_portal.account a ON a.id=s.account_id
   WHERE s.id=p_session AND a.id=p_account AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND s.security_version=a.security_version AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible') THEN RETURN NULL; END IF;
  RETURN v_rows;
 END $$;
REVOKE ALL ON FUNCTION attendance.read_portal_origins_v2(uuid,uuid,text) FROM PUBLIC,anon,authenticated,gradebook_app,collector_runtime;
GRANT USAGE ON SCHEMA attendance TO student_portal_app;
GRANT EXECUTE ON FUNCTION attendance.read_portal_origins_v2(uuid,uuid,text) TO student_portal_app;
GRANT CREATE ON SCHEMA attendance TO frequency_portal_bridge_v2;
GRANT frequency_portal_bridge_v2 TO CURRENT_USER;
ALTER FUNCTION attendance.read_portal_origins_v2(uuid,uuid,text) OWNER TO frequency_portal_bridge_v2;
REVOKE CREATE ON SCHEMA attendance FROM frequency_portal_bridge_v2;
REVOKE frequency_portal_bridge_v2 FROM CURRENT_USER;
COMMIT;
