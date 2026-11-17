import type { GroupDeleteResultV1 } from '../../../shared/platform-groups-v1';
import { capabilitiesForSession } from '../../auth/capabilities';
import { clearCookie, readCookie, secureCookie } from '../../auth/cookies';
import { authorizationUrl, exchangeCode, newAuthTransaction, verifyIdToken } from '../../auth/oidc';
import { seal, unseal } from '../../auth/sealed';
import { requireAuth } from '../../auth/session';
import type { RuntimeEnv } from '../../env';
import { GraphError } from '../../graph/client';
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
const GROUP_DELETE_SCOPE_V1 = 'openid https://graph.microsoft.com/Group.ReadWrite.All';
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
  roleGroupsV1(env).some(([roleGroupId]) => roleGroupId === groupId);

/** The institutional account and the Global Administrators; any failure to tell means no. */
export async function canDeleteGroupsV1(context: ContextV1): Promise<boolean> {
  const { env, session, graph } = context;
  if (env.GROUPS_OWNER_ID && session.oid === env.GROUPS_OWNER_ID) return true;
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
  const managed = (await store?.managedGroups())?.find((group) => group.id === input.groupId);
  if (!managed) throw new GroupsRefusalV1('not-allowed', 403);
  if (!(await canDeleteGroupsV1(context))) throw new GroupsRefusalV1('delete-not-allowed', 403);
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

const finishV1 = (result: GroupDeleteResultV1) =>
  new Response(null, {
    status: 302,
    headers: {
      Location: `/#/configuracoes?grupos=${result}`,
      'Set-Cookie': clearCookie(GROUP_DELETE_COOKIE_V1),
      'Cache-Control': 'no-store',
    },
  });

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

  if (transaction.exp <= now) return finishV1('falhou');
  const error = url.searchParams.get('error');
  if (error) return finishV1(error === 'access_denied' ? 'cancelado' : 'recusado');
  const code = url.searchParams.get('code');
  if (!code) return finishV1('falhou');

  let context: ContextV1;
  try {
    const session = await requireAuth(request, env);
    if (
      session.oid !== transaction.oid ||
      !capabilitiesForSession(session).includes('platform.groups.manage')
    )
      return finishV1('recusado');
    context = groupsContextV1(env, session);
  } catch {
    return finishV1('falhou');
  }
  if (isRoleGroupV1(env, transaction.groupId)) return finishV1('recusado');
  const managed = await context.store
    ?.managedGroups()
    .then((groups) => groups.some((group) => group.id === transaction.groupId))
    .catch(() => false);
  if (!managed) return finishV1('falhou');

  let accessToken: string;
  try {
    const tokens = await exchangeCode(env, code, transaction.verifier);
    const claims = await verifyIdToken(tokens.id_token, env, transaction.nonce);
    // The sign-in for the deletion is the person signed in to the Centro, not another account.
    if (claims.oid !== transaction.oid) return finishV1('recusado');
    accessToken = tokens.access_token;
  } catch {
    return finishV1('falhou');
  }

  const change = { groupId: transaction.groupId, groupName: transaction.groupName, target: null };
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
    return finishV1(refused ? 'recusado' : 'falhou');
  }
}
