-- FP in the Smecel (18/11/2026): the diary stopped giving presence automatically. The teacher marks
-- each lesson present (the point) or absent (X) during the lesson, and a lesson not marked yet shows
-- "FP" (frequência pendente). The Coletor sends those positions in the day's coverage (`pending`, a
-- part of `slots`); they count neither as a presence nor as an absence until marked ("a confirmar").
-- Additive: a column with a constant default (no table rewrite) that every row already written reads
-- as "nothing pending". The server before this change inserts the first five columns by position, so
-- this last one takes its default; the readers that do not know it ignore it. Table grants and
-- policies already cover it. Apply BEFORE the server that writes it.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE attendance.coverage_v2
 ADD COLUMN pending_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(pending_json)='array');
COMMIT;
