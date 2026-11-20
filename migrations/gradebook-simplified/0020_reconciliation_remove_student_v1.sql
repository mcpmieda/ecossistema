-- "Excluir aluno lançado por engano" in the Conciliação (owner request 20/11/2026): a student with no
-- grades, attendance, photos, council, bulletin or Smecel data, and whose Portal account was never used,
-- can be removed. The decision row keeps who, when and what (name, class, number) in before_state; its
-- student_uid stays null, so the removed student is not referenced (the FK to gradebook.aluno would
-- block the delete). Additive: only the allowed actions grow; table grants of 0015 cover the insert.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE gradebook.student_reconciliation_decision_v1 DROP CONSTRAINT student_reconciliation_decision_v1_action_check;
ALTER TABLE gradebook.student_reconciliation_decision_v1 ADD CONSTRAINT student_reconciliation_decision_v1_action_check
  CHECK(action IN ('associate','reject','separate','release','confirm','select-observation','class-link','name-source','smecel-only','remove-student'));
COMMIT;
