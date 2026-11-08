import { useEffect, useRef } from 'react';
import {
  subscribeLiveRefreshV1,
  type LiveDomainV1,
  type LiveRefreshSubscriptionV1,
} from './live-refresh-v1';
import {
  useLiveRefreshAutomaticV1,
  useLiveRefreshIntervalV1,
  useLiveRefreshScopeV1,
} from './live-refresh-scope-v1';

/** Readers own scope, authorization, cancellation and dirty fields. Pausing a workspace
 * retains its subscription/cooldown and does not interrupt any write or destroy its state.
 */
export function useLiveRefreshV1(
  refresh: () => void | Promise<unknown>,
  options: {
    domains: readonly LiveDomainV1[];
    enabled?: boolean;
    /** Retains cooldown while a mounted consumer is temporarily hidden. */
    active?: boolean;
    canRefresh?: () => boolean;
    intervalMs?: number;
  },
) {
  const scopeActive = useLiveRefreshScopeV1();
  const automatic = useLiveRefreshAutomaticV1();
  const active = scopeActive && options.active !== false;
  const scopeInterval = useLiveRefreshIntervalV1();
  const current = useRef({ refresh, canRefresh: options.canRefresh, active, automatic });
  const subscription = useRef<LiveRefreshSubscriptionV1 | null>(null);
  useEffect(() => {
    current.current = { refresh, canRefresh: options.canRefresh, active, automatic };
  });
  // Runs before installing a new subscription: readers that already re-fetch on enable
  // do not receive another initial request. Retained hidden readers resume through the clock.
  useEffect(() => {
    subscription.current?.resume();
  }, [active]);
  const domainsKey = options.domains.join(','),
    enabled = options.enabled !== false;
  const interval = options.intervalMs ?? scopeInterval;
  useEffect(() => {
    if (!enabled) return;
    const control = subscribeLiveRefreshV1({
      domains: domainsKey
        .split(',')
        .filter((domain): domain is LiveDomainV1 => domain === 'gradebook' || domain === 'portal'),
      intervalMs: interval,
      refresh: () => current.current.refresh(),
      canRefresh: () => current.current.canRefresh?.() ?? true,
      isActive: () => current.current.active,
      automatic: () => current.current.automatic,
    });
    subscription.current = control;
    return () => {
      if (subscription.current === control) subscription.current = null;
      control();
    };
  }, [domainsKey, enabled, interval]);
}
