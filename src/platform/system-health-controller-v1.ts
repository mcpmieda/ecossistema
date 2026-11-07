import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1';
import { isSystemHealthSnapshotV1, SYSTEM_HEALTH_POLL_MS_V1, type SystemHealthSnapshotV1 } from '../../shared/system-health-v1';

type HealthMonitorStateV1 = {
  snapshot: SystemHealthSnapshotV1 | null;
  loading: boolean;
  paused: boolean;
  error: 'unavailable' | 'denied' | null;
};
type OptionsV1 = { fetcher?: typeof fetch; now?: () => number; onDenied?: () => void };
const denied = Symbol('health-denied');

/** One reader per visible monitoring workspace. No polling, storage or data survives stop(). */
export function createHealthMonitorV1(options: OptionsV1 = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let state: HealthMonitorStateV1 = { snapshot: null, loading: false, paused: false, error: null };
  const listeners = new Set<() => void>();
  let running = false;
  let available = true;
  let generation = 0;
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStarted = -Infinity;
  let failures = 0;
  const publish = (change: Partial<HealthMonitorStateV1>) => {
    state = { ...state, ...change }; listeners.forEach((listener) => listener());
  };
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const cancel = () => { generation++; active?.abort(); active = undefined; clearTimer(); };
  const schedule = (delay: number) => {
    clearTimer();
    if (running && available && state.error !== 'denied') timer = setTimeout(() => { void refresh(); }, delay);
  };
  async function refresh(): Promise<void> {
    if (!running || !available || active || state.error === 'denied') return;
    const since = now() - lastStarted;
    if (since >= 0 && since < 5_000) { schedule(5_000 - since); return; }
    clearTimer();
    lastStarted = now();
    const token = ++generation;
    const controller = new AbortController(); active = controller;
    publish({ loading: true });
    try {
      const snapshot = await healthDeadlineV1(async (signal) => {
        const response = await fetcher('/api/platform/system-health', {
          method: 'POST', body: '{}', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { 'Content-Type': 'application/json' }, signal,
        });
        if (response.status === 401 || response.status === 403) {
          void response.body?.cancel().catch(() => undefined); throw denied;
        }
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('health-unavailable'); }
        const payload = await readHealthJsonV1(response, signal);
        if (!isSystemHealthSnapshotV1(payload)) throw new Error('health-contract');
        return payload;
      }, 12_000, controller.signal);
      if (!running || token !== generation) return;
      failures = 0; publish({ snapshot, error: null });
    } catch (error) {
      if (!running || token !== generation || controller.signal.aborted) return;
      if (error === denied) { publish({ snapshot: null, error: 'denied' }); options.onDenied?.(); }
      else { failures++; publish({ error: 'unavailable' }); }
    } finally {
      if (running && token === generation) {
        active = undefined; publish({ loading: false });
        schedule(Math.min(300_000, SYSTEM_HEALTH_POLL_MS_V1 * 2 ** Math.min(3, Math.max(0, failures - 1))));
      }
    }
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    start: () => { if (!running) { running = true; void refresh(); } },
    stop: () => { running = false; cancel(); failures = 0; lastStarted = -Infinity;
      publish({ snapshot: null, loading: false, error: null }); },
    setAvailable: (value: boolean) => {
      if (value === available) return;
      available = value;
      if (!value) { cancel(); publish({ paused: true, loading: false }); }
      else { publish({ paused: false }); if (running) void refresh(); }
    },
  };
}
