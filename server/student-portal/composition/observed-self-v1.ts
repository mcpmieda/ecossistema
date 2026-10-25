import { FRONTEND_DIAGNOSTIC_ROUTE_V1, inspectFrontendDiagnosticSubmissionV1 } from '../../../shared/frontend-diagnostic-v1';
import { healthDeadlineV1, readHealthJsonV1 } from '../../../shared/health-io-v1';
import type { PortalSignalInputV1 } from '../../../shared/portal-signals-v1';
import { portalRequestOriginAllowedV1 } from '../runtime/http-v1';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalSignalStubV1 } from './signals-v1';
import { servePortalSelfV1 } from './self-v1';
const routes = new Map<string, { method: string; source: PortalSignalInputV1['source'] }>([
  ['/api/student/auth/challenge', { method: 'POST', source: 'challenge' }],
  ['/api/student/auth/login', { method: 'POST', source: 'login' }],
  ['/api/student/auth/activate', { method: 'POST', source: 'activation' }],
  ['/api/student/session', { method: 'GET', source: 'session' }],
  ['/api/student/me', { method: 'GET', source: 'profile' }],
]);
const browserSources = { 'module-load': 'browser-module', render: 'browser-render', read: 'browser-read' } as const;
const statusOutcome = (status: number): PortalSignalInputV1['outcome'] => {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429) return 'limited';
  if (status >= 400 && status < 500) return 'refused';
  return 'failed';
};
async function record(env: PortalCompositionEnvV1, value: PortalSignalInputV1): Promise<void> {
  try { await healthDeadlineV1(() => portalSignalStubV1(env).recordOperationalSignal(value), 2000); }
  catch { /* Never retry telemetry, change auth outcomes or log payloads. */ }
}
export async function serveStudentDiagnosticV1(request: Request, env: PortalCompositionEnvV1): Promise<Response> {
  const reply = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
  if (!portalRequestOriginAllowedV1(request, env.PORTAL_ENVIRONMENT, env.PORTAL_ORIGIN)
    || request.headers.get('origin') !== env.PORTAL_ORIGIN) return reply(403);
  if (request.method !== 'POST') return reply(405);
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return reply(415);
  let input: unknown;
  try { input = await healthDeadlineV1((signal) => readHealthJsonV1(new Response(request.body, { headers: request.headers }), signal, 1024), 1000); }
  catch { return reply(400); }
  if (!inspectFrontendDiagnosticSubmissionV1(input) || input.area !== 'student-portal') return reply(400);
  if (!env.PORTAL_AUTH_GLOBAL || !env.PORTAL_LIVE) return reply(503);
  try {
    // Independent key in the existing limiter; never consumes the login limiter's key.
    const allowed = await env.PORTAL_AUTH_GLOBAL.limit({ key: 'student-portal:frontend-diagnostic:v1' });
    if (!allowed.success) return reply(429);
    // Ignore correlation/release after validation. Only a fixed enum crosses the accumulator boundary.
    await record(env, { source: browserSources[input.category], outcome: 'failed', elapsedMs: 0 });
    return reply(204);
  } catch { return reply(503); }
}
/** Observe only static operation/status/duration; do not clone or read response/request bodies. */
export async function serveObservedPortalSelfV1(request: Request, env: PortalCompositionEnvV1,
  waitUntil: (promise: Promise<unknown>) => void, serve = servePortalSelfV1): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === FRONTEND_DIAGNOSTIC_ROUTE_V1) return serveStudentDiagnosticV1(request, env);
  const route = routes.get(path), started = Date.now();
  const response = await serve(request, env);
  if (request.method === route?.method && env.PORTAL_ENVIRONMENT === 'production'
    && env.PORTAL_LIVE && portalRequestOriginAllowedV1(request, env.PORTAL_ENVIRONMENT, env.PORTAL_ORIGIN)) {
    const signal: PortalSignalInputV1 = { source: route.source, outcome: statusOutcome(response.status),
      elapsedMs: Math.min(60_000, Math.max(0, Date.now() - started)) };
    try { waitUntil(record(env, signal)); } catch { /* A telemetry scheduling failure must not change the response. */ }
  }
  return response;
}
