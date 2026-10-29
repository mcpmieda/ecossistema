-- Owner decision 29/10/2026: the Portal gets an "Ocorrências" tab with the student's disciplinary
-- records (advertência, suspensão...), read by the Windows collector from the Smecel "Ocorrências"
-- (the list of students, then each student's page). The family reads the whole description and
-- confirms each one ("Estou ciente"); the school has no screen for it, the confirmation is kept here.
--
--   * attendance.incident_v2: one row per Smecel record (its id), with its current content, the
--     student it was linked to in the Centro (NULL while the student is not there) and `removed_at`
--     once a complete reading no longer has it.
--   * attendance.incident_version_v2: every distinct content a record ever had. Written once,
--     never updated: an edit made in the Smecel adds a version, so the history stays.
--   * attendance.incident_ack_v2: the family's "Estou ciente", for one version. An edited record
--     is a new version without confirmation, so it is open again. Never updated or removed.
--   * attendance.incident_state_v2: the school's last reading (its evidence hash and freshness).
-- Additive. Written only through the collector's `incident-collect` operation (device proof and the
-- live lease, like a frequency collection); every table goes with its school year (year reset).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE attendance.incident_v2 (
 id uuid PRIMARY KEY,
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 source_incident_id text NOT NULL CHECK(source_incident_id ~ '^[1-9][0-9]{0,11}$'),
 source_student_id text NOT NULL CHECK(source_student_id ~ '^[1-9][0-9]{0,11}$'),
 student_name text NOT NULL CHECK(length(student_name) BETWEEN 1 AND 300),
 -- The Centro's student and class, re-resolved at every reading; NULL while not linked.
 student_uid uuid,
 class_id integer,
 current_version_id uuid NOT NULL,
 first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_seen_at timestamptz NOT NULL,
 removed_at timestamptz,
 CHECK((student_uid IS NULL) = (class_id IS NULL)),
 UNIQUE(academic_year,source_incident_id)
);
CREATE INDEX incident_v2_student_idx ON attendance.incident_v2(academic_year,student_uid) WHERE student_uid IS NOT NULL;
CREATE TABLE attendance.incident_version_v2 (
 id uuid PRIMARY KEY,
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 incident_id uuid NOT NULL REFERENCES attendance.incident_v2(id) ON DELETE NO ACTION,
 content_hash text NOT NULL CHECK(content_hash ~ '^[A-Za-z0-9_-]{43}$'),
 kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
 occurred_on date NOT NULL,
 source_class_label text NOT NULL CHECK(length(source_class_label) BETWEEN 1 AND 300),
 -- Only a suspension has a leave: both dates and the school days the Smecel counts.
 leave_from date,
 leave_to date,
 leave_days smallint CHECK(leave_days BETWEEN 0 AND 366),
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 8000),
 observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid NOT NULL,
 device_id uuid NOT NULL,
 CHECK((leave_from IS NULL) = (leave_to IS NULL) AND (leave_from IS NULL OR leave_from <= leave_to)),
 UNIQUE(incident_id,content_hash)
);
ALTER TABLE attendance.incident_v2 ADD CONSTRAINT incident_v2_current_version_fk
 FOREIGN KEY(current_version_id) REFERENCES attendance.incident_version_v2(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX incident_v2_current_version_idx ON attendance.incident_v2(current_version_id);
CREATE TABLE attendance.incident_ack_v2 (
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 version_id uuid PRIMARY KEY REFERENCES attendance.incident_version_v2(id) ON DELETE NO ACTION,
 -- The Portal account that was signed in (student and family share it).
 account_id uuid NOT NULL,
 acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE attendance.incident_state_v2 (
 academic_year smallint PRIMARY KEY REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[A-Za-z0-9_-]{43}$'),
 last_observed_at timestamptz NOT NULL,
 last_received_at timestamptz NOT NULL,
 -- What the last reading held, for the collector's history.
 incidents integer NOT NULL CHECK(incidents>=0),
 unresolved_students integer NOT NULL CHECK(unresolved_students>=0)
);
CREATE TRIGGER incident_version_immutable_v2 BEFORE UPDATE ON attendance.incident_version_v2
 FOR EACH ROW EXECUTE FUNCTION attendance.immutable_frequency_evidence_v2();
CREATE TRIGGER incident_ack_immutable_v2 BEFORE UPDATE ON attendance.incident_ack_v2
 FOR EACH ROW EXECUTE FUNCTION attendance.immutable_frequency_evidence_v2();
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['incident_v2','incident_version_v2','incident_ack_v2','incident_state_v2'] LOOP
  EXECUTE format('ALTER TABLE attendance.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE attendance.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON attendance.%I FROM PUBLIC,anon,authenticated,student_portal_app',item);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON attendance.%I TO gradebook_app',item);
  EXECUTE format('CREATE POLICY frequency_runtime_v2 ON attendance.%I TO gradebook_app USING(true) WITH CHECK(true)',item);
 END LOOP;
END $$;
REVOKE UPDATE ON attendance.incident_version_v2 FROM gradebook_app;
REVOKE UPDATE ON attendance.incident_ack_v2 FROM gradebook_app;
COMMIT;
