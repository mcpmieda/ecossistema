-- #1293 audit. Additive: the runtime may delete only finished authorization
-- rows (expired challenges, cancelled pairings without a device).
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE INDEX challenges_expiry_v2 ON collector_auth.challenges(expires_at);
GRANT DELETE ON TABLE collector_auth.challenges,collector_auth.pairings TO collector_runtime;
COMMIT;
