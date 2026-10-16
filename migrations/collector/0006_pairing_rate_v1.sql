-- #1293: pairing admission is bounded atomically in PostgreSQL, not per process.
-- Pairing remains unauthenticated until a human proves ownership with Entra.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE collector_auth.pairing_rate_v1 (
  scope text PRIMARY KEY CHECK (length(scope) BETWEEN 0 AND 120),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  requests integer NOT NULL CHECK (requests BETWEEN 1 AND 500)
);
REVOKE ALL ON collector_auth.pairing_rate_v1 FROM PUBLIC;
DO $migration$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='collector_runtime') THEN
   GRANT SELECT, INSERT, UPDATE, DELETE ON collector_auth.pairing_rate_v1 TO collector_runtime;
 END IF;
END $migration$;
COMMIT;
