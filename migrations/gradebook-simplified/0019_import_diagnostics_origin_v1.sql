-- Issue #1462 (finding 16 of #1450): the Auditoria of a workbook was replaced by (year, file name), so
-- two workbooks of the same year with the same name (two OneDrive folders, or the OneDrive and a manual
-- import) erased each other's findings. Each snapshot now also has its origin: 'manual' (the browser)
-- or 'onedrive:<Graph item id>'. Rows written before this migration are 'legacy': the next snapshot
-- of the same file, from any origin, replaces them. Same bytes from two origins are two snapshots, so
-- the unique key gains the origin. Table grants of 0001 cover the column.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE gradebook.importacao_diagnostico ADD COLUMN origem text NOT NULL DEFAULT 'legacy';
ALTER TABLE gradebook.importacao_diagnostico ALTER COLUMN origem SET DEFAULT 'manual';
ALTER TABLE gradebook.importacao_diagnostico ADD CONSTRAINT importacao_diagnostico_origem_ck
  CHECK (origem IN ('manual', 'legacy') OR origem ~ '^onedrive:[!-~]{1,200}$');
ALTER TABLE gradebook.importacao_diagnostico DROP CONSTRAINT importacao_diagnostico_hash_chave_uk;
ALTER TABLE gradebook.importacao_diagnostico ADD CONSTRAINT importacao_diagnostico_origem_hash_chave_uk
  UNIQUE (origem, hash, chave);
COMMIT;
