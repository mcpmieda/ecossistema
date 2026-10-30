-- Audit 30/10/2026: collector_auth was the only schema without row level security. Nothing changes
-- for who may do what (the column grants stay the only gate): every table gets RLS with one policy
-- per role that reaches it today, so a future grant never opens rows by itself.
--   * collector_runtime (the collector's server): all five tables, as its grants allow.
--   * frequency_bridge_v2 (0004): devices and oauth_grants, read through device_public_v2 and
--     updated by lock_active_device_v2 / revoke_device_admin_v2.
-- Not forced: the owner keeps bypassing it, as in the other schemas (the pg_cron retention jobs of
-- 0007/0008 run as the owner).
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['challenges','devices','oauth_grants','pairings','pairing_rate_v1'] LOOP
  EXECUTE format('ALTER TABLE collector_auth.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('CREATE POLICY collector_runtime_v1 ON collector_auth.%I TO collector_runtime USING(true) WITH CHECK(true)',item);
 END LOOP;
 FOREACH item IN ARRAY ARRAY['devices','oauth_grants'] LOOP
  EXECUTE format('CREATE POLICY frequency_bridge_read_v2 ON collector_auth.%I FOR SELECT TO frequency_bridge_v2 USING(true)',item);
  EXECUTE format('CREATE POLICY frequency_bridge_update_v2 ON collector_auth.%I FOR UPDATE TO frequency_bridge_v2 USING(true) WITH CHECK(true)',item);
 END LOOP;
END $$;
COMMIT;
