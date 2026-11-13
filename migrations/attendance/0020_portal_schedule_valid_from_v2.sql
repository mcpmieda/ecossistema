-- Fix (13/11/2026): the Frequência names the subject of an absence from the class's CURRENT grid. For
-- a day before that grid was first read, the subject may have been another one (a lesson swapped in
-- the Horário). read_portal_schedule_v1 now also says from when the current grid holds: 'validFrom',
-- the school day (America/Bahia) its version was first observed (schedule_version_v2.observed_at, not
-- the state's last_observed_at, which moves on every collection). The Portal names the subject only
-- from that day on. 'observedAt' (the Horário's "Atualizado em") is unchanged; same checks and grants.
-- DEPLOY ORDER: apply AFTER the server is published. The server before this change checks the
-- reader's answer with a strict schema (frequency-v2 gridSchema, schedule-v1 readSchema): applied
-- first, 'validFrom' is rejected, the Horário answers 503 and the Frequência's year read fails for
-- every student with the Horário on. Pages still open with the bundle from before also reject the
-- key in the Frequência (strict grid) until reloaded: apply it out of school hours.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
GRANT CREATE ON SCHEMA attendance TO frequency_portal_bridge_v2;
GRANT frequency_portal_bridge_v2 TO CURRENT_USER;
-- Replace as the reader's owner (attendance 0011/0013); back to the migration's own role afterwards.
SELECT set_config('attendance.migration_role',current_user,true);
SET LOCAL ROLE frequency_portal_bridge_v2;

CREATE OR REPLACE FUNCTION attendance.read_portal_schedule_v1(p_account uuid,p_session uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_uid uuid;v_classes jsonb; BEGIN
  SELECT a.student_uid INTO v_uid FROM student_portal.account a JOIN student_portal.session s ON s.account_id=a.id
   WHERE a.id=p_account AND s.id=p_session AND a.academic_year=2026 AND a.gradebook_student_id IS NOT NULL
    AND a.closed_at IS NULL AND NOT a.blocked AND a.eligibility='eligible'
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.security_version=a.security_version;
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('label',data.label,'observedAt',data.observed_at,'validFrom',data.valid_from,'lessons',data.lessons)
   ORDER BY data.label),'[]'::jsonb) INTO v_classes FROM (
   SELECT DISTINCT ON(r.class_id) v.source_class_label AS label,st.last_observed_at::text AS observed_at,
    (v.observed_at AT TIME ZONE 'America/Bahia')::date::text AS valid_from,v.lessons_json AS lessons
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

DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('attendance.migration_role')); END $$;
REVOKE CREATE ON SCHEMA attendance FROM frequency_portal_bridge_v2;
REVOKE frequency_portal_bridge_v2 FROM CURRENT_USER;
COMMIT;
