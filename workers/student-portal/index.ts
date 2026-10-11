import { sessionCookieTokenV1 } from '../../server/student-portal/http/auth/handler-v1';
import { SESSION_COOKIE_V1 } from '../../shared/student-portal-contracts/auth-v1';
import { limitAdminOperationV1 } from '../../server/student-portal/composition/admin-rate-limit-v1';
import { ERROR_HTTP_V1 } from '../../shared/student-portal-contracts/core-v1';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { portalFailureV1, portalJsonV1 } from '../../server/student-portal/runtime/http-v1';
import { serveObservedPortalSelfV1 } from '../../server/student-portal/composition/observed-self-v1';
import { portalAdminRpcV1 } from '../../server/student-portal/composition/admin-v1';
import { portalReconciliationCredentialsRpcV1 } from '../../server/student-portal/composition/reconciliation-v1';
import { portalMonitoringRpcV1 } from '../../server/student-portal/composition/monitoring-v1';
import { portalHistoryRpcV1, portalHistoryScheduledV1 } from '../../server/student-portal/composition/health-history-v1';
import { portalSignalsRpcV1, portalSignalsScheduledV1 } from '../../server/student-portal/composition/signals-v1';
import { portalCapacityRpcV1 } from '../../server/student-portal/composition/capacity-v1';
import { portalHealthReviewRpcV1 } from '../../server/student-portal/composition/health-review-v1';
import { portalScheduledV1 } from '../../server/student-portal/composition/scheduled-v1';
import type { PortalCompositionEnvV1 } from '../../server/student-portal/composition/config-v1';
import { liveAdminContextV1 } from '../../shared/student-portal-contracts/live-v1';
import { PortalLiveUpdatesV1 } from '../../server/student-portal/live/live-updates-v1';
import { connectPortalLiveV1 } from '../../server/student-portal/live/live-connect-v1';
import { allowPortalLiveDrainV1 } from '../../server/student-portal/composition/live-drain-v1';
import { dispatchPortalLiveEventsV1 } from '../../server/student-portal/live/live-outbox-v1';
export { PortalLiveUpdatesV1 };
const selfMayEnqueueLiveV1 = (request: Request, response: Response): boolean => {
  if (request.method !== 'POST' || response.status !== 200) return false;
  const path = new URL(request.url).pathname;
  if (path === '/api/student/auth/logout') return sessionCookieTokenV1(request) !== '';
  if (path !== '/api/student/auth/activate') return false;
  const cookie = response.headers.get('Set-Cookie') ?? '';
  return cookie.startsWith(`${SESSION_COOKIE_V1.name}=`)
    && /^[A-Za-z0-9_-]{43};/u.test(cookie.slice(SESSION_COOKIE_V1.name.length + 1));
};
export class PortalSelfEntrypoint extends WorkerEntrypoint<PortalWorkerEnv & PortalCompositionEnvV1> {
  override async fetch(request: Request): Promise<Response> {
    const response = await serveObservedPortalSelfV1(request, this.env, (promise) => this.ctx.waitUntil(promise));
    if (selfMayEnqueueLiveV1(request, response)) this.ctx.waitUntil(dispatchPortalLiveEventsV1(this.env).catch(() => undefined));
    return response;
  }
}
export class PortalAdminEntrypoint extends WorkerEntrypoint<PortalWorkerEnv & PortalCompositionEnvV1> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parsed = liveAdminContextV1.safeParse({
      actorId: request.headers.get('x-admin-actor-id'), tenantId: request.headers.get('x-admin-tenant-id'),
      capability: request.headers.get('x-admin-capability'), expiresAt: request.headers.get('x-admin-expires-at'),
    });
    if (url.origin !== 'https://portal-admin.internal' || url.pathname !== '/live'
      || request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
      || !parsed.success || parsed.data.tenantId !== this.env.PORTAL_ADMIN_TENANT_ID
      || Date.parse(parsed.data.expiresAt) <= Date.now()) return portalJsonV1(portalFailureV1('forbidden'), 403);
    const limited = await limitAdminOperationV1(this.env, {
      actorId: parsed.data.actorId, tenantId: parsed.data.tenantId,
      capability: parsed.data.capability, authenticatedAt: new Date().toISOString(), requestId: crypto.randomUUID(),
    }, 'live');
    if (limited) {
      const response = portalJsonV1(limited, ERROR_HTTP_V1[limited.state]);
      if (limited.retryAfterSeconds) response.headers.set('Retry-After', String(limited.retryAfterSeconds));
      return response;
    }
    this.ctx.waitUntil(dispatchPortalLiveEventsV1(this.env).catch(() => undefined));
    return connectPortalLiveV1(this.env, request, { audience: 'admin', expiresAt: parsed.data.expiresAt,
      accountId: null, studentId: null, classId: null });
  }
  async limitOperation(context: unknown, operation: unknown) { return limitAdminOperationV1(this.env, context, operation); }
  async drainLive(context: unknown): Promise<boolean> {
    if (!allowPortalLiveDrainV1(this.env, context)) return false;
    this.ctx.waitUntil(dispatchPortalLiveEventsV1(this.env).catch(() => undefined));
    return true;
  }
  async monitoring(context: unknown) { return portalMonitoringRpcV1(this.env, context); }
  async monitoringHistory(context: unknown, before: unknown) { return portalHistoryRpcV1(this.env, context, before); }
  async monitoringSignals(context: unknown, before: unknown) { return portalSignalsRpcV1(this.env, context, before); }
  async monitoringCapacity(context: unknown) { return portalCapacityRpcV1(this.env, context); }
  async monitoringReview(context: unknown) { return portalHealthReviewRpcV1(this.env, context); }
  async query(context: unknown, request: unknown) { return portalAdminRpcV1(this.env, 'query', context, request); }
  async prepareReconciliationCredentials(context: unknown, request: unknown) {
    return portalReconciliationCredentialsRpcV1(this.env, context, request);
  }
  async command(context: unknown, request: unknown) {
    const result = await portalAdminRpcV1(this.env, 'command', context, request);
    if (['committed', 'batch', 'qr'].includes(result.state))
      this.ctx.waitUntil(dispatchPortalLiveEventsV1(this.env).catch(() => undefined));
    return result;
  }
}
// No admin RPC on the default/self capability. Population remains an explicit, separate operation.
export default {
  async fetch(request, env, ctx) {
    const response = await serveObservedPortalSelfV1(request, env, (promise) => ctx.waitUntil(promise));
    if (selfMayEnqueueLiveV1(request, response)) ctx.waitUntil(dispatchPortalLiveEventsV1(env).catch(() => undefined));
    return response;
  },
  async scheduled(controller, env) {
    await Promise.all([portalScheduledV1(env), dispatchPortalLiveEventsV1(env).catch(() => 0),
      portalHistoryScheduledV1(env, controller.scheduledTime), portalSignalsScheduledV1(env, controller.scheduledTime)]);
  },
} satisfies ExportedHandler<PortalWorkerEnv & PortalCompositionEnvV1>;
