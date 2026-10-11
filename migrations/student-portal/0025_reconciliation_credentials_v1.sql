-- #1269 / #1276. Apply only after the reconciliation core migration, once authorized.
-- The application never owns these tables and cannot use this bridge to set an arbitrary PIN.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(613,0);

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='student_reconciliation_bridge_v1') THEN
    CREATE ROLE student_reconciliation_bridge_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='student_reconciliation_bridge_v1'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR rolreplication))
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='student_reconciliation_bridge_v1') THEN
    RAISE EXCEPTION 'student-reconciliation-bridge-role-unsafe';
  END IF;
END $$;
GRANT USAGE ON SCHEMA gradebook,student_portal TO student_reconciliation_bridge_v1;
GRANT SELECT(id,ano,nome,student_uid) ON gradebook.aluno TO student_reconciliation_bridge_v1;
CREATE POLICY reconciliation_bridge_read_v1 ON gradebook.aluno FOR SELECT TO student_reconciliation_bridge_v1 USING(true);

CREATE TABLE student_portal.reconciliation_birth_v1 (
  account_id uuid PRIMARY KEY REFERENCES student_portal.account(id) ON DELETE NO ACTION,
  academic_year smallint NOT NULL CHECK (academic_year=2026),
  student_uid uuid NOT NULL,
  observation_id uuid NOT NULL REFERENCES gradebook.student_source_observation_v1(id) ON DELETE NO ACTION,
  birth_date date NOT NULL,
  version bigint NOT NULL CHECK (version>0),
  first_observation_id uuid NOT NULL,
  first_decision_id uuid NOT NULL,
  legacy_year smallint,
  legacy_confirmation text,
  legacy_version bigint NOT NULL,
  legacy_pin_missing boolean NOT NULL,
  applied_account_version bigint NOT NULL,
  applied_pin_version bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX reconciliation_birth_year_v1 ON student_portal.reconciliation_birth_v1(academic_year);

-- A small expiry tombstone prevents cleanup/retry from renewing a preparation's one-hour lifetime.
CREATE TABLE student_portal.reconciliation_credential_attempt_v1 (
  batch_id uuid PRIMARY KEY REFERENCES gradebook.student_report_batch_v1(id) ON DELETE NO ACTION,
  academic_year smallint NOT NULL CHECK(academic_year=2026),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '1 hour')
);
CREATE INDEX reconciliation_credential_attempt_year_v1 ON student_portal.reconciliation_credential_attempt_v1(academic_year);

CREATE TABLE student_portal.reconciliation_credential_stage_v1 (
  batch_id uuid NOT NULL REFERENCES gradebook.student_report_batch_v1(id) ON DELETE NO ACTION,
  account_id uuid NOT NULL REFERENCES student_portal.account(id) ON DELETE NO ACTION,
  academic_year smallint NOT NULL CHECK (academic_year=2026),
  generation uuid NOT NULL,
  actor_id uuid NOT NULL,
  expected_scope_revision bigint NOT NULL,
  student_uid uuid NOT NULL,
  target_observation_id uuid NOT NULL,
  birth_date date NOT NULL,
  credential_year smallint,
  action text NOT NULL DEFAULT 'apply' CHECK(action IN ('apply','separate')),
  expected_account_version bigint NOT NULL,
  expected_pin_version bigint NOT NULL,
  expected_birth_version bigint NOT NULL,
  expected_birth_source text NOT NULL CHECK (expected_birth_source IN ('report','profile','legacy','missing')),
  requires_kdf boolean NOT NULL,
  verifier jsonb,
  prepared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(batch_id,account_id),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '1 hour'),
  CHECK (NOT prepared OR NOT requires_kdf OR verifier IS NOT NULL),
  CHECK (credential_year IS NOT NULL OR (action='separate' AND NOT requires_kdf))
);
CREATE INDEX reconciliation_credential_expiry_v1 ON student_portal.reconciliation_credential_stage_v1(expires_at);
CREATE INDEX reconciliation_credential_year_v1 ON student_portal.reconciliation_credential_stage_v1(academic_year);

ALTER TABLE student_portal.reconciliation_birth_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_portal.reconciliation_credential_stage_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_portal.reconciliation_credential_attempt_v1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_bridge_v1 ON student_portal.reconciliation_birth_v1
  FOR ALL TO student_reconciliation_bridge_v1 USING (true) WITH CHECK (true);
CREATE POLICY reconciliation_bridge_v1 ON student_portal.reconciliation_credential_stage_v1
  FOR ALL TO student_reconciliation_bridge_v1 USING (true) WITH CHECK (true);
CREATE POLICY reconciliation_bridge_v1 ON student_portal.reconciliation_credential_attempt_v1
  FOR ALL TO student_reconciliation_bridge_v1 USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON student_portal.reconciliation_birth_v1,
  student_portal.reconciliation_credential_stage_v1,student_portal.reconciliation_credential_attempt_v1 TO student_reconciliation_bridge_v1;
GRANT SELECT ON gradebook.student_reconciliation_scope_v1,gradebook.student_report_batch_v1,
  gradebook.student_report_pending_row_v1,gradebook.student_report_profile_v1,
  gradebook.student_source_observation_v1,gradebook.student_source_link_v1,
  gradebook.student_reconciliation_decision_v1 TO student_reconciliation_bridge_v1;
GRANT UPDATE(revision) ON gradebook.student_reconciliation_scope_v1 TO student_reconciliation_bridge_v1;
GRANT UPDATE(state,class_links) ON gradebook.student_report_batch_v1 TO student_reconciliation_bridge_v1;
GRANT DELETE ON gradebook.student_report_pending_row_v1 TO student_reconciliation_bridge_v1;
CREATE POLICY reconciliation_bridge_scope_lock_v1 ON gradebook.student_reconciliation_scope_v1
  FOR UPDATE TO student_reconciliation_bridge_v1 USING(true) WITH CHECK(true);
CREATE POLICY reconciliation_bridge_expire_batch_v1 ON gradebook.student_report_batch_v1
  FOR UPDATE TO student_reconciliation_bridge_v1 USING(true) WITH CHECK(true);
CREATE POLICY reconciliation_bridge_expire_rows_v1 ON gradebook.student_report_pending_row_v1
  FOR DELETE TO student_reconciliation_bridge_v1 USING(true);
GRANT SELECT ON student_portal.account,student_portal.account_access_data,
  student_portal.password_credential,student_portal.academic_revision,student_portal.link_closure,
  student_portal.academic_student_v1,student_portal.academic_binding_v1 TO student_reconciliation_bridge_v1;
GRANT UPDATE(version,pin_version,updated_at) ON student_portal.account TO student_reconciliation_bridge_v1;
GRANT INSERT,UPDATE ON student_portal.password_credential TO student_reconciliation_bridge_v1;
GRANT SELECT,UPDATE(consumed_at) ON student_portal.auth_challenge TO student_reconciliation_bridge_v1;
GRANT INSERT ON student_portal.audit_event TO student_reconciliation_bridge_v1;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['student_reconciliation_scope_v1','student_report_batch_v1',
    'student_report_pending_row_v1','student_report_profile_v1','student_source_observation_v1','student_source_link_v1','student_reconciliation_decision_v1'] LOOP
    EXECUTE format('CREATE POLICY reconciliation_bridge_read_v1 ON gradebook.%I FOR SELECT TO student_reconciliation_bridge_v1 USING (true)',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['account','account_access_data','password_credential','academic_revision','auth_challenge','audit_event','link_closure'] LOOP
    EXECUTE format('CREATE POLICY reconciliation_bridge_v1 ON student_portal.%I FOR ALL TO student_reconciliation_bridge_v1 USING (true) WITH CHECK (true)',t);
  END LOOP;
END $$;

-- One private reader. A migrated account never falls back to its former manual value.
CREATE VIEW student_portal.account_birth_v1 WITH (security_barrier=true) AS
SELECT a.id AS account_id,
  CASE WHEN r.account_id IS NOT NULL THEN extract(year FROM r.birth_date)::smallint
    WHEN p.observation_id IS NOT NULL AND NOT p.review_required AND NOT l.review_required THEN extract(year FROM o.birth_date)::smallint
    ELSE d.birth_year END AS birth_year,
  CASE WHEN r.account_id IS NOT NULL THEN 'confirmed'::text
    WHEN p.observation_id IS NOT NULL AND NOT p.review_required AND NOT l.review_required THEN 'confirmed'::text
    ELSE d.confirmation END AS confirmation,
  COALESCE(r.version,CASE WHEN NOT p.review_required AND NOT l.review_required THEN p.version END,d.version,0) AS version,
  CASE WHEN r.account_id IS NOT NULL THEN 'report'
    WHEN p.observation_id IS NOT NULL AND NOT p.review_required AND NOT l.review_required THEN 'profile'
    WHEN d.birth_year IS NOT NULL THEN 'legacy' ELSE 'missing' END AS source
FROM student_portal.account a
LEFT JOIN student_portal.reconciliation_birth_v1 r ON r.account_id=a.id AND r.academic_year=a.academic_year AND r.student_uid=a.student_uid
LEFT JOIN gradebook.student_report_profile_v1 p ON p.academic_year=a.academic_year AND p.student_uid=a.student_uid
LEFT JOIN gradebook.student_source_observation_v1 o ON o.id=p.observation_id
LEFT JOIN gradebook.student_source_link_v1 l ON l.academic_year=p.academic_year AND l.source_id=p.source_id AND l.student_uid=p.student_uid
LEFT JOIN student_portal.account_access_data d ON d.account_id=a.id AND r.account_id IS NULL;
ALTER VIEW student_portal.account_birth_v1 OWNER TO student_reconciliation_bridge_v1;
-- The configured display name never participates in identity comparisons.
GRANT SELECT ON gradebook.student_presentation_v1 TO student_reconciliation_bridge_v1;
ALTER VIEW gradebook.student_presentation_v1 OWNER TO student_reconciliation_bridge_v1;
CREATE OR REPLACE VIEW student_portal.academic_student_v1 WITH (security_barrier=true) AS
SELECT student_id,academic_year,name FROM gradebook.student_presentation_v1 WHERE academic_year=2026;
-- Existing publication SECURITY DEFINER functions may be owned by the previous view owner.
-- Preserve that owner's implicit read capability explicitly after narrowing ownership.
DO $$ DECLARE previous_owner name; function_owner name; BEGIN
  SELECT r.rolname INTO previous_owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid='student_portal.academic_student_v1'::regclass;
  ALTER VIEW student_portal.academic_student_v1 OWNER TO student_reconciliation_bridge_v1;
  EXECUTE format('GRANT SELECT ON student_portal.academic_student_v1 TO %I',previous_owner);
  FOR function_owner IN SELECT DISTINCT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.pronamespace='student_portal'::regnamespace AND p.proname IN
      ('synchronize_profiles_v1','capture_publication_source_v2','publication_source_rows_v2','publication_source_rows_v3') LOOP
    EXECUTE format('GRANT SELECT ON student_portal.academic_student_v1 TO %I',function_owner);
  END LOOP;
END $$;
GRANT SELECT ON student_portal.account_birth_v1 TO student_portal_app;

CREATE FUNCTION student_portal.assert_reconciliation_batch_v1(p_batch uuid,p_actor uuid,p_generation uuid,p_revision bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record; s record; v_academic text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(613,0);
  PERFORM pg_advisory_xact_lock(613,2026);
  SELECT concat(academic_generation,':',academic_counter,':',portal_link_generation,':',portal_link_counter,':',reset_generation,':',reset_counter) INTO v_academic
    FROM student_portal.academic_revision WHERE academic_year=2026;
  SELECT * INTO s FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026;
  SELECT * INTO b FROM gradebook.student_report_batch_v1 WHERE id=p_batch;
  IF b.id IS NULL OR b.actor_id IS DISTINCT FROM p_actor OR b.academic_year<>2026
    OR b.generation IS DISTINCT FROM p_generation OR s.generation IS DISTINCT FROM p_generation
    OR b.base_revision IS DISTINCT FROM p_revision OR s.revision IS DISTINCT FROM p_revision
    OR b.base_academic_revision IS DISTINCT FROM v_academic
    OR b.state NOT IN ('preparing','review_required') THEN
    RAISE EXCEPTION 'student-reconciliation-credential-conflict' USING ERRCODE='40001';
  END IF;
  IF b.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'student-reconciliation-credential-expired' USING ERRCODE='P0001';
  END IF;
END $$;

-- First-link reversal restores only the preserved pre-transition year, never an old verifier.
CREATE FUNCTION student_portal.prepare_reconciliation_separation_v1(p_batch uuid,p_actor uuid,p_generation uuid,p_revision bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record; r record; a record; m record; v_required boolean;
BEGIN
  SELECT * INTO b FROM gradebook.student_report_batch_v1 WHERE id=p_batch;
  IF b.purpose<>'decision' OR b.resolution->>'action' IS DISTINCT FROM 'separate' THEN RETURN; END IF;
  IF (SELECT count(*) FROM gradebook.student_report_pending_row_v1 WHERE batch_id=p_batch)<>1 THEN
    RAISE EXCEPTION 'student-reconciliation-credential-conflict-separation'; END IF;
  SELECT * INTO r FROM gradebook.student_report_pending_row_v1 WHERE batch_id=p_batch;
  IF r.selected_profile OR r.target_uid::text IS DISTINCT FROM b.resolution->>'studentUid'
    OR r.target_source_id::text IS DISTINCT FROM b.resolution->>'sourceId'
    OR r.target_observation_id::text IS DISTINCT FROM b.resolution->>'observationId' THEN
    RAISE EXCEPTION 'student-reconciliation-credential-conflict-separation'; END IF;
  FOR a IN SELECT * FROM student_portal.account WHERE student_uid=r.target_uid AND academic_year=b.academic_year AND closed_at IS NULL ORDER BY id FOR UPDATE LOOP
    SELECT * INTO m FROM student_portal.reconciliation_birth_v1 WHERE account_id=a.id;
    IF m.account_id IS NULL OR m.first_observation_id<>m.observation_id OR m.observation_id<>r.target_observation_id
      OR m.first_decision_id::text IS DISTINCT FROM b.resolution->>'revertsDecisionId'
      OR NOT ((m.legacy_year IS NOT NULL AND m.legacy_confirmation IS NOT DISTINCT FROM 'confirmed')
        OR (m.legacy_year IS NULL AND m.legacy_confirmation IS NULL AND m.legacy_pin_missing))
      OR m.applied_account_version<>a.version OR m.applied_pin_version<>a.pin_version
      OR NOT (EXISTS(SELECT 1 FROM student_portal.account_access_data d WHERE d.account_id=a.id
        AND d.birth_year IS NOT DISTINCT FROM m.legacy_year AND d.confirmation IS NOT DISTINCT FROM m.legacy_confirmation AND d.version=m.legacy_version)
        OR (m.legacy_version=0 AND m.legacy_year IS NULL AND m.legacy_confirmation IS NULL
          AND NOT EXISTS(SELECT 1 FROM student_portal.account_access_data d WHERE d.account_id=a.id)))
      OR NOT EXISTS(SELECT 1 FROM gradebook.student_report_profile_v1 p JOIN gradebook.student_source_link_v1 l
        ON l.academic_year=p.academic_year AND l.source_id=p.source_id AND l.student_uid=p.student_uid
        WHERE p.academic_year=b.academic_year AND p.student_uid=r.target_uid AND p.source_id=r.target_source_id
          AND p.observation_id=r.target_observation_id AND p.version=1 AND l.version=1 AND l.decision_id=m.first_decision_id)
      THEN RAISE EXCEPTION 'student-reconciliation-credential-conflict-separation'; END IF;
    SELECT (m.legacy_year IS NOT NULL AND (extract(year FROM m.birth_date)::smallint<>m.legacy_year OR c.pin_verifier IS NULL OR c.pin_version IS DISTINCT FROM a.pin_version))
      INTO v_required FROM student_portal.account x LEFT JOIN student_portal.password_credential c ON c.account_id=x.id WHERE x.id=a.id;
    INSERT INTO student_portal.reconciliation_credential_stage_v1(batch_id,account_id,academic_year,generation,actor_id,
      expected_scope_revision,student_uid,target_observation_id,birth_date,credential_year,action,expected_account_version,
      expected_pin_version,expected_birth_version,expected_birth_source,requires_kdf,prepared,expires_at)
    SELECT p_batch,a.id,b.academic_year,p_generation,p_actor,p_revision,r.target_uid,r.target_observation_id,r.birth_date,
      m.legacy_year,'separate',a.version,a.pin_version,m.version,'report',v_required,NOT v_required,t.expires_at
      FROM student_portal.reconciliation_credential_attempt_v1 t WHERE t.batch_id=p_batch ON CONFLICT(batch_id,account_id) DO NOTHING;
  END LOOP;
END $$;

CREATE FUNCTION student_portal.reconciliation_credential_targets_v1(p_batch uuid,p_actor uuid,p_generation uuid,p_revision bigint,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_prepared integer; v_remaining integer; v_targets jsonb;
BEGIN
  IF p_limit<0 OR p_limit>4 THEN RAISE EXCEPTION 'student-reconciliation-credential-limit'; END IF;
  PERFORM student_portal.assert_reconciliation_batch_v1(p_batch,p_actor,p_generation,p_revision);
  INSERT INTO student_portal.reconciliation_credential_attempt_v1(batch_id,academic_year,expires_at)
    SELECT id,academic_year,LEAST(expires_at,statement_timestamp()+interval '1 hour') FROM gradebook.student_report_batch_v1
    WHERE id=p_batch ON CONFLICT(batch_id) DO NOTHING;
  IF EXISTS(SELECT 1 FROM student_portal.reconciliation_credential_attempt_v1 WHERE batch_id=p_batch AND expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'student-reconciliation-credential-expired';
  END IF;
  IF EXISTS(SELECT 1 FROM gradebook.student_report_pending_row_v1 WHERE batch_id=p_batch AND selected_profile AND target_uid IS NOT NULL
    GROUP BY target_uid HAVING count(*)<>1) THEN RAISE EXCEPTION 'student-reconciliation-credential-profile-conflict'; END IF;
  PERFORM a.id FROM student_portal.account a JOIN gradebook.student_report_pending_row_v1 r ON r.target_uid=a.student_uid
    WHERE r.batch_id=p_batch AND (r.selected_profile OR EXISTS(SELECT 1 FROM gradebook.student_report_batch_v1 target_batch WHERE target_batch.id=p_batch AND target_batch.purpose='decision' AND target_batch.resolution->>'action'='separate')) AND a.academic_year=2026 AND a.closed_at IS NULL ORDER BY a.id FOR UPDATE OF a;
  IF EXISTS(SELECT 1 FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=p_batch AND expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'student-reconciliation-credential-expired';
  END IF;
  PERFORM student_portal.prepare_reconciliation_separation_v1(p_batch,p_actor,p_generation,p_revision);
  INSERT INTO student_portal.reconciliation_credential_stage_v1(batch_id,account_id,academic_year,generation,actor_id,
    expected_scope_revision,student_uid,target_observation_id,birth_date,credential_year,expected_account_version,expected_pin_version,
    expected_birth_version,expected_birth_source,requires_kdf,prepared,expires_at)
  SELECT p_batch,a.id,2026,p_generation,p_actor,p_revision,a.student_uid,r.target_observation_id,r.birth_date,extract(year FROM r.birth_date)::smallint,a.version,a.pin_version,
    d.version,d.source,
    (d.birth_year IS DISTINCT FROM extract(year FROM r.birth_date)::smallint OR c.pin_verifier IS NULL OR c.pin_version IS DISTINCT FROM a.pin_version),
    NOT(d.birth_year IS DISTINCT FROM extract(year FROM r.birth_date)::smallint OR c.pin_verifier IS NULL OR c.pin_version IS DISTINCT FROM a.pin_version),
    t.expires_at
  FROM gradebook.student_report_pending_row_v1 r JOIN gradebook.student_report_batch_v1 b ON b.id=r.batch_id
    JOIN student_portal.reconciliation_credential_attempt_v1 t ON t.batch_id=b.id
    JOIN student_portal.account a ON a.student_uid=r.target_uid AND a.academic_year=b.academic_year AND a.closed_at IS NULL
    JOIN student_portal.account_birth_v1 d ON d.account_id=a.id
    LEFT JOIN student_portal.password_credential c ON c.account_id=a.id
  WHERE r.batch_id=p_batch AND r.selected_profile AND r.target_uid IS NOT NULL
  ON CONFLICT(batch_id,account_id) DO NOTHING;
  IF EXISTS(SELECT 1 FROM student_portal.reconciliation_credential_stage_v1 s
    JOIN student_portal.account a ON a.id=s.account_id JOIN student_portal.account_birth_v1 d ON d.account_id=a.id
    WHERE s.batch_id=p_batch AND (a.version<>s.expected_account_version OR a.pin_version<>s.expected_pin_version
      OR d.version<>s.expected_birth_version OR d.source<>s.expected_birth_source)) THEN
    RAISE EXCEPTION 'student-reconciliation-credential-conflict';
  END IF;
  SELECT count(*) FILTER(WHERE prepared)::integer,count(*) FILTER(WHERE NOT prepared)::integer
    INTO v_prepared,v_remaining FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=p_batch;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('accountId',q.account_id,'year',q.credential_year::text)),'[]'::jsonb)
    INTO v_targets FROM (SELECT account_id,credential_year FROM student_portal.reconciliation_credential_stage_v1
      WHERE batch_id=p_batch AND NOT prepared ORDER BY account_id LIMIT p_limit) q;
  RETURN jsonb_build_object('state',CASE WHEN v_remaining=0 THEN 'ready' ELSE 'preparing' END,
    'preparedCount',v_prepared,'remainingCount',v_remaining,'targets',v_targets);
END $$;

CREATE FUNCTION student_portal.stage_reconciliation_credential_v1(p_batch uuid,p_actor uuid,p_account uuid,p_verifier jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=p_batch AND account_id=p_account;
  IF s.account_id IS NULL OR s.actor_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'student-reconciliation-credential-conflict'; END IF;
  PERFORM student_portal.assert_reconciliation_batch_v1(p_batch,p_actor,s.generation,s.expected_scope_revision);
  PERFORM id FROM student_portal.account WHERE id=p_account AND version=s.expected_account_version AND pin_version=s.expected_pin_version FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'student-reconciliation-credential-conflict'; END IF;
  IF s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'student-reconciliation-credential-expired'; END IF;
  IF s.prepared THEN RETURN; END IF;
  IF NOT s.requires_kdf OR p_verifier IS NULL OR jsonb_typeof(p_verifier)<>'object'
    OR p_verifier->>'algorithm' IS DISTINCT FROM 'scrypt-hmac-sha256-v1'
    OR p_verifier->'parameters' IS DISTINCT FROM '{"N":32768,"r":8,"p":3,"keyLength":32}'::jsonb
    OR COALESCE(p_verifier->>'salt','')!~'^[a-f0-9]{32}$'
    OR COALESCE(p_verifier->>'digest','')!~'^[a-f0-9]{64}$'
    OR COALESCE(p_verifier->>'pepperVersion','')!~'^[1-9][0-9]{0,5}$'
    OR (SELECT count(*) FROM jsonb_object_keys(p_verifier))<>5 THEN RAISE EXCEPTION 'student-reconciliation-credential-invalid'; END IF;
  UPDATE student_portal.reconciliation_credential_stage_v1 SET verifier=p_verifier,prepared=true
    WHERE batch_id=p_batch AND account_id=p_account;
END $$;

CREATE FUNCTION student_portal.apply_reconciliation_credentials_v1(p_batch uuid,p_actor uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record; s record; m record; v_count integer; v_expected integer; v_birth_version bigint; v_source text; v_changed boolean;
BEGIN
  SELECT * INTO b FROM gradebook.student_report_batch_v1 WHERE id=p_batch;
  IF b.id IS NULL THEN RAISE EXCEPTION 'student-reconciliation-credential-conflict'; END IF;
  PERFORM student_portal.assert_reconciliation_batch_v1(p_batch,p_actor,b.generation,b.base_revision);
  IF NOT EXISTS(SELECT 1 FROM student_portal.reconciliation_credential_attempt_v1 WHERE batch_id=p_batch AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'student-reconciliation-credential-expired';
  END IF;
  PERFORM a.id FROM student_portal.account a JOIN gradebook.student_report_pending_row_v1 r ON r.target_uid=a.student_uid
    WHERE r.batch_id=p_batch AND (r.selected_profile OR EXISTS(SELECT 1 FROM gradebook.student_report_batch_v1 target_batch WHERE target_batch.id=p_batch AND target_batch.purpose='decision' AND target_batch.resolution->>'action'='separate')) AND a.academic_year=2026 AND a.closed_at IS NULL ORDER BY a.id FOR UPDATE OF a;
  SELECT count(*)::integer INTO v_expected FROM gradebook.student_report_pending_row_v1 r JOIN student_portal.account a
    ON a.student_uid=r.target_uid AND a.academic_year=2026 AND a.closed_at IS NULL WHERE r.batch_id=p_batch AND (r.selected_profile OR (b.purpose='decision' AND b.resolution->>'action'='separate'));
  SELECT count(*)::integer INTO v_count FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=p_batch;
  IF v_expected<>v_count THEN RAISE EXCEPTION 'student-reconciliation-credential-incomplete'; END IF;
  -- Revalidate the entire set before touching the first credential. A later SQL failure still rolls back the caller's transaction.
  FOR s IN SELECT * FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=p_batch ORDER BY account_id FOR UPDATE LOOP
    IF NOT s.prepared OR s.expires_at<=clock_timestamp() OR s.actor_id IS DISTINCT FROM p_actor
      OR s.generation IS DISTINCT FROM b.generation OR s.expected_scope_revision<>b.base_revision THEN
      RAISE EXCEPTION 'student-reconciliation-credential-conflict-stage';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM student_portal.account a WHERE a.id=s.account_id AND a.student_uid=s.student_uid
        AND a.academic_year=s.academic_year AND a.closed_at IS NULL AND a.version=s.expected_account_version AND a.pin_version=s.expected_pin_version) THEN
      RAISE EXCEPTION 'student-reconciliation-credential-conflict-account';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM gradebook.student_report_pending_row_v1 r WHERE r.batch_id=p_batch AND r.selected_profile=(s.action='apply')
        AND r.target_uid=s.student_uid AND r.target_observation_id=s.target_observation_id AND r.birth_date=s.birth_date) THEN
      RAISE EXCEPTION 'student-reconciliation-credential-conflict-target';
    END IF;
    IF s.action='separate' THEN
      SELECT * INTO m FROM student_portal.reconciliation_birth_v1 WHERE account_id=s.account_id;
      IF m.first_decision_id::text IS DISTINCT FROM b.resolution->>'revertsDecisionId'
        OR m.observation_id IS DISTINCT FROM s.target_observation_id OR m.first_observation_id IS DISTINCT FROM m.observation_id
        OR m.legacy_year IS DISTINCT FROM s.credential_year OR m.applied_account_version<>s.expected_account_version
        OR m.applied_pin_version<>s.expected_pin_version
        OR EXISTS(SELECT 1 FROM gradebook.student_report_profile_v1 WHERE academic_year=s.academic_year AND student_uid=s.student_uid)
        OR EXISTS(SELECT 1 FROM gradebook.student_source_link_v1 WHERE academic_year=s.academic_year AND source_id=(b.resolution->>'sourceId')::uuid)
        OR NOT EXISTS(SELECT 1 FROM gradebook.student_reconciliation_decision_v1 WHERE academic_year=s.academic_year
          AND action='separate' AND reverts_decision_id=m.first_decision_id AND student_uid=s.student_uid AND source_id=(b.resolution->>'sourceId')::uuid)
        OR (m.legacy_year IS NULL AND (NOT m.legacy_pin_missing OR m.legacy_confirmation IS NOT NULL))
        OR NOT (EXISTS(SELECT 1 FROM student_portal.account_access_data d WHERE d.account_id=s.account_id AND d.birth_year IS NOT DISTINCT FROM m.legacy_year
          AND d.confirmation IS NOT DISTINCT FROM m.legacy_confirmation AND d.version=m.legacy_version)
          OR (m.legacy_version=0 AND m.legacy_year IS NULL AND m.legacy_confirmation IS NULL
            AND NOT EXISTS(SELECT 1 FROM student_portal.account_access_data d WHERE d.account_id=s.account_id))) THEN
        RAISE EXCEPTION 'student-reconciliation-credential-conflict-separation';
      END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM gradebook.student_report_profile_v1 p JOIN gradebook.student_source_observation_v1 o ON o.id=p.observation_id
        JOIN gradebook.student_source_link_v1 l ON l.academic_year=p.academic_year AND l.source_id=o.source_id AND l.student_uid=p.student_uid
        WHERE p.academic_year=s.academic_year AND p.student_uid=s.student_uid AND p.observation_id=s.target_observation_id
          AND o.birth_date=s.birth_date AND NOT p.review_required AND NOT l.review_required) THEN
      RAISE EXCEPTION 'student-reconciliation-credential-conflict-profile';
    END IF;
    SELECT COALESCE(r.version,d.version,0),CASE WHEN r.account_id IS NOT NULL THEN 'report' WHEN d.birth_year IS NOT NULL THEN 'legacy' ELSE 'missing' END
      INTO v_birth_version,v_source FROM student_portal.account a LEFT JOIN student_portal.reconciliation_birth_v1 r ON r.account_id=a.id
      LEFT JOIN student_portal.account_access_data d ON d.account_id=a.id AND r.account_id IS NULL WHERE a.id=s.account_id;
    IF s.expected_birth_source='profile' THEN
      IF v_source='report' THEN RAISE EXCEPTION 'student-reconciliation-credential-conflict'; END IF;
    ELSIF v_birth_version<>s.expected_birth_version OR v_source<>s.expected_birth_source THEN
      RAISE EXCEPTION 'student-reconciliation-credential-conflict';
    END IF;
  END LOOP;
  FOR s IN SELECT * FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=p_batch ORDER BY account_id LOOP
    SELECT NOT EXISTS(SELECT 1 FROM student_portal.reconciliation_birth_v1 r WHERE r.account_id=s.account_id AND r.birth_date=s.birth_date) INTO v_changed;
    IF s.action='separate' THEN
      DELETE FROM student_portal.reconciliation_birth_v1 WHERE account_id=s.account_id;
      v_changed:=true;
    ELSE
    INSERT INTO student_portal.reconciliation_birth_v1(account_id,academic_year,student_uid,observation_id,birth_date,version,
      first_observation_id,first_decision_id,legacy_year,legacy_confirmation,legacy_version,legacy_pin_missing,applied_account_version,applied_pin_version)
      SELECT s.account_id,s.academic_year,s.student_uid,s.target_observation_id,s.birth_date,s.expected_birth_version+1,
        s.target_observation_id,l.decision_id,d.birth_year,d.confirmation,COALESCE(d.version,0),c.pin_verifier IS NULL,
        s.expected_account_version+CASE WHEN s.requires_kdf THEN 1 ELSE 0 END,s.expected_pin_version+CASE WHEN s.requires_kdf THEN 1 ELSE 0 END
      FROM gradebook.student_report_profile_v1 p JOIN gradebook.student_source_link_v1 l
        ON l.academic_year=p.academic_year AND l.source_id=p.source_id AND l.student_uid=p.student_uid
      LEFT JOIN student_portal.account_access_data d ON d.account_id=s.account_id
      LEFT JOIN student_portal.password_credential c ON c.account_id=s.account_id
      WHERE p.academic_year=s.academic_year AND p.student_uid=s.student_uid
      ON CONFLICT(account_id) DO UPDATE SET observation_id=EXCLUDED.observation_id,birth_date=EXCLUDED.birth_date,
        version=CASE WHEN student_portal.reconciliation_birth_v1.observation_id=EXCLUDED.observation_id THEN student_portal.reconciliation_birth_v1.version ELSE EXCLUDED.version END,
        updated_at=statement_timestamp();
    END IF;
    IF s.requires_kdf OR (s.action='separate' AND s.credential_year IS NULL) THEN
      INSERT INTO student_portal.password_credential(account_id,pin_verifier,pin_version)
        VALUES(s.account_id,s.verifier,s.expected_pin_version+1) ON CONFLICT(account_id) DO UPDATE
        SET pin_verifier=EXCLUDED.pin_verifier,pin_version=EXCLUDED.pin_version,updated_at=statement_timestamp();
      UPDATE student_portal.account SET version=version+1,pin_version=pin_version+1,updated_at=statement_timestamp() WHERE id=s.account_id;
      UPDATE student_portal.auth_challenge SET consumed_at=statement_timestamp() WHERE account_id=s.account_id AND consumed_at IS NULL;
    END IF;
    IF v_changed THEN
      INSERT INTO student_portal.audit_event(event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version)
        VALUES(gen_random_uuid(),statement_timestamp(),p_actor,s.account_id,jsonb_build_object('kind','account','academicYear',2026,'accountId',s.account_id),
          'birth-changed','success',p_batch,s.expected_birth_version+1);
    END IF;
    -- The legacy row is a private transition fallback only after an explicitly staged reversal.
  END LOOP;
  DELETE FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=p_batch;
  DELETE FROM student_portal.reconciliation_credential_attempt_v1 WHERE batch_id=p_batch;
  RETURN v_count;
END $$;

CREATE FUNCTION student_portal.clear_reconciliation_credentials_v1(p_year smallint)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_count integer; v_birth integer; v_attempt integer;
BEGIN
  PERFORM pg_advisory_xact_lock(613,0);
  PERFORM pg_advisory_xact_lock(613,p_year::integer);
  IF EXISTS(SELECT 1 FROM student_portal.account WHERE academic_year=p_year AND gradebook_student_id IS NOT NULL) THEN
    RAISE EXCEPTION 'student-reconciliation-reset-linked-accounts';
  END IF;
  DELETE FROM student_portal.reconciliation_credential_stage_v1 WHERE academic_year=p_year;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  DELETE FROM student_portal.reconciliation_birth_v1 WHERE academic_year=p_year;
  GET DIAGNOSTICS v_birth=ROW_COUNT;
  DELETE FROM student_portal.reconciliation_credential_attempt_v1 WHERE academic_year=p_year;
  GET DIAGNOSTICS v_attempt=ROW_COUNT;
  RETURN v_count+v_birth+v_attempt;
END $$;

CREATE FUNCTION student_portal.reconciliation_credential_counts_v1(p_year smallint)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT ((SELECT count(*) FROM student_portal.reconciliation_birth_v1 WHERE academic_year=p_year)
    +(SELECT count(*) FROM student_portal.reconciliation_credential_stage_v1 WHERE academic_year=p_year)
    +(SELECT count(*) FROM student_portal.reconciliation_credential_attempt_v1 WHERE academic_year=p_year))::integer
$$;

CREATE FUNCTION student_portal.reconciliation_accounts_v1(p_year smallint)
RETURNS TABLE(student_uid uuid,account_id uuid,account_version bigint,closed_at timestamptz,legacy_birth_year smallint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT a.student_uid,a.id,a.version,a.closed_at,
    CASE WHEN d.confirmation='confirmed' AND d.source='legacy' THEN d.birth_year END
  FROM student_portal.account a
  LEFT JOIN student_portal.account_birth_v1 d ON d.account_id=a.id
  WHERE a.academic_year=p_year
$$;

CREATE FUNCTION student_portal.reconciliation_revision_v1(p_year smallint)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT concat(academic_generation,':',academic_counter,':',portal_link_generation,':',portal_link_counter,':',reset_generation,':',reset_counter)
    FROM student_portal.academic_revision WHERE academic_year=p_year
$$;

CREATE FUNCTION student_portal.cleanup_reconciliation_credentials_v1(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_count integer;
BEGIN
  IF p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'student-reconciliation-cleanup-limit'; END IF;
  WITH expired AS (SELECT batch_id,account_id FROM student_portal.reconciliation_credential_stage_v1 WHERE expires_at<=clock_timestamp()
    ORDER BY expires_at,batch_id,account_id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM student_portal.reconciliation_credential_stage_v1 s USING expired e WHERE s.batch_id=e.batch_id AND s.account_id=e.account_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END $$;

CREATE FUNCTION student_portal.cleanup_reconciliation_pending_v1(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b record; v_count integer:=0;
BEGIN
  IF p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'student-reconciliation-cleanup-limit'; END IF;
  PERFORM pg_advisory_xact_lock_shared(613,0);
  PERFORM pg_advisory_xact_lock(613,2026);
  PERFORM academic_year FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026 FOR UPDATE;
  FOR b IN SELECT id FROM gradebook.student_report_batch_v1 WHERE academic_year=2026
    AND state IN ('awaiting_relation','review_required','preparing') AND expires_at<=clock_timestamp()
    ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    DELETE FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=b.id;
    DELETE FROM student_portal.reconciliation_credential_attempt_v1 WHERE batch_id=b.id;
    DELETE FROM gradebook.student_report_pending_row_v1 WHERE batch_id=b.id;
    UPDATE gradebook.student_report_batch_v1 SET state='expired',class_links='[]'::jsonb WHERE id=b.id;
    v_count:=v_count+1;
  END LOOP;
  IF v_count>0 THEN
    UPDATE gradebook.student_reconciliation_scope_v1 SET revision=revision+1 WHERE academic_year=2026;
  END IF;
  RETURN v_count;
END $$;

DO $$
DECLARE f text; r text;
BEGIN
  FOREACH f IN ARRAY ARRAY['assert_reconciliation_batch_v1(uuid,uuid,uuid,bigint)',
    'reconciliation_credential_targets_v1(uuid,uuid,uuid,bigint,integer)',
    'prepare_reconciliation_separation_v1(uuid,uuid,uuid,bigint)',
    'stage_reconciliation_credential_v1(uuid,uuid,uuid,jsonb)','apply_reconciliation_credentials_v1(uuid,uuid)',
    'clear_reconciliation_credentials_v1(smallint)','cleanup_reconciliation_credentials_v1(integer)',
    'reconciliation_credential_counts_v1(smallint)','reconciliation_accounts_v1(smallint)','reconciliation_revision_v1(smallint)',
    'cleanup_reconciliation_pending_v1(integer)'] LOOP
    EXECUTE 'ALTER FUNCTION student_portal.'||f||' OWNER TO student_reconciliation_bridge_v1';
    EXECUTE 'REVOKE ALL ON FUNCTION student_portal.'||f||' FROM PUBLIC,gradebook_app,student_portal_app';
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE 'REVOKE ALL ON FUNCTION student_portal.'||f||' FROM '||quote_ident(r); END IF;
    END LOOP;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION student_portal.reconciliation_credential_targets_v1(uuid,uuid,uuid,bigint,integer),
  student_portal.stage_reconciliation_credential_v1(uuid,uuid,uuid,jsonb),
  student_portal.cleanup_reconciliation_credentials_v1(integer),student_portal.cleanup_reconciliation_pending_v1(integer) TO student_portal_app;
GRANT EXECUTE ON FUNCTION student_portal.apply_reconciliation_credentials_v1(uuid,uuid),
  student_portal.clear_reconciliation_credentials_v1(smallint),student_portal.reconciliation_credential_counts_v1(smallint),
  student_portal.reconciliation_accounts_v1(smallint),student_portal.reconciliation_revision_v1(smallint) TO gradebook_app;
REVOKE ALL ON student_portal.reconciliation_birth_v1,student_portal.reconciliation_credential_stage_v1,
  student_portal.reconciliation_credential_attempt_v1 FROM PUBLIC,gradebook_app,student_portal_app;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON student_portal.reconciliation_birth_v1,student_portal.reconciliation_credential_stage_v1,student_portal.reconciliation_credential_attempt_v1,student_portal.account_birth_v1 FROM %I',r);
    END IF;
  END LOOP;
END $$;
-- Existing values stay readable through account_birth_v1 until that account is migrated.
REVOKE INSERT,UPDATE,DELETE ON student_portal.account_access_data FROM student_portal_app;
COMMIT;
