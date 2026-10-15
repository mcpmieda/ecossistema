-- #1289. CLI scaffold: 20261015151326_frequency_fk_indexes_v2.sql.
-- Covers the new frequency foreign keys used by parent checks and annual cleanup.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE INDEX frequency_class_parent_v2 ON attendance.class_state_v2(class_id,academic_year);
CREATE INDEX frequency_class_current_batch_v2 ON attendance.class_state_v2(academic_year,last_batch_id);
CREATE INDEX frequency_correction_conflict_v2 ON attendance.correction_v2(conflict_id);
CREATE INDEX frequency_occurrence_identity_v2 ON attendance.occurrence_v2(student_uid);
COMMIT;
