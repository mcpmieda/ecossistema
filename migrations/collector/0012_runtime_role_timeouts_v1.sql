-- Issue #1426, 42 (14/11/2026): collector_runtime was the only application role without time
-- limits stored on the role. The collector asks for them as connection parameters
-- (server/collector/runtime-v1.ts), but its connection goes through Hyperdrive, which pools and
-- reuses server connections: a startup parameter of the client is not guaranteed to be the one of
-- the pooled connection. Stored on the role, the same limits hold on every connection. The values
-- are the ones the code already asks for, so nothing that works today changes.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER ROLE collector_runtime SET statement_timeout='10s';
ALTER ROLE collector_runtime SET lock_timeout='3s';
ALTER ROLE collector_runtime SET idle_in_transaction_session_timeout='10s';
COMMIT;
