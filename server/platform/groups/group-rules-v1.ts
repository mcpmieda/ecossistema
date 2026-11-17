import type { GroupRuleActionV1, GroupsResponseV1 } from '../../../shared/platform-groups-v1';
import type { RuntimeEnv } from '../../env';
import { GroupsRefusalV1, recordV1, roleGroupsV1, type ContextV1 } from './groups-context-v1';
import { cargoKeyV1, groupRulesGraphPortV1, type GroupRulesPortV1 } from './group-rules-graph-v1';

/** The rules of the flow "Grupos por Cargo", edited from Configurações › Grupos (#1513). */
let rulesOverrideV1: GroupRulesPortV1 | null | undefined;
/** Tests replace the SharePoint lists; `undefined` restores them. */
export function setGroupRulesForTestsV1(port: GroupRulesPortV1 | null | undefined): void {
  rulesOverrideV1 = port;
}
const rulesPortV1 = (env: RuntimeEnv) =>
  rulesOverrideV1 === undefined ? groupRulesGraphPortV1(env) : rulesOverrideV1;
const LOG_LIMIT_V1 = 50;

function requireRulesV1(env: RuntimeEnv): GroupRulesPortV1 {
  const port = rulesPortV1(env);
  if (!port) throw new GroupsRefusalV1('unavailable', 503);
  return port;
}

export async function listRulesV1(context: ContextV1): Promise<GroupsResponseV1> {
  const port = requireRulesV1(context.env);
  const [rules, people, log] = await Promise.all([
    port.rules(),
    port.people(),
    port.log(LOG_LIMIT_V1),
  ]);
  return { contractVersion: 1, state: 'ok', operation: 'rules', rules, people, log };
}

/** The group a rule adds to: a role group or one created by the Centro, with its Entra name. */
async function ruleGroupV1(context: ContextV1, groupId: string): Promise<string> {
  const isRole = roleGroupsV1(context.env).some(([roleGroupId]) => roleGroupId === groupId);
  const managed = isRole
    ? null
    : (await context.store?.managedGroups())?.find((group) => group.id === groupId);
  if (!isRole && !managed) throw new GroupsRefusalV1('not-allowed', 403);
  const group = await context.graph.group(groupId);
  const name = group?.name || managed?.name;
  if (!name) throw new GroupsRefusalV1('not-allowed', 403);
  return name;
}

export async function saveRuleV1(
  context: ContextV1,
  input: {
    ruleId?: string;
    cargo: string;
    action: GroupRuleActionV1;
    groupId?: string;
    active: boolean;
    note?: string;
  },
): Promise<GroupsResponseV1> {
  const port = requireRulesV1(context.env);
  const cargo = input.cargo.trim().replace(/\s+/gu, ' ');
  const cargoKey = cargoKeyV1(cargo);
  if (input.action === 'ADICIONAR' && !input.groupId)
    throw new GroupsRefusalV1('invalid-request', 400);
  const groupName =
    input.action === 'ADICIONAR' && input.groupId
      ? await ruleGroupV1(context, input.groupId)
      : null;
  // The flow stops on two active rules for the same title (REGRA_DUPLICADA).
  const rules = await port.rules();
  if (input.ruleId && !rules.some((rule) => rule.id === input.ruleId))
    throw new GroupsRefusalV1('rule-not-found', 404);
  if (
    input.active &&
    rules.some((rule) => rule.active && rule.cargoKey === cargoKey && rule.id !== input.ruleId)
  )
    throw new GroupsRefusalV1('rule-duplicate', 409);

  const fields = {
    cargo,
    cargoKey,
    action: input.action,
    groupId: input.action === 'ADICIONAR' ? (input.groupId ?? null) : null,
    groupName,
    active: input.active,
    note: input.note?.trim() || null,
    reviewedBy: context.session.name,
    reviewedAt: new Date().toISOString(),
  };
  const change = {
    action: 'save-rule' as const,
    groupId: fields.groupId,
    groupName,
    target: cargoKey,
  };
  try {
    const rule = input.ruleId
      ? await port.updateRule(input.ruleId, fields)
      : await port.createRule(fields);
    if (!rule) throw new GroupsRefusalV1('rule-not-found', 404);
    await recordV1(context, { ...change, outcome: 'done' });
    return { contractVersion: 1, state: 'ok', operation: 'save-rule', rule };
  } catch (error) {
    if (!(error instanceof GroupsRefusalV1))
      await recordV1(context, { ...change, outcome: 'failed' });
    throw error;
  }
}

export async function deleteRuleV1(context: ContextV1, ruleId: string): Promise<GroupsResponseV1> {
  const port = requireRulesV1(context.env);
  const rule = (await port.rules()).find((item) => item.id === ruleId);
  if (!rule) throw new GroupsRefusalV1('rule-not-found', 404);
  const change = {
    action: 'delete-rule' as const,
    groupId: rule.groupId,
    groupName: rule.groupName,
    target: rule.cargoKey,
  };
  try {
    const result = await port.deleteRule(ruleId);
    await recordV1(context, { ...change, outcome: result === 'deleted' ? 'done' : 'unchanged' });
    return { contractVersion: 1, state: 'ok', operation: 'delete-rule' };
  } catch (error) {
    await recordV1(context, { ...change, outcome: 'failed' });
    throw error;
  }
}
