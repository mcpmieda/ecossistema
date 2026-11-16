-- read_portal_frequency_v3 has no caller: the Portal reads the whole year through v4 (0012/0025).
-- Dropping it leaves one Portal frequency reader. No data is changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'frequency_portal_bridge_v2', 'MEMBER') THEN
    EXECUTE format('GRANT frequency_portal_bridge_v2 TO %I', current_user);
    PERFORM set_config('attendance.drop_v3_granted', 'yes', true);
  END IF;
END $$;
DROP FUNCTION attendance.read_portal_frequency_v3(uuid, uuid, text);
DO $$
BEGIN
  IF current_setting('attendance.drop_v3_granted', true) = 'yes' THEN
    EXECUTE format('REVOKE frequency_portal_bridge_v2 FROM %I', current_user);
  END IF;
END $$;
COMMIT;
