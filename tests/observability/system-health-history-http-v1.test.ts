// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { handleSystemHealthRequestV1 } from '../../server/platform/system-health-http-v1';
import { requireAuth, AuthenticationError, SESSION_COOKIE } from '../../server/auth/session';
import type { RuntimeEnv } from '../../server/env';
import { historyFixtureV1, historyPointV1 } from './history-fixtures-v1';
vi.mock('../../server/auth/session', () => ({
  SESSION_COOKIE: '__Host-ecossistema-session',
  requireAuth: vi.fn(),
  AuthenticationError: class extends Error {},
}));
const origin = 'http://localhost:8788';
const actor = '11111111-1111-4111-8111-111111111111';
const tenant = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const monitoringHistory = vi.fn<() => Promise<unknown>>(async () => historyFixtureV1());
  const monitoring = vi.fn();
  const env = {
    OFFICIAL_ORIGIN: origin,
    RUNTIME_ENVIRONMENT: 'local',
    TENANT_ID: tenant,
    PORTAL_SERVICE: { monitoring, monitoringHistory },
  } as unknown as RuntimeEnv;
  return { env, monitoring, monitoringHistory };
}
function request(body = '{"before":null}', headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/platform/system-health/history`, {
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
  vi.mocked(requireAuth).mockResolvedValue({
    oid: actor,
    roles: ['ADMINISTRADOR'],
    exp: Math.floor(Date.now() / 1000) + 60,
  } as Awaited<ReturnType<typeof requireAuth>>);
});
it('uses a separate RPC, no-store and server authority on every page', async () => {
  const { env, monitoring, monitoringHistory } = fixture();
  const response = await handleSystemHealthRequestV1(request(), env);
  expect(response?.status).toBe(200);
  expect(response?.headers.get('cache-control')).toContain('no-store');
  expect(await response!.json()).toEqual(historyFixtureV1());
  await handleSystemHealthRequestV1(
    request(JSON.stringify({ before: historyPointV1().bucketAt })),
    env,
  );
  expect(requireAuth).toHaveBeenCalledTimes(2);
  expect(monitoringHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actorId: actor,
      tenantId: tenant,
      capability: 'platform.settings.read',
    }),
    historyPointV1().bucketAt,
  );
  expect(monitoring).not.toHaveBeenCalled();
});
it.each(['PROFESSOR', 'ALUNO'])('refuses %s before reading history', async (role) => {
  const { env, monitoringHistory } = fixture();
  vi.mocked(requireAuth).mockResolvedValue({ oid: actor, roles: [role] } as Awaited<
    ReturnType<typeof requireAuth>
  >);
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(403);
  expect(monitoringHistory).not.toHaveBeenCalled();
});
it('refuses authentication loss and expired sessions before reading history', async () => {
  const { env, monitoringHistory } = fixture();
  vi.mocked(requireAuth).mockRejectedValue(new AuthenticationError());
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(401);
  vi.mocked(requireAuth).mockResolvedValue({
    oid: actor,
    roles: ['ADMINISTRADOR'],
    exp: 1,
  } as Awaited<ReturnType<typeof requireAuth>>);
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(401);
  expect(monitoringHistory).not.toHaveBeenCalled();
});
it.each([
  '{}',
  'null',
  '[]',
  '{"before":"invalid"}',
  '{"before":null,"name":"synthetic"}',
  ' '.repeat(129) + '{"before":null}',
])('rejects invalid or excessive bodies', async (body) => {
  const { env, monitoringHistory } = fixture();
  expect((await handleSystemHealthRequestV1(request(body), env))?.status).toBe(400);
  expect(monitoringHistory).not.toHaveBeenCalled();
});
const invalidHeaders: Record<string, string>[] = [
  { Origin: 'https://untrusted.invalid' },
  { Cookie: '' },
  { Cookie: `${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b` },
  { 'x-forwarded-host': 'untrusted.invalid' },
];
it.each(invalidHeaders)('preserves the origin and cookie boundary', async (headers) => {
  const { env, monitoringHistory } = fixture();
  expect(
    (await handleSystemHealthRequestV1(request(undefined, headers), env))?.status,
  ).toBeGreaterThanOrEqual(400);
  expect(monitoringHistory).not.toHaveBeenCalled();
});
it('keeps an older backend unconfigured and does not echo malformed responses', async () => {
  const { env, monitoringHistory } = fixture();
  monitoringHistory.mockResolvedValue({ ...historyFixtureV1(), token: 'synthetic-private' });
  const rejected = await handleSystemHealthRequestV1(request(), env);
  expect(rejected?.status).toBe(503);
  expect(await rejected!.text()).not.toContain('synthetic-private');
  env.PORTAL_SERVICE = {} as RuntimeEnv['PORTAL_SERVICE'];
  const missing = await handleSystemHealthRequestV1(request(), env);
  expect(await missing!.json()).toMatchObject({
    state: 'unconfigured',
    points: [],
    nextBefore: null,
  });
});
