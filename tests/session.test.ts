// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64Url } from '../server/auth/base64url';
import { clearCookie, readCookie, secureCookie } from '../server/auth/cookies';
import { seal, UNBOUND_SEAL_ACCEPTED_UNTIL_V1, unseal } from '../server/auth/sealed';
import {
  createApplicationSession,
  readSession,
  reconfigureApplicationSession,
  SESSION_COOKIE,
} from '../server/auth/session';
import { testEnv } from './fixtures';

describe('sealed cookies and sessions', () => {
  it('seals and opens a value', async () => {
    const token = await seal({ ok: true }, testEnv.SESSION_SECRET, 'admin-session');
    await expect(unseal(token, testEnv.SESSION_SECRET, 'admin-session')).resolves.toEqual({
      ok: true,
    });
  });
  it('rejects a tampered cookie', async () => {
    const token = await seal({ ok: true }, testEnv.SESSION_SECRET, 'admin-session');
    await expect(
      unseal(`${token.slice(0, -1)}x`, testEnv.SESSION_SECRET, 'admin-session'),
    ).resolves.toBeNull();
  });
  it('rejects a cookie encrypted with another key', async () => {
    const token = await seal({ ok: true }, testEnv.SESSION_SECRET, 'admin-session');
    await expect(
      unseal(token, `${testEnv.SESSION_SECRET}different`, 'admin-session'),
    ).resolves.toBeNull();
  });
  it('never opens a value sealed for another purpose', async () => {
    const session = createApplicationSession({
      oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Pessoa',
      roles: ['ADMINISTRADOR'],
    });
    const asPolicy = await seal(session, testEnv.SESSION_SECRET, 'session-policy');
    await expect(unseal(asPolicy, testEnv.SESSION_SECRET, 'admin-session')).resolves.toBeNull();
    await expect(unseal(asPolicy, testEnv.SESSION_SECRET, 'session-policy')).resolves.toEqual(
      session,
    );
    const request = new Request(testEnv.OFFICIAL_ORIGIN, {
      headers: { Cookie: `${SESSION_COOKIE}=${asPolicy}` },
    });
    await expect(readSession(request, testEnv)).resolves.toBeNull();
  });
  describe('values sealed before the purpose binding', () => {
    afterEach(() => vi.useRealTimers());
    async function unboundToken(value: unknown): Promise<string> {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(testEnv.SESSION_SECRET),
      );
      const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(JSON.stringify(value)),
      );
      return encodeBase64Url(
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            iv: encodeBase64Url(iv),
            ct: encodeBase64Url(new Uint8Array(ct)),
          }),
        ),
      );
    }
    it('still open during the transition and stop opening after it', async () => {
      const token = await unboundToken({ ok: true });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(UNBOUND_SEAL_ACCEPTED_UNTIL_V1 - 1);
      await expect(unseal(token, testEnv.SESSION_SECRET, 'admin-session')).resolves.toEqual({
        ok: true,
      });
      vi.setSystemTime(UNBOUND_SEAL_ACCEPTED_UNTIL_V1);
      await expect(unseal(token, testEnv.SESSION_SECRET, 'admin-session')).resolves.toBeNull();
    });
  });
  it('reads a named cookie', () =>
    expect(
      readCookie(
        new Request('https://x.test', { headers: { Cookie: 'a=1; target=value=with=equals' } }),
        'target',
      ),
    ).toBe('value=with=equals'));
  it('emits __Host-compatible attributes', () =>
    expect(secureCookie(SESSION_COOKIE, 'x')).toContain('Path=/; HttpOnly; Secure; SameSite=Lax'));
  it('clears a cookie', () => expect(clearCookie(SESSION_COOKIE)).toContain('Max-Age=0'));
  it('accepts a live session', async () => {
    const token = await seal(
      {
        oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Pessoa',
        roles: ['ALUNO'],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      testEnv.SESSION_SECRET,
      'admin-session',
    );
    const request = new Request(testEnv.OFFICIAL_ORIGIN, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect((await readSession(request, testEnv))?.name).toBe('Pessoa');
  });
  it('rejects an expired session', async () => {
    const token = await seal(
      { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Pessoa', roles: ['ALUNO'], exp: 1 },
      testEnv.SESSION_SECRET,
      'admin-session',
    );
    const request = new Request(testEnv.OFFICIAL_ORIGIN, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    await expect(readSession(request, testEnv)).resolves.toBeNull();
  });
  it('rejects a session payload with fields a session never carries', async () => {
    const token = await seal(
      {
        oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Pessoa',
        roles: ['ALUNO'],
        exp: Math.floor(Date.now() / 1000) + 60,
        purpose: 'draft',
      },
      testEnv.SESSION_SECRET,
      'admin-session',
    );
    const request = new Request(testEnv.OFFICIAL_ORIGIN, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    await expect(readSession(request, testEnv)).resolves.toBeNull();
  });
  it('rejects a malformed session payload', async () => {
    const token = await seal({ name: 'Pessoa' }, testEnv.SESSION_SECRET, 'admin-session');
    const request = new Request(testEnv.OFFICIAL_ORIGIN, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    await expect(readSession(request, testEnv)).resolves.toBeNull();
  });

  it('issues an eight-hour application session independently from the validated identity token', () => {
    const authenticatedAt = 1_800_000_000;
    const session = createApplicationSession(
      {
        oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Pessoa',
        roles: ['ADMINISTRADOR'],
      },
      undefined,
      authenticatedAt,
    );

    expect(session.authenticatedAt).toBe(authenticatedAt);
    expect(session.durationHours).toBe(8);
    expect(session.exp).toBe(authenticatedAt + 8 * 60 * 60);
  });

  it('keeps duration changes absolute from authentication instead of sliding on activity', () => {
    const authenticatedAt = 1_800_000_000;
    const original = createApplicationSession(
      {
        oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Pessoa',
        roles: ['ADMINISTRADOR'],
      },
      4,
      authenticatedAt,
    );

    expect(reconfigureApplicationSession(original, 8, authenticatedAt + 3_600)?.exp).toBe(
      authenticatedAt + 8 * 60 * 60,
    );
    expect(reconfigureApplicationSession(original, 4, authenticatedAt + 5 * 60 * 60)).toBeNull();
  });
});
