-- Synthetic fixture only. Never a production migration.
CREATE TABLE trial_private.cache_probe (
  id bigint PRIMARY KEY,
  value integer NOT NULL CHECK (value >= 0)
);
ALTER TABLE trial_private.cache_probe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trial_private.cache_probe FROM PUBLIC;
