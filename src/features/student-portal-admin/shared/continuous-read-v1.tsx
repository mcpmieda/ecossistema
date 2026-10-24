import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Button, Spinner } from '@heroui/react';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { useOperationalReadV1 } from '../overview/operations-values-v1';
import { useLiveRefreshScopeV1 } from '../../../shared/live-data/live-refresh-scope-v1';

type CursorPage = { items: unknown[]; nextCursor: string | null };
type CollectionOptions = { maxPages?: number; cursors?: Set<string | undefined> };
const INITIAL_ROWS = 100;
/** Collection/revalidation helper. The owning hook gives initial/append reads a one-page
 * budget, even for empty filtered pages, and keeps cursor history across incremental reads. */
export async function collectCursorPagesV1<P extends CursorPage>(
  loadPage: (cursor: string | undefined, signal: AbortSignal) => Promise<P>,
  signal: AbortSignal,
  key: string,
  seed: P | null = null,
  desired = INITIAL_ROWS,
  options: CollectionOptions = {},
): Promise<P> {
  signal.throwIfAborted();
  if (seed && !seed.nextCursor) return seed;
  let cursor = seed?.nextCursor ?? undefined;
  let result: P | null = seed;
  const items = new Map<string, P['items'][number]>();
  for (const item of seed?.items ?? [])
    items.set(String((item as Record<string, unknown>)[key]), item);
  const seen = options.cursors ?? new Set<string | undefined>();
  const maxPages = options.maxPages ?? Math.max(20, Math.ceil(desired / 100) + 10);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1)
    throw new PortalClientErrorV1('invalid-request');
  let added = 0;
  for (let page = 0; page < maxPages; page++) {
    signal.throwIfAborted();
    if (seen.has(cursor)) throw new PortalClientErrorV1('invalid-response');
    seen.add(cursor);
    const value = await loadPage(cursor, signal);
    signal.throwIfAborted();
    if (value.nextCursor && seen.has(value.nextCursor))
      throw new PortalClientErrorV1('invalid-response');
    for (const item of value.items) {
      const id = (item as Record<string, unknown>)[key];
      if (typeof id !== 'string' && typeof id !== 'number')
        throw new PortalClientErrorV1('invalid-response');
      if (!items.has(String(id))) added++;
      items.set(String(id), item);
    }
    result = { ...value, items: [...items.values()] };
    if (!value.nextCursor || added >= desired) return result;
    cursor = value.nextCursor;
  }
  // A page budget is not a complete-result claim: always retain its continuation.
  if (!result) throw new PortalClientErrorV1('invalid-response');
  return result;
}

export function useContinuousReadV1<P extends CursorPage>(
  loadPage: (cursor: string | undefined, signal: AbortSignal) => Promise<P>,
  key: string,
  onAuthorizationLost?: (error: PortalClientErrorV1) => void,
  active = true,
  eventDriven = true,
  pageSize = INITIAL_ROWS,
) {
  const cache = useMemo(
    () => ({
      data: null as P | null,
      append: false,
      fetchedAt: 0,
      cursors: new Set<string | undefined>(),
    }),
    [loadPage, key],
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      const append = cache.append;
      const seed = append && Date.now() - cache.fetchedAt < 240_000 ? cache.data : null;
      let desired;
      if (append && !seed) {
        desired = (cache.data?.items.length ?? 0) + pageSize;
      } else if (seed) {
        desired = pageSize;
      } else {
        desired = Math.max(pageSize, cache.data?.items.length ?? 0);
      }
      // Rebuild only the previously visited window; a fresh append adds one bounded page.
      const maxPages = seed || !cache.data ? 1 : Math.max(1, cache.cursors.size) + (append ? 1 : 0);
      const cursors = seed ? new Set(cache.cursors) : new Set<string | undefined>();
      cache.append = false;
      try {
        const data = await collectCursorPagesV1(loadPage, signal, key, seed, desired, {
          maxPages,
          cursors,
        });
        signal.throwIfAborted();
        cache.data = data;
        cache.cursors = cursors;
        cache.fetchedAt = Date.now();
        return data;
      } catch (error) {
        if (
          error instanceof PortalClientErrorV1 &&
          ['unauthenticated', 'forbidden'].includes(error.state)
        ) {
          cache.data = null;
          cache.cursors.clear();
        }
        throw error;
      }
    },
    [cache, loadPage, key, pageSize],
  );
  const read = useOperationalReadV1(load, onAuthorizationLost, active, eventDriven);
  useEffect(() => {
    const clear = () => {
      cache.data = null;
      cache.append = false;
      cache.cursors.clear();
    };
    window.addEventListener('pagehide', clear);
    return () => {
      clear();
      window.removeEventListener('pagehide', clear);
    };
  }, [cache]);
  return {
    ...read,
    more: active && read.state.state === 'ready' && Boolean(read.state.data.nextCursor),
    loadMore: () => {
      if (
        read.state.state !== 'ready' ||
        read.refreshing ||
        !read.canReload ||
        !read.state.data.nextCursor
      )
        return;
      cache.append = true;
      read.reload();
    },
  };
}

export function ContinuousEndV1({
  more,
  busy,
  failed,
  loadMore,
  retry,
}: Readonly<{
  more: boolean;
  busy: boolean;
  failed?: boolean;
  loadMore: () => void;
  retry?: () => void;
}>) {
  const active = useLiveRefreshScopeV1();
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(loadMore);
  latest.current = loadMore;
  useEffect(() => {
    if (!active || !more || busy || failed || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      latest.current();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: '500px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [active, more, busy, failed]);
  return (
    <div ref={ref} className="pa-continuous-end" role="status">
      {failed && more ? (
        <Button size="sm" variant="ghost" onPress={retry}>
          Tentar carregar novamente
        </Button>
      ) : more && busy ? (
        <>
          <Spinner size="sm" />
          <span>Carregando mais registros…</span>
        </>
      ) : more ? (
        <span>Role para carregar mais registros.</span>
      ) : null}
    </div>
  );
}
