-- Owner decision 22/10/2026: frequency evidence is pruned TRACEABLY and the nightly pruning also
-- removes the evidence a record left behind under another record's key.
--
-- Why: two fichas of the same student in the same class (a re-enrolment, a duplicate) were told
-- apart by their order in the diary; before the collector kept that order stable (19–21/10/2026)
-- a reading could swap them, storing one ficha's absences under the other's key. The official
-- absence (occurrence_v2) was always right and counted once; only an extra evidence line
-- (origin_v2) pointed at a ficha that, in its own latest coverage, had no lesson that day.
--
-- What changes:
--   * attendance.prune_run_v2: one row per run (nightly or by hand, simulated or real) with what it
--     removed by reason and its health checks. Kept for good: counts only, no personal data.
--   * attendance.pruned_origin_v2: every evidence line removed, copied BEFORE it is deleted, with
--     the student, day, lesson, mark, ficha, reading and reason. Deleted only with its school year
--     (year reset), like the evidence itself.
--   * attendance.prune_superseded_evidence_v2(p_dry_run, p_note): same daily job (03:00 UTC), now
--     archiving origins and with a second rule, "record-without-lesson". A line goes only when ALL
--     hold: its ficha's latest coverage of that day exists and has no such lesson; the same absence
--     stays proven by another ficha of the student whose latest coverage has the lesson; no conflict
--     is open on it; it does not come from the class's current reading. If any absence would be
--     left without evidence the whole run aborts and nothing is removed. p_dry_run => true only
--     counts and records the simulation.
-- The official marks (occurrence_v2) are never touched; the Portal's numbers cannot change.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE attendance.prune_run_v2 (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 rule_version text NOT NULL,
 dry_run boolean NOT NULL,
 note text CHECK(note IS NULL OR length(note) BETWEEN 1 AND 500),
 counts jsonb NOT NULL DEFAULT '{}'::jsonb,
 checks jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE attendance.pruned_origin_v2 (
 run_id bigint NOT NULL REFERENCES attendance.prune_run_v2(id) ON DELETE NO ACTION,
 reason text NOT NULL CHECK(reason IN('superseded','record-without-lesson')),
 -- The removed origin_v2 line, as it was.
 occurrence_id uuid NOT NULL, batch_id uuid NOT NULL, record_key text NOT NULL, mark text CHECK(mark IN('X','J')),
 -- What it was about, so the line reads on its own after its batch is pruned too.
 academic_year smallint NOT NULL, student_uid uuid NOT NULL, date date NOT NULL, shift text NOT NULL,
 slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 6), class_id integer NOT NULL, batch_received_at timestamptz NOT NULL,
 PRIMARY KEY(run_id,occurrence_id,batch_id,record_key)
);
CREATE INDEX pruned_origin_v2_student_idx ON attendance.pruned_origin_v2(academic_year,student_uid,date);
CREATE INDEX pruned_origin_v2_occurrence_idx ON attendance.pruned_origin_v2(occurrence_id);
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['prune_run_v2','pruned_origin_v2'] LOOP
  EXECUTE format('ALTER TABLE attendance.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE attendance.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON attendance.%I FROM PUBLIC,anon,authenticated,student_portal_app',item);
  EXECUTE format('CREATE POLICY frequency_runtime_v2 ON attendance.%I TO gradebook_app USING(true) WITH CHECK(true)',item);
 END LOOP;
END $$;
-- The runtime reads the last run (the Banco's frequency panel) and, with its school year, deletes
-- the archive (year reset). Only the pruning job writes them.
GRANT SELECT ON attendance.prune_run_v2 TO gradebook_app;
GRANT SELECT,DELETE ON attendance.pruned_origin_v2 TO gradebook_app;

DROP FUNCTION attendance.prune_superseded_evidence_v2();
CREATE FUNCTION attendance.prune_superseded_evidence_v2(p_dry_run boolean DEFAULT false, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  v_run bigint; v_superseded bigint; v_without bigint; v_orphaned bigint;
  v_marks bigint:=0; v_coverage bigint:=0; v_rows bigint:=0; v_batches bigint:=0;
  v_counts jsonb; v_checks jsonb;
BEGIN
  DROP TABLE IF EXISTS pg_temp.prune_candidate_v2;
  CREATE TEMP TABLE prune_candidate_v2 ON COMMIT DROP AS
  WITH latest AS (
    -- Each ficha's newest coverage of a day: what it says, today, about that day.
    SELECT DISTINCT ON (b.academic_year,b.class_id,c.record_key,c.date)
      b.academic_year,b.class_id,c.record_key,c.date,c.slots_json
    FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id
    ORDER BY b.academic_year,b.class_id,c.record_key,c.date,b.received_at DESC,b.id DESC),
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
    JOIN latest l ON l.academic_year=base.academic_year AND l.class_id=base.class_id
      AND l.record_key=base.record_key AND l.date=base.date
    WHERE NOT (l.slots_json @> to_jsonb(base.slot))
      AND NOT EXISTS(SELECT 1 FROM attendance.class_state_v2 cs
        WHERE cs.academic_year=base.academic_year AND cs.last_batch_id=base.batch_id)
      AND EXISTS(SELECT 1 FROM attendance.origin_v2 q JOIN attendance.batch_v2 n ON n.id=q.batch_id
        JOIN latest m ON m.academic_year=n.academic_year AND m.class_id=n.class_id
          AND m.record_key=q.record_key AND m.date=base.date
        WHERE q.occurrence_id=base.occurrence_id AND q.record_key<>base.record_key
          AND m.slots_json @> to_jsonb(base.slot)))
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
  WITH latest AS (
    SELECT DISTINCT ON (b.academic_year,b.class_id,c.record_key,c.date)
      b.academic_year,b.class_id,c.record_key,c.date,c.slots_json
    FROM attendance.coverage_v2 c JOIN attendance.batch_v2 b ON b.id=c.batch_id
    ORDER BY b.academic_year,b.class_id,c.record_key,c.date,b.received_at DESC,b.id DESC)
  SELECT jsonb_build_object(
    'occurrencesWithoutEvidence',
      (SELECT count(*) FROM attendance.occurrence_v2 o
        WHERE NOT EXISTS(SELECT 1 FROM attendance.origin_v2 p WHERE p.occurrence_id=o.id)),
    'unprovenRecordWithoutLesson',
      (SELECT count(*) FROM attendance.origin_v2 p JOIN attendance.occurrence_v2 o ON o.id=p.occurrence_id
        JOIN attendance.batch_v2 b ON b.id=p.batch_id
        JOIN latest l ON l.academic_year=b.academic_year AND l.class_id=b.class_id
          AND l.record_key=p.record_key AND l.date=o.date
        WHERE NOT (l.slots_json @> to_jsonb(o.slot))
          AND NOT EXISTS(SELECT 1 FROM attendance.origin_v2 q JOIN attendance.batch_v2 n ON n.id=q.batch_id
            JOIN latest m ON m.academic_year=n.academic_year AND m.class_id=n.class_id
              AND m.record_key=q.record_key AND m.date=o.date
            WHERE q.occurrence_id=p.occurrence_id AND q.record_key<>p.record_key
              AND m.slots_json @> to_jsonb(o.slot))))
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
REVOKE ALL ON FUNCTION attendance.prune_superseded_evidence_v2(boolean,text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','gradebook_app','collector_runtime','student_portal_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION attendance.prune_superseded_evidence_v2(boolean,text) FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
