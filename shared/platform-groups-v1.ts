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

export type GroupChangeActionV1 =
  'create-group' | 'add-member' | 'remove-member' | 'delete-group' | 'save-rule' | 'delete-rule';
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

/**
 * A rule of the flow "Grupos por Cargo" (SharePoint list REGRAS): a job title adds the person to a
 * group, or is ignored. The flow compares the title in lower case.
 */
export type GroupRuleActionV1 = 'ADICIONAR' | 'IGNORAR';
export type GroupRuleV1 = {
  id: string;
  /** The job title as written by the Secretaria. */
  cargo: string;
  /** What the flow compares: the title in lower case. */
  cargoKey: string;
  action: GroupRuleActionV1;
  groupId: string | null;
  groupName: string | null;
  active: boolean;
  note: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
};
export const GROUP_RULE_CARGO_MAX_V1 = 120;
export const GROUP_RULE_NOTE_MAX_V1 = 300;

/** People the flow could not place (list ESTADO), to review. */
export type GroupRuleStatusV1 = 'PENDENTE_CARGO' | 'SEM_REGRA' | 'PENDENTE_GRUPO' | 'ERRO';
export type GroupRulePersonV1 = {
  name: string | null;
  email: string | null;
  cargo: string | null;
  status: GroupRuleStatusV1;
  detail: string | null;
  checkedAt: string | null;
};

/** The flow's recent log (list LOG), newest first. */
export type GroupFlowLogV1 = {
  at: string | null;
  name: string | null;
  email: string | null;
  cargo: string | null;
  groupName: string | null;
  operation: string | null;
  result: string | null;
  detail: string | null;
};

export type GroupsRequestV1 =
  | { contractVersion: 1; operation: 'list' }
  | { contractVersion: 1; operation: 'members'; groupId: string }
  | { contractVersion: 1; operation: 'find-people'; query: string }
  | { contractVersion: 1; operation: 'history'; groupId?: string }
  | { contractVersion: 1; operation: 'add-member'; groupId: string; email: string }
  | { contractVersion: 1; operation: 'remove-member'; groupId: string; personId: string }
  | { contractVersion: 1; operation: 'create-group'; name: string; description?: string }
  /** Starts the deletion: the answer sends the browser to Microsoft, which asks the person to sign
   * in for it; the deletion runs on the way back, with that sign-in. */
  | { contractVersion: 1; operation: 'delete-start'; groupId: string; confirmName: string }
  | { contractVersion: 1; operation: 'rules' }
  | {
      contractVersion: 1;
      operation: 'save-rule';
      /** Absent for a new rule. */
      ruleId?: string;
      cargo: string;
      action: GroupRuleActionV1;
      /** Required to add; absent to ignore. */
      groupId?: string;
      active: boolean;
      note?: string;
    }
  | { contractVersion: 1; operation: 'delete-rule'; ruleId: string };

export type GroupsReadOperationV1 = 'list' | 'members' | 'find-people' | 'history' | 'rules';
export const GROUPS_READ_OPERATIONS_V1: readonly GroupsReadOperationV1[] = [
  'list',
  'members',
  'find-people',
  'history',
  'rules',
];

export type GroupsResponseV1 =
  | {
      contractVersion: 1;
      state: 'ok';
      operation: 'list';
      groups: GroupViewV1[];
      /** Global Administrators and the institutional account may delete groups created here. */
      canDelete: boolean;
    }
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
  | { contractVersion: 1; state: 'ok'; operation: 'create-group'; group: GroupViewV1 }
  | { contractVersion: 1; state: 'ok'; operation: 'delete-start'; authorizeUrl: string }
  | {
      contractVersion: 1;
      state: 'ok';
      operation: 'rules';
      rules: GroupRuleV1[];
      people: GroupRulePersonV1[];
      log: GroupFlowLogV1[];
    }
  | { contractVersion: 1; state: 'ok'; operation: 'save-rule'; rule: GroupRuleV1 }
  | { contractVersion: 1; state: 'ok'; operation: 'delete-rule' };

/** How the deletion ended, in the address the browser comes back to (`#/configuracoes?grupos=`). */
export const GROUP_DELETE_RESULTS_V1 = ['excluido', 'recusado', 'cancelado', 'falhou'] as const;
export type GroupDeleteResultV1 = (typeof GROUP_DELETE_RESULTS_V1)[number];

/**
 * - `not-allowed`: the group is neither a role group nor one created by the Centro;
 * - `person-not-found`: no account with that e-mail;
 * - `self-removal`: nobody removes themselves from the admin group (it would lock them out);
 * - `name-taken`: a reachable group already has that name;
 * - `delete-not-allowed`: a role group, or a person who may not delete;
 * - `name-mismatch`: the name typed to confirm a deletion is not the group's;
 * - `rule-duplicate`: another active rule has the same job title;
 * - `rule-not-found`: the rule was removed meanwhile.
 */
export type GroupsFailureStateV1 =
  | 'invalid-request'
  | 'not-authorized'
  | 'not-allowed'
  | 'person-not-found'
  | 'self-removal'
  | 'name-taken'
  | 'delete-not-allowed'
  | 'name-mismatch'
  | 'rule-duplicate'
  | 'rule-not-found'
  | 'unavailable';

export type GroupsFailureV1 = { contractVersion: 1; state: GroupsFailureStateV1 };
