-- Issue #1450, finding 24 (15/11/2026): the database's work_mem is 2 MB (small Supabase machine), so
-- the publication capture that runs inside every academic revision (each grade import and each
-- OneDrive write) spilled to temporary files on disk: ~450 KB per call, 4.5 GB in total. A function
-- level SET holds only during the call, as the nightly evidence pruning already does (attendance
-- 0021/0023, 32 MB). Settings only: same bodies, owners and grants; no data is changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER FUNCTION student_portal.capture_publication_source_v2() SET work_mem = '16MB';
ALTER FUNCTION student_portal.publication_source_rows_v2() SET work_mem = '16MB';
ALTER FUNCTION student_portal.pin_publication_auto_approval_v2() SET work_mem = '16MB';
COMMIT;
