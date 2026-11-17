import type {
  GroupChangeActionV1,
  GroupRoleV1,
  GroupsFailureStateV1,
} from '../../../shared/platform-groups-v1';
import type { Session } from '../../auth/session';
import type { RuntimeEnv } from '../../env';
import { graphGroupsPortV1, type GroupsGraphPortV1 } from './groups-graph-v1';
import { groupsStoreV1, type GroupsStorePortV1 } from './groups-store-v1';

/** What every groups operation shares (#1513): who acts, Entra, the database and the history. */
export class GroupsRefusalV1 extends Error {
  constructor(
    readonly state: GroupsFailureStateV1,
    readonly status: number,
  ) {
    super(state);
  }
}
let graphOverrideV1: GroupsGraphPortV1 | undefined;
/** Tests replace Entra; `undefined` restores the Graph Backend app. */
export function setGroupsGraphForTestsV1(port: GroupsGraphPortV1 | undefined): void {
  graphOverrideV1 = port;
}
export const groupsGraphV1 = (env: RuntimeEnv): GroupsGraphPortV1 =>
  graphOverrideV1 ?? graphGroupsPortV1(env);
/** The five role groups, in the order of the Ecossistema roles. */
export function roleGroupsV1(env: RuntimeEnv): ReadonlyArray<readonly [string, GroupRoleV1]> {
  return [
    [env.GROUP_ADMIN_ID, 'ADMINISTRADOR'],
    [env.GROUP_PROFESSOR_ID, 'PROFESSOR'],
    [env.GROUP_ALUNO_ID, 'ALUNO'],
    [env.GROUP_APOIO_ID, 'APOIO'],
    [env.GROUP_VISITANTE_ID, 'VISITANTE'],
  ];
}
export type ContextV1 = {
  env: RuntimeEnv;
  session: Session;
  graph: GroupsGraphPortV1;
  store: GroupsStorePortV1 | null;
};
/** A context for this request. */
export const groupsContextV1 = (env: RuntimeEnv, session: Session): ContextV1 => ({
  env,
  session,
  graph: groupsGraphV1(env),
  store: groupsStoreV1(env),
});
/** The group may be touched: a role group or one created by the Centro. */
export async function reachableV1(
  context: ContextV1,
  groupId: string,
): Promise<{ role: GroupRoleV1 | null; name: string | null }> {
  const role = roleGroupsV1(context.env).find(([groupId_]) => groupId_ === groupId)?.[1];
  if (role) return { role, name: null };
  const managed = (await context.store?.managedGroups())?.find((group) => group.id === groupId);
  if (managed) return { role: null, name: managed.name };
  throw new GroupsRefusalV1('not-allowed', 403);
}
/** Writes one line of history; a failure to write it is logged and does not undo the change. */
export async function recordV1(
  context: ContextV1,
  change: {
    action: GroupChangeActionV1;
    groupId: string | null;
    groupName: string | null;
    target: string | null;
    outcome: 'done' | 'unchanged' | 'failed';
    correlationId?: string | null;
  },
): Promise<void> {
  try {
    await context.store?.record({
      actorOid: context.session.oid,
      actorName: context.session.name,
      correlationId: change.correlationId ?? null,
      ...change,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'groups_history_write_failed',
        action: change.action,
        message: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }
}
export async function groupNameV1(context: ContextV1, groupId: string, known: string | null) {
  if (known) return known;
  return (await context.graph.group(groupId).catch(() => null))?.name ?? null;
}
