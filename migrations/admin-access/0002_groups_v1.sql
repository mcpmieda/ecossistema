-- Owner decision of 17/11/2026 (#1513): members of the admin group manage the Microsoft 365 groups
-- from the Centro (create a group, add and remove people). The Centro touches only the five role
-- groups (wrangler GROUP_*_ID) and the groups it created itself, kept in managed_group_v1.
-- group_change_v1 records who did what to which group, and how it ended. The person's sign-in name
-- is kept as the target so the history can be read; no grades or student records.
-- Additive. Without these tables the Centro still lists and changes the role groups, but cannot
-- create a group nor show the history: apply it before the deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gradebook_app') THEN
    RAISE EXCEPTION 'groups-v1 requires the dedicated gradebook_app role';
  END IF;
  IF to_regnamespace('admin_access') IS NULL THEN
    RAISE EXCEPTION 'groups-v1 requires admin_access (0001_area_grant_v1)';
  END IF;
END $$;

CREATE TABLE admin_access.managed_group_v1 (
  group_id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE admin_access.group_change_v1 (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  actor_oid uuid NOT NULL,
  actor_name text NOT NULL CHECK (char_length(actor_name) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (action IN ('create-group', 'add-member', 'remove-member')),
  group_id uuid,
  group_name text CHECK (group_name IS NULL OR char_length(group_name) <= 120),
  target text CHECK (target IS NULL OR char_length(target) <= 320),
  outcome text NOT NULL CHECK (outcome IN ('done', 'unchanged', 'failed')),
  correlation_id text CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 64)
);
CREATE INDEX group_change_v1_group_at ON admin_access.group_change_v1 (group_id, at DESC);
CREATE INDEX group_change_v1_at ON admin_access.group_change_v1 (at DESC);

DO $$
DECLARE role_name text; table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['managed_group_v1', 'group_change_v1'] LOOP
    EXECUTE format('REVOKE ALL ON admin_access.%I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'student_portal_app'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON admin_access.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    EXECUTE format('ALTER TABLE admin_access.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;
CREATE POLICY managed_group_backend_v1 ON admin_access.managed_group_v1
  FOR ALL TO gradebook_app USING (true) WITH CHECK (true);
CREATE POLICY group_change_backend_v1 ON admin_access.group_change_v1
  FOR ALL TO gradebook_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON admin_access.managed_group_v1 TO gradebook_app;
-- The history is only appended and read.
GRANT SELECT, INSERT ON admin_access.group_change_v1 TO gradebook_app;
COMMIT;
