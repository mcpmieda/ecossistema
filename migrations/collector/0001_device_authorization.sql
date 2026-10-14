-- Candidate migration only. Never executed automatically by application startup.
-- Owner-only by default. Runtime role/binding grants require deployment approval.
CREATE SCHEMA collector_auth;
REVOKE ALL ON SCHEMA collector_auth FROM PUBLIC;

CREATE TABLE collector_auth.oauth_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  client_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  credential_version integer NOT NULL CHECK (credential_version >= 0),
  origin_authenticated_at timestamptz NOT NULL,
  encrypted_refresh text,
  state text NOT NULL CHECK (state IN ('active', 'needs_reauth', 'revoked')),
  directory_authorized boolean NOT NULL DEFAULT false,
  directory_checked_at timestamptz,
  directory_valid_until timestamptz,
  revoked_at timestamptz,
  refresh_owner uuid,
  refresh_until timestamptz,
  CHECK (state <> 'active' OR encrypted_refresh IS NOT NULL),
  CHECK (encrypted_refresh IS NULL OR octet_length(encrypted_refresh) BETWEEN 32 AND 25000),
  CHECK ((directory_checked_at IS NULL AND directory_valid_until IS NULL)
    OR (directory_checked_at IS NOT NULL AND directory_valid_until = directory_checked_at + interval '5 minutes')),
  CHECK ((refresh_owner IS NULL) = (refresh_until IS NULL))
);
CREATE TABLE collector_auth.devices (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES collector_auth.oauth_grants(id),
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  public_key jsonb NOT NULL CHECK (jsonb_typeof(public_key) = 'object'
    AND NOT public_key ? 'd' AND public_key->>'kty' = 'EC' AND public_key->>'crv' = 'P-256'),
  key_thumbprint text NOT NULL CHECK (key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  generation integer NOT NULL CHECK (generation > 0),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX devices_active_grant ON collector_auth.devices(grant_id) WHERE revoked_at IS NULL;
CREATE TABLE collector_auth.challenges (
  nonce_hash text PRIMARY KEY CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  device_id uuid NOT NULL REFERENCES collector_auth.devices(id),
  generation integer NOT NULL CHECK (generation > 0),
  key_thumbprint text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at = issued_at + interval '60 seconds')
);
CREATE INDEX challenges_device_deadline ON collector_auth.challenges(device_id, expires_at);
REVOKE ALL ON ALL TABLES IN SCHEMA collector_auth FROM PUBLIC;

-- Rotation never changes authentication origin/subject. Reauthentication creates
-- a new grant; replacing the refresh value does not renew the original timestamp.
CREATE FUNCTION collector_auth.immutable_grant_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.actor_id <> OLD.actor_id
    OR NEW.client_id <> OLD.client_id OR NEW.origin_authenticated_at <> OLD.origin_authenticated_at THEN
    RAISE EXCEPTION 'collector-grant-origin-immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_grant_origin BEFORE UPDATE ON collector_auth.oauth_grants
FOR EACH ROW EXECUTE FUNCTION collector_auth.immutable_grant_origin();
