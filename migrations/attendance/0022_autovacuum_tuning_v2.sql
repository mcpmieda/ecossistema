-- Issue #1426, 27 (complement 2, 14/11/2026): the most read frequency tables are small and change a
-- little every day (the diary sends, the nightly pruning). With the default thresholds (20% of the
-- table) autovacuum hardly ran (occurrence_v2 last vacuumed 17/10, 10% of its pages all-visible),
-- so index-only scans went back to the table row by row. Lower thresholds keep the visibility map
-- current. Settings only: no data changes. A manual VACUUM (ANALYZE) was run on 14/11/2026, and
-- gradebook.nota got the same setting (scale factors 0.05) directly, as an operation.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE attendance.occurrence_v2 SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_vacuum_insert_scale_factor=0.02, autovacuum_analyze_scale_factor=0.02);
ALTER TABLE attendance.origin_v2 SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_vacuum_insert_scale_factor=0.02, autovacuum_analyze_scale_factor=0.02);
ALTER TABLE attendance.source_row_v2 SET (autovacuum_vacuum_scale_factor=0.05, autovacuum_vacuum_insert_scale_factor=0.05);
COMMIT;
