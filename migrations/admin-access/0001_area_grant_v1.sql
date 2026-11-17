-- Owner decision of 17/11/2026 (#1513): an administrator opens areas of the Centro (Banco de notas,
-- Importação, Painel do Aluno, Saúde) to people outside the admin group, such as the librarian.
-- Rows are keyed by the sign-in name (UPN), so an area can be opened before the first sign-in;
-- updated_by keeps the name of the administrator who made the last change. No student data.
-- Additive: without this table nobody outside the admin group gets an area (the code reads it and
-- opens nothing when it is missing), so it can be applied before or after the deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gradebook_app') THEN
    RAISE EXCEPTION 'area-grant-v1 requires the dedicated gradebook_app role';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS admin_access;
REVOKE ALL ON SCHEMA admin_access FROM PUBLIC;

CREATE TABLE admin_access.area_grant_v1 (
  email text PRIMARY KEY CHECK (email = lower(email) AND email ~ '^[^[:space:]@]{1,64}@[^[:space:]@]{1,255}$'),
  areas text[] NOT NULL CHECK (
    cardinality(areas) BETWEEN 1 AND 4
    AND areas <@ ARRAY['desempenho', 'importacao', 'painel-do-aluno', 'saude']::text[]
  ),
  updated_by text CHECK (updated_by IS NULL OR char_length(updated_by) <= 200),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

REVOKE ALL ON admin_access.area_grant_v1 FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'student_portal_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA admin_access FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON admin_access.area_grant_v1 FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE admin_access.area_grant_v1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY area_grant_backend_v1 ON admin_access.area_grant_v1
  FOR ALL TO gradebook_app USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA admin_access TO gradebook_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_access.area_grant_v1 TO gradebook_app;
COMMIT;
