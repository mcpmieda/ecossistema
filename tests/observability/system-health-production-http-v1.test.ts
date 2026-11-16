// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seal } from '../../server/auth/sealed';
import { createApplicationSession, SESSION_COOKIE } from '../../server/auth/session';
import type { Role } from '../../server/auth/roles';
import { validateEnv, type RuntimeEnv } from '../../server/env';
import { handleSystemHealthRequestV1 } from '../../server/platform/system-health-http-v1';
import type { PortalMonitorSampleV1 } from '../../shared/system-health-v1';
import type { TrustedAdminContextV1 } from '../../shared/student-portal-contracts/ports-v1';

const actor = '11111111-1111-4111-8111-111111111111';
const origin = 'https://admin.escolaieda.com';
const secret = 'synthetic-system-health-session-969-'.repeat(3);

function environment(tenant: string = crypto.randomUUID(), overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return validateEnv({
    RUNTIME_ENVIRONMENT: 'production', OFFICIAL_ORIGIN: origin, TENANT_ID: tenant,
    WEB_CLIENT_ID: actor, GRAPH_CLIENT_ID: actor, SHAREPOINT_SITE_ID: 'synthetic-site-for-health-969',
    GROUP_ADMIN_ID: actor, GROUP_PROFESSOR_ID: actor, GROUP_ALUNO_ID: actor,
    GROUP_APOIO_ID: actor, GROUP_VISITANTE_ID: actor, SESSION_SECRET: secret, ...overrides,
  } as RuntimeEnv);
}
async function cookie(roles: Role[] = ['ADMINISTRADOR'], expiresAt?: number): Promise<string> {
  const session = createApplicationSession({ oid: actor, name: 'SYNTHETIC HEALTH ADMIN', roles });
  return `${SESSION_COOKIE}=${await seal({ ...session, ...(expiresAt === undefined ? {} : { exp: expiresAt }) }, secret, 'admin-session')}`;
}
function request(sessionCookie: string, atOrigin = origin, body = '{}'): Request {
  return new Request(`${atOrigin}/api/platform/system-health`, { method: 'POST', body,
    headers: { origin: atOrigin, 'content-type': 'application/json', cookie: sessionCookie,
      'sec-fetch-site': 'same-origin' } });
}
function sample(): PortalMonitorSampleV1 {
  return { schemaVersion: 1, observedAt: new Date().toISOString(), servingEnabled: true,
    credentialsConfigured: true, database: 'ok', readDurationMs: 1, maintenance: {
      status: 'normal', liveOutboxAvailable: true, expiredIp: 0, expiredAudit: 0,
      backlog: false, exhausted: false, publicationDue: 0, oldestPublicationDueMs: 0,
      liveBacklog: false, livePending: 0, liveRetrying: 0, oldestLiveDueMs: 0,
      waitingConnections: 0, oldestWaitingQueryMs: 0,
    } };
}
function publicEntry() {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('production system-health endpoint with real sealed sessions', () => {
  it('authenticates the administrator and passes only server-derived context to the private binding', async () => {
    const monitoring = vi.fn<(context: TrustedAdminContextV1) => Promise<PortalMonitorSampleV1>>()
      .mockImplementation(async () => sample());
    const env = environment(undefined, { PORTAL_SERVICE: { monitoring } });
    const fetcher = publicEntry();
    const sessionCookie = await cookie();
    const response = await handleSystemHealthRequestV1(request(sessionCookie), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toContain('no-store');
    const payload = await response!.json();
    expect(payload).toMatchObject({ portalReadState: 'ok', portal: { database: 'ok' }, publicEntry: { outcome: 'ok' } });
    expect(monitoring).toHaveBeenCalledWith({ actorId: actor, tenantId: env.TENANT_ID,
      requestId: expect.any(String), authenticatedAt: expect.any(String), capability: 'platform.settings.read' });
    expect(fetcher).toHaveBeenCalledWith('https://aluno.escolaieda.com/', expect.objectContaining({
      method: 'HEAD', credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal),
    }));
    const probeHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers);
    expect(probeHeaders.has('cookie')).toBe(false);
    expect(probeHeaders.has('authorization')).toBe(false);
    const encoded = JSON.stringify(payload);
    for (const privateValue of [actor, env.TENANT_ID, secret, sessionCookie, 'SYNTHETIC HEALTH ADMIN'])
      expect(encoded).not.toContain(privateValue);
    await handleSystemHealthRequestV1(request(sessionCookie), validateEnv({ ...env }));
    expect(monitoring).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('deduplicates absent-binding reads across newly parsed environments and expires the cached sample', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = Date.now();
    const firstEnv = environment();
    const secondEnv = validateEnv({ ...firstEnv });
    expect(secondEnv).not.toBe(firstEnv);
    const fetcher = publicEntry();
    const sessionCookie = await cookie();
    const responses = await Promise.all([
      handleSystemHealthRequestV1(request(sessionCookie), firstEnv),
      handleSystemHealthRequestV1(request(sessionCookie), secondEnv),
    ]);
    const payloads = await Promise.all(responses.map((response) => response!.json()));
    expect(payloads[0]).toMatchObject({ portalReadState: 'unconfigured', portal: null, publicEntry: { outcome: 'ok' } });
    expect(payloads[1]).toEqual(payloads[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(started + 29_999);
    const cached = await handleSystemHealthRequestV1(request(sessionCookie), validateEnv({ ...firstEnv }));
    expect(await cached!.json()).toEqual(payloads[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(started + 30_000);
    await handleSystemHealthRequestV1(request(sessionCookie), validateEnv({ ...firstEnv }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps missing-binding cache partitions isolated by tenant and local origin/environment', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = Date.now();
    const firstEnv = environment();
    const fetcher = publicEntry();
    const sessionCookie = await cookie();
    await handleSystemHealthRequestV1(request(sessionCookie), firstEnv);
    await handleSystemHealthRequestV1(request(sessionCookie), environment());
    expect(fetcher).toHaveBeenCalledTimes(2);
    const localOrigin = 'http://localhost:8788';
    const localEnv = environment(firstEnv.TENANT_ID, { RUNTIME_ENVIRONMENT: 'local', OFFICIAL_ORIGIN: localOrigin });
    const local = await handleSystemHealthRequestV1(request(sessionCookie, localOrigin), localEnv);
    expect(await local!.json()).toMatchObject({ publicEntry: { outcome: 'not-probed' }, generatedAt: new Date(started).toISOString() });
    vi.setSystemTime(started + 1_000);
    const otherOrigin = 'http://127.0.0.1:8788';
    const otherEnv = environment(firstEnv.TENANT_ID, { RUNTIME_ENVIRONMENT: 'local', OFFICIAL_ORIGIN: otherOrigin });
    const other = await handleSystemHealthRequestV1(request(sessionCookie, otherOrigin), otherEnv);
    expect(await other!.json()).toMatchObject({ publicEntry: { outcome: 'not-probed' }, generatedAt: new Date(started + 1_000).toISOString() });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('denies invalid, expired, duplicate and unauthorized sessions before reading or serving the cache', async () => {
    const env = environment();
    const fetcher = publicEntry();
    const sessionCookie = await cookie();
    const denied = [
      ['', 401], [`${SESSION_COOKIE}=tampered`, 401],
      [await cookie(['ADMINISTRADOR'], Math.floor(Date.now() / 1000) - 1), 401],
      [`${sessionCookie}; ${sessionCookie}`, 401], [await cookie(['PROFESSOR']), 403],
    ] as const;
    for (const warm of [false, true]) {
      if (warm) expect((await handleSystemHealthRequestV1(request(sessionCookie), env))?.status).toBe(200);
      for (const [value, status] of denied) {
        const response = await handleSystemHealthRequestV1(request(value), validateEnv({ ...env }));
        expect(response?.status).toBe(status);
        expect(await response!.json()).toEqual({ state: status === 401 ? 'unauthenticated' : 'forbidden' });
      }
      expect(fetcher).toHaveBeenCalledTimes(warm ? 1 : 0);
    }
  });

  it('rechecks session expiration after a delayed body read before consulting a source or cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = Math.floor(Date.now() / 1000) * 1000;
    vi.setSystemTime(started);
    const env = environment();
    const fetcher = publicEntry();
    const sessionCookie = await cookie(['ADMINISTRADOR'], started / 1000 + 1);
    class ExpiringRequest extends Request {
      override get body() { vi.setSystemTime(started + 2_000); return super.body; }
    }
    const delayed = new ExpiringRequest(request(sessionCookie));
    const response = await handleSystemHealthRequestV1(delayed, env);
    expect(response?.status).toBe(401);
    expect(await response!.json()).toEqual({ state: 'unauthenticated' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized input and private extra fields without forwarding them or making public probes', async () => {
    const env = environment();
    const fetcher = publicEntry();
    const sessionCookie = await cookie();
    for (const body of [' '.repeat(65) + '{}', '{"token":"SYNTHETIC-PRIVATE-MARKER"}']) {
      const response = await handleSystemHealthRequestV1(request(sessionCookie, origin, body), env);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toEqual({ state: 'invalid-request' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
