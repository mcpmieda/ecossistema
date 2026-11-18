import type { GroupRuleActionV1, GroupsResponseV1 } from '../../../shared/platform-groups-v1';
import type { RuntimeEnv } from '../../env';
import { GroupsRefusalV1, recordV1, roleGroupsV1, type ContextV1 } from './groups-context-v1';
import { RuleLockUnreachableV1 } from './groups-store-v1';
import {
  cargoKeyV1,
  groupRulesGraphPortV1,
  sameIdV1,
  type GroupRulesPortV1,
} from './group-rules-graph-v1';

/** The rules of the flow "Grupos por Cargo", edited from Configurações › Grupos (#1513). */
let rulesOverrideV1: GroupRulesPortV1 | null | undefined;
/** Tests replace the SharePoint lists; `undefined` restores them. */
export function setGroupRulesForTestsV1(port: GroupRulesPortV1 | null | undefined): void {
  rulesOverrideV1 = port;
}
export const rulesPortV1 = (env: RuntimeEnv) =>
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

/** An active rule still adds people to the group, so it is not deleted before that changes. */
export async function groupHasRulesV1(context: ContextV1, groupId: string): Promise<boolean> {
  const port = rulesPortV1(context.env);
  if (!port) return false;
  return (await port.rules()).some(
    (rule) => rule.active && rule.action === 'ADICIONAR' && sameIdV1(rule.groupId, groupId),
  );
}

/** The group a rule adds to: a role group or one created by the Centro, with its Entra name. */
async function ruleGroupV1(context: ContextV1, groupId: string): Promise<string> {
  const isRole = roleGroupsV1(context.env).some(([roleGroupId]) => sameIdV1(roleGroupId, groupId));
  const managed = isRole
    ? null
    : (await context.store?.managedGroups())?.find((group) => sameIdV1(group.id, groupId));
  if (!isRole && !managed) throw new GroupsRefusalV1('not-allowed', 403);
  const group = await context.graph.group(groupId);
  const name = group?.name || managed?.name;
  if (!name) throw new GroupsRefusalV1('not-allowed', 403);
  return name;
}

/**
 * One rule change at a time (#1530 S1): a rule save, or deleting a group rules may point at. Without
 * the database, or when it cannot be reached at all, the change still runs (logged); a lock held too
 * long by another change answers "unavailable".
 */
export async function withRulesLockV1<T>(context: ContextV1, run: () => Promise<T>): Promise<T> {
  if (!context.store) return run();
  const state: { started: boolean; result?: { value: T } } = { started: false };
  try {
    await context.store.serializeRuleSaves(async () => {
      state.started = true;
      state.result = { value: await run() };
    });
  } catch (error) {
    // The save ran and only ending the lock failed: the save stands.
    if (state.result) return state.result.value;
    if (state.started || !(error instanceof RuleLockUnreachableV1)) throw error;
    console.error(
      JSON.stringify({
        event: 'group_rules_lock_failed',
        correlationId: context.correlationId,
        message: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return run();
  }
  return state.result!.value;
}

export async function saveRuleV1(
  context: ContextV1,
  input: {
    ruleId?: string;
    etag?: string;
    cargo: string;
    action: GroupRuleActionV1;
    groupId?: string;
    active: boolean;
    note?: string;
  },
): Promise<GroupsResponseV1> {
  const port = requireRulesV1(context.env);
  // The key is what the flow compares: inner spaces are kept, as in the job title in Entra, so a
  // rule saved again keeps its key.
  const cargo = input.cargo.trim();
  const cargoKey = cargoKeyV1(cargo);
  if (input.action === 'ADICIONAR' && !input.groupId)
    throw new GroupsRefusalV1('invalid-request', 400);
  const groupName =
    input.action === 'ADICIONAR' && input.groupId
      ? await ruleGroupV1(context, input.groupId)
      : null;
  return withRulesLockV1(context, () =>
    writeRuleV1(context, port, input, { cargo, cargoKey, groupName }),
  );
}

async function writeRuleV1(
  context: ContextV1,
  port: GroupRulesPortV1,
  input: Parameters<typeof saveRuleV1>[1],
  { cargo, cargoKey, groupName }: { cargo: string; cargoKey: string; groupName: string | null },
): Promise<GroupsResponseV1> {
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
      ? await port.updateRule(input.ruleId, fields, input.etag)
      : await port.createRule(fields);
    if (!rule) throw new GroupsRefusalV1('rule-not-found', 404);
    if (rule === 'changed') throw new GroupsRefusalV1('rule-changed', 409);
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
