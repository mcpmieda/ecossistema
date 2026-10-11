-- #1269 / #1276. Candidate, apply once after core 0015 and Portal 0025.
-- No production reset or historical migration replay is authorized by this file.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(613,0);

ALTER TABLE student_portal.year_reset_preview_proof
 ADD COLUMN reconciliation_generation uuid,
 ADD COLUMN reconciliation_revision bigint CHECK(reconciliation_revision>=0),
 ADD COLUMN reconciliation_staging_digest text CHECK(reconciliation_staging_digest ~ '^[a-f0-9]{64}$');

CREATE FUNCTION student_portal.reset_reconciliation_state_v1(p_year smallint)
RETURNS TABLE(generation uuid,revision bigint,has_data boolean,staging_digest text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT s.generation,s.revision,
   EXISTS(SELECT 1 FROM gradebook.student_report_batch_v1 b WHERE b.academic_year=s.academic_year),
   encode(sha256(convert_to(jsonb_build_array(
     (SELECT jsonb_agg(jsonb_build_array(c.account_id,c.batch_id,c.prepared,c.expected_account_version,c.expires_at)
       ORDER BY c.batch_id,c.account_id) FROM student_portal.reconciliation_credential_stage_v1 c WHERE c.academic_year=p_year),
     (SELECT jsonb_agg(jsonb_build_array(a.batch_id,a.expires_at) ORDER BY a.batch_id)
       FROM student_portal.reconciliation_credential_attempt_v1 a WHERE a.academic_year=p_year),
     (SELECT jsonb_agg(jsonb_build_array(m.account_id,m.version,m.observation_id) ORDER BY m.account_id)
       FROM student_portal.reconciliation_birth_v1 m WHERE m.academic_year=p_year)
   )::text,'UTF8')),'hex')
 FROM gradebook.student_reconciliation_scope_v1 s WHERE s.academic_year=p_year
$$;
ALTER FUNCTION student_portal.reset_reconciliation_state_v1(smallint) OWNER TO student_reconciliation_bridge_v1;
REVOKE ALL ON FUNCTION student_portal.reset_reconciliation_state_v1(smallint) FROM PUBLIC,student_portal_app;
GRANT EXECUTE ON FUNCTION student_portal.reset_reconciliation_state_v1(smallint) TO gradebook_app;
DO $$ DECLARE owner_name text; runtime_role text; BEGIN
 FOR owner_name IN SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc
  WHERE oid IN ('student_portal.prepare_year_reset_v1(smallint,text,text)'::regprocedure,
    'student_portal.consume_year_reset_v1(smallint,text,text)'::regprocedure) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION student_portal.reset_reconciliation_state_v1(smallint) TO %I',owner_name);
 END LOOP;
 FOR runtime_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION student_portal.reset_reconciliation_state_v1(smallint) FROM %I',runtime_role);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION student_portal.prepare_year_reset_v1(p_year smallint,p_actor text,p_token text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,student_portal AS $$
DECLARE r student_portal.academic_revision%ROWTYPE; c record; issued timestamptz;
BEGIN
 PERFORM student_portal.assert_year_reset_locks_v1(p_year,false);
 IF p_actor IS NULL OR p_actor !~ '^[a-f0-9]{64}$' OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'year-reset-invalid-proof' USING ERRCODE='22023';
 END IF;
 SELECT * INTO c FROM student_portal.reset_reconciliation_state_v1(p_year);
 IF NOT EXISTS(SELECT 1 FROM gradebook.ano_letivo WHERE ano=p_year) AND NOT COALESCE(c.has_data,false) THEN
  RETURN 'not-found';
 END IF;
 SELECT * INTO r FROM student_portal.academic_revision WHERE academic_year=p_year FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'year-reset-coordination-missing' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM student_portal.account WHERE academic_year=p_year AND gradebook_student_id IS NOT NULL) THEN
  RETURN 'portal-linked-accounts';
 END IF;
 issued:=clock_timestamp();
 INSERT INTO student_portal.year_reset_preview_proof(token_digest,actor_digest,academic_year,issued_at,expires_at,
  academic_revision,reset_revision,portal_link_revision,reconciliation_generation,reconciliation_revision,reconciliation_staging_digest)
 VALUES(p_token,p_actor,p_year,issued,issued+interval '5 minutes',
  r.academic_generation||':'||r.academic_counter::text,r.reset_generation||':'||r.reset_counter::text,
  r.portal_link_generation||':'||r.portal_link_counter::text,c.generation,c.revision,c.staging_digest);
 RETURN 'clear';
END $$;

CREATE OR REPLACE FUNCTION student_portal.consume_year_reset_v1(p_year smallint,p_actor text,p_token text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,student_portal AS $$
DECLARE r student_portal.academic_revision%ROWTYPE; c record; affected integer;
BEGIN
 PERFORM student_portal.assert_year_reset_locks_v1(p_year,true);
 SELECT * INTO c FROM student_portal.reset_reconciliation_state_v1(p_year);
 IF NOT EXISTS(SELECT 1 FROM gradebook.ano_letivo WHERE ano=p_year) AND NOT COALESCE(c.has_data,false) THEN
  RETURN 'preview-changed';
 END IF;
 SELECT * INTO r FROM student_portal.academic_revision WHERE academic_year=p_year FOR UPDATE;
 IF NOT FOUND THEN RETURN 'preview-changed'; END IF;
 IF EXISTS(SELECT 1 FROM student_portal.account WHERE academic_year=p_year AND gradebook_student_id IS NOT NULL) THEN
  RETURN 'portal-linked-accounts';
 END IF;
 UPDATE student_portal.year_reset_preview_proof SET consumed_at=clock_timestamp(),consumed_transaction=pg_current_xact_id()
 WHERE token_digest=p_token AND actor_digest=p_actor AND academic_year=p_year AND consumed_at IS NULL
  AND issued_at<=clock_timestamp() AND expires_at>clock_timestamp()
  AND academic_revision=r.academic_generation||':'||r.academic_counter::text
  AND reset_revision=r.reset_generation||':'||r.reset_counter::text
  AND portal_link_revision=r.portal_link_generation||':'||r.portal_link_counter::text
  AND reconciliation_generation IS NOT DISTINCT FROM c.generation
  AND reconciliation_revision IS NOT DISTINCT FROM c.revision
  AND reconciliation_staging_digest IS NOT DISTINCT FROM c.staging_digest;
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN CASE WHEN affected=1 THEN 'clear' ELSE 'preview-changed' END;
END $$;
REVOKE ALL ON FUNCTION student_portal.prepare_year_reset_v1(smallint,text,text),
 student_portal.consume_year_reset_v1(smallint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION student_portal.prepare_year_reset_v1(smallint,text,text),
 student_portal.consume_year_reset_v1(smallint,text,text) TO gradebook_app;
COMMIT;
