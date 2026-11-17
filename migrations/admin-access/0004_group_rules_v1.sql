-- Owner decision of 17/11/2026 (#1513): the rules of the flow "Grupos por Cargo" (SharePoint list
-- REGRAS) are edited from the Centro. The history gains 'save-rule' and 'delete-rule'; the job
-- title goes in target, never a person.
-- Additive: the old values stay valid. Apply before the deploy that edits rules.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE admin_access.group_change_v1
  DROP CONSTRAINT group_change_v1_action_check,
  ADD CONSTRAINT group_change_v1_action_check
    CHECK (action IN ('create-group', 'add-member', 'remove-member', 'delete-group', 'save-rule', 'delete-rule'));
COMMIT;
