-- Owner decision of 17/11/2026: a collector is authorized with one click by a person signed in to
-- the Ecossistema, and the server itself reads the directory (Graph Backend app) to know the person
-- is still in the admin group. No Microsoft credential of the person is stored any more, so two
-- rules written for the delegated sign-in stop holding:
--   * an active grant no longer carries an encrypted refresh token;
--   * a completed pairing no longer carries an OAuth state hash.
-- The columns stay (the retention and frequency-bridge functions still name them) and are never
-- written again. Additive for the code already deployed, which still satisfies both rules:
-- APPLY BEFORE the deploy that authorizes by session.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('collector_auth.oauth_grants', 'oauth_grants_check', 'encrypted_refresh IS NOT NULL'),
      ('collector_auth.pairings', 'pairings_check1', 'oauth_state_hash IS NOT NULL')
    ) AS rule(table_name, constraint_name, fragment)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = target.table_name::regclass AND conname = target.constraint_name
        AND position(target.fragment IN pg_get_constraintdef(oid)) > 0
    ) THEN
      RAISE EXCEPTION 'session-authorization-v1: % on % is not the expected rule',
        target.constraint_name, target.table_name;
    END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', target.table_name, target.constraint_name);
  END LOOP;
END $$;
COMMIT;
