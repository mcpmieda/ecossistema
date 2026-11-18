import { z } from 'zod';
import {
  GROUP_DESCRIPTION_MAX_V1,
  GROUP_NAME_MAX_V1,
  GROUP_RULE_CARGO_MAX_V1,
  GROUP_RULE_NOTE_MAX_V1,
  GROUPS_PATH_V1,
  type GroupRoleV1,
  type GroupsFailureStateV1,
  type GroupsResponseV1,
  type GroupViewV1,
} from '../../../shared/platform-groups-v1';
import { capabilitiesForSession, requireCapability } from '../../auth/capabilities';
import { AuthorizationError } from '../../auth/roles';
import { AuthenticationError, requireAuth } from '../../auth/session';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
  withSecurityHeaders,
} from '../../http/security';
import {
  groupNameV1,
  groupsContextV1,
  GroupsRefusalV1,
  reachableV1,
  recordV1,
  roleGroupsV1,
  type ContextV1,
} from './groups-context-v1';
import { canDeleteGroupsV1, startGroupDeleteV1 } from './groups-delete-v1';
import { cargoKeyV1, sameIdV1 } from './group-rules-graph-v1';
import { deleteRuleV1, listRulesV1, rulesPortV1, saveRuleV1 } from './group-rules-v1';
import { GraphError } from '../../graph/client';
import { mailNicknameV1, type GroupsGraphPortV1 } from './groups-graph-v1';

export { roleGroupsV1, setGroupsGraphForTestsV1 } from './groups-context-v1';

// Entra ids are compared without case; they are kept in lower case from here on.
const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
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
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('delete-start'),
      groupId: id,
      confirmName: z.string().max(GROUP_NAME_MAX_V1),
    })
    .strict(),
  z.object({ contractVersion: z.literal(1), operation: z.literal('rules') }).strict(),
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('save-rule'),
      ruleId: z
        .string()
        .regex(/^\d{1,9}$/u)
        .optional(),
      etag: z.string().max(200).optional(),
      cargo: z.string().trim().min(1).max(GROUP_RULE_CARGO_MAX_V1),
      action: z.enum(['ADICIONAR', 'IGNORAR']),
      groupId: id.optional(),
      active: z.boolean(),
      note: z.string().max(GROUP_RULE_NOTE_MAX_V1).optional(),
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(1),
      operation: z.literal('delete-rule'),
      ruleId: z.string().regex(/^\d{1,9}$/u),
    })
    .strict(),
]);
type GroupsRequestV1 = z.infer<typeof requestSchemaV1>;

const reply = (value: GroupsResponseV1 | { contractVersion: 1; state: string }, status = 200) =>
  withSecurityHeaders(Response.json(value, { status }), true);

const sameName = (left: string, right: string) =>
  left.trim().localeCompare(right.trim(), 'pt-BR', { sensitivity: 'base' }) === 0;

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
      return {
        contractVersion: 1,
        state: 'ok',
        operation: 'list',
        groups,
        canDelete: await canDeleteGroupsV1(context),
      };
    }
    case 'members': {
      await reachableV1(context, input.groupId);
      const [members, titles] = await Promise.all([
        graph.members(input.groupId).catch(groupGoneV1),
        ruleTitlesV1(context, input.groupId),
      ]);
      for (const member of members)
        member.byRule =
          member.enabled !== false &&
          member.jobTitle !== null &&
          titles.has(cargoKeyV1(member.jobTitle));
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
        const result = await graph.addMember(input.groupId, person.id).catch(groupGoneV1);
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
      if (sameIdV1(input.groupId, env.GROUP_ADMIN_ID) && sameIdV1(input.personId, session.oid))
        throw new GroupsRefusalV1('self-removal', 409);
      const groupName = await groupNameV1(context, input.groupId, reach.name ?? reach.role);
      const target =
        (await graph.person(input.personId).catch(() => null))?.email ?? input.personId;
      try {
        const result = await graph.removeMember(input.groupId, input.personId);
        // Graph answers "not a member" also when the group itself is gone.
        if (result === 'not-member' && !(await graph.group(input.groupId)))
          throw new GroupsRefusalV1('group-not-found', 404);
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
    case 'delete-start':
      // Answered with its cookie by the handler.
      throw new HttpError(400, 'Invalid request');
    case 'rules':
      return listRulesV1(context);
    case 'save-rule':
      return saveRuleV1(context, input);
    case 'delete-rule':
      return deleteRuleV1(context, input.ruleId);
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
      const mailNickname = mailNicknameV1(input.name);
      let created;
      try {
        created = await graph.createGroup({
          name: input.name,
          description: input.description || null,
          mailNickname,
          ownerId,
        });
      } catch (error) {
        // A lost answer (timeout, 5xx) may hide a group Entra did create: look for it first,
        // again after a moment, since a new group takes a little to show up in searches.
        const ambiguous = error instanceof GraphError && error.status >= 500;
        created = ambiguous ? await findCreatedV1(graph, mailNickname) : null;
        if (!created) {
          await recordV1(context, {
            action: 'create-group',
            groupId: null,
            groupName: input.name,
            target: null,
            outcome: 'failed',
          });
          // Entra refuses a name its naming policy does not accept.
          if (error instanceof GraphError && error.status === 400)
            throw new GroupsRefusalV1('invalid-request', 400);
          throw error;
        }
      }
      // The history keeps the new group's id even if the Centro cannot keep the group itself.
      await recordV1(context, {
        action: 'create-group',
        groupId: created.id,
        groupName: input.name,
        target: null,
        outcome: 'done',
      });
      try {
        await store.addManagedGroup({ id: created.id, name: input.name, createdBy: session.name });
      } catch {
        console.error(
          JSON.stringify({
            event: 'groups_create_unrecorded',
            groupId: created.id,
            correlationId: context.correlationId,
          }),
        );
        throw new GroupsRefusalV1('group-unrecorded', 503);
      }
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

/**
 * The job titles an active rule adds to this group: the flow puts (and puts back) whoever has one
 * of them. Without the lists nobody is marked.
 */
async function ruleTitlesV1(context: ContextV1, groupId: string): Promise<ReadonlySet<string>> {
  const port = rulesPortV1(context.env);
  if (!port) return new Set();
  const rules = await port.rules().catch(() => []);
  return new Set(
    rules
      .filter(
        (rule) =>
          rule.active &&
          rule.action === 'ADICIONAR' &&
          rule.cargoKey !== '' &&
          sameIdV1(rule.groupId, groupId),
      )
      .map((rule) => rule.cargoKey),
  );
}

/** Graph answers 404 on a group's members when the group itself is gone. */
const groupGoneV1 = (error: unknown): never => {
  if (error instanceof GraphError && error.status === 404)
    throw new GroupsRefusalV1('group-not-found', 404);
  throw error;
};

async function findCreatedV1(graph: GroupsGraphPortV1, mailNickname: string) {
  for (const waitMs of [0, 2000]) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const found = await graph.groupByMailNickname(mailNickname).catch(() => null);
    if (found) return found;
  }
  return null;
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
  let correlationId: string | null = null;
  try {
    enforceOfficialOrigin(request, env);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    enforceWriteOrigin(request, env);
    const session = await requireAuth(request, env);
    requireCapability(capabilitiesForSession(session), 'platform.groups.manage');
    const parsed = requestSchemaV1.safeParse(await readBoundedJson(request, 2048));
    if (!parsed.success) throw new HttpError(400, 'Invalid request');
    operation = parsed.data.operation;
    const context = groupsContextV1(env, session);
    correlationId = context.correlationId;
    if (parsed.data.operation === 'delete-start') {
      const started = await startGroupDeleteV1(context, parsed.data);
      const response = reply({
        contractVersion: 1,
        state: 'ok',
        operation: 'delete-start',
        authorizeUrl: started.authorizeUrl,
      });
      response.headers.append('Set-Cookie', started.cookie);
      return response;
    }
    const answer = await runV1(context, parsed.data);
    if (!['list', 'members', 'find-people', 'history', 'rules'].includes(operation))
      console.log(JSON.stringify({ event: 'groups_changed', operation, correlationId }));
    return reply(answer);
  } catch (error) {
    const { state, status } = failureV1(error);
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: 'groups_failed',
          operation,
          correlationId,
          message: error instanceof Error ? error.name : 'unknown',
        }),
      );
    return reply({ contractVersion: 1, state }, status);
  }
}
