import { useEffect, useRef, useState } from 'react';
import { RECONCILIATION_PENDING_CAP_V1 } from '../../shared/student-identity/reconciliation-v1';
import { createReconciliationClientV1 } from '../features/student-portal-admin/shared/reconciliation-client-v1';

const SIDEBAR_PENDING_EVERY_MS_V1 = 5 * 60_000;
const SIDEBAR_PENDING_AFTER_VISIT_MS_V1 = 30_000;

/** How many rows wait in the Conciliação, for its badge in the side column ("50+" past the cap).
 * Read while the window is visible, every five minutes and again when one moves between areas. */
export function useSidebarPendingV1(enabled: boolean, visit: string): string | null {
  const [label, setLabel] = useState<string | null>(null);
  const [client] = useState(() => createReconciliationClientV1({ respectRetryAfter: true }));
  const last = useRef(-Infinity);
  useEffect(() => {
    if (!enabled) { setLabel(null); return; }
    let stopped = false;
    let active: AbortController | undefined;
    const read = async (gap: number) => {
      if (stopped || active || document.visibilityState === 'hidden' || Date.now() - last.current < gap) return;
      last.current = Date.now();
      const controller = new AbortController(); active = controller;
      try {
        const result = await client.request(
          { contractVersion: 1, academicYear: 2026, operation: 'pending-count' }, controller.signal);
        if (stopped) return;
        if (result.state !== 'ready' || result.operation !== 'pending-count') { setLabel(null); return; }
        setLabel(result.pending === 0 ? null
          : result.pending > RECONCILIATION_PENDING_CAP_V1 ? `${RECONCILIATION_PENDING_CAP_V1}+` : String(result.pending));
      } catch {
        if (!stopped) setLabel(null);
      } finally { if (active === controller) active = undefined; }
    };
    const timer = setInterval(() => { void read(SIDEBAR_PENDING_EVERY_MS_V1); }, SIDEBAR_PENDING_EVERY_MS_V1);
    const visible = () => { void read(SIDEBAR_PENDING_EVERY_MS_V1); };
    document.addEventListener('visibilitychange', visible);
    // After the page itself has its data: the badge never competes with the first open.
    const first = setTimeout(() => { void read(SIDEBAR_PENDING_AFTER_VISIT_MS_V1); }, last.current === -Infinity ? 3_000 : 0);
    return () => {
      stopped = true; active?.abort(); clearInterval(timer); clearTimeout(first);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, visit, client]);
  return label;
}
