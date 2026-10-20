-- Owner decision (20/10/2026): keep only what frequency needs to work.
-- The official marks (occurrence_v2) are never touched. Collection batches store
-- only what changed, so the newest evidence of each key may live in an old batch;
-- this removes evidence rows a newer batch of the same class already replaced,
-- then batches left empty. Kept on purpose:
--   * the newest row per key, which the next collection compares against
--     (origin per occurrence+record, coverage per record+day, mark per
--     record+day+slot, source row per record);
--   * every origin of an occurrence with an open conflict (admin decision);
--   * a source row still referenced by a kept origin, coverage or mark;
--   * each class's current batch (class_state_v2.last_batch_id, repeat detection).
-- Conflicts and corrections are kept. Receipts of removed batches expire through
-- the existing 8-day operational receipt cleanup.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE FUNCTION attendance.prune_superseded_evidence_v2() RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  v_origins bigint; v_marks bigint; v_coverage bigint; v_rows bigint; v_batches bigint;
BEGIN
  WITH gone AS (
    DELETE FROM attendance.origin_v2 p USING attendance.batch_v2 b
    WHERE b.id=p.batch_id
      AND NOT EXISTS(SELECT 1 FROM attendance.conflict_v2 c WHERE c.occurrence_id=p.occurrence_id AND c.state='open')
      AND EXISTS(SELECT 1 FROM attendance.origin_v2 q JOIN attendance.batch_v2 n ON n.id=q.batch_id
        WHERE q.occurrence_id=p.occurrence_id AND q.record_key=p.record_key
          AND n.academic_year=b.academic_year AND n.class_id=b.class_id AND n.received_at>b.received_at)
    RETURNING 1)
  SELECT count(*) INTO v_origins FROM gone;

  WITH gone AS (
    DELETE FROM attendance.source_mark_v2 m USING attendance.batch_v2 b
    WHERE b.id=m.batch_id
      AND EXISTS(SELECT 1 FROM attendance.source_mark_v2 q JOIN attendance.batch_v2 n ON n.id=q.batch_id
        WHERE q.record_key=m.record_key AND q.date=m.date AND q.slot=m.slot
          AND n.academic_year=b.academic_year AND n.class_id=b.class_id AND n.received_at>b.received_at)
    RETURNING 1)
  SELECT count(*) INTO v_marks FROM gone;

  WITH gone AS (
    DELETE FROM attendance.coverage_v2 c USING attendance.batch_v2 b
    WHERE b.id=c.batch_id
      AND EXISTS(SELECT 1 FROM attendance.coverage_v2 q JOIN attendance.batch_v2 n ON n.id=q.batch_id
        WHERE q.record_key=c.record_key AND q.date=c.date
          AND n.academic_year=b.academic_year AND n.class_id=b.class_id AND n.received_at>b.received_at)
    RETURNING 1)
  SELECT count(*) INTO v_coverage FROM gone;

  WITH gone AS (
    DELETE FROM attendance.source_row_v2 s USING attendance.batch_v2 b
    WHERE b.id=s.batch_id
      AND EXISTS(SELECT 1 FROM attendance.source_row_v2 q JOIN attendance.batch_v2 n ON n.id=q.batch_id
        WHERE q.record_key=s.record_key
          AND n.academic_year=b.academic_year AND n.class_id=b.class_id AND n.received_at>b.received_at)
      AND NOT EXISTS(SELECT 1 FROM attendance.origin_v2 p WHERE p.batch_id=s.batch_id AND p.record_key=s.record_key)
      AND NOT EXISTS(SELECT 1 FROM attendance.coverage_v2 c WHERE c.batch_id=s.batch_id AND c.record_key=s.record_key)
      AND NOT EXISTS(SELECT 1 FROM attendance.source_mark_v2 m WHERE m.batch_id=s.batch_id AND m.record_key=s.record_key)
    RETURNING 1)
  SELECT count(*) INTO v_rows FROM gone;

  WITH gone AS (
    DELETE FROM attendance.batch_v2 b
    WHERE NOT EXISTS(SELECT 1 FROM attendance.source_row_v2 s WHERE s.batch_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM attendance.class_state_v2 cs
        WHERE cs.academic_year=b.academic_year AND cs.last_batch_id=b.id)
    RETURNING 1)
  SELECT count(*) INTO v_batches FROM gone;

  RETURN jsonb_build_object('origins',v_origins,'marks',v_marks,'coverage',v_coverage,
    'sourceRows',v_rows,'batches',v_batches);
END $$;
REVOKE ALL ON FUNCTION attendance.prune_superseded_evidence_v2() FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','gradebook_app','collector_runtime','student_portal_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION attendance.prune_superseded_evidence_v2() FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
