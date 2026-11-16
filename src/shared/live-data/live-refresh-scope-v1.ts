import { createContext, createElement, useContext, type ReactNode } from 'react';

const LiveRefreshActivityV1 = createContext(true);
const LiveRefreshIntervalV1 = createContext<number | undefined>(undefined);

/** Hidden workspaces remain mounted; only automatic reads are paused.
 * Nested scopes cannot reactivate a reader while an ancestor is inactive.
 * Cadence is a safety fallback, never a freshness or authorization guarantee.
 */
export function LiveRefreshScopeV1({
  active,
  intervalMs,
  children,
}: {
  readonly active: boolean;
  readonly intervalMs?: number;
  readonly children: ReactNode;
}) {
  const parentActive = useContext(LiveRefreshActivityV1);
  const parentInterval = useContext(LiveRefreshIntervalV1);
  return createElement(
    LiveRefreshActivityV1.Provider,
    { value: parentActive && active },
    createElement(
      LiveRefreshIntervalV1.Provider,
      { value: intervalMs ?? parentInterval },
      children,
    ),
  );
}

export function useLiveRefreshScopeV1(): boolean {
  return useContext(LiveRefreshActivityV1);
}

export function useLiveRefreshIntervalV1(): number | undefined {
  return useContext(LiveRefreshIntervalV1);
}

const LiveRefreshAutomaticV1 = createContext(true);

/** Pauses only automatic reads (events and cadence). Unlike an inactive scope, visible content
 * keeps its on-demand behavior, such as loading more rows while scrolling. */
export function LiveRefreshAutomaticV1Provider({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const parent = useContext(LiveRefreshAutomaticV1);
  return createElement(LiveRefreshAutomaticV1.Provider, { value: parent && enabled }, children);
}

export function useLiveRefreshAutomaticV1(): boolean {
  return useContext(LiveRefreshAutomaticV1);
}
