// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/auth/oidc', async (original) => ({
  ...(await original<typeof import('../server/auth/oidc')>()),
  exchangeCode: vi.fn(),
  verifyIdToken: vi.fn(),
}));

import { onRequest } from '../functions/[[path]]';
import { exchangeCode, verifyIdToken } from '../server/auth/oidc';
import { seal } from '../server/auth/sealed';
import { createApplicationSession, SESSION_COOKIE } from '../server/auth/session';
import { setSessionRevocationPortForTestsV1 } from '../server/auth/session-revocation-v1';
import type { RuntimeEnv } from '../server/env';
import { GraphError } from '../server/graph/client';
import { GROUP_DELETE_COOKIE_V1 } from '../server/platform/groups/groups-delete-v1';
import type { GroupsGraphPortV1 } from '../server/platform/groups/groups-graph-v1';
import { setGroupsGraphForTestsV1 } from '../server/platform/groups/groups-http-v1';
import {
  setGroupsStoreForTestsV1,
  type GroupChangeRecordV1,
  type GroupsStorePortV1,
} from '../server/platform/groups/groups-store-v1';
import { testEnv } from './fixtures';

/** #1513: the way back from Microsoft deletes the group once, with the person's own sign-in. */
const ownerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const groupId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const env: RuntimeEnv = { ...testEnv, GROUPS_OWNER_ID: ownerId };
const now = () => Math.floor(Date.now() / 1000);

let managed: string[];
let changes: GroupChangeRecordV1[];
let deleteGroupAs: ReturnType<typeof vi.fn>;

beforeEach(() => {
  managed = [groupId];
  changes = [];
  deleteGroupAs = vi.fn(async () => 'deleted' as const);
  setGroupsGraphForTestsV1({ deleteGroupAs } as unknown as GroupsGraphPortV1);
  setGroupsStoreForTestsV1({
    managedGroups: async () =>
      managed.map((id) => ({ id, name: 'Biblioteca', createdBy: 'X', createdAt: '' })),
    removeManagedGroup: async (id: string) => {
      managed = managed.filter((item) => item !== id);
    },
    record: async (change: GroupChangeRecordV1) => {
      changes.push(change);
    },
  } as unknown as GroupsStorePortV1);
  setSessionRevocationPortForTestsV1(null);
  vi.mocked(exchangeCode).mockResolvedValue({
    access_token: 'delegated-token',
    id_token: 'id-token',
    expires_in: 3600,
  });
  vi.mocked(verifyIdToken).mockResolvedValue({ oid: ownerId } as Awaited<
    ReturnType<typeof verifyIdToken>
  >);
});
afterEach(() => {
  setGroupsGraphForTestsV1(undefined);
  setGroupsStoreForTestsV1(undefined);
  setSessionRevocationPortForTestsV1(undefined);
  vi.clearAllMocks();
});

async function callback(
  query: string,
  transaction: Partial<Record<string, unknown>> = {},
  signedIn = ownerId,
) {
  const sessionCookie = await seal(
    createApplicationSession({ oid: signedIn, name: 'Secretaria', roles: ['ADMINISTRADOR'] }),
    env.SESSION_SECRET,
    'admin-session',
  );
  const deletion = await seal(
    {
      state: 'state-1',
      nonce: 'nonce-1',
      verifier: 'verifier-1',
      exp: now() + 600,
      groupId,
      groupName: 'Biblioteca',
      oid: ownerId,
      ...transaction,
    },
    env.SESSION_SECRET,
    'group-delete',
  );
  const response = await onRequest({
    request: new Request(`${env.OFFICIAL_ORIGIN}/auth/callback?${query}`, {
      headers: {
        Cookie: `${SESSION_COOKIE}=${sessionCookie}; ${GROUP_DELETE_COOKIE_V1}=${deletion}`,
      },
    }),
    env,
    waitUntil: () => undefined,
  } as unknown as Parameters<typeof onRequest>[0]);
  return {
    status: response.status,
    location: response.headers.get('Location'),
    cookie: response.headers.get('Set-Cookie'),
  };
}

describe('#1513 deleting a group on the way back from Microsoft', () => {
  it('deletes with the delegated token, forgets the group and records it', async () => {
    const answer = await callback('code=abc&state=state-1');
    expect(answer).toMatchObject({ status: 302, location: '/#/configuracoes?grupos=excluido' });
    expect(answer.cookie).toContain(`${GROUP_DELETE_COOKIE_V1}=;`);
    expect(exchangeCode).toHaveBeenCalledWith(expect.anything(), 'abc', 'verifier-1');
    expect(verifyIdToken).toHaveBeenCalledWith('id-token', expect.anything(), 'nonce-1');
    expect(deleteGroupAs).toHaveBeenCalledWith(groupId, 'delegated-token');
    expect(managed).toEqual([]);
    expect(changes).toMatchObject([
      {
        action: 'delete-group',
        groupId,
        groupName: 'Biblioteca',
        outcome: 'done',
        actorOid: ownerId,
      },
    ]);
  });

  it('Entra refusing the person is told and recorded as failed', async () => {
    deleteGroupAs.mockRejectedValueOnce(new GraphError(403, 'c'));
    expect((await callback('code=abc&state=state-1')).location).toBe(
      '/#/configuracoes?grupos=recusado',
    );
    expect(managed).toEqual([groupId]);
    expect(changes).toMatchObject([{ action: 'delete-group', outcome: 'failed' }]);
  });

  it('a sign-in with another account than the one in the Centro deletes nothing', async () => {
    vi.mocked(verifyIdToken).mockResolvedValueOnce({ oid: 'other' } as Awaited<
      ReturnType<typeof verifyIdToken>
    >);
    expect((await callback('code=abc&state=state-1')).location).toBe(
      '/#/configuracoes?grupos=recusado',
    );
    expect(deleteGroupAs).not.toHaveBeenCalled();
  });

  it('another session, a role group, a cancel or an expired request delete nothing', async () => {
    expect(
      (await callback('code=abc&state=state-1', {}, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'))
        .location,
    ).toBe('/#/configuracoes?grupos=recusado');
    expect(
      (await callback('code=abc&state=state-1', { groupId: testEnv.GROUP_ADMIN_ID })).location,
    ).toBe('/#/configuracoes?grupos=recusado');
    expect((await callback('error=access_denied&state=state-1')).location).toBe(
      '/#/configuracoes?grupos=cancelado',
    );
    expect((await callback('code=abc&state=state-1', { exp: now() - 1 })).location).toBe(
      '/#/configuracoes?grupos=falhou',
    );
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(deleteGroupAs).not.toHaveBeenCalled();
  });

  it('an ordinary sign-in callback (another state) is not taken as a deletion', async () => {
    const answer = await callback('code=abc&state=sign-in-state');
    expect(answer.location ?? '').not.toContain('grupos=');
    expect(deleteGroupAs).not.toHaveBeenCalled();
  });
});
