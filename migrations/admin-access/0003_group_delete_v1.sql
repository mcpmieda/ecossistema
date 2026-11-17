-- Owner decision of 17/11/2026 (#1513): a group created by the Centro can be deleted from it, with
-- the delegated sign-in of the person who deletes (only Global Administrators and the institutional
-- account succeed in Entra). The history gains the 'delete-group' action.
-- Additive: the old values stay valid. Apply before the deploy that deletes groups.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE admin_access.group_change_v1
  DROP CONSTRAINT group_change_v1_action_check,
  ADD CONSTRAINT group_change_v1_action_check
    CHECK (action IN ('create-group', 'add-member', 'remove-member', 'delete-group'));
COMMIT;
