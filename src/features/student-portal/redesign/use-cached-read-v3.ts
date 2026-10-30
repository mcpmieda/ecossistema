import { useCallback, useEffect, useRef, useState } from 'react';
import { FrequencyClientErrorV2 } from '../frequency/client-v2';

/** A page's data older than this is read again when the page is opened (or the phone comes back). */
const STALE_AFTER_MS_V3 = 10 * 60_000;

/**
 * One read with the sign-in, kept on screen (owner request 22/10/2026: "não pode piscar"). The
 * Frequência and Horário pages are read once when the portal opens, like the grades, so opening
 * them or changing months shows the data at once and asks nothing of the server. When the page is
 * opened again, or the phone comes back to it, data older than ten minutes is read again in the
 * background, the old data staying on screen until the new arrives. Nothing is read while hidden.
 * An expired session or a policy turned off clears what was shown; other failures keep it.
 */
export function useCachedReadV3<T>(
  read: (signal: AbortSignal) => Promise<T>,
  active: boolean,
  onUnauthenticated?: () => void,
) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const readAt = useRef(0);
  const running = useRef<AbortController | null>(null);
  const lost = useRef(onUnauthenticated);
  useEffect(() => {
    lost.current = onUnauthenticated;
  }, [onUnauthenticated]);
  const run = useCallback(async () => {
    if (running.current || document.visibilityState === 'hidden') return;
    const controller = new AbortController();
    running.current = controller;
    try {
      const data = await read(controller.signal);
      if (controller.signal.aborted) return;
      readAt.current = Date.now();
      setState({ data, error: null });
    } catch (reason) {
      if (controller.signal.aborted) return;
      const code = reason instanceof FrequencyClientErrorV2 ? reason.state : 'unavailable';
      const blocked = code === 'unauthenticated' || code === 'forbidden';
      setState((current) => ({ data: blocked ? null : current.data, error: code }));
      if (code === 'unauthenticated') lost.current?.();
    } finally {
      if (running.current === controller) running.current = null;
    }
  }, [read]);
  // The first read, with the sign-in.
  useEffect(() => {
    void run();
    return () => {
      running.current?.abort();
      running.current = null;
    };
  }, [run]);
  // Opened again, or back on screen: read again only when what is shown is old (or failed).
  useEffect(() => {
    const refresh = () => {
      if (active && document.visibilityState !== 'hidden' && Date.now() - readAt.current > STALE_AFTER_MS_V3)
        void run();
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [active, run]);
  return { ...state, retry: () => void run() };
}
