-- #1289. Scaffold: 20261014162120_collector_frequency_bridge_v2.sql.
-- Candidate only; no public API/RPC and no password/secret is created.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER FUNCTION collector_auth.immutable_grant_origin() SET search_path=pg_catalog;
CREATE INDEX IF NOT EXISTS collector_pairings_device_v2 ON collector_auth.pairings(device_id);
CREATE ROLE frequency_bridge_v2 NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA collector_auth TO frequency_bridge_v2;
GRANT SELECT(id,grant_id,tenant_id,actor_id,generation,key_thumbprint,revoked_at) ON collector_auth.devices TO frequency_bridge_v2;
GRANT UPDATE(revoked_at,generation) ON collector_auth.devices TO frequency_bridge_v2;
GRANT SELECT(id,state,revoked_at,directory_authorized,directory_valid_until) ON collector_auth.oauth_grants TO frequency_bridge_v2;
GRANT UPDATE(state,revoked_at,encrypted_refresh,directory_authorized,directory_checked_at,directory_valid_until,refresh_owner,refresh_until) ON collector_auth.oauth_grants TO frequency_bridge_v2;
CREATE VIEW collector_auth.device_public_v2 WITH(security_barrier=true) AS
 SELECT d.id AS device_id,d.tenant_id,d.actor_id,d.generation,d.revoked_at,g.state AS grant_state
 FROM collector_auth.devices d JOIN collector_auth.oauth_grants g ON g.id=d.grant_id;
CREATE FUNCTION collector_auth.lock_active_device_v2(p_device uuid,p_tenant uuid,p_actor uuid,p_generation bigint,p_thumb text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_device uuid; BEGIN
  SELECT d.id INTO v_device FROM collector_auth.devices d JOIN collector_auth.oauth_grants g ON g.id=d.grant_id
   WHERE d.id=p_device AND d.tenant_id=p_tenant AND d.actor_id=p_actor AND d.generation=p_generation
    AND d.key_thumbprint=p_thumb AND d.revoked_at IS NULL AND g.state='active' AND g.revoked_at IS NULL
    AND g.directory_authorized AND g.directory_valid_until>clock_timestamp()
   FOR SHARE OF d,g;
  IF v_device IS NULL THEN RETURN false; END IF;
  -- A lock can wait without changing its row. Sample the database clock again AFTER the wait.
  RETURN EXISTS(SELECT 1 FROM collector_auth.devices d JOIN collector_auth.oauth_grants g ON g.id=d.grant_id
   WHERE d.id=v_device AND d.revoked_at IS NULL AND g.state='active' AND g.revoked_at IS NULL
    AND g.directory_authorized AND g.directory_valid_until>clock_timestamp());
 END $$;
CREATE FUNCTION collector_auth.revoke_device_admin_v2(p_device uuid,p_tenant uuid,p_admin uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE v_grant uuid; BEGIN
  IF p_admin IS NULL OR p_tenant IS NULL THEN RETURN false; END IF;
  SELECT grant_id INTO v_grant FROM collector_auth.devices WHERE id=p_device AND tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE collector_auth.devices SET revoked_at=coalesce(revoked_at,clock_timestamp()),generation=generation+1 WHERE id=p_device;
  IF NOT EXISTS(SELECT 1 FROM collector_auth.devices WHERE grant_id=v_grant AND revoked_at IS NULL) THEN
   UPDATE collector_auth.oauth_grants SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()),encrypted_refresh=NULL,
    directory_authorized=false,directory_checked_at=NULL,directory_valid_until=NULL,refresh_owner=NULL,refresh_until=NULL WHERE id=v_grant;
  END IF;
  RETURN true;
 END $$;
REVOKE ALL ON collector_auth.device_public_v2 FROM PUBLIC,anon,authenticated,student_portal_app,collector_runtime;
REVOKE ALL ON FUNCTION collector_auth.lock_active_device_v2(uuid,uuid,uuid,bigint,text) FROM PUBLIC,anon,authenticated,student_portal_app,collector_runtime;
REVOKE ALL ON FUNCTION collector_auth.revoke_device_admin_v2(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,student_portal_app,collector_runtime;
GRANT USAGE ON SCHEMA collector_auth TO gradebook_app;
GRANT SELECT ON collector_auth.device_public_v2 TO gradebook_app;
GRANT EXECUTE ON FUNCTION collector_auth.lock_active_device_v2(uuid,uuid,uuid,bigint,text),collector_auth.revoke_device_admin_v2(uuid,uuid,uuid) TO gradebook_app;
-- Temporary ownership transfer rights are removed before commit, following the existing private bridge pattern.
GRANT CREATE ON SCHEMA collector_auth TO frequency_bridge_v2;
GRANT frequency_bridge_v2 TO CURRENT_USER;
ALTER VIEW collector_auth.device_public_v2 OWNER TO frequency_bridge_v2;
ALTER FUNCTION collector_auth.lock_active_device_v2(uuid,uuid,uuid,bigint,text) OWNER TO frequency_bridge_v2;
ALTER FUNCTION collector_auth.revoke_device_admin_v2(uuid,uuid,uuid) OWNER TO frequency_bridge_v2;
REVOKE CREATE ON SCHEMA collector_auth FROM frequency_bridge_v2;
REVOKE frequency_bridge_v2 FROM CURRENT_USER;
COMMIT;
