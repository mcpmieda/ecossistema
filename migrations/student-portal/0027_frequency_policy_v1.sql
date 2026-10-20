-- Política Frequência (owner request 20/10/2026). Additive only, no seed.
-- `showFrequency` (off) hides the attendance section of the Portal do Aluno and makes
-- /api/student/frequency refuse the read. A missing row reads as off at every level, so the
-- school, shift, class and account scopes store only what the operator saves.
-- DEPLOY ORDER: apply this BEFORE the Worker that writes `showFrequency`; the previous Worker
-- never writes the field, and the new one reads a missing row as off.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE student_portal.setting DROP CONSTRAINT student_portal_setting_field_v1;
ALTER TABLE student_portal.setting ADD CONSTRAINT student_portal_setting_field_v1 CHECK (
  field_key IN ('accessEnabled','accessSchedule','showPartials','autoUpdate','showFinalResult','showTermClosing','termClosingConclusive','showFrequency','allowedPeriods','risk','calendar')
);
COMMIT;
