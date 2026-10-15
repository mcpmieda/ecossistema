-- #1289 follow-up. Additive only: seven-day failure trail and the current
-- unrecognized Smecel rows of each class, both private to gradebook_app.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(613,0);
CREATE TABLE attendance.failure_v2 (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 first_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 occurrences integer NOT NULL DEFAULT 1 CHECK(occurrences>0),
 origin text NOT NULL CHECK(origin IN('collector','admin','device-report')),
 operation text NOT NULL CHECK(operation ~ '^[a-z-]{1,40}$'),
 code text NOT NULL CHECK(code ~ '^[A-Za-z_-]{1,60}$'),
 detail text NOT NULL DEFAULT '' CHECK(length(detail)<=200),
 device_id uuid,
 class_id integer,
 fingerprint text NOT NULL CHECK(length(fingerprint)<=600)
);
CREATE INDEX frequency_failure_recent_v2 ON attendance.failure_v2(last_at DESC);
CREATE INDEX frequency_failure_repeat_v2 ON attendance.failure_v2(fingerprint,last_at DESC);
ALTER TABLE attendance.failure_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance.failure_v2 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON attendance.failure_v2 FROM PUBLIC,anon,authenticated,student_portal_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON attendance.failure_v2 TO gradebook_app;
CREATE POLICY frequency_runtime_v2 ON attendance.failure_v2 TO gradebook_app USING(true) WITH CHECK(true);
ALTER TABLE attendance.class_state_v2 ADD COLUMN unresolved_json jsonb NOT NULL DEFAULT '[]'::jsonb
 CONSTRAINT frequency_unresolved_array_v2 CHECK(jsonb_typeof(unresolved_json)='array' AND jsonb_array_length(unresolved_json)<=64);
COMMIT;
