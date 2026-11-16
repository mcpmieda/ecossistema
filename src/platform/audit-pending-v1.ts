import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { listGradebookImportDiagnosticsAuditV1 } from '../features/gradebook/import/import-diagnostics-client-v1';
import { useLiveRefreshV1 } from '../shared/live-data/use-live-refresh-v1';

/**
 * The count beside the Auditoria tab: the current problems of the Banco's year, the same number the
 * Auditoria lists. The Auditoria publishes its own count when it reads; the tab reads it otherwise
 * (on opening the area, on a change of the Banco and every five minutes while visible).
 */
type AuditPendingStateV1 = { readonly year: number | null; readonly count: number | null };

const READ_EVERY_MS_V1 = 5 * 60_000;
let state: AuditPendingStateV1 = { year: null, count: null };
const listeners = new Set<() => void>();

function setState(next: AuditPendingStateV1): void {
  if (next.year === state.year && next.count === state.count) return;
  state = next;
  for (const listener of listeners) listener();
}

/** The Banco's year was chosen: the count of another year is no longer shown. */
export function publishAuditYearV1(year: number | null): void {
  if (year !== state.year) setState({ year, count: null });
}

/** The Auditoria (or an import that recorded problems) knows the exact count for the year. */
export function publishAuditPendingV1(year: number, count: number): void {
  if (year === state.year || state.year === null) setState({ year, count });
}

export function auditPendingSnapshotV1(): AuditPendingStateV1 {
  return state;
}

export function auditPendingLabelV1(count: number | null): string | null {
  if (count === null || count === 0) return null;
  return count > 999 ? '999+' : String(count);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAuditPendingV1(enabled: boolean, visit: string): string | null {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  const active = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    const year = state.year;
    if (!enabled || year === null || document.visibilityState === 'hidden' || active.current)
      return;
    const controller = new AbortController();
    active.current = controller;
    try {
      const response = await listGradebookImportDiagnosticsAuditV1(
        { academicYear: year, limit: 1 },
        controller.signal,
      );
      if (response.state === 'ready' && response.total !== undefined)
        publishAuditPendingV1(year, response.total);
    } catch {
      // The tab keeps its last count; the Auditoria itself shows a failed read.
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    void read();
    const timer = window.setInterval(() => void read(), READ_EVERY_MS_V1);
    const visible = () => void read();
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      active.current?.abort();
      active.current = null;
    };
  }, [enabled, read, visit, current.year]);

  useLiveRefreshV1(read, { domains: ['gradebook'], enabled: enabled && current.year !== null });
  return enabled ? auditPendingLabelV1(current.count) : null;
}
