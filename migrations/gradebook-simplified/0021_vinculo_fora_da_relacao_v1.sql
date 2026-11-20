-- A line deleted from the Relação keeps its student: the import only adds and updates (owner request
-- 20/11/2026). Each Relação import marks the places of its classes that the file no longer has and
-- clears the mark when the line comes back. Only the Conciliação's "Excluir aluno lançado por engano"
-- reads it: the button is offered only for a student out of the Relação with nothing in the system.
-- Additive: a column with a constant default (no table rewrite); vinculo grants and RLS cover it.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE gradebook.vinculo ADD COLUMN fora_da_relacao boolean NOT NULL DEFAULT false;
COMMIT;
