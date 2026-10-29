-- Política Ocorrências (owner decision 29/10/2026). Additive only, no seed.
-- `showIncidents` (off) hides the "Ocorrências" tab of the Portal do Aluno. A missing row reads as
-- off at every level, so the school, shift, class and account scopes store only what the operator
-- saves; the owner keeps it off until the Portal page is ready.
-- DEPLOY ORDER: apply this BEFORE the Worker that writes `showIncidents`; the previous Worker
-- never writes the field, and the new one reads a missing row as off.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE student_portal.setting DROP CONSTRAINT student_portal_setting_field_v1;
ALTER TABLE student_portal.setting ADD CONSTRAINT student_portal_setting_field_v1 CHECK (
  field_key IN ('accessEnabled','accessSchedule','showPartials','autoUpdate','showFinalResult','showTermClosing','termClosingConclusive','showFrequency','showSchedule','showIncidents','allowedPeriods','risk','calendar')
);
COMMIT;
