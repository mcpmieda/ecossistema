import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { z } from 'zod';
import { PLATFORM_CAPABILITIES } from '../../../../shared/platform-contract';
import {
  hasPortalNoStoreV1,
  PortalClientErrorV1,
  type PortalFetchV1,
} from '../../student-portal/shared/transport-v1';

const identitySchema = z.object({
  authenticated: z.literal(true),
  identityKey: z.string().min(1).max(160),
  expiresAt: z.iso.datetime(),
  capabilities: z.array(z.enum(PLATFORM_CAPABILITIES)),
});
export type PortalAdminIdentityV1 = z.infer<typeof identitySchema>;
type IdentityStateV1 =
  | { state: 'checking' | 'paused' }
  | { state: 'ready'; identity: PortalAdminIdentityV1 }
  | { state: 'error'; error: PortalClientErrorV1 };
const defaultFetch: PortalFetchV1 = (path, init) => fetch(path, init);

/** Same Entra session and capabilities as the Center; this is a fresh read, never a new role system. */
/** No session is 401, no access 403; anything else not OK or cacheable is unavailable. */
function checkIdentityResponseV1(response: Response) {
  if (response.status === 401) throw new PortalClientErrorV1('unauthenticated', 401);
  if (response.status === 403) throw new PortalClientErrorV1('forbidden', 403);
  if (!response.ok || !hasPortalNoStoreV1(response.headers))
    throw new PortalClientErrorV1('unavailable');
}

export function usePortalAdminIdentityV1(fetcher: PortalFetchV1 = defaultFetch) {
  const [state, setState] = useState<IdentityStateV1>({ state: 'checking' });
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const knownIdentity = useRef<PortalAdminIdentityV1 | null>(null);
  const stop = useCallback((preserveDeadline = false) => {
    generation.current++;
    active.current?.abort();
    active.current = null;
    if (!preserveDeadline) clearTimeout(expiry.current);
  }, []);
  const lost = useCallback(
    (error = new PortalClientErrorV1('unauthenticated', 401)) => {
      stop();
      knownIdentity.current = null;
      setState({ state: 'error', error });
    },
    [stop],
  );
  const refresh = useCallback(
    async (background = false) => {
      if (background && active.current) return;
      const preserve =
        background &&
        knownIdentity.current !== null &&
        Date.parse(knownIdentity.current.expiresAt) > Date.now();
      stop(preserve);
      const current = generation.current;
      const controller = new AbortController();
      active.current = controller;
      if (!preserve) {
        knownIdentity.current = null;
        setState({ state: 'checking' });
      }
      try {
        const response = await fetcher('/api/me', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        controller.signal.throwIfAborted();
        checkIdentityResponseV1(response);
        const identity = identitySchema.parse(await response.json());
        controller.signal.throwIfAborted();
        if (generation.current !== current) return;
        if (!identity.capabilities.includes('platform.settings.read'))
          throw new PortalClientErrorV1('forbidden', 403);
        const remaining = Date.parse(identity.expiresAt) - Date.now();
        if (remaining <= 0) throw new PortalClientErrorV1('unauthenticated', 401);
        knownIdentity.current = identity;
        setState({ state: 'ready', identity });
        clearTimeout(expiry.current);
        // Recheck the server deadline: a capped browser timer is not session expiration.
        const checkExpiry = () => {
          if (knownIdentity.current !== identity) return;
          const left = Date.parse(identity.expiresAt) - Date.now();
          if (left <= 0) lost();
          else expiry.current = setTimeout(checkExpiry, Math.min(left, 2147483647));
        };
        checkExpiry();
      } catch (error) {
        if (controller.signal.aborted || generation.current !== current) return;
        lost(error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('unavailable'));
      } finally {
        if (active.current === controller) active.current = null;
      }
    },
    [fetcher, lost, stop],
  );
  useEffect(() => {
    const hide = () => {
      stop();
      knownIdentity.current = null;
      flushSync(() => setState({ state: 'paused' }));
    };
    const resume = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const focus = () => {
      if (document.visibilityState !== 'hidden') void refresh(true);
    };
    const visibility = () => {
      if (document.visibilityState !== 'hidden') focus();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    resume();
    return () => {
      stop();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [refresh, stop]);
  return { state, refresh, lost };
}

/** Observe status before a module decodes an error; a late aborted response cannot clear a new identity. */
export function authorizationAwareFetchV1(
  onLost: (error: PortalClientErrorV1) => void,
  fetcher: PortalFetchV1 = defaultFetch,
): PortalFetchV1 {
  return async (path, init) => {
    const response = await fetcher(path, init);
    if (!init.signal?.aborted && (response.status === 401 || response.status === 403))
      onLost(
        new PortalClientErrorV1(
          response.status === 401 ? 'unauthenticated' : 'forbidden',
          response.status,
        ),
      );
    return response;
  };
}
