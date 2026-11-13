// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/[[path]]';
import { seal } from '../server/auth/sealed';
import {
  createApplicationSession,
  readSession,
  reconfigureApplicationSession,
  SESSION_COOKIE,
} from '../server/auth/session';
import {
  NOT_REVOKED_CACHE_MS_V1,
  revokeSessionV1,
  SESSION_ID_PATTERN_V1,
  setSessionRevocationPortForTestsV1,
  type SessionRevocationPortV1,
} from '../server/auth/session-revocation-v1';
import { testEnv } from './fixtures';

const oid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** The database table, in memory; `reads` counts the questions asked. */
function memoryPort() {
  const revoked = new Map<string, number>();
  let reads = 0;
  const port: SessionRevocationPortV1 = {
    async isRevoked(sid) {
      reads += 1;
      return revoked.has(sid);
    },
    async revoke(sid, expiresAt) {
      revoked.set(sid, expiresAt);
    },
  };
  return { port, revoked, reads: () => reads };
}

async function cookieFor(session: object): Promise<string> {
  return `${SESSION_COOKIE}=${await seal(session, testEnv.SESSION_SECRET)}`;
}
const request = (cookie: string, init: RequestInit = {}) =>
  new Request(`${testEnv.OFFICIAL_ORIGIN}/api/me`, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) } });

afterEach(() => {
  setSessionRevocationPortForTestsV1(undefined);
  vi.useRealTimers();
});

describe('A25: "Sair" ends the ADM session on the server', () => {
  it('each sign-in gets its own id; changing the length keeps it', () => {
    const first = createApplicationSession({ oid, name: 'Pessoa', roles: ['ADMINISTRADOR'] });
    const second = createApplicationSession({ oid, name: 'Pessoa', roles: ['ADMINISTRADOR'] });
    expect(first.sid).toMatch(SESSION_ID_PATTERN_V1);
    expect(second.sid).not.toBe(first.sid);
    expect(reconfigureApplicationSession(first, 4)?.sid).toBe(first.sid);
  });

  it('a copy of the cookie kept after "Sair" no longer opens the Centro', async () => {
    const memory = memoryPort();
    setSessionRevocationPortForTestsV1(memory.port);
    const session = createApplicationSession({ oid, name: 'Pessoa', roles: ['ADMINISTRADOR'] });
    const cookie = await cookieFor(session);
    expect((await readSession(request(cookie), testEnv))?.oid).toBe(oid);

    const logout = await onRequest({
      request: new Request(`${testEnv.OFFICIAL_ORIGIN}/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: testEnv.OFFICIAL_ORIGIN },
      }),
      env: testEnv,
    } as never);
    expect(logout.status).toBe(303);
    expect(logout.headers.get('Set-Cookie')).toContain(`${SESSION_COOKIE}=;`);
    expect(memory.revoked.get(session.sid!)).toBe(session.exp);

    // The copy on this instance, and on another one that never saw the "Sair".
    await expect(readSession(request(cookie), testEnv)).resolves.toBeNull();
    setSessionRevocationPortForTestsV1(memory.port);
    await expect(readSession(request(cookie), testEnv)).resolves.toBeNull();
  });

  it('another instance trusts "not revoked" for 30 s at most, then asks again', async () => {
    vi.useFakeTimers();
    const memory = memoryPort();
    setSessionRevocationPortForTestsV1(memory.port);
    const session = createApplicationSession({ oid, name: 'Pessoa', roles: ['ADMINISTRADOR'] });
    const cookie = await cookieFor(session);
    await readSession(request(cookie), testEnv);
    await readSession(request(cookie), testEnv);
    expect(memory.reads()).toBe(1);
    // "Sair" on another instance: this one learns it once the 30 s are over.
    memory.revoked.set(session.sid!, session.exp);
    expect((await readSession(request(cookie), testEnv))?.oid).toBe(oid);
    vi.advanceTimersByTime(NOT_REVOKED_CACHE_MS_V1 + 1);
    await expect(readSession(request(cookie), testEnv)).resolves.toBeNull();
    expect(memory.reads()).toBe(2);
  });

  it('a database failure does not sign everyone out, and "Sair" still clears the cookie', async () => {
    const failing: SessionRevocationPortV1 = {
      isRevoked: () => Promise.reject(new Error('database down')),
      revoke: () => Promise.reject(new Error('database down')),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setSessionRevocationPortForTestsV1(failing);
    const session = createApplicationSession({ oid, name: 'Pessoa', roles: ['ADMINISTRADOR'] });
    const cookie = await cookieFor(session);
    expect((await readSession(request(cookie), testEnv))?.oid).toBe(oid);
    await expect(revokeSessionV1(testEnv, session.sid!, session.exp)).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a cookie from before the change (no id) is never looked up', async () => {
    const memory = memoryPort();
    setSessionRevocationPortForTestsV1(memory.port);
    const cookie = await cookieFor({ oid, name: 'Pessoa', roles: ['PROFESSOR'], exp: Math.floor(Date.now() / 1000) + 600 });
    expect((await readSession(request(cookie), testEnv))?.oid).toBe(oid);
    expect(memory.reads()).toBe(0);
  });
});
