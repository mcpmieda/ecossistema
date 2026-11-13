import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { servePortalSelfV1 } from '../../../server/student-portal/composition/self-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import { portalAuthBurstV1 } from '../../../server/student-portal/observability/auth-burst-v1';
import { portalAnonymousSubjectV1 } from '../../../server/student-portal/observability/operation-burst-v1';
import { portalAnonymousPeerV1 } from '../../../server/student-portal/observability/anonymous-peer-v1';

const database = vi.hoisted(() => vi.fn());
vi.mock('../../../server/student-portal/composition/database-v1', () => ({ portalDatabaseV1: database }));

const origin = 'https://aluno.escolaieda.com';
const key = JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64') });
const allowAll = () => ({ limit: vi.fn().mockResolvedValue({ success: true }) });
/** A budget of `max` per key, like one Cloudflare location. */
function counting(max: number) {
  const used = new Map<string, number>();
  return { used, limit: vi.fn(async ({ key: limitKey }: { key: string }) => {
    const count = (used.get(limitKey) ?? 0) + 1;
    used.set(limitKey, count);
    return { success: count <= max };
  }) };
}
function portalEnv(overrides: Record<string, unknown> = {}) {
  return { PORTAL_ENVIRONMENT: 'production', PORTAL_ORIGIN: origin, PORTAL_SERVING_ENABLED: 'true',
    PORTAL_ADMIN_TENANT_ID: '50000000-0000-4000-8000-000000000001', PASSWORD_PEPPER: key, QR_HMAC_KEYS: key,
    TURNSTILE_SECRET_KEY: 'synthetic', PORTAL_PUBLICATION_MODE: 'scoped-v2', PORTAL_AUTH_GLOBAL: allowAll(),
    PORTAL_AUTH_SUBJECT: allowAll(), PORTAL_READ_ACCOUNT: allowAll(), ...overrides,
  } as unknown as Parameters<typeof servePortalSelfV1>[1];
}
const qr = (credential: string) => `${origin}/access#v1.${credential.padEnd(32, 'a')}.1.${'s'.repeat(43)}`;
function challenge(credential: string, ip: string | null, cf = true) {
  const request = new Request(origin + '/api/student/auth/challenge', { method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ contractVersion: 1, qr: qr(credential) }) });
  if (ip !== null) request.headers.set('cf-connecting-ip', ip);
  if (cf) Object.defineProperty(request, 'cf', { value: { colo: 'GRU' } });
  return request;
}

afterEach(() => { vi.restoreAllMocks(); database.mockReset(); });

describe('A9: a valid QR repeated from one client never blocks the other families', () => {
  it('spends only that client\'s budget, before and after the QR limit', async () => {
    vi.spyOn(PortalCryptoV1.prototype, 'verifyQr').mockResolvedValue(true);
    database.mockRejectedValue(new Error('synthetic-database-stop'));
    const global = counting(5);
    const env = portalEnv({ PORTAL_AUTH_GLOBAL: global, PORTAL_AUTH_SUBJECT: counting(1000) });
    const attacker: number[] = [];
    for (let index = 0; index < 8; index += 1)
      attacker.push((await servePortalSelfV1(challenge('stolen', '203.0.113.9'), env)).status);
    expect(attacker.at(-1)).toBe(429);
    const family = await servePortalSelfV1(challenge('family', '198.51.100.20'), env);
    expect(family.status).not.toBe(429);
    expect([...global.used.keys()]).not.toContain('student-portal-auth-v1');
  });

  it('still limits one QR at 30 per minute across many addresses', async () => {
    vi.spyOn(PortalCryptoV1.prototype, 'verifyQr').mockResolvedValue(true);
    database.mockRejectedValue(new Error('synthetic-database-stop'));
    const env = portalEnv({ PORTAL_AUTH_SUBJECT: counting(30) });
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1)
      statuses.push((await servePortalSelfV1(challenge('photo', `192.0.2.${index + 1}`), env)).status);
    expect(statuses.slice(0, 30)).not.toContain(429);
    expect(statuses[30]).toBe(429);
  });

  it('keys the guard by the network subject when one is given', async () => {
    const global = counting(1);
    const guard = portalAuthBurstV1(global, allowAll(), () => undefined);
    expect(await guard('qr:1:a', 'ip4:203.0.113.9')).toBe(true);
    expect(await guard('qr:1:b', 'ip4:203.0.113.9')).toBe(false);
    expect(await guard('qr:1:c', 'ip4:198.51.100.20')).toBe(true);
    expect(await guard('qr:1:d', '')).toBe(false);
    expect([...global.used.keys()].every((limitKey) => /^[a-f0-9]{64}$/u.test(limitKey))).toBe(true);
  });
});

describe('A9: a request without a peer address never shares the families\' namespace', () => {
  it('uses the header when request.cf did not survive the service binding', () => {
    const log = vi.fn();
    const peer = portalAnonymousPeerV1({ PORTAL_AUTH_GLOBAL: allowAll() }, challenge('x', '203.0.113.9', false), log);
    expect(peer.subject).toBe('ip4:203.0.113.9');
    expect(log).toHaveBeenCalledExactlyOnceWith({ event: 'student-portal-anonymous-peer-v1', source: 'header' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('203.0.113');
  });

  it('sends a peer with no address to its own budget and logs it', async () => {
    const families = allowAll();
    const unknown = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const log = vi.fn();
    const env = { PORTAL_AUTH_GLOBAL: families, PORTAL_UNKNOWN_PEER: unknown };
    const peer = portalAnonymousPeerV1(env, challenge('x', null, false), log);
    expect(peer.binding).toBe(unknown);
    expect(log).toHaveBeenCalledWith({ event: 'student-portal-anonymous-peer-v1', source: 'unknown' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noAddress = await servePortalSelfV1(new Request(origin + '/api/student/me', { headers: { origin,
      cookie: '__Host-student_portal_session=' + 'a'.repeat(43) } }), portalEnv(env));
    expect(noAddress.status).toBe(429);
    expect(families.limit).not.toHaveBeenCalled();
    const proven = portalAnonymousPeerV1(env, challenge('x', '198.51.100.20'), log);
    expect(proven.binding).toBe(families);
  });

  it('keys an IPv4-mapped IPv6 peer by its IPv4, not one shared /64', () => {
    const subject = (ip: string) => portalAnonymousSubjectV1(challenge('x', ip));
    expect(subject('::ffff:192.0.2.1')).toBe('ip4:192.0.2.1');
    expect(subject('::ffff:192.0.2.1')).not.toBe(subject('::ffff:192.0.2.2'));
  });

  it('declares the higher, separate production namespace', () => {
    const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
    const bindings: { name: string; simple: { limit: number } }[] = config.env.production.ratelimits;
    const limit = (name: string) => bindings.find((binding) => binding.name === name)?.simple.limit ?? 0;
    expect(limit('PORTAL_UNKNOWN_PEER')).toBeGreaterThan(limit('PORTAL_AUTH_GLOBAL'));
  });
});
