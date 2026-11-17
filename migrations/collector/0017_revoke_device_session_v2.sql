-- Clean-up after the one-click authorization (0015, 17/11/2026): revoke_device_admin_v2 (0004) still
-- wrote NULL into collector_auth.oauth_grants.encrypted_refresh, the refresh token of the delegated
-- Microsoft sign-in, which no grant holds any more. Same function without that column: same
-- signature, owner, grants and result. APPLY BEFORE 0018, which drops the column.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
GRANT CREATE ON SCHEMA collector_auth TO frequency_bridge_v2;
GRANT frequency_bridge_v2 TO CURRENT_USER;
-- Replace as the function's owner (0004); back to the migration's own role afterwards.
SELECT set_config('collector_auth.migration_role',current_user,true);
SET LOCAL ROLE frequency_bridge_v2;

CREATE OR REPLACE FUNCTION collector_auth.revoke_device_admin_v2(p_device uuid,p_tenant uuid,p_admin uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_grant uuid; BEGIN
  IF p_admin IS NULL OR p_tenant IS NULL THEN RETURN false; END IF;
  SELECT grant_id INTO v_grant FROM collector_auth.devices WHERE id=p_device AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE collector_auth.devices SET revoked_at=coalesce(revoked_at,clock_timestamp()),generation=generation+1 WHERE id=p_device;
  IF NOT EXISTS(SELECT 1 FROM collector_auth.devices WHERE grant_id=v_grant AND revoked_at IS NULL) THEN
   UPDATE collector_auth.oauth_grants SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()),
    directory_authorized=false,directory_checked_at=NULL,directory_valid_until=NULL,refresh_owner=NULL,refresh_until=NULL WHERE id=v_grant;
  END IF;
  RETURN true;
 END $$;

DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('collector_auth.migration_role')); END $$;
REVOKE CREATE ON SCHEMA collector_auth FROM frequency_bridge_v2;
REVOKE frequency_bridge_v2 FROM CURRENT_USER;
COMMIT;
