-- Owner request of 14/10/2026: every academic revision adds an edition per changed student to
-- publication_source_v2 and none was ever removed (58 per student, 60% of the database).
-- An edition is read only as "the newest one at or below a target revision". The targets a
-- student can still reach are the legacy approval of the account, every scoped release target,
-- the auto-approval pin and the head, each raised to the pin exactly as SCOPED_SELECTION_V2 does.
-- Editions older than the oldest one those targets reach are never read and are removed.
-- No publication, release, policy, account or academic fact is changed.
BEGIN;

CREATE FUNCTION student_portal.prune_publication_source_v1()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed integer;
BEGIN
  -- The same locks as the preparation of a new edition: no capture runs meanwhile.
  PERFORM pg_advisory_xact_lock_shared(613,0);
  PERFORM pg_advisory_xact_lock(613,2026);
  WITH h AS (
    SELECT generation, revision FROM student_portal.publication_source_head_v2 WHERE academic_year=2026
  ), students AS (
    SELECT DISTINCT s.student_id FROM student_portal.publication_source_v2 s, h
    WHERE s.academic_year=2026 AND s.generation=h.generation
  ), targets AS (
    SELECT st.student_id, split_part(p.published_revision,':',2)::numeric AS revision
    FROM students st
    JOIN student_portal.account a ON a.academic_year=2026 AND a.gradebook_student_id=st.student_id
    JOIN student_portal.publication p ON p.account_id=a.id, h
    WHERE p.published_revision IS NOT NULL AND split_part(p.published_revision,':',1)=h.generation::text
    UNION
    SELECT st.student_id, split_part(r.target_revision,':',2)::numeric
    FROM students st CROSS JOIN student_portal.publication_release_v2 r, h
    WHERE r.academic_year=2026 AND r.target_revision IS NOT NULL
      AND split_part(r.target_revision,':',1)=h.generation::text
    UNION
    SELECT st.student_id, h.revision FROM students st, h
  ), caps AS (
    SELECT t.student_id, GREATEST(t.revision, COALESCE(pin.revision,0)) AS cap
    FROM targets t CROSS JOIN h
    LEFT JOIN student_portal.publication_auto_approval_v2 pin ON pin.academic_year=2026
      AND pin.student_id=t.student_id AND pin.generation=h.generation
  ), keep_from AS (
    SELECT c.student_id, min(e.revision) AS revision
    FROM caps c CROSS JOIN h
    JOIN LATERAL (SELECT s.revision FROM student_portal.publication_source_v2 s
      WHERE s.academic_year=2026 AND s.student_id=c.student_id AND s.generation=h.generation
        AND s.revision<=c.cap ORDER BY s.revision DESC LIMIT 1) e ON true
    GROUP BY c.student_id
  )
  DELETE FROM student_portal.publication_source_v2 s
  USING keep_from k, h
  WHERE s.academic_year=2026 AND s.student_id=k.student_id AND s.generation=h.generation
    AND s.revision<k.revision;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION student_portal.prune_publication_source_v1() FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','gradebook_app'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION student_portal.prune_publication_source_v1() FROM %I', r);
    END IF;
  END LOOP;
END $$;
-- The scheduled maintenance of the Portal calls it; the role cannot delete rows by itself.
GRANT EXECUTE ON FUNCTION student_portal.prune_publication_source_v1() TO student_portal_app;

COMMIT;
