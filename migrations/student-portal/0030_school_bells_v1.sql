-- Horário das aulas (owner decision 23/10/2026): the time of each lesson and of the break, per shift
-- (matutino, vespertino) and weekday (1 = Monday … 5 = Friday), marked in the ADM (Portal do Aluno →
-- Políticas → Horário), one for the whole school. One row per school year, the days as JSON and a
-- version for optimistic writes; changes go to the admin audit ('settings-changed'). Starts with
-- the school's official "Horário Matutino / Vespertino 2026 — 22/06" (shared/student-portal-
-- contracts/school-bells-v1.ts), saved as version 1 by the system. Additive.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE student_portal.school_bells_v1 (
  academic_year smallint PRIMARY KEY CHECK (academic_year = 2026),
  bells_json jsonb NOT NULL CHECK (jsonb_typeof(bells_json) = 'object'),
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL
);
REVOKE ALL ON student_portal.school_bells_v1 FROM PUBLIC;
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
      EXECUTE format('REVOKE ALL ON student_portal.school_bells_v1 FROM %I',client_role);
    END IF;
  END LOOP;
END;
$$;
ALTER TABLE student_portal.school_bells_v1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY student_portal_app_backend_v1 ON student_portal.school_bells_v1
  FOR ALL TO student_portal_app USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE ON student_portal.school_bells_v1 TO student_portal_app;
INSERT INTO student_portal.school_bells_v1(academic_year,bells_json,version,updated_by)
VALUES(2026,'{"matutino":{"1":[{"kind":"aula","slot":1,"start":"07:00","end":"07:55"},{"kind":"aula","slot":2,"start":"07:55","end":"08:50"},{"kind":"aula","slot":3,"start":"08:50","end":"09:45"},{"kind":"intervalo","start":"09:45","end":"10:00"},{"kind":"aula","slot":4,"start":"10:00","end":"10:55"},{"kind":"aula","slot":5,"start":"10:55","end":"11:45"}],"2":[{"kind":"aula","slot":1,"start":"07:00","end":"07:45"},{"kind":"aula","slot":2,"start":"07:45","end":"08:30"},{"kind":"aula","slot":3,"start":"08:30","end":"09:15"},{"kind":"aula","slot":4,"start":"09:15","end":"10:00"},{"kind":"intervalo","start":"10:00","end":"10:15"},{"kind":"aula","slot":5,"start":"10:15","end":"11:00"},{"kind":"aula","slot":6,"start":"11:00","end":"11:45"}],"3":[{"kind":"aula","slot":1,"start":"07:00","end":"07:55"},{"kind":"aula","slot":2,"start":"07:55","end":"08:50"},{"kind":"aula","slot":3,"start":"08:50","end":"09:45"},{"kind":"intervalo","start":"09:45","end":"10:00"},{"kind":"aula","slot":4,"start":"10:00","end":"10:55"},{"kind":"aula","slot":5,"start":"10:55","end":"11:45"}],"4":[{"kind":"aula","slot":1,"start":"07:00","end":"07:45"},{"kind":"aula","slot":2,"start":"07:45","end":"08:30"},{"kind":"aula","slot":3,"start":"08:30","end":"09:15"},{"kind":"aula","slot":4,"start":"09:15","end":"10:00"},{"kind":"intervalo","start":"10:00","end":"10:15"},{"kind":"aula","slot":5,"start":"10:15","end":"11:00"},{"kind":"aula","slot":6,"start":"11:00","end":"11:45"}],"5":[{"kind":"aula","slot":1,"start":"07:45","end":"08:30"},{"kind":"aula","slot":2,"start":"08:30","end":"09:15"},{"kind":"aula","slot":3,"start":"09:15","end":"10:00"},{"kind":"intervalo","start":"10:00","end":"10:15"},{"kind":"aula","slot":4,"start":"10:15","end":"11:00"},{"kind":"aula","slot":5,"start":"11:00","end":"11:45"}]},"vespertino":{"1":[{"kind":"aula","slot":1,"start":"13:15","end":"14:10"},{"kind":"aula","slot":2,"start":"14:10","end":"15:05"},{"kind":"intervalo","start":"15:05","end":"15:20"},{"kind":"aula","slot":3,"start":"15:20","end":"16:15"},{"kind":"aula","slot":4,"start":"16:15","end":"17:10"},{"kind":"aula","slot":5,"start":"17:10","end":"18:00"}],"2":[{"kind":"aula","slot":1,"start":"13:15","end":"14:00"},{"kind":"aula","slot":2,"start":"14:00","end":"14:45"},{"kind":"aula","slot":3,"start":"14:45","end":"15:30"},{"kind":"intervalo","start":"15:30","end":"15:45"},{"kind":"aula","slot":4,"start":"15:45","end":"16:30"},{"kind":"aula","slot":5,"start":"16:30","end":"17:15"},{"kind":"aula","slot":6,"start":"17:15","end":"18:00"}],"3":[{"kind":"aula","slot":1,"start":"13:15","end":"14:10"},{"kind":"aula","slot":2,"start":"14:10","end":"15:05"},{"kind":"intervalo","start":"15:05","end":"15:20"},{"kind":"aula","slot":3,"start":"15:20","end":"16:15"},{"kind":"aula","slot":4,"start":"16:15","end":"17:10"},{"kind":"aula","slot":5,"start":"17:10","end":"18:00"}],"4":[{"kind":"aula","slot":1,"start":"13:15","end":"14:00"},{"kind":"aula","slot":2,"start":"14:00","end":"14:45"},{"kind":"aula","slot":3,"start":"14:45","end":"15:30"},{"kind":"intervalo","start":"15:30","end":"15:45"},{"kind":"aula","slot":4,"start":"15:45","end":"16:30"},{"kind":"aula","slot":5,"start":"16:30","end":"17:15"},{"kind":"aula","slot":6,"start":"17:15","end":"18:00"}],"5":[{"kind":"aula","slot":1,"start":"13:15","end":"14:00"},{"kind":"aula","slot":2,"start":"14:00","end":"14:45"},{"kind":"aula","slot":3,"start":"14:45","end":"15:30"},{"kind":"intervalo","start":"15:30","end":"15:45"},{"kind":"aula","slot":4,"start":"15:45","end":"16:30"},{"kind":"aula","slot":5,"start":"16:30","end":"17:15"}]}}'::jsonb,1,'00000000-0000-4000-8000-000000000000')
ON CONFLICT(academic_year) DO NOTHING;
COMMIT;
