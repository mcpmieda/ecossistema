-- Candidate only. Owner-only pending pairing state; no runtime grants/secrets.
-- Apply only after the same reviewed Supabase reconciliation gates as 0001.
CREATE TABLE collector_auth.pairings (
  id uuid PRIMARY KEY,
  public_key jsonb NOT NULL CHECK (jsonb_typeof(public_key) = 'object'
    AND public_key->>'kty' = 'EC' AND public_key->>'crv' = 'P-256'
    AND NOT public_key ? 'd' AND public_key->>'ext' = 'true'
    AND length(public_key->>'x') = 43 AND length(public_key->>'y') = 43),
  key_thumbprint text NOT NULL CHECK (key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  poll_hash text NOT NULL CHECK (poll_hash ~ '^[a-f0-9]{64}$'),
  display_code text NOT NULL CHECK (display_code ~ '^[0-9]{6}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','exchanging','completed','cancelled')),
  oauth_state_hash text UNIQUE CHECK (oauth_state_hash ~ '^[a-f0-9]{64}$'),
  oauth_nonce_hash text CHECK (oauth_nonce_hash ~ '^[a-f0-9]{64}$'),
  oauth_consumed_at timestamptz,
  device_id uuid REFERENCES collector_auth.devices(id),
  claimed_at timestamptz,
  CHECK (expires_at = created_at + interval '10 minutes'),
  CHECK ((state IN ('confirmed','exchanging','completed')) = (oauth_state_hash IS NOT NULL)),
  CHECK ((state = 'completed') = (device_id IS NOT NULL))
);
CREATE INDEX pairings_deadline ON collector_auth.pairings(expires_at);
REVOKE ALL ON collector_auth.pairings FROM PUBLIC;
