// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { handleSystemHealthRequestV1 } from '../../server/platform/system-health-http-v1';
import { requireAuth, AuthenticationError, SESSION_COOKIE } from '../../server/auth/session';
import { CAPACITY_ROUTE_V1, emptyPortalCapacityV1 } from '../../shared/portal-capacity-v1';
import type { RuntimeEnv } from '../../server/env';
vi.mock('../../server/auth/session', () => ({
  SESSION_COOKIE: '__Host-ecossistema-session',
  requireAuth: vi.fn(),
  AuthenticationError: class extends Error {},
}));
const origin = 'http://localhost:8788';
const auth = (roles = ['ADMINISTRADOR']) =>
  ({ oid: '10950000-0000-4000-8000-000000000002', roles, exp: 9999999999 }) as Awaited<
    ReturnType<typeof requireAuth>
  >;
function fixture() {
  const monitoringCapacity = vi.fn<() => Promise<unknown>>(async () =>
    emptyPortalCapacityV1('unavailable'),
  );
  const env = {
    RUNTIME_ENVIRONMENT: 'local',
    OFFICIAL_ORIGIN: origin,
    TENANT_ID: '10950000-0000-4000-8000-000000000001',
    PORTAL_SERVICE: { monitoringCapacity },
  } as unknown as RuntimeEnv;
  return { env, monitoringCapacity };
}
function request(body = '{}', headers: Record<string, string> = {}, path = CAPACITY_ROUTE_V1) {
  return new Request(origin + path, {
    method: 'POST',
    body,
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      Cookie: `${SESSION_COOKIE}=synthetic`,
      ...headers,
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(auth());
});
it('authorizes before every RPC and returns only the bounded contract with no-store headers', async () => {
  const { env, monitoringCapacity } = fixture();
  const response = await handleSystemHealthRequestV1(request(), env);
  expect(response?.status).toBe(200);
  expect(response?.headers.get('cache-control')).toContain('no-store');
  expect(await response!.json()).toMatchObject({ state: 'unavailable', metrics: null });
  expect(monitoringCapacity).toHaveBeenCalledWith(
    expect.objectContaining({
      actorId: auth().oid,
      capability: 'platform.settings.read',
      tenantId: env.TENANT_ID,
    }),
  );
  vi.mocked(requireAuth).mockResolvedValue(auth(['PROFESSOR']));
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(403);
  expect(monitoringCapacity).toHaveBeenCalledTimes(1);
  vi.mocked(requireAuth).mockRejectedValue(new AuthenticationError());
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(401);
  expect(monitoringCapacity).toHaveBeenCalledTimes(1);
});
it.each(['null', '[]', '{"before":null}', '{"role":"admin"}', ' '.repeat(65)])(
  'rejects invalid request body %s before reading',
  async (body) => {
    const { env, monitoringCapacity } = fixture();
    expect((await handleSystemHealthRequestV1(request(body), env))?.status).toBe(400);
    expect(monitoringCapacity).not.toHaveBeenCalled();
  },
);
const untrustedHeaders: Record<string, string>[] = [
  { Origin: 'https://untrusted.invalid' },
  { 'Sec-Fetch-Site': 'cross-site' },
  { 'x-forwarded-host': 'untrusted.invalid' },
  { Cookie: '' },
  { Cookie: `${SESSION_COOKIE}=one; ${SESSION_COOKIE}=two` },
];
it.each(untrustedHeaders)('rejects untrusted origins and ambiguous cookies', async (headers) => {
  const { env, monitoringCapacity } = fixture();
  expect([401, 403]).toContain(
    (await handleSystemHealthRequestV1(request('{}', headers), env))?.status,
  );
  expect(monitoringCapacity).not.toHaveBeenCalled();
});
it('preserves older backends and refuses invalid or private RPC responses', async () => {
  const { env, monitoringCapacity } = fixture();
  monitoringCapacity.mockResolvedValue({
    ...emptyPortalCapacityV1('unavailable'),
    raw: 'SYNTHETIC-PRIVATE',
  });
  const invalid = await handleSystemHealthRequestV1(request(), env);
  expect(invalid?.status).toBe(503);
  expect(await invalid!.text()).not.toContain('PRIVATE');
  monitoringCapacity.mockRejectedValue(Error('SYNTHETIC-TOKEN'));
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(503);
  env.PORTAL_SERVICE = {} as RuntimeEnv['PORTAL_SERVICE'];
  expect(await (await handleSystemHealthRequestV1(request(), env))!.json()).toMatchObject({
    state: 'unconfigured',
    metrics: null,
  });
});
it('does not intercept unknown routes and rejects query parameters or an expired session', async () => {
  const { env, monitoringCapacity } = fixture();
  expect(
    await handleSystemHealthRequestV1(request('{}', {}, CAPACITY_ROUTE_V1 + '/extra'), env),
  ).toBeNull();
  expect(
    (
      await handleSystemHealthRequestV1(
        request('{}', {}, CAPACITY_ROUTE_V1 + '?source=private'),
        env,
      )
    )?.status,
  ).toBe(403);
  vi.mocked(requireAuth).mockResolvedValue({ ...auth(), exp: 1 });
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(401);
  expect(monitoringCapacity).not.toHaveBeenCalled();
});
