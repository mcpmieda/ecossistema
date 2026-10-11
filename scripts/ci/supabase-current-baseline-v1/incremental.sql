-- Synthetic incremental experiment; not approved for any live database.
ALTER TABLE student_portal.seal_count_cache_v1 ADD COLUMN baseline_trial_marker integer NOT NULL DEFAULT 0;
