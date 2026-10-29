-- Automatic Smecel "Relatório de alunos" (owner decision 29/10/2026). The Coletor reads the report on
-- its own agenda and the Ecossistema applies it through the Conciliação's own prepare/apply: whatever is
-- right is applied; every difference (a row with an invalid cell, an unlinked class, origins missing
-- from the report...) is listed in the Conciliação. Nothing is deleted or deactivated by a missing row.

-- The report's agenda, apart from the frequency's: {timezone, enabled, every, from, to, weekdays}.
ALTER TABLE attendance.school_state_v2 ADD COLUMN report_schedule_json jsonb;

-- The last report received: its content hash (an unchanged report only refreshes the dates), what the
-- application did and the differences sent to the Conciliação.
CREATE TABLE attendance.student_report_state_v2 (
 academic_year smallint PRIMARY KEY REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[A-Za-z0-9_-]{43}$'),
 last_observed_at timestamptz NOT NULL,
 last_received_at timestamptz NOT NULL,
 -- When the report last changed something (an application, or the differences recorded).
 last_changed_at timestamptz NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('applied','preparing','awaiting_relation','review')),
 -- The Conciliação batch being prepared or applied by the last report (none when nothing applied).
 batch_id uuid,
 rows integer NOT NULL CHECK(rows>=0),
 -- {counts:{rows,linked,pending}, differences:[text], invalid:[{sourceRow,name,classLabel,field,reason}]}
 notes_json jsonb NOT NULL
);
DO $$ BEGIN
 ALTER TABLE attendance.student_report_state_v2 ENABLE ROW LEVEL SECURITY;
 ALTER TABLE attendance.student_report_state_v2 FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON attendance.student_report_state_v2 FROM PUBLIC,anon,authenticated,student_portal_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON attendance.student_report_state_v2 TO gradebook_app;
 CREATE POLICY frequency_runtime_v2 ON attendance.student_report_state_v2 TO gradebook_app USING(true) WITH CHECK(true);
END $$;
