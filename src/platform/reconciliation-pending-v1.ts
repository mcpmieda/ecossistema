import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RECONCILIATION_PENDING_CAP_V1 } from '../../shared/student-identity/reconciliation-v1';
import { createReconciliationClientV1 } from '../features/student-portal-admin/shared/reconciliation-client-v1';

const READ_EVERY_MS_V1 = 5 * 60_000;
const READ_AFTER_VISIT_MS_V1 = 30_000;

/**
 * How many rows wait in the Conciliação, for the count of its tab and of the Importação in the side
 * column. One reader (the side column) keeps it; the tab only shows it.
 */
let count: number | null = null;
const listeners = new Set<() => void>();

function publish(next: number | null): void {
  if (next === count) return;
  count = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "50+" past the cap the server counts to; nothing for none. */
export function reconciliationPendingLabelV1(value: number | null): string | null {
  if (value === null || value === 0) return null;
  return value > RECONCILIATION_PENDING_CAP_V1
    ? `${RECONCILIATION_PENDING_CAP_V1}+`
    : String(value);
}

export function useReconciliationPendingCountV1(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => count,
    () => count,
  );
}

/** Read while the window is visible, every five minutes and again when one moves between areas. */
export function useReconciliationPendingReaderV1(enabled: boolean, visit: string): void {
  const [client] = useState(() => createReconciliationClientV1({ respectRetryAfter: true }));
  const last = useRef(-Infinity);
  useEffect(() => {
    if (!enabled) {
      publish(null);
      return;
    }
    let stopped = false;
    let active: AbortController | undefined;
    const read = async (gap: number) => {
      if (
        stopped ||
        active ||
        document.visibilityState === 'hidden' ||
        Date.now() - last.current < gap
      )
        return;
      last.current = Date.now();
      const controller = new AbortController();
      active = controller;
      try {
        const result = await client.request(
          { contractVersion: 1, academicYear: 2026, operation: 'pending-count' },
          controller.signal,
        );
        if (stopped) return;
        publish(
          result.state === 'ready' && result.operation === 'pending-count' ? result.pending : null,
        );
      } catch {
        if (!stopped) publish(null);
      } finally {
        if (active === controller) active = undefined;
      }
    };
    const timer = setInterval(() => {
      void read(READ_EVERY_MS_V1);
    }, READ_EVERY_MS_V1);
    const visible = () => {
      void read(READ_EVERY_MS_V1);
    };
    document.addEventListener('visibilitychange', visible);
    // After the page itself has its data: the count never competes with the first open.
    const first = setTimeout(
      () => {
        void read(READ_AFTER_VISIT_MS_V1);
      },
      last.current === -Infinity ? 3_000 : 0,
    );
    return () => {
      stopped = true;
      active?.abort();
      clearInterval(timer);
      clearTimeout(first);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, visit, client]);
}
