// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/[[path]]';
import { ACCESS_AREA_IDS, type AccessArea } from '../shared/platform-contract';
import type { AccessGrantChangeViewV1 } from '../shared/platform-access-v1';
import { setAccessPeopleForTestsV1 } from '../server/platform/access-http-v1';
import {
  accessAreasForV1,
  areasFromDatabaseV1,
  setAccessGrantsPortForTestsV1,
  type AccessGrantsPortV1,
  type AccessGrantV1,
} from '../server/auth/access-grants-v1';
import { capabilitiesForSession } from '../server/auth/capabilities';
import { AuthorizationError } from '../server/auth/roles';
import { seal } from '../server/auth/sealed';
import {
  createApplicationSession,
  readSession,
  reconfigureApplicationSession,
  SESSION_COOKIE,
  sessionDurationOptionsFor,
} from '../server/auth/session';
import { setSessionRevocationPortForTestsV1 } from '../server/auth/session-revocation-v1';
import { authorizeGradebookRuntimeV1 } from '../server/gradebook/authorization-v1';
import { filesByRecentArrivalV1 } from '../server/gradebook/onedrive-sync/sync-rules-v1';
import { testEnv } from './fixtures';

const oid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const librarian = 'bibliotecaria@escola.example';
const adminOid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** The grants table and its history, in memory, keyed by the person; `reads` counts the reads. */
function memoryGrants(initial: Record<string, AccessArea[]> = {}) {
  const rows = new Map<string, AccessGrantV1>(
    Object.entries(initial).map(([id, areas]) => [
      id,
      {
        oid: id,
        email: librarian,
        areas,
        updatedAt: '2026-11-17T12:00:00.000Z',
        updatedBy: 'Admin',
      },
    ]),
  );
  const history: AccessGrantChangeViewV1[] = [];
  let reads = 0;
  let clock = Date.parse('2026-11-17T12:00:00.000Z');
  const port: AccessGrantsPortV1 = {
    async areasFor(id) {
      reads += 1;
      return rows.get(id)?.areas ?? [];
    },
    async list() {
      return [...rows.values()];
    },
    // As the SQL does: an edit (no e-mail) needs the grant and its version; a new one overwrites.
    async change(person, areas, actor, expectedUpdatedAt) {
      const before = rows.get(person.oid);
      if (person.email && before) return 'changed';
      if (
        !person.email &&
        (!before || (expectedUpdatedAt && before.updatedAt !== expectedUpdatedAt))
      )
        return 'changed';
      const email = person.email ?? before!.email;
      if (areas.length === 0) rows.delete(person.oid);
      else
        rows.set(person.oid, {
          oid: person.oid,
          email,
          areas: [...areas],
          updatedAt: new Date((clock += 1000)).toISOString(),
          updatedBy: actor.name,
        });
      history.unshift({
        at: new Date(clock).toISOString(),
        actor: actor.name,
        email,
        before: before?.areas ?? [],
        after: [...areas],
      });
      return 'saved';
    },
    async history(limit) {
      return history.slice(0, limit);
    },
  };
  return { port, rows, history, reads: () => reads };
}

/** Entra, as the Graph Backend answers a sign-in name or e-mail. */
const people: Record<string, { oid: string; email: string }> = {
  [librarian]: { oid, email: librarian },
  'biblioteca.alias@escola.example': { oid, email: librarian },
};

async function cookieFor(session: object): Promise<string> {
  return `${SESSION_COOKIE}=${await seal(session, testEnv.SESSION_SECRET, 'admin-session')}`;
}
const call = (path: string, cookie: string, init: RequestInit = {}) =>
  new Request(`${testEnv.OFFICIAL_ORIGIN}${path}`, {
    ...init,
    headers: { Cookie: cookie, ...(init.headers ?? {}) },
  });
async function serve(request: Request): Promise<Response> {
  return onRequest({
    request,
    env: testEnv,
    waitUntil: () => undefined,
  } as unknown as Parameters<typeof onRequest>[0]);
}

beforeEach(() => {
  setSessionRevocationPortForTestsV1(null);
  setAccessPeopleForTestsV1(async (_env, email) => people[email] ?? null);
});
afterEach(() => {
  setAccessGrantsPortForTestsV1(undefined);
  setSessionRevocationPortForTestsV1(undefined);
  setAccessPeopleForTestsV1(undefined);
  vi.useRealTimers();
});

describe('#1513: areas of the Centro opened to people outside the admin group', () => {
  it('an area adds only its own capability and the module catalog', () => {
    expect(capabilitiesForSession({ roles: ['APOIO'] })).toEqual([]);
    expect(capabilitiesForSession({ roles: ['APOIO'], areas: ['painel-do-aluno'] })).toEqual([
      'platform.snapshot.read',
      'area.painel-do-aluno',
    ]);
    const admin = capabilitiesForSession({ roles: ['ADMINISTRADOR'] });
    for (const area of ['desempenho', 'importacao', 'painel-do-aluno', 'saude'])
      expect(admin).toContain(`area.${area}`);
  });

  it('reads the areas on each request of a non-admin session, never for the administrator', async () => {
    const memory = memoryGrants({ [oid]: ['painel-do-aluno'] });
    setAccessGrantsPortForTestsV1(memory.port);
    const person = createApplicationSession({
      oid,
      name: 'Bibliotecária',
      username: 'Bibliotecaria@Escola.Example',
      roles: ['APOIO'],
    });
    const session = await readSession(call('/api/me', await cookieFor(person)), testEnv);
    expect(session?.areas).toEqual(['painel-do-aluno']);
    const admin = createApplicationSession({
      oid,
      name: 'Admin',
      username: 'admin@escola.example',
      roles: ['ADMINISTRADOR'],
    });
    const before = memory.reads();
    expect((await readSession(call('/api/me', await cookieFor(admin)), testEnv))?.areas).toBe(
      undefined,
    );
    expect(memory.reads()).toBe(before);
  });

  it('never seals the areas into the cookie', () => {
    const session = createApplicationSession({ oid, name: 'Pessoa', roles: ['APOIO'] });
    const reconfigured = reconfigureApplicationSession({ ...session, areas: ['saude'] }, 4);
    expect(reconfigured).not.toHaveProperty('areas');
  });

  it('reads the areas the database hands over as text', () => {
    expect(areasFromDatabaseV1('saude')).toEqual(['saude']);
    expect(areasFromDatabaseV1('saude,desempenho')).toEqual(['desempenho', 'saude']);
    expect(areasFromDatabaseV1(['importacao'])).toEqual(['importacao']);
    expect(areasFromDatabaseV1('{saude}')).toEqual([]);
    expect(areasFromDatabaseV1(null)).toEqual([]);
  });

  it('a failed read opens nothing', async () => {
    const memory = memoryGrants();
    setAccessGrantsPortForTestsV1({
      ...memory.port,
      areasFor: () => Promise.reject(new Error('down')),
    });
    expect(await accessAreasForV1(testEnv, oid)).toEqual([]);
  });

  it('#1530 A3: the areas follow the person, not the sign-in name', async () => {
    setAccessGrantsPortForTestsV1(memoryGrants({ [oid]: ['saude'] }).port);
    const signedIn = (personOid: string, username: string) =>
      createApplicationSession({ oid: personOid, name: 'P', username, roles: ['APOIO'] });
    // Renamed sign-in name: still the same person.
    const renamed = await readSession(
      call('/api/me', await cookieFor(signedIn(oid, 'nova.biblioteca@escola.example'))),
      testEnv,
    );
    expect(renamed?.areas).toEqual(['saude']);
    // The old sign-in name given to someone else opens nothing.
    const reused = await readSession(
      call('/api/me', await cookieFor(signedIn('dddddddd-dddd-4ddd-8ddd-dddddddddddd', librarian))),
      testEnv,
    );
    expect(reused?.areas).toBeUndefined();
  });

  it('#1530 A1: a read that never ends does not hold the other requests of the person', async () => {
    let calls = 0;
    const memory = memoryGrants({ [oid]: ['saude'] });
    setAccessGrantsPortForTestsV1({
      ...memory.port,
      // The first read belongs to a request that was cancelled: it never settles.
      areasFor: (id) =>
        calls++ === 0 ? new Promise<AccessArea[]>(() => undefined) : memory.port.areasFor(id),
    });
    const started = Date.now();
    void accessAreasForV1(testEnv, oid, started);
    // Within the share window it waits only for what is left of it, then reads on its own.
    expect(await accessAreasForV1(testEnv, oid, started + 3_990)).toEqual(['saude']);
    // Past the window it reads at once.
    expect(await accessAreasForV1(testEnv, oid, started + 5_000)).toEqual(['saude']);
    expect(calls).toBe(3);
  });

  it('#1530 A6: an area holds the session to the cap of sessions that can change data', async () => {
    setAccessGrantsPortForTestsV1(memoryGrants({ [oid]: ['saude'] }).port);
    const nineHoursAgo = Math.floor(Date.now() / 1000) - 9 * 60 * 60;
    const old = createApplicationSession(
      { oid, name: 'P', username: librarian, roles: ['APOIO'] },
      12,
      nineHoursAgo,
    );
    expect(await readSession(call('/api/me', await cookieFor(old)), testEnv)).toBeNull();
    setAccessGrantsPortForTestsV1(memoryGrants().port);
    expect(await readSession(call('/api/me', await cookieFor(old)), testEnv)).not.toBeNull();
  });

  it('#1530 A6: someone with an area cannot choose a session past the write cap', () => {
    expect(sessionDurationOptionsFor(['APOIO'])).toEqual([4, 8, 12]);
    expect(sessionDurationOptionsFor(['APOIO'], ['saude'])).toEqual([4, 8]);
  });

  it('#1530 A6: the areas in the code are the ones the table accepts', () => {
    const sql = readFileSync('migrations/admin-access/0001_area_grant_v1.sql', 'utf8');
    const accepted = /areas <@ ARRAY\[([^\]]+)\]/u.exec(sql)?.[1] ?? '';
    expect(accepted.match(/'[a-z-]+'/gu)?.map((value) => value.slice(1, -1))).toEqual([
      ...ACCESS_AREA_IDS,
    ]);
    expect(sql).toContain(`cardinality(areas) BETWEEN 1 AND ${ACCESS_AREA_IDS.length}`);
  });

  it('each gradebook route admits only its areas; the year settings stay with the administrator', () => {
    const notes = { roles: ['PROFESSOR' as const], areas: ['desempenho' as const] };
    expect(() => authorizeGradebookRuntimeV1(notes, ['desempenho'])).not.toThrow();
    expect(() => authorizeGradebookRuntimeV1(notes, ['importacao'])).toThrow(AuthorizationError);
    expect(() => authorizeGradebookRuntimeV1(notes)).toThrow(AuthorizationError);
    expect(() =>
      authorizeGradebookRuntimeV1({ roles: ['ADMINISTRADOR'] }, ['importacao']),
    ).not.toThrow();
  });

  it('only the administrator lists and changes the access, and the person sees it at once', async () => {
    const memory = memoryGrants();
    setAccessGrantsPortForTestsV1(memory.port);
    const admin = await cookieFor(
      createApplicationSession({ oid: adminOid, name: 'Admin', roles: ['ADMINISTRADOR'] }),
    );
    const put = (cookie: string, body: unknown) =>
      serve(
        call('/api/platform/access', cookie, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Origin: testEnv.OFFICIAL_ORIGIN },
          body: JSON.stringify(body),
        }),
      );

    const saved = await put(admin, { email: ' Bibliotecaria@Escola.Example ', areas: ['saude'] });
    expect(saved.status).toBe(200);
    const answer = (await saved.json()) as {
      grants: Array<{ id: string; email: string }>;
      history: AccessGrantChangeViewV1[];
    };
    expect(answer.grants).toMatchObject([
      { id: oid, email: librarian, areas: ['saude'], updatedBy: 'Admin' },
    ]);
    // #1530 A5: who, for whom, before and after.
    expect(answer.history).toMatchObject([
      { actor: 'Admin', email: librarian, before: [], after: ['saude'] },
    ]);
    // An e-mail alias reaches the same person; as a new grant it does not overwrite the one there.
    expect(
      (
        await put(admin, {
          email: 'biblioteca.alias@escola.example',
          areas: ['saude', 'desempenho'],
        })
      ).status,
    ).toBe(409);
    expect([...memory.rows.values()]).toMatchObject([{ oid, email: librarian, areas: ['saude'] }]);
    // The grant shown is edited instead.
    expect(
      (
        await put(admin, {
          id: oid,
          email: librarian,
          areas: ['saude', 'desempenho'],
          expectedUpdatedAt: [...memory.rows.values()][0]!.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect([...memory.rows.values()]).toMatchObject([
      { oid, email: librarian, areas: ['desempenho', 'saude'] },
    ]);
    expect(await put(admin, { email: 'ninguem@escola.example', areas: ['saude'] })).toMatchObject({
      status: 404,
    });
    // #1530 A6: an edit of a version changed meanwhile is refused.
    const stale = await put(admin, {
      id: oid,
      email: librarian,
      areas: ['saude'],
      expectedUpdatedAt: '2026-11-17T12:00:00.000Z',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ state: 'changed' });
    // An edit goes by the person, even when the name shown now belongs to someone else.
    const shown = [...memory.rows.values()][0]!;
    people[librarian] = { oid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', email: librarian };
    expect(
      (
        await put(admin, {
          id: oid.toUpperCase(),
          email: librarian,
          areas: ['desempenho', 'saude'],
          expectedUpdatedAt: shown.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect([...memory.rows.keys()]).toEqual([oid]);
    people[librarian] = { oid, email: librarian };
    // Removing needs the grant's id; a grant gone meanwhile is "changed".
    expect((await put(admin, { email: librarian, areas: [] })).status).toBe(400);
    expect(
      (
        await put(admin, {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          email: librarian,
          areas: [],
        })
      ).status,
    ).toBe(409);
    expect((await put(admin, { email: 'a/b@escola.example', areas: ['saude'] })).status).toBe(404);
    expect((await put(admin, { email: 'sem-arroba', areas: ['saude'] })).status).toBe(400);
    expect((await put(admin, { email: librarian, areas: ['configuracoes'] })).status).toBe(400);

    const person = await cookieFor(
      createApplicationSession({
        oid,
        name: 'Bibliotecária',
        username: librarian,
        roles: ['APOIO'],
      }),
    );
    const me = await serve(call('/api/me', person));
    expect(((await me.json()) as { capabilities: string[] }).capabilities).toEqual([
      'platform.snapshot.read',
      'area.desempenho',
      'area.saude',
    ]);
    expect((await serve(call('/api/platform/access', person))).status).toBe(403);
    expect((await put(person, { email: librarian, areas: ['desempenho'] })).status).toBe(403);

    expect((await put(admin, { id: oid, email: librarian, areas: [] })).status).toBe(200);
    expect(memory.rows.size).toBe(0);
    expect(memory.history[0]).toMatchObject({ email: librarian, after: [] });
  });
});

describe('#1513: OneDrive Planilhas, latest notes first', () => {
  it('orders by the date the row shows, never-read sheets last by name', () => {
    const files = [
      { name: 'C', lastReadAt: null, lastAppliedAt: null },
      { name: 'B', lastReadAt: 5_000, lastAppliedAt: null },
      { name: 'A', lastReadAt: 9_000, lastAppliedAt: 3_000 },
      { name: 'D', lastReadAt: 7_000, lastAppliedAt: 8_000 },
      { name: 'E', lastReadAt: null },
    ];
    expect(
      filesByRecentArrivalV1(files, (a, b) => a.localeCompare(b)).map((file) => file.name),
    ).toEqual(['D', 'B', 'A', 'C', 'E']);
  });
});
