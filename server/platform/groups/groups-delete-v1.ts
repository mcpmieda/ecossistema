import type { GroupDeleteResultV1 } from '../../../shared/platform-groups-v1';
import { capabilitiesForSession } from '../../auth/capabilities';
import { clearCookie, readCookie, secureCookie } from '../../auth/cookies';
import { authorizationUrl, exchangeCode, newAuthTransaction, verifyIdToken } from '../../auth/oidc';
import { seal, unseal } from '../../auth/sealed';
import { requireAuth } from '../../auth/session';
import type { RuntimeEnv } from '../../env';
import { GraphError } from '../../graph/client';
import { sameIdV1 } from './group-rules-graph-v1';
import { groupHasRulesV1 } from './group-rules-v1';
import {
  groupsContextV1,
  GroupsRefusalV1,
  recordV1,
  roleGroupsV1,
  type ContextV1,
} from './groups-context-v1';

/**
 * Deleting a group created by the Centro (#1513). The Graph Backend app has no permission to delete:
 * the deletion runs once with the delegated sign-in of the person who asked, so Entra itself decides
 * (Global Administrators and the institutional account that owns the group succeed). The five role
 * groups are never deleted from here.
 */
export const GROUP_DELETE_COOKIE_V1 = '__Host-ecossistema_group_delete';
// `profile` brings the name the ID token check requires.
const GROUP_DELETE_SCOPE_V1 = 'openid profile https://graph.microsoft.com/Group.ReadWrite.All';
const TRANSACTION_SECONDS_V1 = 600;

type DeleteTransactionV1 = {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
  groupId: string;
  groupName: string;
  oid: string;
};

const isRoleGroupV1 = (env: RuntimeEnv, groupId: string) =>
  roleGroupsV1(env).some(([roleGroupId]) => sameIdV1(roleGroupId, groupId));

/** The institutional account and the Global Administrators; any failure to tell means no. */
export async function canDeleteGroupsV1(context: ContextV1): Promise<boolean> {
  const { env, session, graph } = context;
  if (sameIdV1(session.oid, env.GROUPS_OWNER_ID)) return true;
  if (!env.GLOBAL_ADMIN_ROLE_ID) return false;
  return graph.holdsDirectoryRole(session.oid, env.GLOBAL_ADMIN_ROLE_ID).catch(() => false);
}

/** Checks the group and the typed name, then sends the person to Microsoft to sign in for it. */
export async function startGroupDeleteV1(
  context: ContextV1,
  input: { groupId: string; confirmName: string },
): Promise<{ authorizeUrl: string; cookie: string }> {
  const { env, session, graph, store } = context;
  if (isRoleGroupV1(env, input.groupId)) throw new GroupsRefusalV1('delete-not-allowed', 403);
  const managed = (await store?.managedGroups())?.find((group) =>
    sameIdV1(group.id, input.groupId),
  );
  if (!managed) throw new GroupsRefusalV1('not-allowed', 403);
  if (!(await canDeleteGroupsV1(context))) throw new GroupsRefusalV1('delete-not-allowed', 403);
  // The flow would keep trying to add people to a group that no longer exists.
  if (await groupHasRulesV1(context, input.groupId))
    throw new GroupsRefusalV1('group-has-rules', 409);
  const name = (await graph.group(input.groupId))?.name || managed.name;
  if (input.confirmName.trim() !== name.trim()) throw new GroupsRefusalV1('name-mismatch', 400);

  const transaction = await newAuthTransaction();
  const sealed = await seal(
    {
      state: transaction.state,
      nonce: transaction.nonce,
      verifier: transaction.verifier,
      exp: transaction.exp,
      groupId: input.groupId,
      groupName: name,
      oid: session.oid,
    } satisfies DeleteTransactionV1,
    env.SESSION_SECRET,
    'group-delete',
  );
  return {
    authorizeUrl: authorizationUrl(env, transaction, {
      scope: GROUP_DELETE_SCOPE_V1,
      loginHint: session.username,
    }),
    cookie: secureCookie(GROUP_DELETE_COOKIE_V1, sealed, { maxAge: TRANSACTION_SECONDS_V1 }),
  };
}

const finishV1 = (result: GroupDeleteResultV1, stage?: string) => {
  if (stage) console.error(JSON.stringify({ event: 'groups_delete_stopped', result, stage }));
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/#/configuracoes?grupos=${result}`,
      'Set-Cookie': clearCookie(GROUP_DELETE_COOKIE_V1),
      'Cache-Control': 'no-store',
    },
  });
};

/**
 * The way back from Microsoft for a deletion; null when this callback is an ordinary sign-in (no
 * deletion in progress, or another state). The delegated token is used once and never kept.
 */
export async function handleGroupDeleteCallbackV1(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  now = Math.floor(Date.now() / 1000),
): Promise<Response | null> {
  const raw = readCookie(request, GROUP_DELETE_COOKIE_V1);
  const state = url.searchParams.get('state');
  if (!raw || !state) return null;
  const transaction = await unseal<DeleteTransactionV1>(raw, env.SESSION_SECRET, 'group-delete');
  if (!transaction || transaction.state !== state) return null;

  if (transaction.exp <= now) return finishV1('falhou', 'expired');
  const error = url.searchParams.get('error');
  if (error === 'access_denied') return finishV1('cancelado');
  // Only Microsoft's short code is logged (e.g. consent_required), never its description.
  if (error) return finishV1('recusado', `ms:${/^[a-z_]{1,40}$/u.test(error) ? error : 'other'}`);
  const code = url.searchParams.get('code');
  if (!code) return finishV1('falhou', 'no-code');

  let context: ContextV1;
  try {
    const session = await requireAuth(request, env);
    if (
      !sameIdV1(session.oid, transaction.oid) ||
      !capabilitiesForSession(session).includes('platform.groups.manage')
    )
      return finishV1('recusado', 'session');
    context = groupsContextV1(env, session);
  } catch {
    return finishV1('falhou', 'session');
  }
  if (isRoleGroupV1(env, transaction.groupId)) return finishV1('recusado', 'role-group');
  const managed = await context.store
    ?.managedGroups()
    .then((groups) => groups.some((group) => sameIdV1(group.id, transaction.groupId)))
    .catch(() => false);
  if (!managed) return finishV1('falhou', 'not-managed');
  // A rule may have been saved for the group during the sign-in.
  const hasRules = await groupHasRulesV1(context, transaction.groupId).catch(() => null);
  if (hasRules === null) return finishV1('falhou', 'rules-read');
  if (hasRules) return finishV1('com-regras', 'rules');

  const change = { groupId: transaction.groupId, groupName: transaction.groupName, target: null };

  let accessToken: string;
  try {
    const tokens = await exchangeCode(env, code, transaction.verifier);
    const claims = await verifyIdToken(tokens.id_token, env, transaction.nonce);
    // The sign-in for the deletion is the person signed in to the Centro, not another account.
    if (!sameIdV1(claims.oid, transaction.oid)) {
      await recordV1(context, { action: 'delete-group', ...change, outcome: 'failed' });
      return finishV1('recusado', 'other-account');
    }
    accessToken = tokens.access_token;
  } catch (cause) {
    await recordV1(context, { action: 'delete-group', ...change, outcome: 'failed' });
    return finishV1('falhou', `token:${cause instanceof Error ? cause.name : 'unknown'}`);
  }
  try {
    const result = await context.graph.deleteGroupAs(transaction.groupId, accessToken);
    await context.store?.removeManagedGroup(transaction.groupId).catch((cause: unknown) =>
      console.error(
        JSON.stringify({
          event: 'groups_delete_unrecorded',
          groupId: transaction.groupId,
          message: cause instanceof Error ? cause.name : 'unknown',
        }),
      ),
    );
    await recordV1(context, {
      action: 'delete-group',
      ...change,
      outcome: result === 'deleted' ? 'done' : 'unchanged',
    });
    console.log(JSON.stringify({ event: 'groups_changed', operation: 'delete-group' }));
    return finishV1('excluido');
  } catch (cause) {
    await recordV1(context, { action: 'delete-group', ...change, outcome: 'failed' });
    const refused = cause instanceof GraphError && (cause.status === 403 || cause.status === 401);
    return finishV1(refused ? 'recusado' : 'falhou', 'graph');
  }
}
