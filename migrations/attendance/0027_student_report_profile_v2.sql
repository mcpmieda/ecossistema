-- The enrolment form's data for the online re-enrolment (coletor#91). The Coletor's automatic
-- "Relatório de alunos" brings, with each row, what the Smecel's enrolment form holds (documents,
-- address, phones, guardian, health flags), already normalized. It is personal data: kept here only,
-- one row per Smecel enrolment, replaced by the last report received. The Conciliação, the receipts and
-- the report's notes never hold it. A row missing from a later report deletes nothing, as in 0015.

-- The report's hash over what the Conciliação reads (the rows without the enrolment form's data): the
-- same rows with another phone or address only replace the profiles, with no application.
ALTER TABLE attendance.student_report_state_v2
 ADD COLUMN core_hash text CHECK(core_hash ~ '^[A-Za-z0-9_-]{43}$');

CREATE TABLE attendance.student_report_profile_v2 (
 academic_year smallint NOT NULL REFERENCES attendance.school_state_v2(academic_year) ON DELETE NO ACTION,
 -- The Smecel's "hash da matrícula", as in gradebook.student_source_observation_v1.enrollment_hash.
 enrollment_hash text NOT NULL CHECK(length(enrollment_hash) BETWEEN 1 AND 300),
 -- studentReportProfileV2 (shared/attendance-contracts/frequency-v2.ts).
 profile_json jsonb NOT NULL CHECK(jsonb_typeof(profile_json)='object'),
 -- When the Coletor read the report that last changed this row, and when it arrived.
 observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL,
 PRIMARY KEY(academic_year,enrollment_hash)
);
DO $$ BEGIN
 ALTER TABLE attendance.student_report_profile_v2 ENABLE ROW LEVEL SECURITY;
 ALTER TABLE attendance.student_report_profile_v2 FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON attendance.student_report_profile_v2 FROM PUBLIC,anon,authenticated,student_portal_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON attendance.student_report_profile_v2 TO gradebook_app;
 CREATE POLICY frequency_runtime_v2 ON attendance.student_report_profile_v2 TO gradebook_app USING(true) WITH CHECK(true);
END $$;
