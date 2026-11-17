/**
 * Grupos do Microsoft 365 managed from the Centro (#1513). Only the five role groups and the
 * groups the Centro created are reachable; every change goes to Entra through the Graph Backend app.
 */
export const GROUPS_PATH_V1 = '/api/platform/groups';
export const GROUP_NAME_MAX_V1 = 120;
export const GROUP_DESCRIPTION_MAX_V1 = 500;

export type GroupRoleV1 = 'ADMINISTRADOR' | 'PROFESSOR' | 'ALUNO' | 'APOIO' | 'VISITANTE';

export type GroupViewV1 = {
  id: string;
  name: string;
  description: string | null;
  mail: string | null;
  /** The Ecossistema role the group gives, or null for a group created by the Centro. */
  role: GroupRoleV1 | null;
  memberCount: number | null;
  /** False when Entra did not answer for this group (deleted outside the Centro, or a failure). */
  available: boolean;
};

export type GroupPersonV1 = {
  id: string;
  name: string | null;
  email: string | null;
  jobTitle: string | null;
  enabled: boolean | null;
};

export type GroupChangeActionV1 = 'create-group' | 'add-member' | 'remove-member';
export type GroupChangeOutcomeV1 = 'done' | 'unchanged' | 'failed';

export type GroupChangeV1 = {
  at: string;
  actor: string;
  action: GroupChangeActionV1;
  groupId: string | null;
  groupName: string | null;
  target: string | null;
  outcome: GroupChangeOutcomeV1;
};

export type GroupsRequestV1 =
  | { contractVersion: 1; operation: 'list' }
  | { contractVersion: 1; operation: 'members'; groupId: string }
  | { contractVersion: 1; operation: 'find-people'; query: string }
  | { contractVersion: 1; operation: 'history'; groupId?: string }
  | { contractVersion: 1; operation: 'add-member'; groupId: string; email: string }
  | { contractVersion: 1; operation: 'remove-member'; groupId: string; personId: string }
  | { contractVersion: 1; operation: 'create-group'; name: string; description?: string };

export type GroupsReadOperationV1 = 'list' | 'members' | 'find-people' | 'history';
export const GROUPS_READ_OPERATIONS_V1: readonly GroupsReadOperationV1[] = [
  'list',
  'members',
  'find-people',
  'history',
];

export type GroupsResponseV1 =
  | { contractVersion: 1; state: 'ok'; operation: 'list'; groups: GroupViewV1[] }
  | {
      contractVersion: 1;
      state: 'ok';
      operation: 'members';
      groupId: string;
      members: GroupPersonV1[];
    }
  | { contractVersion: 1; state: 'ok'; operation: 'find-people'; people: GroupPersonV1[] }
  | { contractVersion: 1; state: 'ok'; operation: 'history'; changes: GroupChangeV1[] }
  | {
      contractVersion: 1;
      state: 'ok';
      operation: 'add-member';
      result: 'added' | 'already-member';
      person: GroupPersonV1;
    }
  | {
      contractVersion: 1;
      state: 'ok';
      operation: 'remove-member';
      result: 'removed' | 'not-member';
    }
  | { contractVersion: 1; state: 'ok'; operation: 'create-group'; group: GroupViewV1 };

/**
 * - `not-allowed`: the group is neither a role group nor one created by the Centro;
 * - `person-not-found`: no account with that e-mail;
 * - `self-removal`: nobody removes themselves from the admin group (it would lock them out);
 * - `name-taken`: a reachable group already has that name.
 */
export type GroupsFailureStateV1 =
  | 'invalid-request'
  | 'not-authorized'
  | 'not-allowed'
  | 'person-not-found'
  | 'self-removal'
  | 'name-taken'
  | 'unavailable';

export type GroupsFailureV1 = { contractVersion: 1; state: GroupsFailureStateV1 };
