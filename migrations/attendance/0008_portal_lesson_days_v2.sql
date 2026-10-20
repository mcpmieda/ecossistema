-- Owner decision 20/10/2026: the Portal reads the student's lesson days from the Smecel diary
-- (the positions with a point, an X or a justified mark), so 5- or 6-lesson days, weekends,
-- holidays and days outside the enrolment need no configuration. Additive: the v2 reader stays
-- for the Worker in production until the new one is deployed; apply this BEFORE that Worker.
-- The bridge gains SELECT on coverage only; the function keeps the v2 session and identity checks.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
GRANT SELECT ON attendance.coverage_v2 TO frequency_portal_bridge_v2;
CREATE POLICY frequency_portal_read_v2 ON attendance.coverage_v2 FOR SELECT TO frequency_portal_bridge_v2 USING(true);

CREATE FUNCTION attendance.read_portal_frequency_v3(p_account uuid,p_session uuid,p_month text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_origins jsonb;v_days jsonb; BEGIN
  IF p_month IS NULL OR p_month!~'^2026-(0[1-9]|1[0-2])$' THEN RETURN NULL; END IF;
  SELECT a.student_uid INTO v_uid FROM student_portal.account a JOIN student_portal.session s ON s.account_id=a.id
   WHERE a.id=p_account AND s.id=p_session AND a.academic_year=2026 AND a.gradebook_student_id IS NOT NULL
    AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible'
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.security_version=a.security_version;
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  -- Marks: exactly the v2 reader.
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
   WHERE o.academic_year=2026 AND o.student_uid=v_uid AND o.date>=(p_month||'-01')::date
    AND o.date<((p_month||'-01')::date+interval '1 month')
   GROUP BY o.id,c.id,b.source_class_label ORDER BY o.date,o.shift,o.slot,b.source_class_label
  ) data;
  -- Lesson days: the latest coverage per class, record and date (each collection stores only the
  -- days that changed), and only rows whose identity evidence is still valid.
  SELECT coalesce(jsonb_agg(to_jsonb(data) ORDER BY data.date,data.shift),'[]'::jsonb) INTO v_days FROM (
   SELECT latest.date::text,latest.shift,latest.slots_json,latest.complete FROM (
    SELECT DISTINCT ON(b.class_id,c.record_key,c.date) c.date,b.shift,c.slots_json,c.complete,
     gradebook.reconciliation_evidence_valid_v2(b.academic_year,s.student_uid,b.class_id,s.source_ids_json,s.observation_ids_json) AS mapping_valid
    FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id
    JOIN attendance.source_row_v2 s ON s.batch_id=c.batch_id AND s.record_key=c.record_key
    WHERE b.academic_year=2026 AND s.student_uid=v_uid AND c.date>=(p_month||'-01')::date
     AND c.date<((p_month||'-01')::date+interval '1 month')
    ORDER BY b.class_id,c.record_key,c.date,b.received_at DESC,b.id DESC
   ) latest WHERE latest.mapping_valid
  ) data;
  -- Recheck with the database clock after the read; a long wait never extends a session.
  IF NOT EXISTS(SELECT 1 FROM student_portal.session s JOIN student_portal.account a ON a.id=s.account_id
   WHERE s.id=p_session AND a.id=p_account AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND s.security_version=a.security_version AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible') THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('origins',v_origins,'days',v_days);
 END $$;
REVOKE ALL ON FUNCTION attendance.read_portal_frequency_v3(uuid,uuid,text) FROM PUBLIC,anon,authenticated,gradebook_app;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='collector_runtime') THEN
  REVOKE ALL ON FUNCTION attendance.read_portal_frequency_v3(uuid,uuid,text) FROM collector_runtime;
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION attendance.read_portal_frequency_v3(uuid,uuid,text) TO student_portal_app;
GRANT CREATE ON SCHEMA attendance TO frequency_portal_bridge_v2;
GRANT frequency_portal_bridge_v2 TO CURRENT_USER;
ALTER FUNCTION attendance.read_portal_frequency_v3(uuid,uuid,text) OWNER TO frequency_portal_bridge_v2;
REVOKE CREATE ON SCHEMA attendance FROM frequency_portal_bridge_v2;
REVOKE frequency_portal_bridge_v2 FROM CURRENT_USER;
COMMIT;
