-- Every academic and Coletor write calls ensure_year_coordination_v1, but it only initializes the
-- year's row once. When the row exists it now returns after one index read (~17 us) instead of
-- scanning pg_locks twice and attempting INSERT ... ON CONFLICT (~0.5 ms, more under load: it was
-- the busiest statement of the database). The lock check still guards the first materialization.
-- publication_source_rows_v2 has no caller since the incremental v3 reader; it is dropped.
-- Same owner, grants and settings; no data is changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE OR REPLACE FUNCTION student_portal.ensure_year_coordination_v1(p_year smallint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, student_portal
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM student_portal.academic_revision WHERE academic_year = p_year) THEN
    RETURN;
  END IF;
  PERFORM student_portal.assert_year_reset_locks_v1(p_year,false);
  INSERT INTO student_portal.academic_revision
    (academic_year,academic_generation,reset_generation,portal_link_generation,academic_counter,reset_counter,portal_link_counter)
  VALUES (p_year,replace(gen_random_uuid()::text,'-',''),replace(gen_random_uuid()::text,'-',''),
          replace(gen_random_uuid()::text,'-',''),1,1,1)
  ON CONFLICT (academic_year) DO NOTHING;
END
$$;
DROP FUNCTION student_portal.publication_source_rows_v2();
COMMIT;
