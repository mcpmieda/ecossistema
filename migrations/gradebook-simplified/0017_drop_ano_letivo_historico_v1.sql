-- Removes the history of school-year rule changes. No screen or function ever changes those rules
-- (minimum and Council limit are set when the Relação is imported), so it never held a row.
-- Aborts without changing anything if a single row exists.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM gradebook.ano_letivo_historico) THEN
    RAISE EXCEPTION 'ano-letivo-historico-not-empty';
  END IF;
END $$;

DROP TABLE gradebook.ano_letivo_historico;

COMMIT;
