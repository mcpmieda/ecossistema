-- Issue #1426, 34 (14/11/2026), follow-up of 0021: in the function the evidence lines met `latest`
-- through the batch, so the planner first matched each class's coverage with each of its batches
-- (5.6 million rows) and the dry run took 60 s. The evidence lines are now materialized with their
-- four keys before meeting `latest`, as in the query measured in production (2.8 s), and the
-- record-without-lesson rule reads each line's own answer by the line's key. Same rules, same results.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE OR REPLACE FUNCTION attendance.prune_superseded_evidence_v2(p_dry_run boolean DEFAULT false, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET work_mem='32MB' SET lock_timeout='5s' AS $$
DECLARE
  v_run bigint; v_superseded bigint; v_without bigint; v_orphaned bigint;
  v_marks bigint:=0; v_coverage bigint:=0; v_rows bigint:=0; v_batches bigint:=0;
  v_counts jsonb; v_checks jsonb;
BEGIN
  DROP TABLE IF EXISTS pg_temp.prune_candidate_v2;
  CREATE TEMP TABLE prune_candidate_v2 ON COMMIT DROP AS
  WITH latest AS MATERIALIZED (
    -- Each ficha's newest coverage of a day: what it says, today, about that day.
    SELECT DISTINCT ON (b.academic_year,b.class_id,c.record_key,c.date)
      b.academic_year,b.class_id,c.record_key,c.date,c.slots_json
    FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id
    ORDER BY b.academic_year,b.class_id,c.record_key,c.date,b.received_at DESC,b.id DESC),
  evidence AS MATERIALIZED (
    -- Every evidence line with its four keys first, so it meets `latest` on all four at once
    -- (joined through the batch, the planner matched each class's coverage with each of its batches).
    SELECT p.occurrence_id,p.batch_id,p.record_key,b.academic_year,b.class_id,o.date,o.slot
    FROM attendance.origin_v2 p JOIN attendance.occurrence_v2 o ON o.id=p.occurrence_id
    JOIN attendance.batch_v2 b ON b.id=p.batch_id),
  lines AS MATERIALIZED (
    -- Each evidence line: does its ficha's latest coverage of the day have the lesson?
    SELECT e.occurrence_id,e.batch_id,e.record_key,(l.slots_json @> to_jsonb(e.slot)) AS has_lesson
    FROM evidence e JOIN latest l ON l.academic_year=e.academic_year AND l.class_id=e.class_id
      AND l.record_key=e.record_key AND l.date=e.date),
  lessons AS MATERIALIZED (
    -- Per absence and ficha: does that ficha's latest coverage of the day have the lesson? And how
    -- many fichas of the absence do (one pass, instead of matching every line with every other).
    SELECT occurrence_id,record_key,key_lesson,
      count(*) FILTER (WHERE key_lesson) OVER (PARTITION BY occurrence_id) AS lesson_keys
    FROM (SELECT occurrence_id,record_key,bool_or(has_lesson) AS key_lesson
      FROM lines GROUP BY occurrence_id,record_key) k),
  base AS (
    SELECT p.occurrence_id,p.batch_id,p.record_key,p.mark,o.academic_year,o.student_uid,o.date,o.shift,o.slot,
      b.class_id,b.received_at
    FROM attendance.origin_v2 p JOIN attendance.occurrence_v2 o ON o.id=p.occurrence_id
    JOIN attendance.batch_v2 b ON b.id=p.batch_id
    WHERE NOT EXISTS(SELECT 1 FROM attendance.conflict_v2 c WHERE c.occurrence_id=p.occurrence_id AND c.state='open')),
  found AS (
    -- A newer reading of the same ficha already holds this absence.
    SELECT base.*,'superseded'::text AS reason FROM base
    WHERE EXISTS(SELECT 1 FROM attendance.origin_v2 q JOIN attendance.batch_v2 n ON n.id=q.batch_id
      WHERE q.occurrence_id=base.occurrence_id AND q.record_key=base.record_key
        AND n.academic_year=base.academic_year AND n.class_id=base.class_id AND n.received_at>base.received_at)
    UNION ALL
    -- The ficha says it had no such lesson; another ficha of the student had it and holds the absence.
    SELECT base.*,'record-without-lesson' FROM base
    JOIN lines x ON x.occurrence_id=base.occurrence_id AND x.batch_id=base.batch_id AND x.record_key=base.record_key
    WHERE NOT x.has_lesson
      AND NOT EXISTS(SELECT 1 FROM attendance.class_state_v2 cs
        WHERE cs.academic_year=base.academic_year AND cs.last_batch_id=base.batch_id)
      -- Another ficha of the same absence has the lesson in its latest coverage of the day.
      AND EXISTS(SELECT 1 FROM lessons k WHERE k.occurrence_id=base.occurrence_id AND k.record_key=base.record_key
        AND k.lesson_keys-(CASE WHEN k.key_lesson THEN 1 ELSE 0 END)>0))
  SELECT DISTINCT ON (occurrence_id,batch_id,record_key) * FROM found
  ORDER BY occurrence_id,batch_id,record_key,(reason='superseded') DESC;

  -- Safety: every absence keeps at least one evidence line, or nothing happens.
  SELECT count(*) INTO v_orphaned FROM (SELECT DISTINCT occurrence_id FROM prune_candidate_v2) c
  WHERE NOT EXISTS(SELECT 1 FROM attendance.origin_v2 p WHERE p.occurrence_id=c.occurrence_id
    AND NOT EXISTS(SELECT 1 FROM prune_candidate_v2 x
      WHERE x.occurrence_id=p.occurrence_id AND x.batch_id=p.batch_id AND x.record_key=p.record_key));
  IF v_orphaned>0 THEN
    RAISE EXCEPTION 'prune-would-orphan-occurrence: %',v_orphaned USING ERRCODE='23514';
  END IF;

  SELECT count(*) FILTER (WHERE reason='superseded'),count(*) FILTER (WHERE reason='record-without-lesson')
    INTO v_superseded,v_without FROM prune_candidate_v2;
  INSERT INTO attendance.prune_run_v2(rule_version,dry_run,note)
    VALUES('0009-record-without-lesson',p_dry_run,p_note) RETURNING id INTO v_run;

  IF NOT p_dry_run THEN
    INSERT INTO attendance.pruned_origin_v2(run_id,reason,occurrence_id,batch_id,record_key,mark,academic_year,
      student_uid,date,shift,slot,class_id,batch_received_at)
    SELECT v_run,reason,occurrence_id,batch_id,record_key,mark,academic_year,student_uid,date,shift,slot,class_id,received_at
    FROM prune_candidate_v2;
    DELETE FROM attendance.origin_v2 p USING prune_candidate_v2 c
    WHERE p.occurrence_id=c.occurrence_id AND p.batch_id=c.batch_id AND p.record_key=c.record_key;

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
  END IF;

  -- Health after the run (a simulation reads it as it is now). Both stay 0 in a sound diary:
  -- an absence with no evidence at all, and evidence only from fichas without that lesson (this
  -- rule cannot prove another ficha holds it, so it is left for review, never removed).
  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (b.academic_year,b.class_id,c.record_key,c.date)
      b.academic_year,b.class_id,c.record_key,c.date,c.slots_json
    FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id
    ORDER BY b.academic_year,b.class_id,c.record_key,c.date,b.received_at DESC,b.id DESC),
  evidence AS MATERIALIZED (
    SELECT p.occurrence_id,p.record_key,b.academic_year,b.class_id,o.date,o.slot
    FROM attendance.origin_v2 p JOIN attendance.occurrence_v2 o ON o.id=p.occurrence_id
    JOIN attendance.batch_v2 b ON b.id=p.batch_id),
  keyed AS MATERIALIZED (
    -- Per absence and ficha: its lines whose ficha has no such lesson, and whether the ficha has it.
    SELECT e.occurrence_id,e.record_key,bool_or(l.slots_json @> to_jsonb(e.slot)) AS key_lesson,
      count(*) FILTER (WHERE NOT (l.slots_json @> to_jsonb(e.slot))) AS without
    FROM evidence e JOIN latest l ON l.academic_year=e.academic_year AND l.class_id=e.class_id
      AND l.record_key=e.record_key AND l.date=e.date
    GROUP BY e.occurrence_id,e.record_key),
  counted AS (
    SELECT k.*,count(*) FILTER (WHERE k.key_lesson) OVER (PARTITION BY k.occurrence_id) AS lesson_keys FROM keyed k)
  SELECT jsonb_build_object(
    'occurrencesWithoutEvidence',
      (SELECT count(*) FROM attendance.occurrence_v2 o
        WHERE NOT EXISTS(SELECT 1 FROM attendance.origin_v2 p WHERE p.occurrence_id=o.id)),
    -- Lines whose ficha lacks the lesson while no OTHER ficha of the absence has it.
    'unprovenRecordWithoutLesson',
      (SELECT coalesce(sum(without),0) FROM counted
        WHERE lesson_keys-(CASE WHEN key_lesson THEN 1 ELSE 0 END)=0))
  INTO v_checks;

  v_counts:=jsonb_build_object('origins',v_superseded+v_without,'superseded',v_superseded,
    'recordWithoutLesson',v_without,'marks',v_marks,'coverage',v_coverage,'sourceRows',v_rows,'batches',v_batches);
  UPDATE attendance.prune_run_v2 SET counts=v_counts,checks=v_checks WHERE id=v_run;
  -- A check above zero shows in the Banco's frequency panel, in the seven-day failure trail.
  IF NOT p_dry_run THEN
    INSERT INTO attendance.failure_v2(origin,operation,code,detail,fingerprint)
    SELECT 'admin','evidence-pruning',v.code,format('Revisar %s registro(s) no banco.',v.n),'admin|evidence-pruning|'||v.code
    FROM (VALUES('EVIDENCE_WITHOUT_ORIGIN',(v_checks->>'occurrencesWithoutEvidence')::bigint),
                ('EVIDENCE_UNPROVEN',(v_checks->>'unprovenRecordWithoutLesson')::bigint)) v(code,n)
    WHERE v.n>0;
  END IF;
  RETURN v_counts||jsonb_build_object('run',v_run,'dryRun',p_dry_run,'checks',v_checks);
END $$;
COMMIT;
