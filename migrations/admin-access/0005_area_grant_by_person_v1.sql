-- Audit #1530 A3/A5 (owner authorization of 18/11/2026): an area is opened to a person, not to a
-- sign-in name. The sign-in name (UPN) can be renamed or given to someone else; the Entra object id
-- (oid) cannot. The UPN stays only to be shown. Every grant, change and removal is kept in an
-- append-only history (who, for whom, before and after). No student data.
-- The table had no row when this was written; the migration stops if it has any, so no grant is
-- ever left without its person.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gradebook_app') THEN
    RAISE EXCEPTION 'area-grant-by-person-v1 requires the dedicated gradebook_app role';
  END IF;
  IF to_regclass('admin_access.area_grant_v1') IS NULL THEN
    RAISE EXCEPTION 'area-grant-by-person-v1 requires 0001_area_grant_v1';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_access.area_grant_v1) THEN
    RAISE EXCEPTION 'area-grant-by-person-v1 expects no grant yet: give each row its oid first';
  END IF;
END $$;

ALTER TABLE admin_access.area_grant_v1 DROP CONSTRAINT area_grant_v1_pkey;
ALTER TABLE admin_access.area_grant_v1 ADD COLUMN oid uuid NOT NULL;
ALTER TABLE admin_access.area_grant_v1 ADD CONSTRAINT area_grant_v1_pkey PRIMARY KEY (oid);
CREATE INDEX area_grant_v1_email ON admin_access.area_grant_v1 (email);

CREATE TABLE admin_access.area_grant_change_v1 (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  actor_oid uuid NOT NULL,
  actor_name text NOT NULL CHECK (char_length(actor_name) BETWEEN 1 AND 200),
  target_oid uuid NOT NULL,
  target_email text NOT NULL CHECK (char_length(target_email) BETWEEN 1 AND 320),
  before_areas text[] NOT NULL DEFAULT '{}'::text[],
  after_areas text[] NOT NULL DEFAULT '{}'::text[]
);
CREATE INDEX area_grant_change_v1_at ON admin_access.area_grant_change_v1 (at DESC);

REVOKE ALL ON admin_access.area_grant_change_v1 FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'student_portal_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON admin_access.area_grant_change_v1 FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE admin_access.area_grant_change_v1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY area_grant_change_backend_v1 ON admin_access.area_grant_change_v1
  FOR ALL TO gradebook_app USING (true) WITH CHECK (true);
-- The history is only appended to and read.
GRANT SELECT, INSERT ON admin_access.area_grant_change_v1 TO gradebook_app;
COMMIT;
