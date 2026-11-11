-- "Somente no Smecel" (owner request 10/11/2026): a report row with no student in the Relação that the
-- school knows will stay only in the Smecel. Marked in the Conciliação, it leaves the pending count, the
-- Frequência's "Alunos não reconhecidos" and the Coletor's notices. It is never a link: the next report
-- that finds the student in the Relação links the row as usual and the mark is cleared
-- (server/student-identity/reconciliation/apply-v1.ts). Additive; table grants of 0015 cover the column.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE gradebook.student_source_record_v1 ADD COLUMN smecel_only boolean NOT NULL DEFAULT false;
ALTER TABLE gradebook.student_reconciliation_decision_v1 DROP CONSTRAINT student_reconciliation_decision_v1_action_check;
ALTER TABLE gradebook.student_reconciliation_decision_v1 ADD CONSTRAINT student_reconciliation_decision_v1_action_check
  CHECK(action IN ('associate','reject','separate','release','confirm','select-observation','class-link','name-source','smecel-only'));
COMMIT;
