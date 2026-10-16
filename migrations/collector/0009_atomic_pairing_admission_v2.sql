-- #1293: serialize public pairing admission across ALL serverless connections.
-- New additive function; older migrations already applied in Supabase stay intact.
-- The one function invocation is one transaction: budget/slot checks, both
-- reservations and pending row INSERT commit (or fail) together.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE FUNCTION collector_auth.create_pairing_limited_v2(
  p_scope text,
  p_id uuid,
  p_public_key text,
  p_key_thumbprint text,
  p_poll_hash text,
  p_display_code text,
  p_created_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,collector_auth
AS $admit$
DECLARE
  observed_at timestamptz;
BEGIN
  IF p_scope !~ '^client:[a-f0-9]{64}$' THEN
    RETURN FALSE;
  END IF;
  -- Global admission is deliberately serialized across connections, not
  -- just against a given origin. Each statement below gets a fresh READ
  -- COMMITTED snapshot AFTER the advisory transaction lock is acquired.
  -- No in-process mutex or unlocked CTE snapshot can protect the capacity.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('collector-auth-pairing-admission-v2',0));
  observed_at := clock_timestamp();

  IF EXISTS (
    SELECT 1 FROM collector_auth.pairing_rate_v1
    WHERE scope=p_scope AND window_started_at>=observed_at-interval '10 minutes' AND requests>=30
  ) OR EXISTS (
    SELECT 1 FROM collector_auth.pairing_rate_v1
    WHERE scope='global' AND window_started_at>=observed_at-interval '10 minutes' AND requests>=120
  ) OR (
    SELECT count(*) FROM collector_auth.pairings
    WHERE expires_at>observed_at AND state IN ('pending','confirmed','exchanging')
  )>=80 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO collector_auth.pairing_rate_v1(scope,window_started_at,requests)
  VALUES('global',observed_at,1)
  ON CONFLICT(scope) DO UPDATE SET
    requests=CASE WHEN collector_auth.pairing_rate_v1.window_started_at<observed_at-interval '10 minutes'
      THEN 1 ELSE collector_auth.pairing_rate_v1.requests+1 END,
    window_started_at=CASE WHEN collector_auth.pairing_rate_v1.window_started_at<observed_at-interval '10 minutes'
      THEN observed_at ELSE collector_auth.pairing_rate_v1.window_started_at END;

  INSERT INTO collector_auth.pairing_rate_v1(scope,window_started_at,requests)
  VALUES(p_scope,observed_at,1)
  ON CONFLICT(scope) DO UPDATE SET
    requests=CASE WHEN collector_auth.pairing_rate_v1.window_started_at<observed_at-interval '10 minutes'
      THEN 1 ELSE collector_auth.pairing_rate_v1.requests+1 END,
    window_started_at=CASE WHEN collector_auth.pairing_rate_v1.window_started_at<observed_at-interval '10 minutes'
      THEN observed_at ELSE collector_auth.pairing_rate_v1.window_started_at END;

  INSERT INTO collector_auth.pairings(id,public_key,key_thumbprint,poll_hash,display_code,created_at,expires_at)
  VALUES(p_id,p_public_key::jsonb,p_key_thumbprint,p_poll_hash,p_display_code,p_created_at,p_created_at+interval '10 minutes');

  RETURN TRUE;
END;
$admit$;

REVOKE ALL ON FUNCTION collector_auth.create_pairing_limited_v2(
  text,uuid,text,text,text,text,timestamptz) FROM PUBLIC;
DO $grants$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='collector_runtime') THEN
   GRANT EXECUTE ON FUNCTION collector_auth.create_pairing_limited_v2(
     text,uuid,text,text,text,text,timestamptz) TO collector_runtime;
 END IF;
END;
$grants$;
COMMIT;
