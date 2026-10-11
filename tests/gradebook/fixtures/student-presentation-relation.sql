-- Legacy read-model fixtures install only schema 0001, before reconciliation tables existed.
-- They exercise the same presentation interface using the Relação fallback.
CREATE VIEW gradebook.student_presentation_v1 AS
SELECT id AS student_id, ano AS academic_year, nome AS name FROM gradebook.aluno;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gradebook_app') THEN
    GRANT SELECT ON gradebook.student_presentation_v1 TO gradebook_app;
  END IF;
END $$;
