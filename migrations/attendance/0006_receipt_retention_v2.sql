-- #1293 audit. Additive: receipts carry their age so operational ones
-- (heartbeat, lease, settings, no new batch) can expire after the queue window.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE attendance.receipt_v2 ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX frequency_receipt_age_v2 ON attendance.receipt_v2(recorded_at);
COMMIT;
