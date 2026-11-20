-- Removal of the Banco de Notas "Boletins" tab and everything only it used (owner request 20/11/2026;
-- the tab will be rebuilt simpler). gradebook.boletim_snapshot (0005) held the issued bulletins; no view,
-- function, trigger or foreign key depends on it, and no other module reads it. Its rows are discarded
-- with it (authorized by the owner). Earlier migrations that mention it stay as applied history.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TABLE gradebook.boletim_snapshot;
COMMIT;
