// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import {
  serveObservedPortalSelfV1,
  serveStudentDiagnosticV1,
} from '../../server/student-portal/composition/observed-self-v1';
import { handleSystemHealthRequestV1 } from '../../server/platform/system-health-http-v1';
import { requireAuth, SESSION_COOKIE } from '../../server/auth/session';
import { emptyPortalSignalsV1 } from '../../shared/portal-signals-v1';
import { FRONTEND_DIAGNOSTIC_ROUTE_V1 } from '../../shared/frontend-diagnostic-v1';
import type { PortalCompositionEnvV1 } from '../../server/student-portal/composition/config-v1';
import type { RuntimeEnv } from '../../server/env';
vi.mock('../../server/auth/session', () => ({
  SESSION_COOKIE: '__Host-ecossistema-session',
  requireAuth: vi.fn(),
  AuthenticationError: class extends Error {},
}));
const origin = 'https://aluno.escolaieda.com';
const input = {
  version: 1,
  area: 'student-portal',
  category: 'render',
  release: 'SYNTHETIC-PRIVATE',
  correlationId: '11111111-1111-4111-8111-111111111111',
};
function fixture() {
  const recordOperationalSignal = vi.fn(async (_input: unknown) => true);
  const limit = vi.fn(async () => ({ success: true }));
  const get = vi.fn(() => ({ recordOperationalSignal })),
    idFromName = vi.fn(() => 'synthetic');
  const env = {
    PORTAL_ENVIRONMENT: 'production',
    PORTAL_ORIGIN: origin,
    PORTAL_LIVE: { get, idFromName },
    PORTAL_AUTH_GLOBAL: { limit },
  } as unknown as PortalCompositionEnvV1;
  return { env, recordOperationalSignal, limit, idFromName };
}
const diagnostic = (body = JSON.stringify(input), headers: Record<string, string> = {}) =>
  new Request(origin + FRONTEND_DIAGNOSTIC_ROUTE_V1, {
    method: 'POST',
    body,
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
  });
beforeEach(() => vi.resetAllMocks());
it('accepts only the enum into the existing admin coordinator, not identity/release/correlation', async () => {
  const { env, recordOperationalSignal, limit, idFromName } = fixture();
  expect((await serveStudentDiagnosticV1(diagnostic(), env)).status).toBe(204);
  expect(recordOperationalSignal).toHaveBeenCalledWith({
    source: 'browser-render',
    outcome: 'failed',
    elapsedMs: 0,
  });
  expect(JSON.stringify(recordOperationalSignal.mock.calls)).not.toContain('SYNTHETIC-PRIVATE');
  expect(limit).toHaveBeenCalledWith({ key: 'student-portal:frontend-diagnostic:v1' });
  expect(idFromName).toHaveBeenCalledWith('admin:2026');
});
it.each([
  '{}',
  'null',
  JSON.stringify({ ...input, name: 'private' }),
  JSON.stringify({ ...input, area: 'platform' }),
  ' '.repeat(1025),
])('rejects malformed or excessive diagnostic bodies', async (body) => {
  const { env, recordOperationalSignal } = fixture();
  expect((await serveStudentDiagnosticV1(diagnostic(body), env)).status).toBe(400);
  expect(recordOperationalSignal).not.toHaveBeenCalled();
});
it.each([
  { Origin: '' },
  { Origin: 'https://untrusted.invalid' },
  { 'x-forwarded-host': 'untrusted.invalid' },
  { 'Sec-Fetch-Site': 'cross-site' },
] as Record<string, string>[])('rejects untrusted origin before the limiter', async (headers) => {
  const { env, limit } = fixture();
  expect((await serveStudentDiagnosticV1(diagnostic(undefined, headers), env)).status).toBe(403);
  expect(limit).not.toHaveBeenCalled();
});
it('honors the independent limiter and never returns private failures', async () => {
  const { env, limit, recordOperationalSignal } = fixture();
  limit.mockResolvedValue({ success: false });
  expect((await serveStudentDiagnosticV1(diagnostic(), env)).status).toBe(429);
  expect(recordOperationalSignal).not.toHaveBeenCalled();
  limit.mockRejectedValue(Error('private failure'));
  const response = await serveStudentDiagnosticV1(diagnostic(), env);
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('');
});
it.each([
  [200, 'ok'],
  [401, 'refused'],
  [429, 'limited'],
  [503, 'failed'],
] as const)(
  'preserves the exact response and observes status %i without reading private bodies',
  async (status, outcome) => {
    const { env, recordOperationalSignal } = fixture();
    const promises: Promise<unknown>[] = [];
    const response = new Response('SYNTHETIC-PRIVATE-BODY', {
      status,
      headers: { 'Set-Cookie': 'private' },
    });
    const serve = vi.fn(async () => response);
    const result = await serveObservedPortalSelfV1(
      new Request(origin + '/api/student/auth/login', { method: 'POST' }),
      env,
      (p) => promises.push(p),
      serve,
    );
    expect(result).toBe(response);
    expect(response.bodyUsed).toBe(false);
    await Promise.all(promises);
    expect(recordOperationalSignal).toHaveBeenCalledWith({
      source: 'login',
      outcome,
      elapsedMs: expect.any(Number),
    });
    expect(JSON.stringify(recordOperationalSignal.mock.calls)).not.toContain('private');
  },
);
it('does not turn telemetry failure or waitUntil failure into a login failure', async () => {
  const { env, recordOperationalSignal } = fixture();
  recordOperationalSignal.mockRejectedValue(Error('private'));
  const response = new Response('ok');
  const promises: Promise<unknown>[] = [];
  const request = new Request(origin + '/api/student/session');
  expect(
    await serveObservedPortalSelfV1(
      request,
      env,
      (p) => promises.push(p),
      async () => response,
    ),
  ).toBe(response);
  await Promise.all(promises);
  expect(
    await serveObservedPortalSelfV1(
      request,
      env,
      () => {
        throw Error('context unavailable');
      },
      async () => response,
    ),
  ).toBe(response);
});
it('does not collect health probes, other paths or invalid origins', async () => {
  const { env, recordOperationalSignal } = fixture();
  const wait = vi.fn();
  for (const url of [
    origin + '/healthz',
    origin + '/api/student/unknown',
    'https://untrusted.invalid/api/student/session',
  ])
    await serveObservedPortalSelfV1(new Request(url), env, wait, async () => new Response('ok'));
  expect(wait).not.toHaveBeenCalled();
  expect(recordOperationalSignal).not.toHaveBeenCalled();
});
it('guards administrative signal reads before the RPC and preserves older backend compatibility', async () => {
  const monitoringSignals = vi.fn<() => Promise<unknown>>(async () => ({
    ...emptyPortalSignalsV1('unavailable'),
    state: 'ok',
  }));
  const env = {
    RUNTIME_ENVIRONMENT: 'local',
    OFFICIAL_ORIGIN: 'http://localhost:8788',
    TENANT_ID: '22222222-2222-4222-8222-222222222222',
    PORTAL_SERVICE: { monitoringSignals },
  } as unknown as RuntimeEnv;
  const request = () =>
    new Request('http://localhost:8788/api/platform/system-health/signals', {
      method: 'POST',
      body: '{"before":null}',
      headers: {
        Origin: 'http://localhost:8788',
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE}=synthetic`,
      },
    });
  vi.mocked(requireAuth).mockResolvedValue({
    oid: '11111111-1111-4111-8111-111111111111',
    roles: ['PROFESSOR'],
    exp: 9999999999,
  } as Awaited<ReturnType<typeof requireAuth>>);
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(403);
  expect(monitoringSignals).not.toHaveBeenCalled();
  vi.mocked(requireAuth).mockResolvedValue({
    oid: '11111111-1111-4111-8111-111111111111',
    roles: ['ADMINISTRADOR'],
    exp: 9999999999,
  } as Awaited<ReturnType<typeof requireAuth>>);
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(200);
  monitoringSignals.mockResolvedValue({ ...emptyPortalSignalsV1('unavailable'), raw: 'private' });
  expect((await handleSystemHealthRequestV1(request(), env))?.status).toBe(503);
  env.PORTAL_SERVICE = {} as RuntimeEnv['PORTAL_SERVICE'];
  expect(await (await handleSystemHealthRequestV1(request(), env))!.json()).toMatchObject({
    state: 'unconfigured',
    points: [],
  });
});
