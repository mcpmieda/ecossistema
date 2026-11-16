// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSystemHealthRequestV1 } from '../../server/platform/system-health-http-v1';
import { requireAuth, AuthenticationError, SESSION_COOKIE } from '../../server/auth/session';
import type { RuntimeEnv } from '../../server/env';
import {
  isSystemHealthSnapshotV1,
  type PortalMonitorSampleV1,
} from '../../shared/system-health-v1';

vi.mock('../../server/auth/session', () => ({
  SESSION_COOKIE: '__Host-ecossistema-session',
  requireAuth: vi.fn(),
  AuthenticationError: class extends Error {
    readonly status = 401;
  },
}));
const actor = '11111111-1111-4111-8111-111111111111';
const tenant = '22222222-2222-4222-8222-222222222222';
const origin = 'http://localhost:8788';
function sample(): PortalMonitorSampleV1 {
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    servingEnabled: true,
    credentialsConfigured: true,
    database: 'ok',
    readDurationMs: 1,
    maintenance: {
      status: 'normal',
      liveOutboxAvailable: true,
      expiredIp: 0,
      expiredAudit: 0,
      backlog: false,
      exhausted: false,
      publicationDue: 0,
      oldestPublicationDueMs: 0,
      liveBacklog: false,
      livePending: 0,
      liveRetrying: 0,
      oldestLiveDueMs: 0,
      waitingConnections: 0,
      oldestWaitingQueryMs: 0,
    },
  };
}
function fixture() {
  const monitoring = vi.fn(async () => sample());
  const env = {
    OFFICIAL_ORIGIN: origin,
    RUNTIME_ENVIRONMENT: 'local',
    TENANT_ID: tenant,
    PORTAL_SERVICE: { monitoring },
  } as unknown as RuntimeEnv;
  return { env, monitoring };
}
function request(overrides: RequestInit = {}, suffix = '') {
  const headers = new Headers({
    Origin: origin,
    'Content-Type': 'application/json',
    Cookie: `${SESSION_COOKIE}=synthetic`,
  });
  new Headers(overrides.headers).forEach((value, name) => headers.set(name, value));
  return new Request(`${origin}/api/platform/system-health${suffix}`, {
    method: 'POST',
    body: '{}',
    ...overrides,
    headers,
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ oid: actor, roles: ['ADMINISTRADOR'] } as Awaited<
    ReturnType<typeof requireAuth>
  >);
});
describe('authenticated system-health HTTP boundary', () => {
  it('does not participate in unrelated routes', async () => {
    const { env, monitoring } = fixture();
    expect(
      await handleSystemHealthRequestV1(new Request(`${origin}/api/elsewhere`), env),
    ).toBeNull();
    expect(requireAuth).not.toHaveBeenCalled();
    expect(monitoring).not.toHaveBeenCalled();
  });
  it('authenticates every cache hit and builds private context on the server', async () => {
    const { env, monitoring } = fixture();
    const response = await handleSystemHealthRequestV1(request(), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toContain('no-store');
    expect(response?.headers.get('x-content-type-options')).toBe('nosniff');
    const payload = await response!.json();
    if (!isSystemHealthSnapshotV1(payload)) throw new Error('Invalid health response');
    expect(payload.portalReadState).toBe('ok');
    expect(payload.publicEntry.outcome).toBe('not-probed');
    expect(JSON.stringify(payload)).not.toContain(actor);
    expect(JSON.stringify(payload)).not.toContain(tenant);
    expect(monitoring).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: actor,
        tenantId: tenant,
        capability: 'platform.settings.read',
      }),
    );
    await handleSystemHealthRequestV1(request(), env);
    expect(requireAuth).toHaveBeenCalledTimes(2);
    expect(monitoring).toHaveBeenCalledTimes(1);
    vi.mocked(requireAuth).mockRejectedValue(new AuthenticationError());
    expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(401);
    expect(monitoring).toHaveBeenCalledTimes(1);
  });
  it('rejects role denial before querying or serving cached data', async () => {
    const { env, monitoring } = fixture();
    vi.mocked(requireAuth).mockResolvedValue({ oid: actor, roles: ['PROFESSOR'] } as Awaited<
      ReturnType<typeof requireAuth>
    >);
    const response = await handleSystemHealthRequestV1(request(), env);
    expect(response?.status).toBe(403);
    expect(monitoring).not.toHaveBeenCalled();
  });
  it.each(['', `${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b`])(
    'rejects missing or duplicate cookies',
    async (cookie) => {
      const { env, monitoring } = fixture();
      const response = await handleSystemHealthRequestV1(
        request({ headers: { Cookie: cookie } }),
        env,
      );
      expect(response?.status).toBe(401);
      expect(requireAuth).not.toHaveBeenCalled();
      expect(monitoring).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['Origin', 'https://untrusted.invalid'],
    ['x-forwarded-host', 'untrusted.invalid'],
    ['x-original-url', '/api/elsewhere'],
    ['Host', 'untrusted.invalid'],
    ['Sec-Fetch-Site', 'cross-site'],
  ])('rejects an untrusted request origin/host (%s)', async (name, value) => {
    const { env, monitoring } = fixture();
    expect(
      (await handleSystemHealthRequestV1(request({ headers: { [name]: value } }), env))?.status,
    ).toBe(403);
    expect(monitoring).not.toHaveBeenCalled();
  });
  it.each(['?url=https://untrusted.invalid', '#fragment'])(
    'rejects unapproved URL data',
    async (suffix) => {
      const { env, monitoring } = fixture();
      expect((await handleSystemHealthRequestV1(request({}, suffix), env))?.status).toBe(403);
      expect(monitoring).not.toHaveBeenCalled();
    },
  );
  it.each(['{"actorId":"untrusted"}', '[]', 'null', '"text"', 'x', ' '.repeat(65) + '{}'])(
    'rejects nonempty or invalid bounded bodies',
    async (body) => {
      const { env, monitoring } = fixture();
      expect((await handleSystemHealthRequestV1(request({ body }), env))?.status).toBe(400);
      expect(monitoring).not.toHaveBeenCalled();
    },
  );
  it('rejects unsupported media type and method', async () => {
    const { env, monitoring } = fixture();
    expect(
      (
        await handleSystemHealthRequestV1(
          request({ headers: { 'Content-Type': 'text/plain' } }),
          env,
        )
      )?.status,
    ).toBe(415);
    expect(
      (await handleSystemHealthRequestV1(request({ method: 'GET', body: null }), env))?.status,
    ).toBe(405);
    expect(monitoring).not.toHaveBeenCalled();
  });
  it('reports an older backend as unconfigured, never fabricates a success', async () => {
    const { env } = fixture();
    env.PORTAL_SERVICE = {} as RuntimeEnv['PORTAL_SERVICE'];
    const response = await handleSystemHealthRequestV1(request(), env);
    const payload = await response!.json();
    if (!isSystemHealthSnapshotV1(payload)) throw new Error('Invalid health response');
    expect(payload.portal).toBeNull();
    expect(payload.portalReadState).toBe('unconfigured');
  });
  it('refuses preview access', async () => {
    const { env, monitoring } = fixture();
    env.RUNTIME_ENVIRONMENT = 'preview';
    expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(403);
    expect(monitoring).not.toHaveBeenCalled();
  });
});
