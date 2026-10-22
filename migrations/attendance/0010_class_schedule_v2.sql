-- Owner decision 22/10/2026: the Portal gets a "Horário" tab with each class's weekly grid, read by
-- the Windows collector from the Smecel "Grade de horários" (one page with every class).
--
--   * attendance.schedule_version_v2: every distinct grid a class ever had (Monday to Friday, lesson
--     positions 1–6, the subject as the Smecel names it, no teacher). Written once, never updated;
--     a grid that changes adds a version, so the history stays.
--   * attendance.schedule_state_v2: the class's current version and when it was last read.
-- Additive. Written only through the collector's `schedule-collect` operation (device proof and
-- the live lease, like a frequency collection); both go with their school year (year reset).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE attendance.schedule_version_v2 (
 id uuid PRIMARY KEY,
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 class_id integer NOT NULL,
 source_version text NOT NULL CHECK(source_version ~ '^sha256:[a-f0-9]{64}$'),
 source_class_id text NOT NULL CHECK(source_class_id ~ '^[1-9][0-9]{0,9}$'),
 source_class_label text NOT NULL CHECK(length(source_class_label) BETWEEN 1 AND 300),
 content_hash text NOT NULL CHECK(content_hash ~ '^[A-Za-z0-9_-]{43}$'),
 -- [{weekday 1-5, slot 1-6, subject}], in day then position order; a free position is absent.
 lessons_json jsonb NOT NULL CHECK(jsonb_typeof(lessons_json)='array' AND jsonb_array_length(lessons_json)<=30),
 observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid NOT NULL,
 device_id uuid NOT NULL
);
CREATE INDEX schedule_version_v2_class_idx ON attendance.schedule_version_v2(academic_year,class_id,received_at DESC);
CREATE TABLE attendance.schedule_state_v2 (
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 class_id integer NOT NULL,
 current_version_id uuid NOT NULL REFERENCES attendance.schedule_version_v2(id) ON DELETE NO ACTION,
 last_observed_at timestamptz NOT NULL,
 last_received_at timestamptz NOT NULL,
 PRIMARY KEY(academic_year,class_id)
);
CREATE INDEX schedule_state_v2_version_idx ON attendance.schedule_state_v2(current_version_id);
CREATE TRIGGER schedule_version_immutable_v2 BEFORE UPDATE ON attendance.schedule_version_v2
 FOR EACH ROW EXECUTE FUNCTION attendance.immutable_frequency_evidence_v2();
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['schedule_version_v2','schedule_state_v2'] LOOP
  EXECUTE format('ALTER TABLE attendance.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE attendance.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON attendance.%I FROM PUBLIC,anon,authenticated,student_portal_app',item);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON attendance.%I TO gradebook_app',item);
  EXECUTE format('CREATE POLICY frequency_runtime_v2 ON attendance.%I TO gradebook_app USING(true) WITH CHECK(true)',item);
 END LOOP;
END $$;
REVOKE UPDATE ON attendance.schedule_version_v2 FROM gradebook_app;
COMMIT;
