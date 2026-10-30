-- Owner decisions 29/10/2026: the Portal's "Ocorrências" tab (policy showIncidents, student-portal
-- 0032) shows the student's own Smecel records (attendance 0014) and keeps the family's
-- "Estou ciente dessa ocorrência". Depends on 0014.
--
--   * attendance.read_portal_incidents_v1(account, session): the current version of every record
--     linked to the account's student in the year, still in the Smecel (removed_at IS NULL), newest
--     first, each with the whole description and its confirmation (on THAT version: an edit in the
--     Smecel is a new version, open again).
--   * attendance.acknowledge_portal_incident_v1(account, session, version): the confirmation, for
--     the signed-in account. Only the current version of a record of the account's own student;
--     definitive (a repeat returns the first moment). 'changed' when that version is no longer the
--     current one (the school edited or removed it), so the Portal reads again.
-- The same session and identity checks as the Horário reader (0011/0013). Additive: the bridge gains
-- SELECT on the incident tables and INSERT on the confirmations only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['incident_v2','incident_version_v2','incident_ack_v2'] LOOP
  EXECUTE format('GRANT SELECT ON attendance.%I TO frequency_portal_bridge_v2',item);
  EXECUTE format('CREATE POLICY frequency_portal_read_v2 ON attendance.%I FOR SELECT TO frequency_portal_bridge_v2 USING(true)',item);
 END LOOP;
END $$;
GRANT INSERT ON attendance.incident_ack_v2 TO frequency_portal_bridge_v2;
CREATE POLICY frequency_portal_ack_v2 ON attendance.incident_ack_v2 FOR INSERT TO frequency_portal_bridge_v2 WITH CHECK(true);
GRANT CREATE ON SCHEMA attendance TO frequency_portal_bridge_v2;
GRANT frequency_portal_bridge_v2 TO CURRENT_USER;
-- Create as the readers' owner; back to the migration's own role (saved here) before the grants.
SELECT set_config('attendance.migration_role',current_user,true);
SET LOCAL ROLE frequency_portal_bridge_v2;

-- The account's student while its session is valid (the database clock), or NULL.
CREATE FUNCTION attendance.portal_session_student_v1(p_account uuid,p_session uuid) RETURNS uuid
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT a.student_uid FROM student_portal.account a JOIN student_portal.session s ON s.account_id=a.id
  WHERE a.id=p_account AND s.id=p_session AND a.academic_year=2026 AND a.gradebook_student_id IS NOT NULL
   AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible'
   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.security_version=a.security_version $$;

CREATE FUNCTION attendance.read_portal_incidents_v1(p_account uuid,p_session uuid) RETURNS jsonb
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
  WHERE i.academic_year=2026 AND i.student_uid=v_uid AND i.removed_at IS NULL;
  -- Recheck with the database clock after the read; a long wait never extends a session.
  IF attendance.portal_session_student_v1(p_account,p_session) IS DISTINCT FROM v_uid THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('incidents',v_incidents);
 END $$;

CREATE FUNCTION attendance.acknowledge_portal_incident_v1(p_account uuid,p_session uuid,p_version uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_at timestamptz; BEGIN
  v_uid:=attendance.portal_session_student_v1(p_account,p_session);
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  -- No lock (the bridge has no UPDATE): a collection replacing the version meanwhile leaves this
  -- confirmation on the old one, and the new one open, as an edit after it would.
  PERFORM 1 FROM attendance.incident_v2 i
   WHERE i.academic_year=2026 AND i.student_uid=v_uid AND i.removed_at IS NULL AND i.current_version_id=p_version;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','changed'); END IF;
  INSERT INTO attendance.incident_ack_v2(academic_year,version_id,account_id) VALUES(2026,p_version,p_account)
   ON CONFLICT(version_id) DO NOTHING;
  SELECT acknowledged_at INTO v_at FROM attendance.incident_ack_v2 WHERE version_id=p_version;
  RETURN jsonb_build_object('state','acknowledged','acknowledgedAt',v_at);
 END $$;

DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('attendance.migration_role')); END $$;
REVOKE ALL ON FUNCTION attendance.portal_session_student_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,gradebook_app,student_portal_app;
REVOKE ALL ON FUNCTION attendance.read_portal_incidents_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,gradebook_app;
REVOKE ALL ON FUNCTION attendance.acknowledge_portal_incident_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,gradebook_app;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='collector_runtime') THEN
  REVOKE ALL ON FUNCTION attendance.read_portal_incidents_v1(uuid,uuid) FROM collector_runtime;
  REVOKE ALL ON FUNCTION attendance.acknowledge_portal_incident_v1(uuid,uuid,uuid) FROM collector_runtime;
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION attendance.read_portal_incidents_v1(uuid,uuid) TO student_portal_app;
GRANT EXECUTE ON FUNCTION attendance.acknowledge_portal_incident_v1(uuid,uuid,uuid) TO student_portal_app;
REVOKE CREATE ON SCHEMA attendance FROM frequency_portal_bridge_v2;
REVOKE frequency_portal_bridge_v2 FROM CURRENT_USER;
COMMIT;
