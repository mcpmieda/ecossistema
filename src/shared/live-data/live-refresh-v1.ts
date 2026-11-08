import { secureJitterV1 } from './secure-jitter-v1';
export type LiveDomainV1 = 'gradebook' | 'portal';
const LIVE_REFRESH_INTERVAL_V1 = 30_000;
/** Heavy, read-only analytics opt in; interactive Portal/Council readers keep their cadence. */
export const LIVE_HEAVY_READ_INTERVAL_V1 = 120_000;
const MIN_GAP = 2_000;
const FOCUS_GAP = 10_000;
const MAX_RETRY_DELAY = 300_000;
const CHANNEL = 'ecossistema-invalidation-v1';
interface Subscription {
  domains: readonly LiveDomainV1[];
  refresh: () => void | Promise<unknown>;
  canRefresh: () => boolean;
  isActive: () => boolean;
  /** False pauses event and cadence reads; focus/return and failure retries still apply. */
  automatic: () => boolean;
  interval: number;
  settledAt: number;
  requested: boolean;
  nextAt: number;
  lastAt: number;
  retryAt: number;
  failures: number;
  pending: boolean;
  dirty: boolean;
}
export type LiveRefreshSubscriptionV1 = (() => void) & { resume(): void };
const subscriptions = new Set<Subscription>();
const changeListeners = new Set<(domain: LiveDomainV1) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let channel: BroadcastChannel | undefined;
let listening = false;
const visible = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;
const jitter = () => secureJitterV1(1_000);

function nextCadenceAt(entry: Subscription, from: number) {
  return entry.automatic() ? from + entry.interval + jitter() : Number.POSITIVE_INFINITY;
}


/** In-memory invalidation metadata only; no independent clock, socket, payload or storage. */
export function subscribeLiveChangesV1(listener: (domain: LiveDomainV1) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
function wake() {
  clearTimeout(timer);
  timer = undefined;
  if (!subscriptions.size || !visible()) return;
  const next = Math.min(
    ...Array.from(subscriptions)
      .filter((entry) => !entry.pending && entry.isActive())
      .map((entry) => entry.nextAt),
  );
  if (!Number.isFinite(next)) return;
  timer = setTimeout(tick, Math.max(0, next - Date.now()));
}
function request(entry: Subscription, changed = true) {
  // Focus/pageshow are not evidence of a new commit. A pending read already covers them.
  if (entry.pending) {
    if (changed) entry.dirty = true;
    return;
  }
  entry.requested = true;
  const requestedAt = Math.max(
    Date.now() + 250 + jitter(),
    entry.lastAt + (changed ? MIN_GAP : FOCUS_GAP),
    entry.retryAt,
  );
  entry.nextAt = Math.max(entry.retryAt, Math.min(entry.nextAt, requestedAt));
}
function invalidate(domain: LiveDomainV1) {
  for (const listener of changeListeners) {
    try {
      listener(domain);
    } catch {
      /* An observer must not prevent authorized revalidation. */
    }
  }
  for (const entry of subscriptions)
    if (entry.domains.includes(domain) && entry.automatic()) request(entry);
  wake();
}
function resume() {
  if (visible()) for (const entry of subscriptions) if (entry.isActive()) request(entry, false);
  wake();
}
function tick() {
  timer = undefined;
  if (!visible()) return;
  const now = Date.now();
  for (const entry of subscriptions) {
    if (entry.pending || !entry.isActive() || entry.nextAt > now) continue;
    if (!entry.canRefresh()) {
      entry.nextAt = now + 1_000;
      continue;
    }
    entry.pending = true;
    entry.requested = false;
    entry.dirty = false;
    entry.lastAt = now;
    void Promise.resolve()
      .then(entry.refresh)
      .then(
        (result) => {
          // A typed reader may resolve false after displaying its failure. Undefined stays compatible.
          entry.failures = result === false ? Math.min(entry.failures + 1, 10) : 0;
        },
        () => {
          // Only a read is retried; the reader owns its error presentation, scope and cancellation.
          entry.failures = Math.min(entry.failures + 1, 10);
        },
      )
      .finally(() => {
        entry.pending = false;
        if (!subscriptions.has(entry)) return;
        entry.settledAt = Date.now();
        entry.nextAt =
          entry.failures === 0
            ? nextCadenceAt(entry, Date.now())
            : Date.now() +
              Math.min(MAX_RETRY_DELAY, entry.interval * 2 ** (entry.failures - 1)) +
              jitter();
        entry.retryAt = entry.failures === 0 ? 0 : entry.nextAt;
        if (entry.dirty) request(entry);
        wake();
      });
  }
  wake();
}
function start() {
  if (listening) return;
  listening = true;
  window.addEventListener('focus', resume);
  window.addEventListener('pageshow', resume);
  window.addEventListener('online', resume);
  window.addEventListener('offline', resume);
  document.addEventListener('visibilitychange', resume);
  try {
    if (typeof window.BroadcastChannel === 'function') {
      channel = new window.BroadcastChannel(CHANNEL);
      channel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
        const value = data as Record<string, unknown>;
        if (Object.keys(value).length !== 2 || value.type !== 'invalidate') return;
        if (value.domain === 'gradebook' || value.domain === 'portal') invalidate(value.domain);
      };
    }
  } catch {
    channel = undefined;
  }
}
function stop() {
  if (subscriptions.size || !listening) return;
  clearTimeout(timer);
  timer = undefined;
  window.removeEventListener('focus', resume);
  window.removeEventListener('pageshow', resume);
  window.removeEventListener('online', resume);
  window.removeEventListener('offline', resume);
  document.removeEventListener('visibilitychange', resume);
  channel?.close();
  channel = undefined;
  listening = false;
}
/** Local commits are relayed to same-origin tabs. Remote notices already arrive at each
 * connected document and must not be echoed across all those documents a second time.
 */
export function notifyLiveChangeV1(domain: LiveDomainV1, options: { broadcast?: boolean } = {}) {
  if (typeof window === 'undefined') return;
  invalidate(domain);
  if (options.broadcast === false) return;
  try {
    if (channel) channel.postMessage({ type: 'invalidate', domain });
    else if (typeof window.BroadcastChannel === 'function') {
      const temporary = new window.BroadcastChannel(CHANNEL);
      temporary.postMessage({ type: 'invalidate', domain });
      temporary.close();
    }
  } catch {
    /* An optional notification never changes a committed operation's result. */
  }
}
/** One listener set and one clock per document; at most one read in flight per subscriber.
 * A committed change received during a read is coalesced into one later revalidation.
 * Rejected reads, or readers resolving false, back off without event-driven retry storms.
 */
export function subscribeLiveRefreshV1(options: {
  domains: readonly LiveDomainV1[];
  refresh: () => void | Promise<unknown>;
  canRefresh?: () => boolean;
  isActive?: () => boolean;
  automatic?: () => boolean;
  intervalMs?: number;
}): LiveRefreshSubscriptionV1 {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return Object.assign(() => undefined, { resume: () => undefined });
  const interval = Math.max(10_000, options.intervalMs ?? LIVE_REFRESH_INTERVAL_V1);
  const entry: Subscription = {
    domains: options.domains,
    refresh: options.refresh,
    canRefresh: options.canRefresh ?? (() => true),
    isActive: options.isActive ?? (() => true),
    automatic: options.automatic ?? (() => true),
    interval,
    settledAt: Date.now(),
    requested: false,
    nextAt: 0,
    lastAt: 0,
    retryAt: 0,
    failures: 0,
    pending: false,
    dirty: false,
  };
  entry.nextAt = nextCadenceAt(entry, entry.settledAt);
  subscriptions.add(entry);
  start();
  wake();
  return Object.assign(
    () => {
      subscriptions.delete(entry);
      stop();
      if (subscriptions.size) wake();
    },
    {
      resume() {
        if (!subscriptions.has(entry)) return;
        if (entry.isActive()) request(entry, false);
        wake();
      },
    },
  );
}
