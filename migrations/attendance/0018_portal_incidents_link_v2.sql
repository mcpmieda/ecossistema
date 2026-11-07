-- Audit finding (owner approval 04/11/2026), with 0017: the Portal's incident readers (0016) show a
-- record, and accept its "Estou ciente", only while its link to the student still holds in the
-- Conciliação, revalidated with gradebook.reconciliation_evidence_valid_v2 like the Frequência and
-- the Horário (0003, 0011, 0012). The same functions, owner and grants; only the link check is new.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
GRANT CREATE ON SCHEMA attendance TO frequency_portal_bridge_v2;
GRANT frequency_portal_bridge_v2 TO CURRENT_USER;
SELECT set_config('attendance.migration_role',current_user,true);
SET LOCAL ROLE frequency_portal_bridge_v2;

CREATE OR REPLACE FUNCTION attendance.read_portal_incidents_v1(p_account uuid,p_session uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_incidents jsonb; BEGIN
  v_uid:=attendance.portal_session_student_v1(p_account,p_session);
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'kind',v.kind,'date',v.occurred_on,'classLabel',v.source_class_label,
    'leaveFrom',v.leave_from,'leaveTo',v.leave_to,'leaveDays',v.leave_days,'description',v.description,'acknowledgedAt',k.acknowledged_at)
   ORDER BY v.occurred_on DESC,i.first_seen_at DESC,v.id),'[]'::jsonb) INTO v_incidents
  FROM attendance.incident_v2 i
  JOIN attendance.incident_version_v2 v ON v.id=i.current_version_id
  LEFT JOIN attendance.incident_ack_v2 k ON k.version_id=v.id
  WHERE i.academic_year=2026 AND i.student_uid=v_uid AND i.removed_at IS NULL
   AND gradebook.reconciliation_evidence_valid_v2(i.academic_year,i.student_uid,i.class_id,i.source_ids_json,i.observation_ids_json);
  -- Recheck with the database clock after the read; a long wait never extends a session.
  IF attendance.portal_session_student_v1(p_account,p_session) IS DISTINCT FROM v_uid THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('incidents',v_incidents);
 END $$;

CREATE OR REPLACE FUNCTION attendance.acknowledge_portal_incident_v1(p_account uuid,p_session uuid,p_version uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_at timestamptz; BEGIN
  v_uid:=attendance.portal_session_student_v1(p_account,p_session);
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  -- No lock (the bridge has no UPDATE): a collection replacing the version meanwhile leaves this
  -- confirmation on the old one, and the new one open, as an edit after it would.
  PERFORM 1 FROM attendance.incident_v2 i
   WHERE i.academic_year=2026 AND i.student_uid=v_uid AND i.removed_at IS NULL AND i.current_version_id=p_version
    AND gradebook.reconciliation_evidence_valid_v2(i.academic_year,i.student_uid,i.class_id,i.source_ids_json,i.observation_ids_json);
  IF NOT FOUND THEN RETURN jsonb_build_object('state','changed'); END IF;
  INSERT INTO attendance.incident_ack_v2(academic_year,version_id,account_id) VALUES(2026,p_version,p_account)
   ON CONFLICT(version_id) DO NOTHING;
  SELECT acknowledged_at INTO v_at FROM attendance.incident_ack_v2 WHERE version_id=p_version;
  RETURN jsonb_build_object('state','acknowledged','acknowledgedAt',v_at);
 END $$;

DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('attendance.migration_role')); END $$;
REVOKE CREATE ON SCHEMA attendance FROM frequency_portal_bridge_v2;
REVOKE frequency_portal_bridge_v2 FROM CURRENT_USER;
COMMIT;
