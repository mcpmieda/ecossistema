import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import { createLatestPortalRequestV1, type PortalLoadStateV1 } from '../shared/latest-request-v1';
import type { PortalSelfClientV1 } from '../shared/self-client-v1';
import { PortalClientErrorV1 } from '../shared/transport-v1';
import { createStudentSecurityV1 } from './student-security-v1';

export type LogoutStateV1 = 'idle' | 'pending' | 'failed' | 'done';
export function createStudentSessionV1(
  client: PortalSelfClientV1,
  publish: (load: PortalLoadStateV1<SelfResponseV1>) => void,
  logoutState: (state: LogoutStateV1) => void,
  now: () => number = Date.now,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiresAt = 0,
    blocked = false,
    disposed = false;
  let logoutRequest: AbortController | undefined;
  let lastLoad: PortalLoadStateV1<SelfResponseV1> = { state: 'idle' };
  let preserve = false;
  let pending: Promise<boolean | undefined> | undefined;
  let securityGeneration = 0;
  let securityVerifiedAt = 0;
  const checkExpiry = () => {
    if (disposed) return;
    if (expiresAt > now()) {
      timer = setTimeout(checkExpiry, Math.min(2147483647, expiresAt - now()));
      return;
    }
    latest.clear();
    publish({ state: 'error', error: new PortalClientErrorV1('unauthenticated', 401) });
  };
  const latest = createLatestPortalRequestV1<SelfResponseV1>((load) => {
    if (disposed) return;
    if (preserve && (load.state === 'loading' || (load.state === 'ready' && load.refreshing)))
      return;
    lastLoad = load;
    clearTimeout(timer);
    publish(load);
    if (load.state === 'ready')
      timer = setTimeout(checkExpiry, Math.min(2147483647, Math.max(0, expiresAt - now())));
  });
  const clear = () => {
    securityGeneration += 1;
    pending = undefined;
    clearTimeout(timer);
    latest.clear();
  };
  const acceptSecurityAuthorization = (expiry: string, accountId: string, startedAt: number) => {
    if (
      blocked ||
      disposed ||
      lastLoad.state !== 'ready' ||
      lastLoad.data.profile.accountId !== accountId ||
      startedAt < securityVerifiedAt
    )
      return false;
    const end = Date.parse(expiry);
    if (!Number.isFinite(end) || end <= now()) return false;
    securityVerifiedAt = startedAt;
    expiresAt = end;
    clearTimeout(timer);
    timer = setTimeout(checkExpiry, Math.min(2147483647, end - now()));
    return true;
  };
  const authorizeSecurity = async (signal: AbortSignal, connectionId?: string) => {
    if (blocked || disposed || lastLoad.state !== 'ready') return;
    const generation = securityGeneration;
    const accountId = lastLoad.data.profile.accountId;
    const startedAt = now();
    try {
      const result = await client.session(signal, accountId, connectionId);
      signal.throwIfAborted();
      if (disposed || generation !== securityGeneration) return;
      if (Date.parse(result.expiresAt) <= now())
        throw new PortalClientErrorV1('unauthenticated', 401);
      acceptSecurityAuthorization(result.expiresAt, accountId, startedAt);
      return result.liveRenewed;
    } catch (error) {
      if (
        signal.aborted ||
        disposed ||
        generation !== securityGeneration ||
        startedAt < securityVerifiedAt
      )
        return;
      if (
        error instanceof PortalClientErrorV1 &&
        (error.state === 'unauthenticated' ||
          error.state === 'access-closed' ||
          error.state === 'forbidden' ||
          error.status === 401 ||
          error.status === 403)
      ) {
        clear();
        publish({
          state: 'error',
          error:
            error.state === 'access-closed'
              ? error
              : new PortalClientErrorV1('unauthenticated', 401),
        });
      }
      throw error;
    }
  };
  const refresh = async (background = false) => {
    if (blocked || disposed) return;
    if (background && pending) return pending;
    preserve = background && lastLoad.state === 'ready' && expiresAt > now();
    const previousAccount = lastLoad.state === 'ready' ? lastLoad.data.profile.accountId : null;
    if (!preserve) clearTimeout(timer);
    const request = latest.run(
      async (signal) => {
        const startedAt = now();
        const session = await client.session(signal);
        signal.throwIfAborted();
        const data = await client.me(signal);
        signal.throwIfAborted();
        if (previousAccount !== null && previousAccount !== data.profile.accountId)
          throw new PortalClientErrorV1('unauthenticated', 401);
        if (startedAt >= securityVerifiedAt) {
          expiresAt = Date.parse(session.expiresAt);
          securityVerifiedAt = startedAt;
        }
        if (expiresAt <= now()) throw new PortalClientErrorV1('unauthenticated', 401);
        return data;
      },
      { background: preserve },
    );
    pending = request;
    try {
      return await request;
    } finally {
      if (pending === request) pending = undefined;
    }
  };
  return {
    clear,
    /** A server-confirmed frequency 401 invalidates ALL protected student state. */
    invalidateAuthorization() {
      if (disposed || blocked) return;
      blocked = true;
      clear();
      expiresAt = 0;
      preserve = false;
      lastLoad = { state: 'error', error: new PortalClientErrorV1('unauthenticated', 401) };
      publish(lastLoad);
    },
    authorizeSecurity,
    acceptSecurityAuthorization,
    /** Content was dropped on pagehide (never frozen in history); reload it on return. */
    restoredFromHistory() {
      clear();
      void refresh();
    },
    refresh,
    async authenticated() {
      blocked = false;
      logoutState('idle');
      await refresh();
    },
    async logout() {
      if (disposed || logoutRequest) return;
      blocked = true;
      clear();
      logoutState('pending');
      const controller = new AbortController();
      logoutRequest = controller;
      try {
        await client.logout(controller.signal);
        controller.signal.throwIfAborted();
        if (!disposed) {
          lastLoad = { state: 'idle' };
          expiresAt = 0;
          logoutState('done');
          publish({ state: 'error', error: new PortalClientErrorV1('unauthenticated', 401) });
        }
      } catch {
        if (!disposed && !controller.signal.aborted) {
          logoutState('failed');
          publish({ state: 'error', error: new PortalClientErrorV1('network-error') });
        }
      } finally {
        if (logoutRequest === controller) logoutRequest = undefined;
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      latest.clear();
      logoutRequest?.abort();
    },
  };
}

/** Read on entry or explicit action; a restored page must reauthorize its protected data. */
export function useStudentSessionV1(client: PortalSelfClientV1) {
  const [load, setLoad] = useState<PortalLoadStateV1<SelfResponseV1>>({ state: 'idle' });
  const [logoutState, setLogoutState] = useState<LogoutStateV1>('idle');
  const session = useRef<ReturnType<typeof createStudentSessionV1> | null>(null);
  useEffect(() => {
    const current = createStudentSessionV1(client, setLoad, setLogoutState);
    session.current = current;
    let hiddenByNavigation = false;
    // Clear synchronously before the browser can freeze protected data in its history cache.
    const hide = () => {
      hiddenByNavigation = true;
      flushSync(() => current.clear());
    };
    const show = (event: PageTransitionEvent) => {
      // The ordinary initial pageshow must not duplicate the entry request.
      if (!hiddenByNavigation && !event.persisted) return;
      hiddenByNavigation = false;
      current.restoredFromHistory();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    void current.refresh();
    return () => {
      current.dispose();
      session.current = null;
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [client]);
  const securityAccountId = load.state === 'ready' ? load.data.profile.accountId : null;
  useEffect(() => {
    if (!securityAccountId || !session.current) return;
    const current = session.current;
    const security = createStudentSecurityV1({
      connect: (connectionId) => {
        const url = new URL('/api/student/live', window.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('purpose', 'security');
        url.searchParams.set('accountId', securityAccountId);
        if (connectionId) url.searchParams.set('connectionId', connectionId);
        return new window.WebSocket(url);
      },
      authorize: current.authorizeSecurity,
      onAuthorized: (expiry, startedAt) =>
        current.acceptSecurityAuthorization(expiry, securityAccountId, startedAt),
    });
    return () => security.dispose();
  }, [securityAccountId, client]);
  return {
    load,
    logoutState,
    refresh: () => session.current?.refresh(),
    authenticated: () => session.current?.authenticated(),
    logout: () => session.current?.logout(),
    invalidateAuthorization: () => session.current?.invalidateAuthorization(),
  };
}
