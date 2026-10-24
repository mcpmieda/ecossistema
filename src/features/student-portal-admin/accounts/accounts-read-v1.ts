import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import {
  createLatestPortalRequestV1,
  type PortalLoadStateV1,
} from '../../student-portal/shared/latest-request-v1';

/** Owning views remain keyed by filters/scope/identity. Background reads never reuse another
 * context's data. Pure reads only; previews and writes must not use this hook.
 */
export function useAccountsReadV1<T>(
  load: (signal: AbortSignal) => Promise<T>,
  active = true,
  eventDriven = true,
  intervalMs?: number,
) {
  const [result, setResult] = useState<{ load: typeof load; state: PortalLoadStateV1<T> }>({
    load,
    state: { state: 'idle' },
  });
  const deadline = useRef(0);
  const state: PortalLoadStateV1<T> = result.load === load ? result.state : { state: 'loading' };
  const [clock, setClock] = useState(0);
  const reader = useMemo(
    () =>
      createLatestPortalRequestV1<T>((next) => {
        let error;
        if (next.state === 'error') {
          error = next.error;
        } else if (next.state === 'ready') {
          error = next.refreshError;
        } else {
          error = undefined;
        }
        deadline.current = error
          ? Date.now() + Math.max(5, error.retryAfterSeconds ?? 0) * 1000
          : 0;
        setResult({ load, state: next });
      }),
    [load],
  );
  useEffect(() => {
    deadline.current = 0;
    void reader.run(load);
    return () => reader.clear();
  }, [reader, load]);
  let error;
  if (state.state === 'error') {
    error = state.error;
  } else if (state.state === 'ready') {
    error = state.refreshError;
  } else {
    error = undefined;
  }
  useEffect(() => {
    if (!error) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [error]);
  useLiveRefreshV1(() => reader.run(load, { background: true }), {
    active,
    eventDriven,
    intervalMs,
    domains: ['portal', 'gradebook'],
    canRefresh: () =>
      Date.now() >= deadline.current &&
      (state.state === 'idle' ||
        (state.state === 'ready' && !state.refreshing) ||
        (state.state === 'error' &&
          ['network-error', 'unavailable', 'rate-limited'].includes(state.error.state))),
  });
  return {
    state,
    refreshing: state.state === 'ready' && Boolean(state.refreshing),
    refreshError: state.state === 'ready' ? state.refreshError : undefined,
    canReload: state.state !== 'loading' && (!error || clock >= deadline.current),
    reload: () => {
      if (Date.now() >= deadline.current)
        void reader.run(load, { background: state.state === 'ready' });
    },
    clear: reader.clear,
  };
}
