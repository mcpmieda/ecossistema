import { afterEach, describe, expect, it, vi } from 'vitest';
import { servePortalAdminV1 } from '../../../server/student-portal/http/admin/handler-v1';
import { seal } from '../../../server/auth/sealed';
import { createApplicationSession, SESSION_COOKIE } from '../../../server/auth/session';
import type { RuntimeEnv } from '../../../server/env';
import type { PortalAdminEntrypointV1, PortalAdminServiceBindingV1, TrustedAdminContextV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { Role } from '../../../server/auth/roles';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://admin.escolaieda.com';
const env = { SESSION_SECRET: 'synthetic-sealed-adm-session-713-'.repeat(3), TENANT_ID: TENANT,
  RUNTIME_ENVIRONMENT: 'production', OFFICIAL_ORIGIN: ORIGIN } as unknown as RuntimeEnv;
const query = { contractVersion: 1, operation: 'health', scope: { kind: 'school', academicYear: 2026 }, page: {} };
const command = { contractVersion: 1, operation: 'block', accountId: ACTOR, expectedVersion: 1, idempotencyKey: TENANT, blocked: true, confirmed: true };
async function cookie(roles: Role[] = ['ADMINISTRADOR'], expired = false) {
  const session = createApplicationSession({ oid: ACTOR, name: 'SYNTHETIC ADMIN', roles }, 12, Math.floor(Date.now() / 1000) - 3600);
  return `${SESSION_COOKIE}=${await seal({ ...session, ...(expired ? { exp: Math.floor(Date.now() / 1000) - 1 } : {}) }, env.SESSION_SECRET)}`;
}
async function request(body: unknown = query, extra: RequestInit = {}, path = 'query') {
  const headers = new Headers({ 'content-type': 'application/json', origin: ORIGIN, cookie: await cookie() });
  new Headers(extra.headers).forEach((value, key) => headers.set(key, value));
  return new Request(`${ORIGIN}/api/student-portal/admin/${path}`, { method: 'POST', body: JSON.stringify(body), ...extra, headers });
}
function binding() {
  const seen: TrustedAdminContextV1[] = [];
  const rpc: PortalAdminEntrypointV1 = {
    async query(context) { seen.push(context); return { contractVersion: 1, requestId: context.requestId, state: 'health', status: 'normal' }; },
    async command(context) { seen.push(context); return { contractVersion: 1, requestId: context.requestId, state: 'committed', operationId: TENANT, version: 2 }; },
  };
  return { rpc, seen };
}
afterEach(() => { vi.useRealTimers(); });

describe('ADM Pages to private Portal binding', () => {

  it('passes opt-in V2 reads through sealed ADM authentication and validates their own envelope', async () => {
    const input = { ...query, contractVersion: 2, operation: 'accounts-read' };
    const rpc: PortalAdminEntrypointV1 = {
      ...binding().rpc,
      async query(context) { return { contractVersion: 2, requestId: context.requestId,
        observedAt: new Date().toISOString(), state: 'accounts-read', scopeVersion: 0,
        items: [], nextCursor: null, lastAuthenticationWindowMonths: 12 }; },
    };
    const response = await servePortalAdminV1(await request(input), env, rpc);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contractVersion: 2, state: 'accounts-read' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await servePortalAdminV1(await request(input, { headers: { cookie: '' } }), env, rpc)).status).toBe(401);
    expect((await servePortalAdminV1(await request(input, { headers: { cookie: await cookie(['PROFESSOR']) } }), env, rpc)).status).toBe(403);
    expect((await servePortalAdminV1(await request(input, { headers: { origin: 'https://attacker.invalid' } }), env, rpc)).status).toBe(403);
    expect((await servePortalAdminV1(await request(input), env, binding().rpc)).status).toBe(503);
    expect((await servePortalAdminV1(await request(query), env, rpc)).status).toBe(503);
  });

  it('verifies the existing sealed session and produces fresh context rather than accepting browser identity', async () => {
    const { rpc, seen } = binding();
    const response = await servePortalAdminV1(await request(query, { headers: { 'x-portal-actor': TENANT, 'x-portal-actor-name': 'SYNTHETIC SPOOFED', 'x-portal-capability': 'platform.settings.write' } }), env, rpc);
    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({ actorId: ACTOR, actorName: 'SYNTHETIC ADMIN', tenantId: TENANT, capability: 'platform.settings.read' });
    expect(Date.now() - Date.parse(seen[0]!.authenticatedAt)).toBeLessThan(5000);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('set-cookie')).toBeNull();
    const result = await servePortalAdminV1(await request(command, {}, 'command'), env, rpc);
    expect(result.status).toBe(200);
    expect(seen[1]!.capability).toBe('platform.settings.write');
    expect((await servePortalAdminV1(await request({ ...command, actorId: TENANT }, {}, 'command'), env, rpc)).status).toBe(400);
    expect(seen).toHaveLength(2);
  });

  it('elevates the destructive bulk preview to the write capability it is authorized under', async () => {
    const preview = { contractVersion: 1, operation: 'bulk-preview', scope: { kind: 'class', academicYear: 2026, classId: 910001 }, page: { limit: 100 }, action: 'qr-regenerate' };
    const seen: TrustedAdminContextV1[] = [];
    const rpc: PortalAdminEntrypointV1 = {
      ...binding().rpc,
      async query(context) { seen.push(context); return { contractVersion: 1, requestId: context.requestId, state: 'forbidden' } as never; },
    };
    await servePortalAdminV1(await request(preview), env, rpc);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.capability).toBe('platform.settings.write');
    expect((await servePortalAdminV1(await request(preview, { headers: { cookie: await cookie(['PROFESSOR']) } }), env, rpc)).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it('rejects absent, invalid, expired or duplicated session cookies and roles without the capability', async () => {
    const { rpc, seen } = binding();
    const valid = await cookie();
    for (const value of ['', `${SESSION_COOKIE}=forged`, await cookie(['ADMINISTRADOR'], true), `${valid}; ${valid}`])
      expect((await servePortalAdminV1(await request(query, { headers: { cookie: value } }), env, rpc)).status).toBe(401);
    for (const role of ['PROFESSOR', 'ALUNO', 'APOIO', 'VISITANTE'] as Role[])
      expect((await servePortalAdminV1(await request(query, { headers: { cookie: await cookie([role]) } }), env, rpc)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('rechecks expiration after reading the body before allowing the private RPC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Math.floor(Date.now() / 1000) * 1000;
    vi.setSystemTime(start);
    const token = await seal({ oid: ACTOR, name: 'SYNTHETIC ADMIN', roles: ['ADMINISTRADOR'], exp: start / 1000 + 1 }, env.SESSION_SECRET);
    class ExpiringRequest extends Request {
      override get body() { vi.setSystemTime(start + 2000); return super.body; }
    }
    const input = new ExpiringRequest(`${ORIGIN}/api/student-portal/admin/query`, { method: 'POST', body: JSON.stringify(query),
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `${SESSION_COOKIE}=${token}` } });
    const { rpc, seen } = binding();
    expect((await servePortalAdminV1(input, env, rpc)).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('rejects cross-origin, spoofed Host, query strings, forwarding claims and preview before invoking RPC', async () => {
    const { rpc, seen } = binding();
    const invalidHeaders: Record<string, string>[] = [{ origin: 'https://attacker.invalid' }, { origin: 'null' }, { origin: '' }, { host: 'attacker.invalid' },
      { 'x-forwarded-host': 'attacker.invalid' }, { 'x-original-url': '/api/student-portal/admin/command' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of invalidHeaders)
      expect((await servePortalAdminV1(await request(query, { headers }), env, rpc)).status).toBe(403);
    const base = await request();
    expect((await servePortalAdminV1(new Request(`${base.url}?accountId=${TENANT}`, base), env, rpc)).status).toBe(403);
    expect((await servePortalAdminV1(await request(), { ...env, RUNTIME_ENVIRONMENT: 'preview' }, rpc)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('bounds declared and streamed bodies and rejects malformed schema, methods, media and batch limits', async () => {
    const { rpc, seen } = binding();
    expect((await servePortalAdminV1(await request(query, { headers: { 'content-length': '65537' } }), env, rpc)).status).toBe(413);
    expect((await servePortalAdminV1(await request(query, { body: ' '.repeat(65537) }), env, rpc)).status).toBe(413);
    expect((await servePortalAdminV1(await request(query, { body: '{broken' }), env, rpc)).status).toBe(400);
    expect((await servePortalAdminV1(await request(query, { headers: { 'content-type': 'text/plain' } }), env, rpc)).status).toBe(400);
    expect((await servePortalAdminV1(await request(query, { method: 'GET', body: undefined }), env, rpc)).status).toBe(400);
    expect((await servePortalAdminV1(await request({ ...query, page: { limit: 101 } }), env, rpc)).status).toBe(400);
    expect((await servePortalAdminV1(await request({ ...query, role: 'ADMINISTRADOR' }), env, rpc)).status).toBe(400);
    const many = { ...command, operation: 'qr-batch', classId: 1, accountIds: Array.from({ length: 101 }, () => crypto.randomUUID()) };
    delete (many as Partial<typeof command>).accountId;
    delete (many as Partial<typeof command>).blocked;
    expect((await servePortalAdminV1(await request(many, {}, 'command'), env, rpc)).status).toBe(400);
    expect((await servePortalAdminV1(await request(query, {}, 'unknown'), env, rpc)).status).toBe(404);
    expect(seen).toHaveLength(0);
    const exact = JSON.stringify(query).padEnd(65536, ' ');
    expect((await servePortalAdminV1(await request(query, { body: exact }), env, rpc)).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('validates response kind, correlation and allowlist, and never serializes provider errors', async () => {
    for (const unsafe of [
      (id: string) => ({ contractVersion: 1, requestId: id, state: 'accounts', scopeVersion: 0, items: [], nextCursor: null }),
      () => ({ contractVersion: 1, requestId: ACTOR, state: 'health', status: 'normal' }),
      (id: string) => ({ contractVersion: 1, requestId: id, state: 'health', status: 'normal', verifier: 'private-provider-secret' }),
    ]) {
      const rpc = { query: async (context: TrustedAdminContextV1) => unsafe(context.requestId) } as unknown as PortalAdminEntrypointV1;
      const response = await servePortalAdminV1(await request(), env, rpc);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private-provider-secret');
    }
    const down = { query: async () => { throw new Error('private-provider-error'); } } as unknown as PortalAdminEntrypointV1;
    const response = await servePortalAdminV1(await request(), env, down);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-provider-error');
  });
});
