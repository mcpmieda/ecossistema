-- Candidate #1289: private frequency storage. Never apply automatically in production.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(613,0);
CREATE SCHEMA IF NOT EXISTS attendance;
REVOKE ALL ON SCHEMA attendance FROM PUBLIC,anon,authenticated,student_portal_app;
GRANT USAGE ON SCHEMA attendance TO gradebook_app;
CREATE TABLE attendance.school_state_v2 (
 academic_year smallint PRIMARY KEY CHECK(academic_year=2026), tenant_id uuid NOT NULL,
 generation uuid NOT NULL DEFAULT gen_random_uuid(), revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 paused boolean NOT NULL DEFAULT false, schedule_json jsonb,
 fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
 lease_device uuid, lease_actor uuid, lease_until timestamptz,
 CHECK ((lease_device IS NULL AND lease_actor IS NULL AND lease_until IS NULL) OR
        (lease_device IS NOT NULL AND lease_actor IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TABLE attendance.device_status_v2 (
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 device_id uuid NOT NULL, label text NOT NULL DEFAULT 'Computador' CHECK(length(label) BETWEEN 1 AND 80),
 state text NOT NULL DEFAULT 'ready' CHECK(state IN('ready','collecting','login-required','error')),
 last_seen_at timestamptz, class_id integer, code text, last_collection_at timestamptz,
 PRIMARY KEY(academic_year,device_id)
);
CREATE TABLE attendance.class_state_v2 (
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 class_id integer NOT NULL, revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 last_observed_at timestamptz, last_received_at timestamptz, last_payload_hash text, last_batch_id uuid, PRIMARY KEY(academic_year,class_id),
 FOREIGN KEY(class_id,academic_year) REFERENCES gradebook.turma(id,ano) ON DELETE NO ACTION
);
CREATE TABLE attendance.batch_v2 (
 id uuid PRIMARY KEY, academic_year smallint NOT NULL, generation uuid NOT NULL,
 class_id integer NOT NULL, source_class_id text NOT NULL, source_class_label text NOT NULL,
 shift text NOT NULL, source_version text NOT NULL, content_hash text NOT NULL, evidence_hash text NOT NULL,
 observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 roster_complete boolean NOT NULL, actor_id uuid NOT NULL, device_id uuid NOT NULL,
 resolved_records integer NOT NULL DEFAULT 0, unresolved_records integer NOT NULL DEFAULT 0,
 conflicts integer NOT NULL DEFAULT 0,
 UNIQUE(academic_year,id),
 FOREIGN KEY(academic_year,class_id) REFERENCES attendance.class_state_v2(academic_year,class_id) ON DELETE NO ACTION
);
CREATE TABLE attendance.source_row_v2 (
 batch_id uuid NOT NULL REFERENCES attendance.batch_v2(id) ON DELETE NO ACTION, record_key text NOT NULL,
 original_name text NOT NULL, original_class text NOT NULL,
 resolution text NOT NULL CHECK(resolution IN('resolved','ambiguous','not_found')),
 student_uid uuid REFERENCES gradebook.student_identity(id) ON DELETE NO ACTION, decision_version bigint NOT NULL,
 source_ids_json jsonb NOT NULL, observation_ids_json jsonb NOT NULL, eligibility_json jsonb NOT NULL,
 PRIMARY KEY(batch_id,record_key), CHECK((resolution='resolved')=(student_uid IS NOT NULL))
);
ALTER TABLE attendance.class_state_v2 ADD CONSTRAINT frequency_current_batch_v2
 FOREIGN KEY(academic_year,last_batch_id) REFERENCES attendance.batch_v2(academic_year,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE attendance.coverage_v2 (
 batch_id uuid NOT NULL, record_key text NOT NULL, date date NOT NULL,
 slots_json jsonb NOT NULL, complete boolean NOT NULL,
 PRIMARY KEY(batch_id,record_key,date),
 FOREIGN KEY(batch_id,record_key) REFERENCES attendance.source_row_v2(batch_id,record_key) ON DELETE NO ACTION
);
CREATE TABLE attendance.source_mark_v2 (
 batch_id uuid NOT NULL, record_key text NOT NULL, date date NOT NULL, slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 6),
 mark text NOT NULL CHECK(mark IN('X','J')),
 PRIMARY KEY(batch_id,record_key,date,slot),
 FOREIGN KEY(batch_id,record_key) REFERENCES attendance.source_row_v2(batch_id,record_key) ON DELETE NO ACTION
);
CREATE TABLE attendance.occurrence_v2 (
 id uuid PRIMARY KEY, academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 student_uid uuid NOT NULL REFERENCES gradebook.student_identity(id) ON DELETE NO ACTION, date date NOT NULL, shift text NOT NULL, slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 6),
 mark text CHECK(mark IN('X','J')), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 UNIQUE(academic_year,student_uid,date,shift,slot)
);
CREATE TABLE attendance.origin_v2 (
 occurrence_id uuid NOT NULL REFERENCES attendance.occurrence_v2(id) ON DELETE NO ACTION,
 batch_id uuid NOT NULL, record_key text NOT NULL,
 mark text CHECK(mark IN('X','J')), PRIMARY KEY(occurrence_id,batch_id,record_key),
 FOREIGN KEY(batch_id,record_key) REFERENCES attendance.source_row_v2(batch_id,record_key) ON DELETE NO ACTION
);
CREATE TABLE attendance.conflict_v2 (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES attendance.occurrence_v2(id) ON DELETE NO ACTION,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), marks_json jsonb NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN('open','resolved')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), resolved_at timestamptz
);
CREATE UNIQUE INDEX frequency_open_conflict_v2 ON attendance.conflict_v2(occurrence_id) WHERE state='open';
CREATE TABLE attendance.correction_v2 (
 id uuid PRIMARY KEY, conflict_id uuid NOT NULL REFERENCES attendance.conflict_v2(id) ON DELETE NO ACTION,
 actor_id uuid NOT NULL, before_mark text, after_mark text, reason text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(length(reason) BETWEEN 1 AND 500)
);
CREATE TABLE attendance.receipt_v2 (
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 generation uuid NOT NULL, request_id uuid NOT NULL, actor_id uuid NOT NULL, device_id uuid,
 payload_hash text NOT NULL, result_json jsonb NOT NULL,
 PRIMARY KEY(academic_year,request_id)
);
-- No personal data; retained across reset to reject old mutation IDs.
CREATE TABLE attendance.retired_request_v2 (
 academic_year smallint NOT NULL, request_id uuid NOT NULL, PRIMARY KEY(academic_year,request_id)
);
CREATE INDEX frequency_batch_class_time_v2 ON attendance.batch_v2(academic_year,class_id,observed_at DESC);
CREATE INDEX frequency_batch_version_v2 ON attendance.batch_v2(academic_year,class_id,source_version);
CREATE INDEX frequency_sources_uid_v2 ON attendance.source_row_v2(student_uid,batch_id);
CREATE INDEX frequency_occurrence_uid_month_v2 ON attendance.occurrence_v2(academic_year,student_uid,date);
CREATE INDEX frequency_origin_batch_v2 ON attendance.origin_v2(batch_id,record_key);
CREATE INDEX frequency_conflict_occurrence_v2 ON attendance.conflict_v2(occurrence_id,state);
CREATE FUNCTION attendance.immutable_frequency_evidence_v2() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'frequency-evidence-immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION attendance.immutable_frequency_evidence_v2() FROM PUBLIC,anon,authenticated,student_portal_app,gradebook_app;
CREATE TRIGGER frequency_source_immutable_v2 BEFORE UPDATE ON attendance.source_row_v2 FOR EACH ROW EXECUTE FUNCTION attendance.immutable_frequency_evidence_v2();
CREATE TRIGGER frequency_mark_immutable_v2 BEFORE UPDATE ON attendance.source_mark_v2 FOR EACH ROW EXECUTE FUNCTION attendance.immutable_frequency_evidence_v2();
CREATE TRIGGER frequency_origin_immutable_v2 BEFORE UPDATE ON attendance.origin_v2 FOR EACH ROW EXECUTE FUNCTION attendance.immutable_frequency_evidence_v2();
CREATE TRIGGER frequency_correction_immutable_v2 BEFORE UPDATE ON attendance.correction_v2 FOR EACH ROW EXECUTE FUNCTION attendance.immutable_frequency_evidence_v2();
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['school_state_v2','device_status_v2','class_state_v2','batch_v2','source_row_v2','coverage_v2','source_mark_v2','occurrence_v2','origin_v2','conflict_v2','correction_v2','receipt_v2','retired_request_v2'] LOOP
  EXECUTE format('ALTER TABLE attendance.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE attendance.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON attendance.%I FROM PUBLIC,anon,authenticated,student_portal_app',item);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON attendance.%I TO gradebook_app',item);
  EXECUTE format('CREATE POLICY frequency_runtime_v2 ON attendance.%I TO gradebook_app USING(true) WITH CHECK(true)',item);
 END LOOP;
END $$;
REVOKE UPDATE ON attendance.source_row_v2,attendance.source_mark_v2,attendance.origin_v2,attendance.correction_v2 FROM gradebook_app;
COMMIT;
