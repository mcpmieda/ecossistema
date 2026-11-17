// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/[[path]]';
import { ACCESS_AREA_IDS, type AccessArea } from '../shared/platform-contract';
import {
  setAccessGrantsPortForTestsV1,
  type AccessGrantsPortV1,
} from '../server/auth/access-grants-v1';
import { seal } from '../server/auth/sealed';
import { createApplicationSession, SESSION_COOKIE } from '../server/auth/session';
import { setSessionRevocationPortForTestsV1 } from '../server/auth/session-revocation-v1';
import { testEnv } from './fixtures';

/**
 * #1513: someone outside the Secretaria, even with every area opened, calls the API directly
 * (no screen) for what only the Secretaria may do, and tries to forge the session cookie.
 */
const oid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const attacker = 'pessoa.apoio@escola.example';
const ADMIN_ONLY = [
  'platform.settings.read',
  'platform.settings.write',
  'gradebook.persistence.admin',
] as const;

let grants: Map<string, AccessArea[]>;
const port: AccessGrantsPortV1 = {
  areasFor: async (email) => grants.get(email) ?? [],
  list: async () =>
    [...grants].map(([email, areas]) => ({
      email,
      areas,
      updatedAt: '2026-11-17T12:00:00.000Z',
      updatedBy: 'Admin',
    })),
  save: async (email, areas) => {
    if (areas.length === 0) grants.delete(email);
    else grants.set(email, [...areas]);
  },
};

const sealed = (session: object, secret = testEnv.SESSION_SECRET) =>
  seal(session, secret, 'admin-session').then((token) => `${SESSION_COOKIE}=${token}`);
const personSession = () =>
  createApplicationSession({ oid, name: 'Pessoa', username: attacker, roles: ['APOIO'] });

async function call(cookie: string, path: string, method = 'GET', body?: unknown) {
  return onRequest({
    request: new Request(`${testEnv.OFFICIAL_ORIGIN}${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: testEnv.OFFICIAL_ORIGIN,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env: testEnv,
    waitUntil: () => undefined,
  } as unknown as Parameters<typeof onRequest>[0]);
}

/** Every route only the Secretaria may call, with a body an attacker would send. */
type CallV1 = [path: string, method: string, body?: unknown];
const adminOnlyCalls: CallV1[] = [
  ['/api/platform/access', 'GET'],
  ['/api/platform/access', 'PUT', { email: attacker, areas: [...ACCESS_AREA_IDS] }],
  ['/api/platform/access', 'PUT', { email: 'outra@escola.example', areas: ['desempenho'] }],
  ['/api/platform/settings/session', 'GET'],
  ['/api/platform/settings/session', 'POST', { durationHours: 8 }],
  ['/api/gradebook/assessment-names', 'POST', { contractVersion: 1, year: 2026 }],
  ['/api/gradebook/year-reset', 'POST', { contractVersion: 1, year: 2026 }],
];

beforeEach(() => {
  grants = new Map([[attacker, [...ACCESS_AREA_IDS]]]);
  setAccessGrantsPortForTestsV1(port);
  setSessionRevocationPortForTestsV1(null);
});
afterEach(() => {
  setAccessGrantsPortForTestsV1(undefined);
  setSessionRevocationPortForTestsV1(undefined);
});

describe('#1513: what only the Secretaria does stays closed to everyone else, through the API', () => {
  it('every area opened still gives none of the Secretaria capabilities', async () => {
    const me = await call(await sealed(personSession()), '/api/me');
    const { capabilities } = (await me.json()) as { capabilities: string[] };
    expect(capabilities).toEqual(
      expect.arrayContaining(ACCESS_AREA_IDS.map((area) => `area.${area}`)),
    );
    for (const capability of ADMIN_ONLY) expect(capabilities).not.toContain(capability);
  });

  it.each(adminOnlyCalls)(
    '%s %s is refused with every area opened',
    async (...[path, method, body]: CallV1) => {
      const before = JSON.stringify([...grants]);
      const response = await call(await sealed(personSession()), path, method, body);
      expect(response.status).toBe(403);
      // Nothing was granted or changed by the attempt.
      expect(JSON.stringify([...grants])).toBe(before);
    },
  );

  it('a cookie sealed without the server secret is not a session, even claiming ADMINISTRADOR', async () => {
    const forged = await sealed(
      { ...personSession(), roles: ['ADMINISTRADOR'] },
      'x'.repeat(testEnv.SESSION_SECRET.length),
    );
    for (const [path, method, body] of adminOnlyCalls)
      expect((await call(forged, path, method, body)).status).toBe(401);
  });

  it('a real cookie changed by one character is not a session', async () => {
    const cookie = await sealed(personSession());
    const at = cookie.length - 10;
    const changed = `${cookie.slice(0, at)}${cookie[at] === 'A' ? 'B' : 'A'}${cookie.slice(at + 1)}`;
    expect((await call(changed, '/api/platform/access')).status).toBe(401);
    expect((await call(changed, '/api/me')).status).toBe(401);
  });

  it('areas written into the cookie are refused: only the table grants them', async () => {
    grants.clear();
    const stuffed = await sealed({ ...personSession(), areas: [...ACCESS_AREA_IDS] });
    expect((await call(stuffed, '/api/me')).status).toBe(401);
    expect((await call(stuffed, '/api/platform/access')).status).toBe(401);
  });

  it('without any area, the person reaches nothing of the Centro', async () => {
    grants.clear();
    const cookie = await sealed(personSession());
    const me = (await (await call(cookie, '/api/me')).json()) as { capabilities: string[] };
    expect(me.capabilities).toEqual([]);
    for (const [path, body] of [
      ['/api/gradebook/performance', { contractVersion: 2, year: 2026 }],
      ['/api/platform/system-health', { contractVersion: 1 }],
    ] as const)
      expect((await call(cookie, path, 'POST', body)).status).toBe(403);
  });
});
