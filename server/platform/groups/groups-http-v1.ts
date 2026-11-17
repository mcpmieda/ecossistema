import { z } from 'zod';
import {
  GROUP_DESCRIPTION_MAX_V1,
  GROUP_NAME_MAX_V1,
  GROUPS_PATH_V1,
  type GroupChangeActionV1,
  type GroupRoleV1,
  type GroupsFailureStateV1,
  type GroupsResponseV1,
  type GroupViewV1,
} from '../../../shared/platform-groups-v1';
import { capabilitiesForSession, requireCapability } from '../../auth/capabilities';
import { AuthorizationError } from '../../auth/roles';
import { AuthenticationError, requireAuth, type Session } from '../../auth/session';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
  withSecurityHeaders,
} from '../../http/security';
import { graphGroupsPortV1, mailNicknameV1, type GroupsGraphPortV1 } from './groups-graph-v1';
import { groupsStoreV1, type GroupsStorePortV1 } from './groups-store-v1';

const id = z.string().uuid();
const requestSchemaV1 = z.discriminatedUnion('operation', [
  z.object({ contractVersion: z.literal(1), operation: z.literal('list') }).strict(),
  z
    .object({ contractVersion: z.literal(1), operation: z.literal('members'), groupId: id })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('find-people'),
      query: z.string().trim().min(2).max(100),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('history'),
      groupId: id.optional(),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('add-member'),
      groupId: id,
      email: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[^\s@]{1,64}@[^\s@]{1,255}$/u),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('remove-member'),
      groupId: id,
      personId: id,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('create-group'),
      name: z.string().trim().min(1).max(GROUP_NAME_MAX_V1),
      description: z.string().trim().max(GROUP_DESCRIPTION_MAX_V1).optional(),
    })
    .strict(),
]);
type GroupsRequestV1 = z.infer<typeof requestSchemaV1>;

class GroupsRefusalV1 extends Error {
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

const reply = (value: GroupsResponseV1 | { contractVersion: 1; state: string }, status = 200) =>
  withSecurityHeaders(Response.json(value, { status }), true);

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

const sameName = (left: string, right: string) =>
  left.trim().localeCompare(right.trim(), 'pt-BR', { sensitivity: 'base' }) === 0;

type ContextV1 = {
  env: RuntimeEnv;
  session: Session;
  graph: GroupsGraphPortV1;
  store: GroupsStorePortV1 | null;
};

/** The group may be touched: a role group or one created by the Centro. */
async function reachableV1(
  context: ContextV1,
  groupId: string,
): Promise<{ role: GroupRoleV1 | null; name: string | null }> {
  const role = roleGroupsV1(context.env).find(([groupId_]) => groupId_ === groupId)?.[1];
  if (role) return { role, name: null };
  const managed = (await context.store?.managedGroups())?.find((group) => group.id === groupId);
  if (managed) return { role: null, name: managed.name };
  throw new GroupsRefusalV1('not-allowed', 403);
}

async function viewV1(
  graph: GroupsGraphPortV1,
  groupId: string,
  role: GroupRoleV1 | null,
  fallbackName: string,
): Promise<GroupViewV1> {
  try {
    const [group, memberCount] = await Promise.all([
      graph.group(groupId),
      graph.memberCount(groupId).catch(() => null),
    ]);
    if (group)
      return {
        id: group.id,
        name: group.name || fallbackName,
        description: group.description,
        mail: group.mail,
        role,
        memberCount,
        available: true,
      };
  } catch {
    // Shown as unavailable below.
  }
  return {
    id: groupId,
    name: fallbackName,
    description: null,
    mail: null,
    role,
    memberCount: null,
    available: false,
  };
}

/** Writes one line of history; a failure to write it is logged and does not undo the change. */
async function recordV1(
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

async function groupNameV1(context: ContextV1, groupId: string, known: string | null) {
  if (known) return known;
  return (await context.graph.group(groupId).catch(() => null))?.name ?? null;
}

async function runV1(context: ContextV1, input: GroupsRequestV1): Promise<GroupsResponseV1> {
  const { graph, store, env, session } = context;
  switch (input.operation) {
    case 'list': {
      // Without the database the role groups are still listed.
      const managed = await (store?.managedGroups() ?? Promise.resolve([])).catch((error) => {
        console.error(
          JSON.stringify({
            event: 'groups_managed_read_failed',
            message: error instanceof Error ? error.name : 'unknown',
          }),
        );
        return [];
      });
      const groups = await Promise.all([
        ...roleGroupsV1(env).map(([groupId, role]) => viewV1(graph, groupId, role, role)),
        ...managed.map((group) => viewV1(graph, group.id, null, group.name)),
      ]);
      return { contractVersion: 1, state: 'ok', operation: 'list', groups };
    }
    case 'members': {
      await reachableV1(context, input.groupId);
      const members = await graph.members(input.groupId);
      members.sort((left, right) =>
        (left.name ?? left.email ?? '').localeCompare(right.name ?? right.email ?? '', 'pt-BR'),
      );
      return {
        contractVersion: 1,
        state: 'ok',
        operation: 'members',
        groupId: input.groupId,
        members,
      };
    }
    case 'find-people':
      return {
        contractVersion: 1,
        state: 'ok',
        operation: 'find-people',
        people: await graph.findPeople(input.query),
      };
    case 'history': {
      if (!store) throw new GroupsRefusalV1('unavailable', 503);
      return {
        contractVersion: 1,
        state: 'ok',
        operation: 'history',
        changes: await store.history(input.groupId ?? null, 100),
      };
    }
    case 'add-member': {
      const reach = await reachableV1(context, input.groupId);
      const person = await graph.person(input.email);
      if (!person) throw new GroupsRefusalV1('person-not-found', 404);
      const groupName = await groupNameV1(context, input.groupId, reach.name ?? reach.role);
      const target = person.email ?? input.email;
      try {
        const result = await graph.addMember(input.groupId, person.id);
        await recordV1(context, {
          action: 'add-member',
          groupId: input.groupId,
          groupName,
          target,
          outcome: result === 'added' ? 'done' : 'unchanged',
        });
        return { contractVersion: 1, state: 'ok', operation: 'add-member', result, person };
      } catch (error) {
        await recordV1(context, {
          action: 'add-member',
          groupId: input.groupId,
          groupName,
          target,
          outcome: 'failed',
        });
        throw error;
      }
    }
    case 'remove-member': {
      const reach = await reachableV1(context, input.groupId);
      // Nobody removes themselves from the admin group: they would lose the Centro at once.
      if (input.groupId === env.GROUP_ADMIN_ID && input.personId === session.oid)
        throw new GroupsRefusalV1('self-removal', 409);
      const groupName = await groupNameV1(context, input.groupId, reach.name ?? reach.role);
      const target =
        (await graph.person(input.personId).catch(() => null))?.email ?? input.personId;
      try {
        const result = await graph.removeMember(input.groupId, input.personId);
        await recordV1(context, {
          action: 'remove-member',
          groupId: input.groupId,
          groupName,
          target,
          outcome: result === 'removed' ? 'done' : 'unchanged',
        });
        return { contractVersion: 1, state: 'ok', operation: 'remove-member', result };
      } catch (error) {
        await recordV1(context, {
          action: 'remove-member',
          groupId: input.groupId,
          groupName,
          target,
          outcome: 'failed',
        });
        throw error;
      }
    }
    case 'create-group': {
      const ownerId = env.GROUPS_OWNER_ID;
      if (!store || !ownerId) throw new GroupsRefusalV1('unavailable', 503);
      const managed = await store.managedGroups();
      const roleNames = await Promise.all(
        roleGroupsV1(env).map(([groupId]) => graph.group(groupId).catch(() => null)),
      );
      const taken = [...managed.map((group) => group.name), ...roleNames.map((g) => g?.name)];
      if (taken.some((name) => name && sameName(name, input.name)))
        throw new GroupsRefusalV1('name-taken', 409);
      let created;
      try {
        created = await graph.createGroup({
          name: input.name,
          description: input.description || null,
          mailNickname: mailNicknameV1(input.name),
          ownerId,
        });
      } catch (error) {
        await recordV1(context, {
          action: 'create-group',
          groupId: null,
          groupName: input.name,
          target: null,
          outcome: 'failed',
        });
        throw error;
      }
      try {
        await store.addManagedGroup({ id: created.id, name: input.name, createdBy: session.name });
      } catch (error) {
        // The group exists in Entra but the Centro could not keep it: logged with its id so it can
        // be added by hand.
        console.error(JSON.stringify({ event: 'groups_create_unrecorded', groupId: created.id }));
        throw error;
      }
      await recordV1(context, {
        action: 'create-group',
        groupId: created.id,
        groupName: input.name,
        target: null,
        outcome: 'done',
      });
      return {
        contractVersion: 1,
        state: 'ok',
        operation: 'create-group',
        group: {
          id: created.id,
          name: created.name || input.name,
          description: created.description,
          mail: created.mail,
          role: null,
          memberCount: 0,
          available: true,
        },
      };
    }
  }
}

function failureV1(error: unknown): { state: GroupsFailureStateV1; status: number } {
  if (error instanceof GroupsRefusalV1) return { state: error.state, status: error.status };
  if (error instanceof AuthenticationError) return { state: 'not-authorized', status: 401 };
  if (error instanceof AuthorizationError) return { state: 'not-authorized', status: 403 };
  if (error instanceof HttpError && error.status < 500)
    return { state: 'invalid-request', status: error.status };
  return { state: 'unavailable', status: 503 };
}

/**
 * Grupos (#1513): members of the admin group see the role groups and the groups created by the
 * Centro, create groups (owned by GROUPS_OWNER_ID) and add or remove people. Deleting a group is
 * not here.
 */
export async function handleGroupsRequestV1(
  request: Request,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== GROUPS_PATH_V1) return null;
  let operation = 'unknown';
  try {
    enforceOfficialOrigin(request, env);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    enforceWriteOrigin(request, env);
    const session = await requireAuth(request, env);
    requireCapability(capabilitiesForSession(session), 'platform.groups.manage');
    const parsed = requestSchemaV1.safeParse(await readBoundedJson(request, 2048));
    if (!parsed.success) throw new HttpError(400, 'Invalid request');
    operation = parsed.data.operation;
    const context: ContextV1 = {
      env,
      session,
      graph: graphOverrideV1 ?? graphGroupsPortV1(env),
      store: groupsStoreV1(env),
    };
    const answer = await runV1(context, parsed.data);
    if (!['list', 'members', 'find-people', 'history'].includes(operation))
      console.log(JSON.stringify({ event: 'groups_changed', operation }));
    return reply(answer);
  } catch (error) {
    const { state, status } = failureV1(error);
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: 'groups_failed',
          operation,
          message: error instanceof Error ? error.name : 'unknown',
        }),
      );
    return reply({ contractVersion: 1, state }, status);
  }
}
