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
import { readSchoolDayWindowV1, type SchoolDayWindowV1 } from '../../server/student-portal/composition/poll-window-v1';
import { portalDatabaseV1 } from '../../server/student-portal/composition/database-v1';
import type { PortalCompositionEnvV1 } from '../../server/student-portal/composition/config-v1';
import { liveAdminContextV1 } from '../../shared/student-portal-contracts/live-v1';

import { connectPortalLiveV1 } from '../../server/student-portal/live/live-connect-v1';
import { allowPortalLiveDrainV1 } from '../../server/student-portal/composition/live-drain-v1';
import { dispatchPortalLiveEventsV1 } from '../../server/student-portal/live/live-outbox-v1';
type PortalEnvV1 = PortalWorkerEnv & PortalCompositionEnvV1 & {
  /** 'notas-onedrive-sync': that Worker runs the minute's work next to the database; the cron here rests. */
  readonly PORTAL_SCHEDULER?: string;
};

/** The minute's scheduled work (retention, live outbox, health history and signals). */
async function scheduledWorkV1(env: PortalEnvV1, scheduledTime: number): Promise<void> {
  await Promise.all([portalScheduledV1(env, scheduledTime), dispatchPortalLiveEventsV1(env).catch(() => 0),
    portalHistoryScheduledV1(env, scheduledTime), portalSignalsScheduledV1(env, scheduledTime)]);
}

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
/**
 * The minute's work, asked by the notas-onedrive-sync Worker from a request placed in São Paulo
 * (next to the database): a cron runs wherever Cloudflare starts it and placement does not apply.
 * Bound only to that Worker; it carries no data in or out.
 */
export class PortalSchedulerEntrypoint extends WorkerEntrypoint<PortalEnvV1> {
  async run(scheduledTime: unknown): Promise<boolean> {
    if (typeof scheduledTime !== 'number' || !Number.isFinite(scheduledTime)) return false;
    await scheduledWorkV1(this.env, scheduledTime);
    return true;
  }

  /** The day's school hours (calendar and bells) for the OneDrive 10 s poll; null when unreadable. */
  async pollWindow(day: unknown): Promise<SchoolDayWindowV1 | null> {
    if (typeof day !== 'string') return null;
    return readSchoolDayWindowV1(this.env, day).catch(() => null);
  }
}

/**
 * Safety net for the minute run by notas-onedrive-sync (issue #1426, 32): every 5 minutes the
 * Portal's own cron looks at the last health sample that run writes; when it is older than 12
 * minutes (that Worker stopped, lost its binding or slowed its cron), the cron here runs the minute.
 */
async function schedulerStalledV1(env: PortalEnvV1): Promise<boolean> {
  try {
    return await portalDatabaseV1(env, 'cleanup', async (sql) => {
      const [row] = await sql.unsafe(`SELECT coalesce(max(bucket_at) < now() - interval '12 minutes', true) AS late
        FROM system_health.portal_sample_v1`);
      return (row as { late?: unknown } | undefined)?.late !== false;
    });
  } catch {
    return true;
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
    if (env.PORTAL_SCHEDULER === 'notas-onedrive-sync') {
      // This cron runs every 5 min (2-59/5) only as the safety net of the minute run by notas-onedrive-sync.
      if (!(await schedulerStalledV1(env))) return;
      console.error(JSON.stringify({ event: 'portal-scheduler-fallback' }));
      // The work due at the last multiple of 5 min: the health sample, the signals, the cleanups and
      // the midnight pruning all run on those minutes, never on the 2nd/7th (issue #1450, 6).
      await scheduledWorkV1(env, Math.floor(controller.scheduledTime / 300_000) * 300_000);
      return;
    }
    await scheduledWorkV1(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<PortalEnvV1>;

export {PortalLiveUpdatesV1} from '../../server/student-portal/live/live-updates-v1';