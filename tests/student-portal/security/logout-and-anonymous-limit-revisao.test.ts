import { afterEach, describe, expect, it, vi } from 'vitest';
import { servePortalSelfV1 } from '../../../server/student-portal/composition/self-v1';
import { SessionServiceV1 } from '../../../server/student-portal/auth/session-service-v1';
import { portalAnonymousSubjectV1 } from '../../../server/student-portal/observability/operation-burst-v1';

const database = vi.hoisted(() => vi.fn());
vi.mock('../../../server/student-portal/composition/database-v1', () => ({ portalDatabaseV1: database }));

const origin = 'https://aluno.escolaieda.com';
const key = JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64') });
const cookie = '__Host-student_portal_session=' + 'a'.repeat(43);
const allowAll = () => ({ limit: vi.fn().mockResolvedValue({ success: true }) });
function portalEnv(overrides: Record<string, unknown> = {}) {
  return { PORTAL_ENVIRONMENT: 'production', PORTAL_ORIGIN: origin, PORTAL_SERVING_ENABLED: 'true',
    PORTAL_ADMIN_TENANT_ID: '50000000-0000-4000-8000-000000000001', PASSWORD_PEPPER: key, QR_HMAC_KEYS: key,
    PORTAL_PUBLICATION_MODE: 'scoped-v2', PORTAL_AUTH_GLOBAL: allowAll(), PORTAL_AUTH_SUBJECT: allowAll(),
    PORTAL_READ_ACCOUNT: allowAll(), ...overrides } as unknown as Parameters<typeof servePortalSelfV1>[1];
}
function fromPeer(request: Request, ip: string | null) {
  if (ip !== null) request.headers.set('cf-connecting-ip', ip);
  Object.defineProperty(request, 'cf', { value: { colo: 'GRU' } });
  return request;
}
const logout = () => new Request(origin + '/api/student/auth/logout', { method: 'POST',
  headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ contractVersion: 1 }) });
const clears = (response: Response) =>
  expect(response.headers.get('set-cookie')).toBe('__Host-student_portal_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');

afterEach(() => { vi.restoreAllMocks(); database.mockReset(); });

describe('A6: Sair always clears the cookie on this device', () => {
  it('clears it when the database fails', async () => {
    database.mockRejectedValue(new Error('database down'));
    const response = await servePortalSelfV1(logout(), portalEnv());
    expect(response.status).toBe(503);
    clears(response);
  });

  it('clears it when the anonymous limit is spent', async () => {
    const response = await servePortalSelfV1(logout(), portalEnv({
      PORTAL_AUTH_GLOBAL: { limit: vi.fn().mockResolvedValue({ success: false }) } }));
    expect(response.status).toBe(429);
    clears(response);
  });

  it('clears it during maintenance and never touches the database', async () => {
    const response = await servePortalSelfV1(logout(), portalEnv({ PORTAL_SERVING_ENABLED: 'false' }));
    expect(response.status).toBe(503);
    clears(response);
    expect(database).not.toHaveBeenCalled();
  });

  it('clears it on a malformed logout body too', async () => {
    const request = new Request(origin + '/api/student/auth/logout', { method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' }, body: '{' });
    const response = await servePortalSelfV1(request, portalEnv());
    expect(response.status).toBe(400);
    clears(response);
  });

  it('still clears it on success', async () => {
    database.mockImplementation(async (_env, _operation, run) => run({}));
    vi.spyOn(SessionServiceV1.prototype, 'logout').mockResolvedValue(undefined as never);
    const response = await servePortalSelfV1(logout(), portalEnv());
    expect(response.status).toBe(200);
    clears(response);
  });
});

describe('A9: the anonymous entry limit is per network peer, never one shared key', () => {
  it('one client spending its budget does not block another family', async () => {
    const used = new Map<string, number>();
    const global = { limit: vi.fn(async ({ key: limitKey }: { key: string }) => {
      const count = (used.get(limitKey) ?? 0) + 1;
      used.set(limitKey, count);
      return { success: count <= 3 };
    }) };
    database.mockImplementation(async (_env, _operation, run) => run({}));
    vi.spyOn(SessionServiceV1.prototype, 'withAuthorized').mockResolvedValue(null);
    const env = portalEnv({ PORTAL_AUTH_GLOBAL: global });
    const me = (ip: string) => fromPeer(new Request(origin + '/api/student/me', { headers: { origin, cookie } }), ip);
    const attacker: number[] = [];
    for (let index = 0; index < 6; index += 1)
      attacker.push((await servePortalSelfV1(me('203.0.113.9'), env)).status);
    expect(attacker.slice(-1)).toEqual([429]);
    const family = await servePortalSelfV1(me('198.51.100.20'), env);
    expect(family.status).toBe(401);
  });

  it('keys by IPv4, by the IPv6 /64, and never by a shared literal', () => {
    const subject = (ip: string | null) => portalAnonymousSubjectV1(fromPeer(new Request(origin), ip));
    expect(subject('203.0.113.9')).toBe('ip4:203.0.113.9');
    expect(subject('2001:db8:1:2:aaaa::1')).toBe(subject('2001:0db8:0001:0002:bbbb:cccc:dddd:2'));
    expect(subject('2001:db8:1:2::')).toBe('ip6:2001:db8:1:2');
    expect(subject('2001:db8:1:3::1')).not.toBe(subject('2001:db8:1:2::1'));
    expect(subject('::ffff:192.0.2.1')).toBe('ip6:0:0:0:0');
    expect(subject('fe80::1')).toBe('ip6:fe80:0:0:0');
    expect(subject(null)).toBe('ip:unknown');
    expect(subject('203.0.113.9')).not.toBe('public');
  });
});
