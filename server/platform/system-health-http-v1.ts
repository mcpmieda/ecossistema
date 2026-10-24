import type { RuntimeEnv } from '../env';
import { requireAuth, AuthenticationError, SESSION_COOKIE } from '../auth/session';
import { AuthorizationError } from '../auth/roles';
import { capabilitiesForRoles, requireCapability } from '../auth/capabilities';
import { enforceOfficialOrigin, enforceWriteOrigin, HttpError, withSecurityHeaders } from '../http/security';
import type { TrustedAdminContextV1 } from '../../shared/student-portal-contracts/ports-v1';
import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1';
import { emptyPortalHistoryV1, isHistoryRequestV1, isPortalHistoryV1 } from '../../shared/system-health-history-v1';
import { emptyPortalSignalsV1, isPortalSignalsPageV1 } from '../../shared/portal-signals-v1';
import { CAPACITY_ROUTE_V1, emptyPortalCapacityV1, isPortalCapacitySampleV1 } from '../../shared/portal-capacity-v1';
import { HEALTH_REVIEW_ROUTE_V1, emptyHealthReviewV1, isHealthReviewV1 } from '../../shared/health-review-v1';
import { PROVIDER_HEALTH_ROUTE_V1, isPublicProviderHealthV1 } from '../../shared/public-provider-health-v1';
import { readPublicProviderHealthV1 } from './system-health-providers-v1';
import { collectSystemHealthV1, createSystemHealthCacheV1 } from './system-health-source-v1';
type MonitorBindingV1 = {
  monitoring(context: TrustedAdminContextV1): Promise<unknown>;
  monitoringHistory?(context: TrustedAdminContextV1, before: string | null): Promise<unknown>;
  monitoringSignals?(context: TrustedAdminContextV1, before: string | null): Promise<unknown>;
  monitoringCapacity?(context: TrustedAdminContextV1): Promise<unknown>;
  monitoringReview?(context: TrustedAdminContextV1): Promise<unknown>;
};
const snapshotPaths = new Set(['/api/platform/system-health', CAPACITY_ROUTE_V1, HEALTH_REVIEW_ROUTE_V1, PROVIDER_HEALTH_ROUTE_V1]);
const caches = new WeakMap<object, Map<string, ReturnType<typeof createSystemHealthCacheV1>>>();
const absentBindingCacheKey = {};
const reply = (value: unknown, status = 200) => withSecurityHeaders(Response.json(value, { status }), true);
function guardedRequestV1(request: Request, env: RuntimeEnv): void {
  const url = new URL(request.url);
  enforceOfficialOrigin(request, env); enforceWriteOrigin(request, env);
  const mode = env.RUNTIME_ENVIRONMENT ?? 'production';
  if ((mode === 'production' && env.OFFICIAL_ORIGIN !== 'https://admin.escolaieda.com')
    || (mode !== 'production' && (mode !== 'local' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.search || url.hash || url.username || url.password
    || request.headers.has('x-forwarded-host') || request.headers.has('x-original-url')) throw new HttpError(403, 'health-forbidden');
  const host = request.headers.get('host'), site = request.headers.get('sec-fetch-site');
  if ((host && host.toLowerCase() !== url.host.toLowerCase())
    || (site && site !== 'same-origin' && site !== 'none')) throw new HttpError(403, 'health-forbidden');
  if (request.method !== 'POST') throw new HttpError(405, 'health-method');
  const copies = (request.headers.get('cookie') ?? '').split(';').filter((part) => part.trim().startsWith(`${SESSION_COOKIE}=`)).length;
  if (copies !== 1) throw new AuthenticationError();
}
function snapshotCacheV1(key: object, env: RuntimeEnv) {
  let group = caches.get(key);
  if (!group) { group = new Map(); caches.set(key, group); }
  const name = `${env.TENANT_ID}|${env.OFFICIAL_ORIGIN}|${env.RUNTIME_ENVIRONMENT ?? 'production'}`;
  let cache = group.get(name);
  if (!cache) {
    if (group.size >= 4) group.clear();
    cache = createSystemHealthCacheV1();
    group.set(name, cache);
  }
  return cache;
}
async function boundedBodyV1(request: Request, paged: boolean): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'health-content-type');
  try { return await healthDeadlineV1((signal) => readHealthJsonV1(new Response(request.body, { headers: request.headers }), signal, paged ? 128 : 64), 2000); }
  catch { throw new HttpError(400, 'health-invalid-body'); }
}
async function historyReplyV1(body: unknown, binding: MonitorBindingV1 | undefined, context: TrustedAdminContextV1): Promise<Response> {
  if (!isHistoryRequestV1(body)) throw new HttpError(400, 'health-invalid-body');
  if (typeof binding?.monitoringHistory !== 'function') return reply(emptyPortalHistoryV1('unconfigured'));
  const snapshot = await healthDeadlineV1(() => binding.monitoringHistory!(context, body.before), 3000);
  if (!isPortalHistoryV1(snapshot)) throw new Error('health-history-unavailable');
  return reply(snapshot);
}
async function signalsReplyV1(body: unknown, binding: MonitorBindingV1 | undefined, context: TrustedAdminContextV1): Promise<Response> {
  if (!isHistoryRequestV1(body)) throw new HttpError(400, 'health-invalid-body');
  if (typeof binding?.monitoringSignals !== 'function') return reply(emptyPortalSignalsV1('unconfigured'));
  const snapshot = await healthDeadlineV1(() => binding.monitoringSignals!(context, body.before), 3000);
  if (!isPortalSignalsPageV1(snapshot)) throw new Error('health-signals-unavailable');
  return reply(snapshot);
}
async function capacityReplyV1(binding: MonitorBindingV1 | undefined, context: TrustedAdminContextV1): Promise<Response> {
  if (typeof binding?.monitoringCapacity !== 'function') return reply(emptyPortalCapacityV1('unconfigured'));
  const snapshot = await healthDeadlineV1(() => binding.monitoringCapacity!(context), 3000);
  if (!isPortalCapacitySampleV1(snapshot)) throw new Error('health-capacity-unavailable');
  return reply(snapshot);
}
async function reviewReplyV1(binding: MonitorBindingV1 | undefined, context: TrustedAdminContextV1): Promise<Response> {
  if (typeof binding?.monitoringReview !== 'function') return reply(emptyHealthReviewV1('unconfigured'));
  const snapshot = await healthDeadlineV1(() => binding.monitoringReview!(context), 3000);
  if (!isHealthReviewV1(snapshot)) throw new Error('health-review-unavailable');
  return reply(snapshot);
}
async function currentReplyV1(path: string, binding: MonitorBindingV1 | undefined, context: TrustedAdminContextV1, env: RuntimeEnv): Promise<Response> {
  if (path === CAPACITY_ROUTE_V1) return capacityReplyV1(binding, context);
  if (path === HEALTH_REVIEW_ROUTE_V1) return reviewReplyV1(binding, context);
  if (path === PROVIDER_HEALTH_ROUTE_V1) {
    const data = await readPublicProviderHealthV1();
    if (!isPublicProviderHealthV1(data)) throw new Error('health-providers-unavailable');
    return reply(data);
  }
  // Auth is checked on EVERY call, including cache hits. Only anonymous aggregates are cached.
  const cache = snapshotCacheV1(binding ?? absentBindingCacheKey, env);
  return reply(await cache(() => collectSystemHealthV1({
    production: (env.RUNTIME_ENVIRONMENT ?? 'production') === 'production',
    readPortal: binding && typeof binding.monitoring === 'function' ? () => binding.monitoring(context) : undefined,
  })));
}
export async function handleSystemHealthRequestV1(request: Request, env: RuntimeEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const history = path === '/api/platform/system-health/history', signals = path === '/api/platform/system-health/signals';
  if (!history && !signals && !snapshotPaths.has(path)) return null;
  try {
    guardedRequestV1(request, env);
    const session = await requireAuth(request, env), capabilities = capabilitiesForRoles(session.roles);
    requireCapability(capabilities, 'platform.health.read'); requireCapability(capabilities, 'platform.settings.read');
    const body = await boundedBodyV1(request, history || signals);
    if (session.exp <= Math.floor(Date.now() / 1000)) throw new AuthenticationError();
    const context: TrustedAdminContextV1 = { actorId: session.oid, tenantId: env.TENANT_ID,
      requestId: crypto.randomUUID(), authenticatedAt: new Date().toISOString(), capability: 'platform.settings.read' };
    const binding = env.PORTAL_SERVICE as unknown as MonitorBindingV1 | undefined;
    if (history) return await historyReplyV1(body, binding, context);
    if (signals) return await signalsReplyV1(body, binding, context);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) throw new HttpError(400, 'health-invalid-body');
    return await currentReplyV1(path, binding, context, env);
  } catch (error) {
    if (error instanceof AuthenticationError) return reply({ state: 'unauthenticated' }, 401);
    if (error instanceof AuthorizationError) return reply({ state: 'forbidden' }, 403);
    if (error instanceof HttpError) return reply({ state: 'invalid-request' }, error.status);
    return reply({ state: 'unavailable' }, 503);
  }
}
