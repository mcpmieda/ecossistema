-- #1269 / #1276. Candidate only. Apply once after explicit production authorization.
-- Requires the current academic schema and shared identity migration 0018.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(613,0);

CREATE TABLE gradebook.student_reconciliation_scope_v1 (
  academic_year smallint PRIMARY KEY CHECK (academic_year BETWEEN 2000 AND 9999),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  academic_revision text,
  current_batch_id uuid,
  name_source text NOT NULL DEFAULT 'report' CHECK (name_source IN ('relation','report')),
  UNIQUE(academic_year,generation)
);
CREATE TABLE gradebook.student_report_batch_v1 (
  id uuid PRIMARY KEY, academic_year smallint NOT NULL, generation uuid NOT NULL,
  actor_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  source_generated_at timestamptz, source_evidence text NOT NULL CHECK(source_evidence IN ('declared','unknown')),
  normalization_version smallint NOT NULL CHECK(normalization_version=1),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key uuid NOT NULL,
  base_revision bigint NOT NULL CHECK(base_revision>=0), base_academic_revision text NOT NULL,
  state text NOT NULL CHECK(state IN ('awaiting_relation','review_required','preparing','applied','superseded','expired')),
  purpose text NOT NULL DEFAULT 'report' CHECK(purpose IN ('report','decision')),
  resolution jsonb,
  expires_at timestamptz NOT NULL,
  differences text[] NOT NULL DEFAULT '{}',
  class_links jsonb NOT NULL CHECK(jsonb_typeof(class_links)='array'),
  apply_key uuid, apply_digest text, applied_revision bigint,
  UNIQUE(academic_year,id), UNIQUE(academic_year,generation,actor_id,idempotency_key),
  FOREIGN KEY(academic_year,generation) REFERENCES gradebook.student_reconciliation_scope_v1(academic_year,generation)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE gradebook.student_reconciliation_scope_v1 ADD CONSTRAINT reconciliation_current_batch_fk_v1
 FOREIGN KEY(academic_year,current_batch_id) REFERENCES gradebook.student_report_batch_v1(academic_year,id)
 ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE gradebook.student_report_class_v1 (
  id uuid PRIMARY KEY, academic_year smallint NOT NULL,
  label text NOT NULL, class_key text NOT NULL, shift text NOT NULL, shift_key text NOT NULL,
  stage_label text NOT NULL, stage smallint NOT NULL CHECK(stage BETWEEN 6 AND 9),
  gradebook_class_id integer, version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  review_required boolean NOT NULL DEFAULT false,
  UNIQUE(academic_year,id), UNIQUE(academic_year,class_key,shift_key,stage),
  FOREIGN KEY(academic_year) REFERENCES gradebook.student_reconciliation_scope_v1(academic_year) ON DELETE NO ACTION,
  FOREIGN KEY(gradebook_class_id,academic_year) REFERENCES gradebook.turma(id,ano) ON DELETE NO ACTION
);
CREATE TABLE gradebook.student_source_record_v1 (
  id uuid PRIMARY KEY, academic_year smallint NOT NULL, current_observation_id uuid,
  last_batch_id uuid NOT NULL, review_required boolean NOT NULL DEFAULT false,
  pending_reason text, version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(academic_year,id),
  FOREIGN KEY(academic_year,last_batch_id) REFERENCES gradebook.student_report_batch_v1(academic_year,id) ON DELETE NO ACTION
);
CREATE TABLE gradebook.student_source_observation_v1 (
  id uuid PRIMARY KEY, academic_year smallint NOT NULL, source_id uuid NOT NULL,
  version bigint NOT NULL CHECK(version>0), batch_id uuid NOT NULL, report_class_id uuid NOT NULL,
  name text NOT NULL, name_key text NOT NULL, birth_date date NOT NULL,
  filiation1 text, filiation1_key text, inep text, inep_key text,
  enrollment_hash text NOT NULL, shift text NOT NULL, shift_key text NOT NULL,
  status text NOT NULL, status_key text NOT NULL, enrolled_at date, transferred_at date,
  UNIQUE(academic_year,id), UNIQUE(academic_year,source_id,id), UNIQUE(source_id,version),
  FOREIGN KEY(academic_year,source_id) REFERENCES gradebook.student_source_record_v1(academic_year,id) ON DELETE NO ACTION,
  FOREIGN KEY(academic_year,batch_id) REFERENCES gradebook.student_report_batch_v1(academic_year,id) ON DELETE NO ACTION,
  FOREIGN KEY(academic_year,report_class_id) REFERENCES gradebook.student_report_class_v1(academic_year,id) ON DELETE NO ACTION,
  CHECK(inep_key IS NULL OR inep_key ~ '^[0-9]+$'), CHECK(filiation1_key IS NULL OR length(filiation1_key)>0)
);
ALTER TABLE gradebook.student_source_record_v1 ADD CONSTRAINT reconciliation_current_observation_fk_v1
 FOREIGN KEY(academic_year,id,current_observation_id) REFERENCES gradebook.student_source_observation_v1(academic_year,source_id,id)
 ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE gradebook.student_reconciliation_decision_v1 (
  id uuid PRIMARY KEY, academic_year smallint NOT NULL, generation uuid NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0), actor_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  action text NOT NULL CHECK(action IN ('associate','reject','separate','release','confirm','select-observation','class-link','name-source')),
  source_id uuid, student_uid uuid, report_class_id uuid, observation_id uuid,
  rule_version smallint NOT NULL DEFAULT 1 CHECK(rule_version=1), reason text NOT NULL,
  before_state jsonb NOT NULL DEFAULT '{}', after_state jsonb NOT NULL DEFAULT '{}',
  reverts_decision_id uuid, idempotency_key uuid, request_digest text,
  UNIQUE(academic_year,id), UNIQUE(academic_year,generation,actor_id,idempotency_key),
  FOREIGN KEY(academic_year,generation) REFERENCES gradebook.student_reconciliation_scope_v1(academic_year,generation) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(academic_year,source_id) REFERENCES gradebook.student_source_record_v1(academic_year,id) ON DELETE NO ACTION,
  FOREIGN KEY(student_uid,academic_year) REFERENCES gradebook.aluno(student_uid,ano) ON DELETE NO ACTION,
  FOREIGN KEY(academic_year,report_class_id) REFERENCES gradebook.student_report_class_v1(academic_year,id) ON DELETE NO ACTION,
  FOREIGN KEY(academic_year,observation_id) REFERENCES gradebook.student_source_observation_v1(academic_year,id) ON DELETE NO ACTION,
  FOREIGN KEY(academic_year,reverts_decision_id) REFERENCES gradebook.student_reconciliation_decision_v1(academic_year,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE gradebook.student_source_link_v1 (
  academic_year smallint NOT NULL, source_id uuid NOT NULL, student_uid uuid NOT NULL,
  version bigint NOT NULL CHECK(version>0), decision_id uuid NOT NULL, review_required boolean NOT NULL DEFAULT false,
  PRIMARY KEY(academic_year,source_id), UNIQUE(academic_year,source_id,student_uid),
  FOREIGN KEY(academic_year,source_id) REFERENCES gradebook.student_source_record_v1(academic_year,id) ON DELETE NO ACTION,
  FOREIGN KEY(student_uid,academic_year) REFERENCES gradebook.aluno(student_uid,ano) ON DELETE NO ACTION,
  FOREIGN KEY(academic_year,decision_id) REFERENCES gradebook.student_reconciliation_decision_v1(academic_year,id) ON DELETE NO ACTION
);
CREATE TABLE gradebook.student_report_profile_v1 (
  academic_year smallint NOT NULL, student_uid uuid NOT NULL, source_id uuid NOT NULL, observation_id uuid NOT NULL,
  version bigint NOT NULL CHECK(version>0), review_required boolean NOT NULL DEFAULT false,
  PRIMARY KEY(academic_year,student_uid),
  FOREIGN KEY(student_uid,academic_year) REFERENCES gradebook.aluno(student_uid,ano) ON DELETE NO ACTION,
  FOREIGN KEY(academic_year,source_id,student_uid) REFERENCES gradebook.student_source_link_v1(academic_year,source_id,student_uid)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(academic_year,source_id,observation_id) REFERENCES gradebook.student_source_observation_v1(academic_year,source_id,id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE gradebook.student_report_pending_row_v1 (
  batch_id uuid NOT NULL, source_row integer NOT NULL CHECK(source_row BETWEEN 2 AND 10001), academic_year smallint NOT NULL,
  name text NOT NULL, name_key text NOT NULL, birth_date date NOT NULL,
  filiation1 text, filiation1_key text, inep text, inep_key text, enrollment_hash text NOT NULL,
  class_label text NOT NULL, class_key text NOT NULL, stage_label text NOT NULL,
  stage smallint NOT NULL CHECK(stage BETWEEN 6 AND 9), shift text NOT NULL, shift_key text NOT NULL,
  status text NOT NULL, status_key text NOT NULL, enrolled_at date, transferred_at date,
  gradebook_class_id integer, target_uid uuid, target_source_id uuid NOT NULL, target_observation_id uuid NOT NULL,
  target_rule text, pending_reason text, selected_profile boolean NOT NULL DEFAULT false,
  PRIMARY KEY(batch_id,source_row),
  FOREIGN KEY(academic_year,batch_id) REFERENCES gradebook.student_report_batch_v1(academic_year,id) ON DELETE NO ACTION,
  FOREIGN KEY(target_uid,academic_year) REFERENCES gradebook.aluno(student_uid,ano) ON DELETE NO ACTION,
  FOREIGN KEY(gradebook_class_id,academic_year) REFERENCES gradebook.turma(id,ano) ON DELETE NO ACTION,
  CHECK(NOT selected_profile OR target_uid IS NOT NULL)
);
CREATE UNIQUE INDEX reconciliation_prepared_profile_v1 ON gradebook.student_report_pending_row_v1(batch_id,target_uid) WHERE selected_profile;
CREATE INDEX reconciliation_batch_expiry_v1 ON gradebook.student_report_batch_v1(expires_at,academic_year) WHERE state IN ('awaiting_relation','review_required','preparing');
CREATE INDEX reconciliation_batch_year_v1 ON gradebook.student_report_batch_v1(academic_year,generation);
CREATE INDEX reconciliation_class_academic_v1 ON gradebook.student_report_class_v1(gradebook_class_id,academic_year);
CREATE INDEX reconciliation_source_batch_v1 ON gradebook.student_source_record_v1(academic_year,last_batch_id);
CREATE INDEX reconciliation_source_current_v1 ON gradebook.student_source_record_v1(academic_year,current_observation_id);
CREATE INDEX reconciliation_observation_class_name_v1 ON gradebook.student_source_observation_v1(academic_year,report_class_id,name_key);
CREATE INDEX reconciliation_observation_name_v1 ON gradebook.student_source_observation_v1(academic_year,name_key);
CREATE INDEX reconciliation_observation_inep_birth_v1 ON gradebook.student_source_observation_v1(academic_year,inep_key,birth_date) WHERE inep_key IS NOT NULL;
CREATE INDEX reconciliation_observation_person_v1 ON gradebook.student_source_observation_v1(academic_year,name_key,birth_date,filiation1_key) WHERE filiation1_key IS NOT NULL;
CREATE INDEX reconciliation_observation_hash_v1 ON gradebook.student_source_observation_v1(academic_year,enrollment_hash);
CREATE INDEX reconciliation_observation_batch_v1 ON gradebook.student_source_observation_v1(academic_year,batch_id);
CREATE INDEX reconciliation_decision_pair_v1 ON gradebook.student_reconciliation_decision_v1(academic_year,source_id,student_uid,sequence DESC,recorded_at DESC);
CREATE INDEX reconciliation_decision_uid_v1 ON gradebook.student_reconciliation_decision_v1(student_uid,academic_year);
CREATE INDEX reconciliation_decision_class_v1 ON gradebook.student_reconciliation_decision_v1(academic_year,report_class_id);
CREATE INDEX reconciliation_decision_observation_v1 ON gradebook.student_reconciliation_decision_v1(academic_year,observation_id);
CREATE INDEX reconciliation_decision_reverts_v1 ON gradebook.student_reconciliation_decision_v1(academic_year,reverts_decision_id);
CREATE INDEX reconciliation_link_uid_v1 ON gradebook.student_source_link_v1(student_uid,academic_year);
CREATE INDEX reconciliation_link_decision_v1 ON gradebook.student_source_link_v1(academic_year,decision_id);
CREATE INDEX reconciliation_profile_observation_v1 ON gradebook.student_report_profile_v1(academic_year,source_id,observation_id);
CREATE INDEX reconciliation_pending_year_v1 ON gradebook.student_report_pending_row_v1(academic_year,batch_id);
CREATE INDEX reconciliation_pending_uid_v1 ON gradebook.student_report_pending_row_v1(target_uid,academic_year);
CREATE INDEX reconciliation_pending_class_v1 ON gradebook.student_report_pending_row_v1(gradebook_class_id,academic_year);

CREATE FUNCTION gradebook.reconciliation_observation_immutable_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'reconciliation-observation-immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION gradebook.reconciliation_observation_immutable_v1() FROM PUBLIC,gradebook_app,student_portal_app;
CREATE TRIGGER reconciliation_observation_immutable_v1 BEFORE UPDATE ON gradebook.student_source_observation_v1
 FOR EACH ROW EXECUTE FUNCTION gradebook.reconciliation_observation_immutable_v1();
CREATE TRIGGER reconciliation_decision_immutable_v1 BEFORE UPDATE ON gradebook.student_reconciliation_decision_v1
 FOR EACH ROW EXECUTE FUNCTION gradebook.reconciliation_observation_immutable_v1();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['student_reconciliation_scope_v1','student_report_batch_v1','student_report_pending_row_v1',
 'student_report_class_v1','student_source_record_v1','student_source_observation_v1','student_source_link_v1',
 'student_report_profile_v1','student_reconciliation_decision_v1'] LOOP
  EXECUTE format('ALTER TABLE gradebook.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY reconciliation_backend_v1 ON gradebook.%I TO gradebook_app USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON gradebook.%I FROM PUBLIC,anon,authenticated,student_portal_app',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON gradebook.%I TO gradebook_app',t);
 END LOOP;
END $$;
REVOKE UPDATE ON gradebook.student_source_observation_v1,gradebook.student_reconciliation_decision_v1 FROM gradebook_app;
-- The control row has no personal content and survives annual reset with a fresh generation.
CREATE VIEW gradebook.student_presentation_v1 WITH (security_barrier=true) AS
SELECT a.id AS student_id,a.ano AS academic_year,
  CASE WHEN s.name_source='report' THEN COALESCE(o.name,a.nome) ELSE a.nome END AS name
FROM gradebook.aluno a
LEFT JOIN gradebook.student_reconciliation_scope_v1 s ON s.academic_year=a.ano
LEFT JOIN gradebook.student_report_profile_v1 p ON p.academic_year=a.ano AND p.student_uid=a.student_uid
LEFT JOIN gradebook.student_source_observation_v1 o ON o.id=p.observation_id
LEFT JOIN gradebook.student_source_link_v1 l ON l.academic_year=p.academic_year AND l.source_id=p.source_id AND l.student_uid=p.student_uid;
REVOKE ALL ON gradebook.student_presentation_v1 FROM PUBLIC;
GRANT SELECT ON gradebook.student_presentation_v1 TO gradebook_app;
COMMIT;
