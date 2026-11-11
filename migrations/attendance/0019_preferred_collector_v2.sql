-- Preferred collector (owner request 10/11/2026): with two or more authorized computers, the ADM picks
-- the one that sends the frequency. Any other computer waits as a reserve while the preferred one is
-- online, and still collects when it is offline or did not start the slot within the grace period
-- (server/attendance/service-v2.ts, PREFERRED_GRACE_SECONDS_V2), so a slot is never left without one.
-- Additive: NULL keeps the first-come lease of 0001. Table grants of 0001 cover the new columns.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE attendance.school_state_v2 ADD COLUMN preferred_device uuid;
-- lease_waiting_since: when a reserve was first refused for the preferred one, cleared by its own
-- lease. last_lease_at: the last lease a computer was granted.
ALTER TABLE attendance.device_status_v2 ADD COLUMN lease_waiting_since timestamptz;
ALTER TABLE attendance.device_status_v2 ADD COLUMN last_lease_at timestamptz;
COMMIT;
