import { beforeEach, describe, expect, it, vi } from 'vitest';
import { servePortalSelfV1 } from '../../../server/student-portal/composition/self-v1';
import { portalDatabaseV1 } from '../../../server/student-portal/composition/database-v1';
import { sessionCookieTokenV1 } from '../../../server/student-portal/http/auth/handler-v1';
import { SESSION_COOKIE_V1 } from '../../../shared/student-portal-contracts/auth-v1';
import { portalKeysV1 } from '../../../server/student-portal/composition/config-v1';

vi.mock('../../../server/student-portal/composition/database-v1', () => ({ portalDatabaseV1: vi.fn() }));
const origin = 'https://aluno.escolaieda.com';
const token = 'a'.repeat(43), cookie = `${SESSION_COOKIE_V1.name}=${token}`;
const key = JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64') });
const env = { PORTAL_ENVIRONMENT: 'production', PORTAL_ORIGIN: origin,
  PORTAL_ADMIN_TENANT_ID: '50000000-0000-4000-8000-000000000001', PORTAL_SERVING_ENABLED: 'true',
  PORTAL_PHOTOS_ENABLED: 'true', PASSWORD_PEPPER: key, QR_HMAC_KEYS: key, TURNSTILE_SECRET_KEY: 'synthetic',
  PORTAL_AUTH_GLOBAL: { limit: vi.fn().mockResolvedValue({ success: true }) },
  PORTAL_AUTH_SUBJECT: { limit: vi.fn().mockResolvedValue({ success: true }) } };
const request = (path: string, value: string, init: RequestInit = {}) => new Request(origin + path, {
  ...init, headers: { origin, cookie: value, 'sec-fetch-site': 'same-origin', ...init.headers },
});
beforeEach(() => vi.clearAllMocks());
describe('bounded cookie input before database entry', () => {
  const invalid = ['', cookie + '; ' + cookie, `${SESSION_COOKIE_V1.name}=bad`, cookie + '; x=' + 'x'.repeat(8192),
    cookie + ';' + Array.from({ length: 64 }, () => 'x=1').join(';'), cookie + '; x=' + 'é'.repeat(4096)];
  it.each(invalid)('rejects malformed or excessive cookie without opening SQL', async (value) => {
    for (const path of ['/api/student/session', '/api/student/me', '/api/student/live', '/api/student/photo',
      '/api/student/photo/content?v=50000000-0000-4000-8000-000000000001']) {
      const response = await servePortalSelfV1(request(path, value, path.endsWith('/live') ? { headers: { upgrade: 'websocket' } } : {}), env);
      expect(response.status).toBe(401);
      expect(portalDatabaseV1).not.toHaveBeenCalled();
    }
  });
  it('accepts the unchanged token format at both parser boundaries', () => {
    expect(sessionCookieTokenV1(request('/api/student/session', cookie))).toBe(token);
    const exact = cookie + ';x=' + 'x'.repeat(8192 - cookie.length - 3);
    expect(sessionCookieTokenV1(request('/api/student/session', exact))).toBe(token);
    expect(sessionCookieTokenV1(request('/api/student/session', exact + 'x'))).toBe('');
    expect(sessionCookieTokenV1(request('/api/student/session', cookie + ';' + Array(63).fill('x=1').join(';')))).toBe(token);
  });
  it('keeps no-token logout idempotent without opening SQL', async () => {
    const response = await servePortalSelfV1(request('/api/student/auth/logout', '', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"contractVersion":1}',
    }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(portalDatabaseV1).not.toHaveBeenCalled();
  });
});
it('contains invalid QR before crypto and keeps proven credentials quota untouched', async () => {
  const credential = 'a'.repeat(43);
  const signature = await portalKeysV1(env).cryptoPort.signQr(credential, 1);
  for (const invalidSignature of ['A'.repeat(43), signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A')]) {
    vi.clearAllMocks();
    const response = await servePortalSelfV1(request('/api/student/auth/login', '', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contractVersion: 1, qr: `${origin}/access#v1.${credential}.1.${invalidSignature}`, password: '123456', keepConnected: false }),
    }), env);
    expect(response.status).toBe(401);
    expect(env.PORTAL_AUTH_GLOBAL.limit).toHaveBeenCalledExactlyOnceWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(env.PORTAL_AUTH_SUBJECT.limit).not.toHaveBeenCalled();
    expect(portalDatabaseV1).not.toHaveBeenCalled();
  }
});

it('canonicalizes signed QR aliases and rejects unknown key versions before proven quota or SQL', async () => {
  const credential = 'a'.repeat(43), signature = await portalKeysV1(env).cryptoPort.signQr(credential, 1);
  vi.mocked(portalDatabaseV1).mockRejectedValue(new Error('synthetic-database-not-configured'));
  const login = (qr: string) => servePortalSelfV1(request('/api/student/auth/login', '', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contractVersion: 1, qr, password: '123456', keepConnected: false }),
  }), env);
  await login(`${origin}/access#v1.${credential}.1.${signature}`);
  await login(`HTTPS://ALUNO.ESCOLAIEDA.COM/access#v1.${credential}.1.${signature}`);
  expect(env.PORTAL_AUTH_SUBJECT.limit).toHaveBeenCalledTimes(2);
  expect(env.PORTAL_AUTH_SUBJECT.limit.mock.calls[0]).toEqual(env.PORTAL_AUTH_SUBJECT.limit.mock.calls[1]);
  vi.clearAllMocks();
  expect((await login(`${origin}/access#v1.${credential}.2.${signature}`)).status).toBe(401);
  expect(env.PORTAL_AUTH_SUBJECT.limit).not.toHaveBeenCalled();
  expect(portalDatabaseV1).not.toHaveBeenCalled();
});


it('keeps a signed QR out of the anonymous budget that forged QRs can exhaust', async () => {
  const credential = 'a'.repeat(43), signature = await portalKeysV1(env).cryptoPort.signQr(credential, 1);
  vi.mocked(portalDatabaseV1).mockRejectedValue(new Error('synthetic-database-not-configured'));
  // Only the proven-credential key still has room: the anonymous 'auth-entry' budget is spent.
  const exhausted = { ...env, PORTAL_AUTH_GLOBAL: { limit: vi.fn(async ({ key }: { key: string }) =>
    ({ success: key === 'student-portal-auth-v1' })) } };
  const login = (sig: string) => servePortalSelfV1(request('/api/student/auth/login', '', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contractVersion: 1, qr: `${origin}/access#v1.${credential}.1.${sig}`, password: '123456', keepConnected: false }),
  }), exhausted);
  expect((await login('A'.repeat(43))).status).toBe(429);
  expect(portalDatabaseV1).not.toHaveBeenCalled();
  expect((await login(signature)).status).not.toBe(429);
  expect(env.PORTAL_AUTH_SUBJECT.limit).toHaveBeenCalledTimes(1);
  expect(portalDatabaseV1).toHaveBeenCalledTimes(1);
});

it('does not confuse malformed entry limiter success with a real quota decision', async () => {
  const response = await servePortalSelfV1(request('/api/student/auth/login', '', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contractVersion: 1, qr: `${origin}/access#v1.${'a'.repeat(43)}.1.${'b'.repeat(43)}`,
      password: '123456', keepConnected: false }),
  }), { ...env, PORTAL_AUTH_GLOBAL: { limit: vi.fn().mockResolvedValue({}) } });
  expect(response.status).toBe(503);
  expect(env.PORTAL_AUTH_SUBJECT.limit).not.toHaveBeenCalled();
  expect(portalDatabaseV1).not.toHaveBeenCalled();
});
