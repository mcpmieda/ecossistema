-- Clean-up after the one-click authorization (0015, 17/11/2026): the four columns of the delegated
-- Microsoft sign-in go away. Nothing writes or reads them: the server since 0015, the retention job
-- since 0016 and revoke_device_admin_v2 since 0017 (APPLY AFTER both). Their own rules (format
-- checks, the unique state hash) and column grants go with them.
--   collector_auth.oauth_grants.encrypted_refresh   the person's refresh token, encrypted
--   collector_auth.pairings.oauth_state_hash        the sign-in transaction of a pairing
--   collector_auth.pairings.oauth_nonce_hash
--   collector_auth.pairings.oauth_consumed_at
-- Refused while anything of that sign-in is still alive: a stored token, or a pairing in the middle
-- of it ('confirmed', 'exchanging': states only that sign-in produced).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM collector_auth.oauth_grants WHERE encrypted_refresh IS NOT NULL) THEN
    RAISE EXCEPTION 'drop-delegated-sign-in-columns-v1: a grant still holds a refresh token';
  END IF;
  IF EXISTS (SELECT 1 FROM collector_auth.pairings WHERE state IN ('confirmed', 'exchanging')) THEN
    RAISE EXCEPTION 'drop-delegated-sign-in-columns-v1: a pairing is still inside the delegated sign-in';
  END IF;
END $$;
ALTER TABLE collector_auth.oauth_grants DROP COLUMN encrypted_refresh;
ALTER TABLE collector_auth.pairings
  DROP COLUMN oauth_state_hash,
  DROP COLUMN oauth_nonce_hash,
  DROP COLUMN oauth_consumed_at;
COMMIT;
