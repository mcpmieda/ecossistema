-- Issue #1426, 41 (owner decision 14/11/2026): one time zone for the school, America/Bahia
-- (shared/school-time-zone-v1.ts). The database's default was America/Sao_Paulo; both are UTC−3 today
-- (no daylight saving since 2019), so no date or time changes now. If daylight saving returns, a
-- timestamp read without an explicit zone follows the school's rule. Setting only: no data changes;
-- it applies to new connections. A database the migration role does not own (a local test copy) keeps
-- its default and says so.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET "TimeZone" = %L', current_database(), 'America/Bahia');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'school time zone: database % kept its default (not its owner)', current_database();
END
$$;
