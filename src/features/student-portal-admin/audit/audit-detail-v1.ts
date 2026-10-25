import type { AdminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { OperationsPropsV1 } from '../overview/operations-values-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
type DetailV1 = Extract<AdminResponseV1, { state: 'audit-detail' }>;
export type AuditDetailStateV1 =
  | { state: 'idle' | 'loading' | 'expired' }
  | { state: 'ready'; detail: DetailV1; ipExpired: boolean }
  | { state: 'error'; error: PortalClientErrorV1; retryAt: number };
/** The detail of the event asked for, and of the account in scope. */
function matchingDetailV1(
  detail: AdminResponseV1,
  scope: ScopeV1,
  eventId: string,
): detail is DetailV1 {
  if (detail.state !== 'audit-detail' || detail.event.eventId !== eventId) return false;
  return scope.kind !== 'account' || detail.event.accountId === scope.accountId;
}

/** Event metadata is kept for one year: the same day next year, or that month's last day. */
function metadataEndV1(at: string) {
  const occurred = new Date(at);
  const metadataEnd = new Date(occurred);
  metadataEnd.setUTCDate(1);
  metadataEnd.setUTCFullYear(metadataEnd.getUTCFullYear() + 1);
  const lastDay = new Date(
    Date.UTC(metadataEnd.getUTCFullYear(), metadataEnd.getUTCMonth() + 1, 0),
  ).getUTCDate();
  metadataEnd.setUTCDate(Math.min(occurred.getUTCDate(), lastDay));
  return metadataEnd;
}

/** The IP is shown until its own expiry, and never past 90 days after the event. */
function ipDeadlineV1(detail: DetailV1) {
  return Math.min(
    detail.ipExpiresAt ? Date.parse(detail.ipExpiresAt) : 0,
    Date.parse(detail.event.at) + 90 * 86_400_000,
  );
}

function shownDetailV1(detail: DetailV1, allowed: boolean): DetailV1 {
  return {
    ...detail,
    ip: allowed ? detail.ip : null,
    ipExpiresAt: allowed ? detail.ipExpiresAt : null,
  };
}

const clientFailureV1 = (error: unknown) =>
  error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');

/** The server enforces capability and 90 days. A conservative monotonic clock removes
 * the returned IP at its remaining deadline; the whole private detail expires after 5 min.
 */
export function createAuditDetailV1(
  props: Pick<OperationsPropsV1, 'client' | 'reader' | 'canWrite'>,
  publish: (state: AuditDetailStateV1) => void,
  monotonic = () => performance.now(),
) {
  let generation = 0,
    active: AbortController | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined,
    lifetime: ReturnType<typeof setTimeout> | undefined;
  let retryAt = 0;
  function clear() {
    generation++;
    active?.abort();
    active = undefined;
    clearTimeout(expiry);
    clearTimeout(lifetime);
    expiry = lifetime = undefined;
    publish({ state: 'idle' });
  }
  /** At its deadline the IP leaves the screen and the value this detail still holds. */
  function expireIp(current: number, safe: DetailV1, delay: number) {
    expiry = setTimeout(() => {
      if (generation === current)
        publish({
          state: 'ready',
          detail: { ...safe, ip: null, ipExpiresAt: null },
          ipExpired: true,
        });
      // Release the original raw value retained by this callback as well.
      safe.ip = null;
      safe.ipExpiresAt = null;
    }, delay);
  }
  async function readClock(scope: ScopeV1, signal: AbortSignal) {
    const clock = await props.reader.query(
      { contractVersion: 2, operation: 'accounts-read', scope, page: { limit: 1 } },
      signal,
    );
    if (clock.state !== 'accounts-read') throw new PortalClientErrorV1('invalid-response');
    return clock.observedAt;
  }
  async function open(scope: ScopeV1, eventId: string) {
    if (!props.canWrite) return;
    if (Date.now() < retryAt) {
      publish({ state: 'error', error: new PortalClientErrorV1('rate-limited'), retryAt });
      return;
    }
    clear();
    const current = ++generation,
      controller = new AbortController(),
      started = monotonic();
    active = controller;
    publish({ state: 'loading' });
    try {
      const detail = await props.client.query(
        {
          contractVersion: 1,
          operation: 'audit-detail',
          includeEntities: true,
          includeReadContext: true,
          scope,
          eventId,
          page: { limit: 1 },
        },
        controller.signal,
      );
      if (generation !== current || controller.signal.aborted) return;
      if (!matchingDetailV1(detail, scope, eventId))
        throw new PortalClientErrorV1('invalid-response');
      // Missing clock metadata uses the complete authorized read.
      let observedAt = detail.observedAt;
      if (!observedAt) {
        const clock = await readClock(scope, controller.signal);
        if (generation !== current || controller.signal.aborted) return;
        observedAt = clock;
      }
      const serverNow = Date.parse(observedAt) + Math.max(0, monotonic() - started);
      const remainingMetadata = metadataEndV1(detail.event.at).getTime() - serverNow;
      if (remainingMetadata <= 0) {
        publish({ state: 'expired' });
        return;
      }
      const deadline = ipDeadlineV1(detail);
      const allowed = detail.ip !== null && deadline > serverNow;
      const safe = shownDetailV1(detail, allowed);
      publish({ state: 'ready', detail: safe, ipExpired: !allowed });
      if (allowed) expireIp(current, safe, Math.min(deadline - serverNow, 300_000));
      lifetime = setTimeout(
        () => {
          if (generation === current) {
            clear();
            publish({ state: 'expired' });
          }
        },
        Math.min(300_000, remainingMetadata),
      );
    } catch (error) {
      if (generation !== current || controller.signal.aborted) return;
      controller.abort();
      const failure = clientFailureV1(error);
      retryAt = Date.now() + (failure.retryAfterSeconds ?? 0) * 1000;
      publish({ state: 'error', error: failure, retryAt });
    } finally {
      if (generation === current) active = undefined;
    }
  }
  return { open, clear };
}
