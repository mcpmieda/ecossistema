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
  FAILURE_CACHE_MS_V1,
  isSessionRevokedV1,
  NOT_REVOKED_CACHE_MS_V1,
  PENDING_SHARE_MS_V1,
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

  it('simultaneous requests of one session ask the database once (issue #1426, 3)', async () => {
    const memory = memoryPort();
    setSessionRevocationPortForTestsV1(memory.port);
    const sid = 'a'.repeat(22);
    const answers = await Promise.all(Array.from({ length: 5 }, () => isSessionRevokedV1(testEnv, sid, 2_000_000_000)));
    expect(answers).toEqual([false, false, false, false, false]);
    expect(memory.reads()).toBe(1);
  });

  it('a failed read is remembered for 15 s, and "Sair" during a read is never overwritten', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let release: (value: boolean) => void = () => undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setSessionRevocationPortForTestsV1({
      isRevoked: () => { reads += 1; return reads === 1 ? Promise.reject(new Error('down')) : new Promise((resolve) => { release = resolve; }); },
      revoke: async () => undefined,
    });
    const sid = 'b'.repeat(22);
    await expect(isSessionRevokedV1(testEnv, sid, 2_000_000_000)).resolves.toBe(false);
    await expect(isSessionRevokedV1(testEnv, sid, 2_000_000_000)).resolves.toBe(false);
    expect(reads).toBe(1);
    vi.advanceTimersByTime(FAILURE_CACHE_MS_V1 + 1);
    const pending = isSessionRevokedV1(testEnv, sid, 2_000_000_000);
    expect(reads).toBe(2);
    await revokeSessionV1(testEnv, sid, 2_000_000_000);
    release(false);
    await pending;
    await expect(isSessionRevokedV1(testEnv, sid, 2_000_000_000)).resolves.toBe(true);
    warn.mockRestore();
  });

  it('a read that never answers (its request was cancelled) does not hold the others (issue #1450, 2)', async () => {
    vi.useFakeTimers();
    let reads = 0;
    setSessionRevocationPortForTestsV1({
      isRevoked: () => { reads += 1; return reads === 1 ? new Promise<boolean>(() => undefined) : Promise.resolve(false); },
      revoke: async () => undefined,
    });
    const sid = 'c'.repeat(22);
    void isSessionRevokedV1(testEnv, sid, 2_000_000_000);
    // A request at the same moment joins the read, and asks on its own once the wait is over.
    const joined = isSessionRevokedV1(testEnv, sid, 2_000_000_000);
    await vi.advanceTimersByTimeAsync(PENDING_SHARE_MS_V1 + 1);
    await expect(joined).resolves.toBe(false);
    expect(reads).toBe(2);
    // A later request does not wait on the dead read at all.
    await expect(isSessionRevokedV1(testEnv, sid, 2_000_000_000)).resolves.toBe(false);
    expect(reads).toBe(3);
  });

  it('a cookie from before the change (no id) is never looked up', async () => {
    const memory = memoryPort();
    setSessionRevocationPortForTestsV1(memory.port);
    const cookie = await cookieFor({ oid, name: 'Pessoa', roles: ['PROFESSOR'], exp: Math.floor(Date.now() / 1000) + 600 });
    expect((await readSession(request(cookie), testEnv))?.oid).toBe(oid);
    expect(memory.reads()).toBe(0);
  });
});
