-- Issue #1484 (15/11/2026, owner authorized): the Hyperdrive config ecossistema-collector-auth keeps
-- up to 5 pooled connections, which took the whole CONNECTION LIMIT 5 of collector_runtime. Any 6th
-- connection (the validation Cloudflare runs when the config changes, maintenance) was refused with
-- "too many connections". The role gets 3 spare slots; the Hyperdrive limit stays 5, so the
-- collector does not open more connections than before.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER ROLE collector_runtime CONNECTION LIMIT 8;
COMMIT;
