// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clearCookie, readCookie, secureCookie } from '../server/auth/cookies';
import { seal, unseal } from '../server/auth/sealed';
import {
  createApplicationSession,
  readSession,
  reconfigureApplicationSession,
  SESSION_COOKIE,
} from '../server/auth/session';
import { testEnv } from './fixtures';

describe('sealed cookies and sessions', () => {
  it('seals and opens a value', async () => {
    const token = await seal({ ok: true }, testEnv.SESSION_SECRET);
    await expect(unseal(token, testEnv.SESSION_SECRET)).resolves.toEqual({ ok: true });
  });
  it('rejects a tampered cookie', async () => {
    const token = await seal({ ok: true }, testEnv.SESSION_SECRET);
    await expect(unseal(`${token.slice(0, -1)}x`, testEnv.SESSION_SECRET)).resolves.toBeNull();
  });
  it('rejects a cookie encrypted with another key', async () => {
    const token = await seal({ ok: true }, testEnv.SESSION_SECRET);
    await expect(unseal(token, `${testEnv.SESSION_SECRET}different`)).resolves.toBeNull();
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
    );
    const request = new Request(testEnv.OFFICIAL_ORIGIN, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    await expect(readSession(request, testEnv)).resolves.toBeNull();
  });
  it('rejects a malformed session payload', async () => {
    const token = await seal({ name: 'Pessoa' }, testEnv.SESSION_SECRET);
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
