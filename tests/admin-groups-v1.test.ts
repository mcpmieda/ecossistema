// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/[[path]]';
import { ACCESS_AREA_IDS } from '../shared/platform-contract';
import type { GroupPersonV1 } from '../shared/platform-groups-v1';
import { setAccessGrantsPortForTestsV1 } from '../server/auth/access-grants-v1';
import { seal } from '../server/auth/sealed';
import { createApplicationSession, SESSION_COOKIE } from '../server/auth/session';
import { setSessionRevocationPortForTestsV1 } from '../server/auth/session-revocation-v1';
import { classifyAdminOperationV1 } from '../server/http/admin-rate-limit-v1';
import type { RuntimeEnv } from '../server/env';
import {
  mailNicknameV1,
  memberCountOfPageV1,
  personFromGraphV1,
  type EntraGroupV1,
  type GroupsGraphPortV1,
} from '../server/platform/groups/groups-graph-v1';
import { setGroupsGraphForTestsV1 } from '../server/platform/groups/groups-http-v1';
import { GraphError } from '../server/graph/client';
import type { GroupRulesPortV1 } from '../server/platform/groups/group-rules-graph-v1';
import { setGroupRulesForTestsV1 } from '../server/platform/groups/group-rules-v1';
import {
  setGroupsStoreForTestsV1,
  type GroupChangeRecordV1,
  type GroupsStorePortV1,
  type ManagedGroupV1,
} from '../server/platform/groups/groups-store-v1';
import { testEnv } from './fixtures';

const adminOid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const createdId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const otherTenantGroup = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const person: GroupPersonV1 = {
  id: '12121212-1212-4212-8212-121212121212',
  name: 'Pessoa Teste',
  email: 'pessoa@escola.example',
  jobTitle: 'equipe de apoio',
  enabled: true,
};
const globalAdminRole = '99999999-9999-4999-8999-999999999999';
const env: RuntimeEnv = {
  ...testEnv,
  GROUPS_OWNER_ID: ownerId,
  GLOBAL_ADMIN_ROLE_ID: globalAdminRole,
};

/** Entra, in memory: the five role groups plus whatever the test creates. */
function fakeEntra() {
  const groups = new Map<string, EntraGroupV1>(
    [
      [testEnv.GROUP_ADMIN_ID, 'GRUPO DA SECRETARIA'],
      [testEnv.GROUP_PROFESSOR_ID, 'PROFESSORES'],
      [testEnv.GROUP_ALUNO_ID, 'ALUNOS'],
      [testEnv.GROUP_APOIO_ID, 'EQUIPE DE APOIO'],
      [testEnv.GROUP_VISITANTE_ID, 'VISITANTE'],
      [otherTenantGroup, 'OUTRO GRUPO DO TENANT'],
    ].map(([id, name]) => [id!, { id: id!, name: name!, description: null, mail: null }]),
  );
  const members = new Map<string, Set<string>>([...groups.keys()].map((id) => [id, new Set()]));
  const people = new Map([[person.id, person]]);
  const globalAdmins = new Set<string>();
  const port: GroupsGraphPortV1 = {
    group: vi.fn(async (id: string) => groups.get(id) ?? null),
    memberCount: vi.fn(async (id: string) => members.get(id)?.size ?? null),
    members: vi.fn(async (id: string) =>
      [...(members.get(id) ?? [])].map((member) => people.get(member)!),
    ),
    findPeople: vi.fn(async (text: string) =>
      [...people.values()].filter((item) => item.name?.startsWith(text)),
    ),
    person: vi.fn(
      async (key: string) =>
        [...people.values()].find((item) => item.id === key || item.email === key) ?? null,
    ),
    isMember: vi.fn(async (groupId: string, id: string) => members.get(groupId)!.has(id)),
    addMember: vi.fn(async (groupId: string, id: string) => {
      const set = members.get(groupId)!;
      if (set.has(id)) return 'already-member' as const;
      set.add(id);
      return 'added' as const;
    }),
    removeMember: vi.fn(async (groupId: string, id: string) =>
      members.get(groupId)!.delete(id) ? ('removed' as const) : ('not-member' as const),
    ),
    holdsDirectoryRole: vi.fn(
      async (id: string, role: string) => globalAdmins.has(id) && role === globalAdminRole,
    ),
    deleteGroupAs: vi.fn(async (id: string) => (groups.delete(id) ? 'deleted' : 'not-found')),
    groupByMailNickname: vi.fn(async () => null),
    createGroup: vi.fn(async ({ name, description }) => {
      const group = { id: createdId, name, description, mail: 'novo@escola.example' };
      groups.set(createdId, group);
      members.set(createdId, new Set());
      return group;
    }),
  };
  return { port, groups, members, globalAdmins };
}

function memoryStore() {
  const managed: ManagedGroupV1[] = [];
  const changes: GroupChangeRecordV1[] = [];
  const port: GroupsStorePortV1 = {
    managedGroups: async () => [...managed],
    removeManagedGroup: async (id) => {
      managed.splice(
        managed.findIndex((group) => group.id === id),
        1,
      );
    },
    addManagedGroup: async ({ id, name, createdBy }) => {
      managed.push({ id, name, createdBy, createdAt: '2026-11-17T12:00:00.000Z' });
    },
    record: async (change) => {
      changes.push(change);
    },
    serializeRuleSaves: (run) => run(),
    history: async (groupId, limit) =>
      changes
        .filter((change) => groupId === null || change.groupId === groupId)
        .slice(-limit)
        .reverse()
        .map((change) => ({
          at: '2026-11-17T12:00:00.000Z',
          actor: change.actorName,
          action: change.action,
          groupId: change.groupId,
          groupName: change.groupName,
          target: change.target,
          outcome: change.outcome,
        })),
  };
  return { port, managed, changes };
}

const cookieFor = async (roles: Array<'ADMINISTRADOR' | 'APOIO'>, oid = adminOid) =>
  `${SESSION_COOKIE}=${await seal(
    createApplicationSession({
      oid,
      name: 'Secretaria Teste',
      username: 'sec@escola.example',
      roles,
    }),
    testEnv.SESSION_SECRET,
    'admin-session',
  )}`;

async function groups(body: unknown, cookie?: string, environment = env) {
  const response = await onRequest({
    request: new Request(`${testEnv.OFFICIAL_ORIGIN}/api/platform/groups`, {
      method: 'POST',
      headers: {
        Cookie: cookie ?? (await cookieFor(['ADMINISTRADOR'])),
        Origin: testEnv.OFFICIAL_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contractVersion: 1, ...(body as object) }),
    }),
    env: environment,
    waitUntil: () => undefined,
  } as unknown as Parameters<typeof onRequest>[0]);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let entra: ReturnType<typeof fakeEntra>;
let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  entra = fakeEntra();
  store = memoryStore();
  setGroupsGraphForTestsV1(entra.port);
  setGroupsStoreForTestsV1(store.port);
  setSessionRevocationPortForTestsV1(null);
});
afterEach(() => {
  setGroupsGraphForTestsV1(undefined);
  setGroupsStoreForTestsV1(undefined);
  setGroupRulesForTestsV1(undefined);
  setSessionRevocationPortForTestsV1(undefined);
  setAccessGrantsPortForTestsV1(undefined);
});

describe('#1513 Grupos: only the Secretaria manages, and only the reachable groups', () => {
  it('someone outside the Secretaria, even with every area, is refused before Entra is asked', async () => {
    setAccessGrantsPortForTestsV1({
      areasFor: async () => [...ACCESS_AREA_IDS],
      list: async () => [],
      save: async () => undefined,
    });
    const cookie = await cookieFor(['APOIO'], person.id);
    for (const body of [
      { operation: 'list' },
      { operation: 'members', groupId: testEnv.GROUP_ADMIN_ID },
      { operation: 'add-member', groupId: testEnv.GROUP_ADMIN_ID, email: person.email },
      { operation: 'create-group', name: 'Biblioteca' },
    ])
      expect(await groups(body, cookie)).toMatchObject({
        status: 403,
        body: { state: 'not-authorized' },
      });
    expect(entra.port.group).not.toHaveBeenCalled();
    expect(entra.port.addMember).not.toHaveBeenCalled();
  });

  it('lists the five role groups and the groups the Centro created, with their members count', async () => {
    store.managed.push({
      id: createdId,
      name: 'Biblioteca',
      createdBy: 'Secretaria Teste',
      createdAt: '2026-11-17T12:00:00.000Z',
    });
    const answer = await groups({ operation: 'list' });
    expect(answer.status).toBe(200);
    const listed = answer.body.groups as Array<Record<string, unknown>>;
    expect(listed.map((group) => group.role)).toEqual([
      'ADMINISTRADOR',
      'PROFESSOR',
      'ALUNO',
      'APOIO',
      'VISITANTE',
      null,
    ]);
    // Deleted outside the Centro: still listed, marked unavailable, with the name it was given.
    expect(listed[5]).toMatchObject({ id: createdId, name: 'Biblioteca', available: false });
    expect(listed[0]).toMatchObject({ name: 'GRUPO DA SECRETARIA', memberCount: 0 });
    expect(listed.some((group) => group.id === otherTenantGroup)).toBe(false);
  });

  it('without the database the role groups are still listed', async () => {
    store.port.managedGroups = () => Promise.reject(new Error('down'));
    const answer = await groups({ operation: 'list' });
    expect(answer.status).toBe(200);
    expect((answer.body.groups as unknown[]).length).toBe(5);
  });

  it('never reads or changes a group of the tenant the Centro did not create', async () => {
    for (const body of [
      { operation: 'members', groupId: otherTenantGroup },
      { operation: 'add-member', groupId: otherTenantGroup, email: person.email },
      { operation: 'remove-member', groupId: otherTenantGroup, personId: person.id },
    ])
      expect(await groups(body)).toMatchObject({ status: 403, body: { state: 'not-allowed' } });
    expect(entra.port.members).not.toHaveBeenCalled();
    expect(entra.port.addMember).not.toHaveBeenCalled();
    expect(entra.port.removeMember).not.toHaveBeenCalled();
  });

  it('adds by e-mail, says when the person already was a member, and records each change', async () => {
    const add = {
      operation: 'add-member',
      groupId: testEnv.GROUP_APOIO_ID,
      email: ' Pessoa@Escola.Example ',
    };
    expect(await groups(add)).toMatchObject({
      status: 200,
      body: { result: 'added', person: { id: person.id } },
    });
    expect(await groups(add)).toMatchObject({ status: 200, body: { result: 'already-member' } });
    expect(
      await groups({
        operation: 'add-member',
        groupId: testEnv.GROUP_APOIO_ID,
        email: 'ninguem@escola.example',
      }),
    ).toMatchObject({ status: 404, body: { state: 'person-not-found' } });
    expect(store.changes.map((change) => [change.action, change.outcome, change.target])).toEqual([
      ['add-member', 'done', person.email],
      ['add-member', 'unchanged', person.email],
    ]);
    expect(store.changes[0]).toMatchObject({
      actorOid: adminOid,
      actorName: 'Secretaria Teste',
      groupId: testEnv.GROUP_APOIO_ID,
      groupName: 'APOIO',
    });
    const members = await groups({ operation: 'members', groupId: testEnv.GROUP_APOIO_ID });
    expect(members.body.members).toEqual([person]);
  });

  it('removes, and nobody removes themselves from the Secretaria group', async () => {
    entra.members.get(testEnv.GROUP_ADMIN_ID)!.add(adminOid);
    entra.members.get(testEnv.GROUP_PROFESSOR_ID)!.add(person.id);
    expect(
      await groups({
        operation: 'remove-member',
        groupId: testEnv.GROUP_ADMIN_ID,
        personId: adminOid,
      }),
    ).toMatchObject({ status: 409, body: { state: 'self-removal' } });
    expect(entra.members.get(testEnv.GROUP_ADMIN_ID)!.has(adminOid)).toBe(true);
    const remove = {
      operation: 'remove-member',
      groupId: testEnv.GROUP_PROFESSOR_ID,
      personId: person.id,
    };
    expect(await groups(remove)).toMatchObject({ status: 200, body: { result: 'removed' } });
    expect(await groups(remove)).toMatchObject({ status: 200, body: { result: 'not-member' } });
    expect(store.changes.map((change) => change.outcome)).toEqual(['done', 'unchanged']);
  });

  it('#1530 S5: the self-removal guard holds with the ids in capitals', async () => {
    entra.members.get(testEnv.GROUP_ADMIN_ID)!.add(adminOid);
    expect(
      await groups({
        operation: 'remove-member',
        groupId: testEnv.GROUP_ADMIN_ID.toUpperCase(),
        personId: adminOid.toUpperCase(),
      }),
    ).toMatchObject({ status: 409, body: { state: 'self-removal' } });
    expect(entra.port.removeMember).not.toHaveBeenCalled();
  });

  it('#1530 S7: a group gone from Entra is told as such, not as unavailable', async () => {
    store.managed.push({ id: createdId, name: 'Biblioteca', createdBy: 'X', createdAt: '' });
    entra.members.set(createdId, new Set());
    expect(
      await groups({ operation: 'remove-member', groupId: createdId, personId: person.id }),
    ).toMatchObject({ status: 404, body: { state: 'group-not-found' } });
    vi.mocked(entra.port.members).mockRejectedValueOnce(new GraphError(404, 'c'));
    expect(await groups({ operation: 'members', groupId: createdId })).toMatchObject({
      status: 404,
      body: { state: 'group-not-found' },
    });
    vi.mocked(entra.port.createGroup).mockRejectedValueOnce(new GraphError(400, 'c'));
    expect(await groups({ operation: 'create-group', name: 'Nome recusado' })).toMatchObject({
      status: 400,
      body: { state: 'invalid-request' },
    });
  });

  it('#1530 P1: marks the members the flow keeps in the group by a job-title rule', async () => {
    const other = {
      ...person,
      id: '34343434-3434-4434-8434-343434343434',
      email: 'o@escola.example',
      jobTitle: 'secretaria',
    };
    entra.members.get(testEnv.GROUP_APOIO_ID)!.add(person.id).add(other.id);
    vi.mocked(entra.port.members).mockResolvedValueOnce([person, other]);
    const rule = (cargoKey: string, groupId: string, active = true) => ({
      cargoKey,
      groupId,
      active,
      action: 'ADICIONAR',
    });
    setGroupRulesForTestsV1({
      rules: async () => [
        rule('equipe de apoio', testEnv.GROUP_APOIO_ID.toUpperCase()),
        rule('secretaria', testEnv.GROUP_APOIO_ID, false),
      ],
    } as unknown as GroupRulesPortV1);
    const answer = await groups({ operation: 'members', groupId: testEnv.GROUP_APOIO_ID });
    expect(
      (answer.body.members as GroupPersonV1[]).map((member) => [member.id, member.byRule]),
    ).toEqual([
      [person.id, true],
      [other.id, false],
    ]);
  });

  it('creates a Microsoft 365 group owned by the institutional account, then reaches it', async () => {
    const created = await groups({
      operation: 'create-group',
      name: ' Biblioteca ',
      description: 'Acervo',
    });
    expect(created).toMatchObject({
      status: 200,
      body: { group: { id: createdId, name: 'Biblioteca', role: null, available: true } },
    });
    expect(entra.port.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Biblioteca', description: 'Acervo', ownerId }),
    );
    expect(store.managed.map((group) => group.id)).toEqual([createdId]);
    expect(store.changes.at(-1)).toMatchObject({
      action: 'create-group',
      outcome: 'done',
      groupId: createdId,
    });
    expect(
      await groups({ operation: 'add-member', groupId: createdId, email: person.email }),
    ).toMatchObject({ status: 200, body: { result: 'added' } });
  });

  it('#1530 S6: a group Entra created is kept in the history even if the Centro cannot keep it', async () => {
    store.port.addManagedGroup = () => Promise.reject(new Error('db down'));
    expect(await groups({ operation: 'create-group', name: 'Biblioteca' })).toMatchObject({
      status: 503,
      body: { state: 'group-unrecorded' },
    });
    expect(store.changes.at(-1)).toMatchObject({
      action: 'create-group',
      outcome: 'done',
      groupId: createdId,
    });
    expect(store.changes.at(-1)!.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('#1530 S6: when the answer from Entra is lost, the group it did create is found and kept', async () => {
    vi.mocked(entra.port.createGroup).mockRejectedValueOnce(new GraphError(503, 'c'));
    vi.mocked(entra.port.groupByMailNickname).mockResolvedValueOnce({
      id: createdId,
      name: 'Biblioteca',
      description: null,
      mail: null,
    });
    expect(await groups({ operation: 'create-group', name: 'Biblioteca' })).toMatchObject({
      status: 200,
      body: { group: { id: createdId } },
    });
    expect(entra.port.groupByMailNickname).toHaveBeenCalledWith(
      expect.stringMatching(/^biblioteca-[0-9a-f]{6}$/u),
    );
    expect(store.managed.map((group) => group.id)).toEqual([createdId]);
  });

  it('refuses a name already in use, ignoring case and accents', async () => {
    store.managed.push({ id: createdId, name: 'Biblioteca', createdBy: 'X', createdAt: '' });
    for (const name of ['BIBLIOTECA', 'bibliotéca', 'Professores'])
      expect(await groups({ operation: 'create-group', name })).toMatchObject({
        status: 409,
        body: { state: 'name-taken' },
      });
    expect(entra.port.createGroup).not.toHaveBeenCalled();
  });

  it('without the owner account configured, no group is created', async () => {
    const { GROUPS_OWNER_ID: _owner, ...withoutOwner } = env;
    expect(
      await groups(
        { operation: 'create-group', name: 'Biblioteca' },
        undefined,
        withoutOwner as RuntimeEnv,
      ),
    ).toMatchObject({ status: 503, body: { state: 'unavailable' } });
    expect(entra.port.createGroup).not.toHaveBeenCalled();
  });

  it('a failure in Entra is answered as unavailable and recorded as failed', async () => {
    vi.mocked(entra.port.addMember).mockRejectedValueOnce(new Error('graph down'));
    expect(
      await groups({
        operation: 'add-member',
        groupId: testEnv.GROUP_APOIO_ID,
        email: person.email,
      }),
    ).toMatchObject({ status: 503, body: { state: 'unavailable' } });
    expect(store.changes.at(-1)).toMatchObject({ action: 'add-member', outcome: 'failed' });
  });

  it('shows the history, newest first, and refuses malformed requests', async () => {
    await groups({ operation: 'add-member', groupId: testEnv.GROUP_APOIO_ID, email: person.email });
    const history = await groups({ operation: 'history', groupId: testEnv.GROUP_APOIO_ID });
    expect(history.body.changes).toMatchObject([{ action: 'add-member', target: person.email }]);
    for (const body of [
      { operation: 'members', groupId: 'not-a-uuid' },
      { operation: 'find-people', query: 'a' },
      { operation: 'create-group', name: '' },
      { operation: 'drop-group', groupId: createdId },
      { operation: 'list', extra: true },
    ])
      expect((await groups(body)).status).toBe(400);
  });

  it('counts reads apart from changes in the request limiter', () => {
    for (const operation of ['list', 'members', 'find-people', 'history'])
      expect(classifyAdminOperationV1('/api/platform/groups', 'POST', { operation })).toBe('read');
    for (const operation of ['add-member', 'remove-member', 'create-group'])
      expect(classifyAdminOperationV1('/api/platform/groups', 'POST', { operation })).toBe('write');
  });
});

describe('#1513 Grupos: deleting starts only for who may, on a group the Centro created', () => {
  const library = { id: createdId, name: 'Biblioteca', createdBy: 'X', createdAt: '' };
  beforeEach(() => {
    entra.groups.set(createdId, {
      id: createdId,
      name: 'Biblioteca',
      description: null,
      mail: null,
    });
    store.managed.push(library);
  });

  it('tells who may delete: the institutional account and the Global Administrators', async () => {
    expect((await groups({ operation: 'list' })).body.canDelete).toBe(false);
    entra.globalAdmins.add(adminOid);
    expect((await groups({ operation: 'list' })).body.canDelete).toBe(true);
    entra.globalAdmins.clear();
    const owner = await cookieFor(['ADMINISTRADOR'], ownerId);
    expect((await groups({ operation: 'list' }, owner)).body.canDelete).toBe(true);
  });

  it('refuses a role group, someone who may not, and a name typed wrong', async () => {
    const owner = await cookieFor(['ADMINISTRADOR'], ownerId);
    expect(
      await groups(
        {
          operation: 'delete-start',
          groupId: testEnv.GROUP_PROFESSOR_ID,
          confirmName: 'PROFESSORES',
        },
        owner,
      ),
    ).toMatchObject({ status: 403, body: { state: 'delete-not-allowed' } });
    expect(
      await groups({ operation: 'delete-start', groupId: createdId, confirmName: 'Biblioteca' }),
    ).toMatchObject({ status: 403, body: { state: 'delete-not-allowed' } });
    expect(
      await groups(
        { operation: 'delete-start', groupId: createdId, confirmName: 'biblioteca' },
        owner,
      ),
    ).toMatchObject({ status: 400, body: { state: 'name-mismatch' } });
    expect(entra.port.deleteGroupAs).not.toHaveBeenCalled();
  });

  it('#1530 S2: refuses while an active job-title rule still adds people to the group', async () => {
    const owner = await cookieFor(['ADMINISTRADOR'], ownerId);
    const rule = {
      id: '4',
      cargo: 'bibliotecária',
      cargoKey: 'bibliotecária',
      action: 'ADICIONAR' as const,
      groupId: createdId.toUpperCase(),
      groupName: 'Biblioteca',
      active: true,
      note: null,
      reviewedAt: null,
      reviewedBy: null,
      etag: null,
    };
    let rules = [rule];
    setGroupRulesForTestsV1({ rules: async () => rules } as unknown as GroupRulesPortV1);
    const start = { operation: 'delete-start', groupId: createdId, confirmName: 'Biblioteca' };
    expect(await groups(start, owner)).toMatchObject({
      status: 409,
      body: { state: 'group-has-rules' },
    });
    rules = [{ ...rule, active: false }];
    expect((await groups(start, owner)).status).toBe(200);
  });

  it('sends the person to Microsoft for a one-time sign-in that can delete groups', async () => {
    const owner = await cookieFor(['ADMINISTRADOR'], ownerId);
    const response = await onRequest({
      request: new Request(`${testEnv.OFFICIAL_ORIGIN}/api/platform/groups`, {
        method: 'POST',
        headers: {
          Cookie: owner,
          Origin: testEnv.OFFICIAL_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contractVersion: 1,
          operation: 'delete-start',
          groupId: createdId,
          confirmName: ' Biblioteca ',
        }),
      }),
      env,
      waitUntil: () => undefined,
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(response.status).toBe(200);
    const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.searchParams.get('scope')).toBe(
      'openid profile https://graph.microsoft.com/Group.ReadWrite.All',
    );
    expect(url.searchParams.get('login_hint')).toBe('sec@escola.example');
    expect(url.searchParams.get('redirect_uri')).toBe(`${testEnv.OFFICIAL_ORIGIN}/auth/callback`);
    expect(response.headers.get('Set-Cookie')).toMatch(
      /^__Host-ecossistema_group_delete=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/u,
    );
    expect(entra.port.deleteGroupAs).not.toHaveBeenCalled();
  });
});

describe('#1513 Grupos: what is sent to Entra', () => {
  it('names the mail of a new group without accents and with a random ending', () => {
    expect(mailNicknameV1('Biblioteca Ação 2026', '0a1b2c3d-0000-4000-8000-000000000000')).toBe(
      'biblioteca-acao-2026-0a1b2c',
    );
    expect(mailNicknameV1('###', 'abcdef00-0000-4000-8000-000000000000')).toBe('grupo-abcdef');
  });

  it('reads the members count from the JSON page Graph answers', () => {
    expect(memberCountOfPageV1({ '@odata.count': 24, value: [{ id: 'x' }] })).toBe(24);
    expect(memberCountOfPageV1({ value: [] })).toBeNull();
    expect(memberCountOfPageV1('24')).toBeNull();
  });

  it('reads a person from Graph, with the sign-in name when there is no mail', () => {
    expect(
      personFromGraphV1({
        id: person.id,
        displayName: 'Pessoa',
        mail: null,
        userPrincipalName: 'pessoa@escola.example',
        jobTitle: '  ',
        accountEnabled: false,
      }),
    ).toEqual({
      id: person.id,
      name: 'Pessoa',
      email: 'pessoa@escola.example',
      jobTitle: null,
      enabled: false,
    });
  });
});
