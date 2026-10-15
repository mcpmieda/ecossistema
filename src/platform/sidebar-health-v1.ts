import { useEffect, useState } from 'react';
import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1';
import { isSystemHealthSnapshotV1, systemHealthStateV1, type HealthStateV1 } from '../../shared/system-health-v1';

const SIDEBAR_HEALTH_EVERY_MS_V1 = 5 * 60_000;
const SIDEBAR_FIRST_READ_MS_V1 = 3_000;

/** The overall state of Saúde do Sistema for its dot in the side column: the same read and rule as
 * the page, only while the window is visible and at most every five minutes. Nothing is kept. */
export function useSidebarHealthV1(enabled: boolean): HealthStateV1 | null {
  const [state, setState] = useState<HealthStateV1 | null>(null);
  useEffect(() => {
    if (!enabled) { setState(null); return; }
    let active: AbortController | undefined;
    let last = -Infinity;
    let stopped = false;
    const read = async () => {
      if (stopped || active || document.visibilityState === 'hidden' || Date.now() - last < SIDEBAR_HEALTH_EVERY_MS_V1) return;
      last = Date.now();
      const controller = new AbortController(); active = controller;
      try {
        const snapshot = await healthDeadlineV1(async (signal) => {
          const response = await fetch('/api/platform/system-health', {
            method: 'POST', body: '{}', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { 'Content-Type': 'application/json' }, signal,
          });
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('health-unavailable'); }
          const payload = await readHealthJsonV1(response, signal);
          if (!isSystemHealthSnapshotV1(payload)) throw new Error('health-contract');
          return payload;
        }, 12_000, controller.signal);
        if (!stopped) setState(systemHealthStateV1(snapshot, Date.now()));
      } catch {
        if (!stopped) setState(null);
      } finally { if (active === controller) active = undefined; }
    };
    const timer = setInterval(() => { void read(); }, SIDEBAR_HEALTH_EVERY_MS_V1);
    const visible = () => { void read(); };
    document.addEventListener('visibilitychange', visible);
    // After the page itself has its data: the dot never competes with the first open.
    const first = setTimeout(() => { void read(); }, SIDEBAR_FIRST_READ_MS_V1);
    return () => {
      stopped = true; active?.abort(); clearInterval(timer); clearTimeout(first);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled]);
  return state;
}
