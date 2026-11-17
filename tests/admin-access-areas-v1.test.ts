// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/[[path]]';
import type { AccessArea } from '../shared/platform-contract';
import {
  accessAreasForV1,
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
} from '../server/auth/session';
import { setSessionRevocationPortForTestsV1 } from '../server/auth/session-revocation-v1';
import { authorizeGradebookRuntimeV1 } from '../server/gradebook/authorization-v1';
import { filesByRecentArrivalV1 } from '../server/gradebook/onedrive-sync/sync-rules-v1';
import { testEnv } from './fixtures';

const oid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const librarian = 'bibliotecaria@escola.example';

/** The grants table, in memory; `reads` counts the questions asked. */
function memoryGrants(initial: Record<string, AccessArea[]> = {}) {
  const rows = new Map<string, AccessGrantV1>(
    Object.entries(initial).map(([email, areas]) => [
      email,
      { email, areas, updatedAt: '2026-11-17T12:00:00.000Z', updatedBy: 'Admin' },
    ]),
  );
  let reads = 0;
  const port: AccessGrantsPortV1 = {
    async areasFor(email) {
      reads += 1;
      return rows.get(email)?.areas ?? [];
    },
    async list() {
      return [...rows.values()];
    },
    async save(email, areas, actor) {
      if (areas.length === 0) rows.delete(email);
      else
        rows.set(email, {
          email,
          areas: [...areas],
          updatedAt: '2026-11-17T12:00:00.000Z',
          updatedBy: actor.name,
        });
    },
  };
  return { port, rows, reads: () => reads };
}

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

beforeEach(() => setSessionRevocationPortForTestsV1(null));
afterEach(() => {
  setAccessGrantsPortForTestsV1(undefined);
  setSessionRevocationPortForTestsV1(undefined);
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
    const memory = memoryGrants({ [librarian]: ['painel-do-aluno'] });
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

  it('a failed read opens nothing', async () => {
    setAccessGrantsPortForTestsV1({
      areasFor: () => Promise.reject(new Error('down')),
      list: () => Promise.resolve([]),
      save: () => Promise.resolve(),
    });
    expect(await accessAreasForV1(testEnv, 'falha@escola.example')).toEqual([]);
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
      createApplicationSession({ oid, name: 'Admin', roles: ['ADMINISTRADOR'] }),
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
    expect(((await saved.json()) as { grants: AccessGrantV1[] }).grants).toMatchObject([
      { email: librarian, areas: ['saude'], updatedBy: 'Admin' },
    ]);
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
      'area.saude',
    ]);
    expect((await serve(call('/api/platform/access', person))).status).toBe(403);
    expect((await put(person, { email: librarian, areas: ['desempenho'] })).status).toBe(403);

    expect((await put(admin, { email: librarian, areas: [] })).status).toBe(200);
    expect(memory.rows.size).toBe(0);
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
