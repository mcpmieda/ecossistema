import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { z } from 'zod';
import { PLATFORM_CAPABILITIES, type PlatformCapability } from '../../shared/platform-contract';

export type PlatformIdentityV1 = {
  authenticated: boolean;
  name?: string;
  roles?: string[];
  capabilities?: PlatformCapability[];
  identityKey?: string;
  expiresAt?: string;
};
const identityResponse = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false) }),
  z.object({ authenticated: z.literal(true), name: z.string().optional(), roles: z.array(z.string()).optional(),
    capabilities: z.array(z.enum(PLATFORM_CAPABILITIES)),
    identityKey: z.string().min(1).max(160).optional(), expiresAt: z.iso.datetime({ offset: true }).optional() }),
]);
const FORBIDDEN = Symbol('identity-forbidden');
const isCurrent = (identity: PlatformIdentityV1 | null) => identity?.authenticated === true
  && (identity.expiresAt === undefined || Date.parse(identity.expiresAt) > Date.now());

/** Existing /api/me identity, not a new session or permission system. No browser storage.
 * Background failure preserves only an unexpired identity; confirmed denial clears it.
 */
export function usePlatformIdentityV1() {
  const [identity, setIdentity] = useState<PlatformIdentityV1 | null>(null);
  const [accessError, setAccessError] = useState(false);
  const known = useRef<PlatformIdentityV1 | null>(null);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const lastAt = useRef(-Infinity);
  const mounted = useRef(false);
  const stop = useCallback(() => {
    generation.current++;
    active.current?.abort();
    active.current = null;
  }, []);
  const refresh = useCallback(async (force = false) => {
    if (!mounted.current || (!force && (active.current || Date.now() - lastAt.current < 10_000))) return;
    stop();
    lastAt.current = Date.now();
    const current = generation.current;
    const controller = new AbortController();
    active.current = controller;
    const timeout = new AbortController();
    const deadline = setTimeout(() => timeout.abort(), 15_000);
    const signal = AbortSignal.any([controller.signal, timeout.signal]);
    if (!isCurrent(known.current)) { known.current = null; setIdentity(null); }
    setAccessError(false);
    let onAbort: (() => void) | undefined;
    try {
      // Race the complete body read too, even if a mock/transport ignores cancellation.
      const result = await Promise.race([
        (async () => {
          const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
          signal.throwIfAborted();
          if (response.status === 401) return { authenticated: false } as const;
          if (response.status === 403) throw FORBIDDEN;
          if (!response.ok) throw new Error('identity-unavailable');
          return identityResponse.parse(await response.json());
        })(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new DOMException('Identity read cancelled', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
      signal.throwIfAborted();
      if (!mounted.current || current !== generation.current) return;
      if (result.authenticated && result.expiresAt && Date.parse(result.expiresAt) <= Date.now())
        throw FORBIDDEN;
      // The same identity keeps the object already shown, so the Centro does not render again.
      if (JSON.stringify(known.current) === JSON.stringify(result)) return;
      known.current = result;
      setIdentity(result);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current || current !== generation.current) return;
      if (error === FORBIDDEN || !isCurrent(known.current)) {
        known.current = null;
        setIdentity(null);
        setAccessError(true);
      }
    } finally {
      clearTimeout(deadline);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (active.current === controller) active.current = null;
    }
  }, [stop]);
  useEffect(() => {
    mounted.current = true;
    const focus = () => {
      if (document.visibilityState !== 'hidden' && navigator.onLine !== false) void refresh();
    };
    const hide = () => {
      stop(); known.current = null;
      flushSync(() => { setIdentity(null); setAccessError(false); });
    };
    const show = () => { if (document.visibilityState !== 'hidden') void refresh(true); };
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', focus);
    void refresh(true);
    return () => {
      mounted.current = false; stop();
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [refresh, stop]);
  useEffect(() => {
    if (!identity?.authenticated || !identity.expiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const left = Date.parse(identity.expiresAt!) - Date.now();
      if (left <= 0) { void refresh(true); return; }
      timer = setTimeout(check, Math.min(left, 2147483647));
    };
    check();
    return () => clearTimeout(timer);
  }, [identity, refresh]);
  const recheck = useCallback(() => { void refresh(true); }, [refresh]);
  return { identity, accessError, retry: recheck, recheck };
}
