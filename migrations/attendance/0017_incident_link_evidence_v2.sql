-- Audit finding (owner approval 04/11/2026): an incident kept the student it was linked to even
-- after the Conciliação undid that link, so the Portal could show it on the wrong account.
-- Each record now keeps the evidence of its link, the same pair the frequency rows keep
-- (source ids and observation ids, attendance 0001), written at every collection. 0018 makes the
-- Portal readers revalidate it with gradebook.reconciliation_evidence_valid_v2.
-- Additive. Rows collected before this migration have no evidence and stay hidden from the Portal
-- until the next collection writes it; their confirmations are kept.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE attendance.incident_v2
 ADD COLUMN source_ids_json jsonb CHECK(source_ids_json IS NULL OR jsonb_typeof(source_ids_json)='array'),
 ADD COLUMN observation_ids_json jsonb CHECK(observation_ids_json IS NULL OR jsonb_typeof(observation_ids_json)='array'),
 ADD CONSTRAINT incident_v2_link_evidence_v2 CHECK(student_uid IS NOT NULL OR (source_ids_json IS NULL AND observation_ids_json IS NULL));
COMMIT;
