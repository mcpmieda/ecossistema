// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { handleSystemHealthRequestV1 } from '../../server/platform/system-health-http-v1';
import { requireAuth, SESSION_COOKIE, AuthenticationError } from '../../server/auth/session';
import { readPublicProviderHealthV1 } from '../../server/platform/system-health-providers-v1';
import { buildHealthReviewV1, HEALTH_REVIEW_ROUTE_V1 } from '../../shared/health-review-v1';
import { PROVIDER_HEALTH_ROUTE_V1 } from '../../shared/public-provider-health-v1';
import type { RuntimeEnv } from '../../server/env';
vi.mock('../../server/auth/session', () => ({
  requireAuth: vi.fn(),
  SESSION_COOKIE: '__Host-ecossistema-session',
  AuthenticationError: class extends Error {},
}));
vi.mock('../../server/platform/system-health-providers-v1', () => ({
  readPublicProviderHealthV1: vi.fn(),
}));
const origin = 'http://localhost:8788';
const auth = (roles = ['ADMINISTRADOR']) =>
  ({ oid: '10970000-0000-4000-8000-000000000001', roles, exp: 9999999999 }) as Awaited<
    ReturnType<typeof requireAuth>
  >;
function fixture() {
  const monitoringReview = vi.fn<() => Promise<unknown>>(async () =>
    buildHealthReviewV1(new Date().toISOString(), [], []),
  );
  return {
    monitoringReview,
    env: {
      RUNTIME_ENVIRONMENT: 'local',
      OFFICIAL_ORIGIN: origin,
      TENANT_ID: '10970000-0000-4000-8000-000000000002',
      PORTAL_SERVICE: { monitoringReview },
    } as unknown as RuntimeEnv,
  };
}
const request = (route: string, body = '{}', headers: Record<string, string> = {}) =>
  new Request(origin + route, {
    method: 'POST',
    body,
    headers: {
      Origin: origin,
      Cookie: `${SESSION_COOKIE}=synthetic`,
      'Content-Type': 'application/json',
      ...headers,
    },
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(auth());
});
it.each([HEALTH_REVIEW_ROUTE_V1, PROVIDER_HEALTH_ROUTE_V1])(
  'guards %s before any RPC or external/cache read',
  async (route) => {
    const { env, monitoringReview } = fixture();
    vi.mocked(requireAuth).mockResolvedValue(auth(['PROFESSOR']));
    expect((await handleSystemHealthRequestV1(request(route), env))?.status).toBe(403);
    vi.mocked(requireAuth).mockRejectedValue(new AuthenticationError());
    expect((await handleSystemHealthRequestV1(request(route), env))?.status).toBe(401);
    expect(monitoringReview).not.toHaveBeenCalled();
    expect(readPublicProviderHealthV1).not.toHaveBeenCalled();
  },
);
it('accepts only an empty body and rejects untrusted request metadata before dispatch', async () => {
  const { env, monitoringReview } = fixture();
  const headers: Record<string, string>[] = [
    { Origin: 'https://untrusted.invalid' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'x-forwarded-host': 'untrusted.invalid' },
    { Cookie: `${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b` },
  ];
  for (const route of [HEALTH_REVIEW_ROUTE_V1, PROVIDER_HEALTH_ROUTE_V1]) {
    for (const body of [
      'null',
      '[]',
      '{"url":"https://untrusted.invalid"}',
      '{"days":30}',
      ' '.repeat(65),
    ])
      expect((await handleSystemHealthRequestV1(request(route, body), env))?.status).toBe(400);
    for (const h of headers)
      expect([401, 403]).toContain(
        (await handleSystemHealthRequestV1(request(route, '{}', h), env))?.status,
      );
    expect(
      (await handleSystemHealthRequestV1(request(route + '?before=private'), env))?.status,
    ).toBe(403);
  }
  expect(monitoringReview).not.toHaveBeenCalled();
  expect(readPublicProviderHealthV1).not.toHaveBeenCalled();
});
it('validates new responses, preserves backend-first rollout, and does not echo private errors', async () => {
  const { env, monitoringReview } = fixture();
  const good = await handleSystemHealthRequestV1(request(HEALTH_REVIEW_ROUTE_V1), env);
  expect(good?.status).toBe(200);
  expect(good?.headers.get('cache-control')).toContain('no-store');
  expect(await good!.json()).toMatchObject({ coverage: 'partial', state: 'ok' });
  monitoringReview.mockResolvedValue({ private: 'secret' });
  expect((await handleSystemHealthRequestV1(request(HEALTH_REVIEW_ROUTE_V1), env))?.status).toBe(
    503,
  );
  vi.mocked(readPublicProviderHealthV1).mockRejectedValue(Error('SYNTHETIC-PRIVATE'));
  const denied = await handleSystemHealthRequestV1(request(PROVIDER_HEALTH_ROUTE_V1), env);
  expect(denied?.status).toBe(503);
  expect(await denied!.text()).not.toContain('PRIVATE');
  env.PORTAL_SERVICE = {} as RuntimeEnv['PORTAL_SERVICE'];
  expect(
    await (await handleSystemHealthRequestV1(request(HEALTH_REVIEW_ROUTE_V1), env))!.json(),
  ).toMatchObject({ state: 'unconfigured' });
  expect(
    await handleSystemHealthRequestV1(request(HEALTH_REVIEW_ROUTE_V1 + '/extra'), env),
  ).toBeNull();
});
