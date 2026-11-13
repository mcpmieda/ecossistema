-- Owner decision of 13/11/2026 (review A25): "Sair" ends the ADM session on the server too. The
-- sealed cookie carries a random session id (sid, 22 base64url characters, no personal data); "Sair"
-- records it here until the cookie would expire, and every request checks it (cached for 30 s per
-- instance). Rows expire with the cookie and are purged on each "Sair". Additive: the code reads
-- this table and lets sessions through when it is missing, so it can be applied before the deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gradebook_app') THEN
    RAISE EXCEPTION 'revoked-session-v1 requires the dedicated gradebook_app role';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS admin_session;
REVOKE ALL ON SCHEMA admin_session FROM PUBLIC;

CREATE TABLE admin_session.revoked_v1 (
  sid text PRIMARY KEY CHECK (sid ~ '^[A-Za-z0-9_-]{22}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX revoked_v1_expires_idx ON admin_session.revoked_v1 (expires_at);

REVOKE ALL ON admin_session.revoked_v1 FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'student_portal_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA admin_session FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON admin_session.revoked_v1 FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE admin_session.revoked_v1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY revoked_v1_backend ON admin_session.revoked_v1
  FOR ALL TO gradebook_app USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA admin_session TO gradebook_app;
GRANT SELECT, INSERT, DELETE ON admin_session.revoked_v1 TO gradebook_app;
COMMIT;
