-- Calendário escolar (owner decision 22/10/2026): the school's days of the year, marked in the ADM
-- (Portal do Aluno → Políticas → Calendário), one for the whole school (never per shift, class or
-- student). The rule is 200 school days. The Portal counts the year's countdown and the absence
-- limit from it. One row per school year: the marked days as JSON ([{date, kind, note?}], a date
-- not marked has no school) and a version for optimistic writes. Who changed it goes to the admin
-- audit ('settings-changed'). Additive; a missing row means no calendar yet.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE student_portal.school_calendar_v1 (
  academic_year smallint PRIMARY KEY CHECK (academic_year = 2026),
  days_json jsonb NOT NULL CHECK (jsonb_typeof(days_json) = 'array' AND jsonb_array_length(days_json) <= 366),
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL
);
REVOKE ALL ON student_portal.school_calendar_v1 FROM PUBLIC;
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
      EXECUTE format('REVOKE ALL ON student_portal.school_calendar_v1 FROM %I',client_role);
    END IF;
  END LOOP;
END;
$$;
ALTER TABLE student_portal.school_calendar_v1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY student_portal_app_backend_v1 ON student_portal.school_calendar_v1
  FOR ALL TO student_portal_app USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE ON student_portal.school_calendar_v1 TO student_portal_app;
COMMIT;
