-- Approved dedicated runtime access. Credentials are provisioned separately;
-- never store a password or verifier in migration history.
CREATE ROLE collector_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
GRANT USAGE ON SCHEMA collector_auth TO collector_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE collector_auth.oauth_grants,
  collector_auth.devices, collector_auth.challenges, collector_auth.pairings
  TO collector_runtime;
