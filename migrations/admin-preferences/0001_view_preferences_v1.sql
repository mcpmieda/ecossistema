-- Owner request of 12/11/2026: the Centro reopens, on any computer, the last view each person used
-- (area, period, perspective, filters). Rows hold only identifiers of choices, keyed by the
-- Entra object id of the session; never names or marks. Separate schema so the academic
-- gradebook catalog, backups and year reset stay unchanged. Candidate: apply after authorization.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gradebook_app') THEN
    RAISE EXCEPTION 'view-preferences-v1 requires the dedicated gradebook_app role';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS admin_preferences;
REVOKE ALL ON SCHEMA admin_preferences FROM PUBLIC;

CREATE TABLE admin_preferences.view_state_v1 (
  actor_id uuid NOT NULL,
  view_key text NOT NULL CHECK (view_key ~ '^[a-z][a-z0-9-]{0,63}(:[0-9]{1,6})?$'),
  view_value jsonb NOT NULL CHECK (octet_length(view_value::text) <= 4096),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (actor_id, view_key)
);
CREATE INDEX view_state_v1_recent_idx ON admin_preferences.view_state_v1 (actor_id, updated_at DESC);

REVOKE ALL ON admin_preferences.view_state_v1 FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'student_portal_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA admin_preferences FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON admin_preferences.view_state_v1 FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE admin_preferences.view_state_v1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY view_state_backend_v1 ON admin_preferences.view_state_v1
  FOR ALL TO gradebook_app USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA admin_preferences TO gradebook_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_preferences.view_state_v1 TO gradebook_app;
COMMIT;
