import { useCallback, useEffect, useRef, useState } from 'react';
import { FrequencyClientErrorV2 } from './client-v2';

/** A failed read: its state, and whether it is final (no session or no access: no retry). */
function readFailureV2(reason: unknown) {
  const state = reason instanceof FrequencyClientErrorV2 ? reason.state : 'unavailable';
  return {
    state,
    terminal:
      reason instanceof FrequencyClientErrorV2 &&
      ['unauthenticated', 'forbidden', 'not-authorized'].includes(reason.state),
  };
}

/** One request at a time; visibility/unmount fences every late completion. */
export function useFrequencyReadV2<T>(
  read: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  onUnauthenticated?: () => void,
) {
  const authenticationLost = useRef(onUnauthenticated);
  authenticationLost.current = onUnauthenticated;
  const [data, setData] = useState<T | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const current = useRef({
    generation: 0,
    active: false,
    pending: false,
    failures: 0,
    controller: null as AbortController | null,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const run = useCallback(
    async function request(action?: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
      const state = current.current;
      if (!state.active || state.pending || document.visibilityState === 'hidden') return false;
      state.pending = true;
      setPending(true);
      setError(null);
      clearTimeout(state.timer);
      const generation = ++state.generation;
      const controller = new AbortController();
      state.controller = controller;
      const valid = () =>
        state.active && generation === state.generation && !controller.signal.aborted;
      let committed = false;
      let terminal = false;
      let confirmed = false;
      try {
        if (action) {
          await action(controller.signal);
          committed = valid();
        }
        controller.signal.throwIfAborted();
        const result = await read(controller.signal);
        if (valid()) {
          setData(result);
          setReadAt(new Date().toISOString());
          state.failures = 0;
          confirmed = true;
        }
      } catch (reason) {
        if (valid()) {
          setData(null);
          setReadAt(null);
          state.failures += 1;
          const failure = readFailureV2(reason);
          setError(failure.state);
          terminal = failure.terminal;
          if (failure.state === 'unauthenticated') authenticationLost.current?.();
        }
      } finally {
        if (valid()) {
          state.pending = false;
          setPending(false);
          state.controller = null;
          const delay = Math.min(300_000, 30_000 * 2 ** Math.min(state.failures, 4));
          if (!terminal)
            state.timer = setTimeout(() => {
              void request();
            }, delay);
        }
      }
      return committed && confirmed;
    },
    [read],
  );
  useEffect(() => {
    const state = current.current;
    const stop = () => {
      state.active = false;
      state.generation += 1;
      state.controller?.abort();
      clearTimeout(state.timer);
      state.pending = false;
      setPending(false);
      setData(null);
      setReadAt(null);
      setError(null);
    };
    const visibility = () => {
      stop();
      if (enabled && document.visibilityState !== 'hidden') {
        state.active = true;
        void run();
      }
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [enabled, run]);
  return {
    data,
    readAt,
    error,
    pending,
    refresh: () => run(),
    perform: (action: (signal: AbortSignal) => Promise<void>) => run(action),
  };
}
