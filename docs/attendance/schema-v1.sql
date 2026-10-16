-- #1267: candidate only. NOT registered in production migration tooling.
-- Requires existing gradebook.student_identity and the annual Relação schema.
-- Apply only to an explicitly authorized empty/local attendance schema.
BEGIN;
CREATE SCHEMA attendance;
REVOKE ALL ON SCHEMA attendance FROM PUBLIC;
CREATE TABLE attendance.scope (
  academic_year integer NOT NULL,
  class_id integer NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  current_batch uuid,
  current_configuration uuid,
  lease_holder uuid,
  lease_actor uuid,
  lease_until timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (academic_year,class_id),
  FOREIGN KEY (class_id,academic_year) REFERENCES gradebook.turma(id,ano) ON DELETE RESTRICT
);
CREATE TABLE attendance.configuration (
  id uuid PRIMARY KEY,
  academic_year integer NOT NULL,
  class_id integer NOT NULL,
  relation_fingerprint text NOT NULL,
  actor uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (academic_year,class_id) REFERENCES attendance.scope
);
CREATE TABLE attendance.calendar (
  configuration_id uuid NOT NULL REFERENCES attendance.configuration ON DELETE RESTRICT,
  date date NOT NULL,
  eligible boolean NOT NULL,
  slots smallint[] NOT NULL,
  PRIMARY KEY (configuration_id,date),
  CHECK (cardinality(slots) BETWEEN 1 AND 6 AND slots <@ ARRAY[1,2,3,4,5,6]::smallint[])
);
CREATE TABLE attendance.enrollment (
  configuration_id uuid NOT NULL REFERENCES attendance.configuration ON DELETE RESTRICT,
  student_uid uuid NOT NULL REFERENCES gradebook.student_identity(id) ON DELETE RESTRICT,
  starts_on date NOT NULL,
  ends_on date,
  PRIMARY KEY (configuration_id,student_uid,starts_on),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE TABLE attendance.batch (
  id uuid PRIMARY KEY,
  academic_year integer NOT NULL,
  class_id integer NOT NULL,
  source_version text NOT NULL,
  report_identity text NOT NULL,
  observed_at timestamptz NOT NULL,
  relation_fingerprint text NOT NULL,
  roster_complete boolean NOT NULL,
  content_fingerprint text NOT NULL,
  actor uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (academic_year,class_id,source_version,relation_fingerprint),
  FOREIGN KEY (academic_year,class_id) REFERENCES attendance.scope
);
CREATE TABLE attendance.source_record (
  batch_id uuid NOT NULL REFERENCES attendance.batch ON DELETE RESTRICT,
  record_key text NOT NULL,
  original_name text NOT NULL,
  original_class text NOT NULL,
  identity_basis text NOT NULL CHECK (identity_basis IN ('durable','report-local')),
  PRIMARY KEY (batch_id,record_key)
);
CREATE TABLE attendance.coverage (
  batch_id uuid NOT NULL,
  record_key text NOT NULL,
  date date NOT NULL,
  slots smallint[] NOT NULL,
  complete boolean NOT NULL,
  PRIMARY KEY (batch_id,record_key,date),
  FOREIGN KEY (batch_id,record_key) REFERENCES attendance.source_record ON DELETE RESTRICT,
  CHECK (cardinality(slots) BETWEEN 1 AND 6 AND slots <@ ARRAY[1,2,3,4,5,6]::smallint[])
);
CREATE TABLE attendance.mark (
  batch_id uuid NOT NULL,
  record_key text NOT NULL,
  date date NOT NULL,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 6),
  mark text NOT NULL CHECK (mark IN ('X','J')),
  PRIMARY KEY (batch_id,record_key,date,slot),
  FOREIGN KEY (batch_id,record_key,date) REFERENCES attendance.coverage ON DELETE RESTRICT
);
CREATE TABLE attendance.decision (
  academic_year integer NOT NULL,
  class_id integer NOT NULL,
  revision bigint NOT NULL,
  batch_id uuid NOT NULL,
  record_key text NOT NULL,
  student_uid uuid NOT NULL REFERENCES gradebook.student_identity(id) ON DELETE RESTRICT,
  evidence_fingerprint text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('same-student','different-students')),
  reason text NOT NULL,
  actor uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (academic_year,class_id,revision),
  FOREIGN KEY (batch_id,record_key) REFERENCES attendance.source_record ON DELETE RESTRICT,
  FOREIGN KEY (academic_year,class_id) REFERENCES attendance.scope
);
CREATE INDEX decision_evidence_v1 ON attendance.decision
  (academic_year,class_id,evidence_fingerprint,revision DESC);
CREATE TABLE attendance.receipt (
  academic_year integer NOT NULL,
  class_id integer NOT NULL,
  request_id uuid NOT NULL,
  actor uuid NOT NULL,
  payload_fingerprint text NOT NULL,
  result_json jsonb NOT NULL,
  PRIMARY KEY (academic_year,class_id,request_id),
  FOREIGN KEY (academic_year,class_id) REFERENCES attendance.scope
);
ALTER TABLE attendance.scope ADD FOREIGN KEY (current_batch) REFERENCES attendance.batch;
ALTER TABLE attendance.scope ADD FOREIGN KEY (current_configuration) REFERENCES attendance.configuration;
-- Private backend only: no new roles/credentials, no PUBLIC/anon/authenticated access.
-- Existing gradebook_app is the only runtime reader/writer. Histories are append-only.
GRANT USAGE ON SCHEMA attendance TO gradebook_app;
DO $$ DECLARE name text; runtime_role text; BEGIN
  FOR name IN SELECT tablename FROM pg_tables WHERE schemaname='attendance' LOOP
    EXECUTE format('ALTER TABLE attendance.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON attendance.%I FROM PUBLIC',name);
    FOR runtime_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','student_portal_app') LOOP
      EXECUTE format('REVOKE ALL ON attendance.%I FROM %I',name,runtime_role);
    END LOOP;
    EXECUTE format('GRANT SELECT,INSERT ON attendance.%I TO gradebook_app',name);
    EXECUTE format('CREATE POLICY backend_read_v1 ON attendance.%I FOR SELECT TO gradebook_app USING (true)',name);
    EXECUTE format('CREATE POLICY backend_insert_v1 ON attendance.%I FOR INSERT TO gradebook_app WITH CHECK (true)',name);
  END LOOP;
END $$;
GRANT UPDATE ON attendance.scope TO gradebook_app;
CREATE POLICY backend_scope_update_v1 ON attendance.scope FOR UPDATE TO gradebook_app
  USING (true) WITH CHECK (true);
COMMIT;
