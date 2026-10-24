import { useCallback, useEffect, useMemo } from 'react';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { ADMIN_ACCOUNTS_PAGE_SIZE_V2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { PortalAdminReadClientV2 } from './accounts-client-v2';
import { useAccountsReadV1 } from './accounts-read-v1';
import {
  LIVE_HEAVY_READ_INTERVAL_V1,
  subscribeLiveChangesV1,
} from '../../../shared/live-data/live-refresh-v1';

/** Seals each student sees on the Portal; null when no marks are shown to that student. */
export type SealCountsV1 = ReadonlyMap<string, number | null>;
type SealTargetV1 = Extract<ScopeV1, { kind: 'class' | 'account' }> | { accountIds: string[] };
const MAX_CACHED_BATCHES_V1 = 32;
function pruneEntriesV1(cache: SealCountsCacheV1) {
  const now = Date.now();
  for (const [key, saved] of cache.entries)
    if (now - saved.at >= 60_000) cache.entries.delete(key);
  while (cache.entries.size > MAX_CACHED_BATCHES_V1)
    cache.entries.delete(cache.entries.keys().next().value!);
}
function targetKeyV1(target: SealTargetV1) {
  if ('accountIds' in target) return 'accounts:' + target.accountIds.join(',');
  return target.kind === 'account' ? 'account:' + target.accountId : 'class:' + target.classId;
}
export type SealReadStateV1 =
  | { state: 'idle' | 'loading' }
  | {
      state: 'ready';
      counts: SealCountsV1;
      refreshing?: boolean;
      refreshError?: PortalClientErrorV1;
    }
  | { state: 'error'; error: PortalClientErrorV1 };

export interface SealCountsCacheV1 {
  reader: PortalAdminReadClientV2;
  entries: Map<string, { at: number; items: Awaited<ReturnType<typeof readSealsV1>> }>;
  generation: number;
  revision: string | number | undefined;
  clear: () => void;
  invalidate: () => void;
  retainPending: (targets: readonly SealTargetV1[]) => void;
  read: (
    scope: SealTargetV1,
  ) => Promise<Awaited<ReturnType<typeof readSealsV1>>>;
}

/** A list owns this memory across filter changes; a standalone record owns its own. */
export function useSealCountsCacheV1(
  reader: PortalAdminReadClientV2,
  supplied?: SealCountsCacheV1,
) {
  const cache = useMemo(() => {
    if (supplied?.reader === reader) return supplied;
    // Two lanes belong to the list, so filter changes can join pending reads without restarting them.
    let nextLane = 0;
    let lanes = [Promise.resolve(), Promise.resolve()];
    const pending = new Map<
      string,
      {
        controller: AbortController;
        promise: Promise<Awaited<ReturnType<typeof readSealsV1>>>;
      }
    >();
    const value: SealCountsCacheV1 = {
      reader,
      entries: new Map(),
      generation: 0,
      revision: undefined,
      retainPending: (targets) => {
        const keys = new Set(targets.map(targetKeyV1));
        for (const [key, job] of pending) {
          if (keys.has(key)) continue;
          job.controller.abort();
          pending.delete(key);
        }
      },
      invalidate: () => {
        value.entries.clear();
        value.generation++;
      },
      clear: () => {
        value.invalidate();
        for (const job of pending.values()) job.controller.abort();
        pending.clear();
        lanes = [Promise.resolve(), Promise.resolve()];
        nextLane = 0;
      },
      read: (scope) => {
        const key = targetKeyV1(scope);
        pruneEntriesV1(value);
        const saved = value.entries.get(key);
        if (saved) {
          value.entries.delete(key);
          value.entries.set(key, saved);
          return Promise.resolve(saved.items);
        }
        const existing = pending.get(key);
        if (existing) return existing.promise;
        const controller = new AbortController();
        let generation = value.generation;
        const lane = nextLane++ % 2;
        const task = lanes[lane]!.then(async () => {
          controller.signal.throwIfAborted();
          generation = value.generation;
          const items = await readSealsV1(reader, scope, controller.signal);
          controller.signal.throwIfAborted();
          if (generation === value.generation) {
            value.entries.set(key, { at: Date.now(), items });
            pruneEntriesV1(value);
          }
          return items;
        }).finally(() => {
          if (pending.get(key)?.controller === controller) pending.delete(key);
        });
        lanes[lane] = task.then(
          () => undefined,
          () => undefined,
        );
        const promise = task.then((items) => {
          controller.signal.throwIfAborted();
          return generation === value.generation ? items : value.read(scope);
        });
        pending.set(key, { controller, promise });
        return promise;
      },
    };
    return value;
  }, [reader, supplied]);
  useEffect(() => {
    if (supplied === cache) return;
    const unsubscribe = subscribeLiveChangesV1(cache.invalidate);
    window.addEventListener('pagehide', cache.clear);
    return () => {
      cache.clear();
      unsubscribe();
      window.removeEventListener('pagehide', cache.clear);
    };
  }, [cache, supplied]);
  return cache;
}

async function readSealsV1(
  reader: PortalAdminReadClientV2,
  target: SealTargetV1,
  signal: AbortSignal,
) {
  const result = await reader.query(
    { contractVersion: 2, operation: 'seals-read', page: { limit: 100 },
      ...('accountIds' in target
        ? { scope: { kind: 'school' as const, academicYear: 2026 as const }, accountIds: target.accountIds }
        : { scope: target }),
    },
    signal,
  );
  if (result.state !== 'seals-read') throw new PortalClientErrorV1('invalid-response');
  return result.items;
}

/**
 * Selos brilhantes for a record or a list (owner request 29/09/2026). The server counts one
 * record or up to 400 selected accounts per read; two batches may be in flight.
 */
export function useSealCountsV1(
  reader: PortalAdminReadClientV2,
  target: { accountId: string } | { classIds: readonly number[] } | { accountIds: readonly string[] } | null,
  options: { active?: boolean; revision?: string | number; cache?: SealCountsCacheV1 } = {},
): SealReadStateV1 {
  let key;
  if (target === null) {
    key = null;
  } else if ('accountId' in target) {
    key = 'account:' + target.accountId;
  } else if ('accountIds' in target) {
    key = 'accounts:' + [...new Set(target.accountIds)].join(',');
  } else {
    key = 'classes:' + [...new Set(target.classIds)].sort((a, b) => a - b).join(',');
  }
  // Owned by the mounted list/record, never persisted or shared between administrators.
  const cache = useSealCountsCacheV1(reader, options.cache);
  const revision = options.revision;
  const active = options.active !== false;
  const load = useCallback(
    async (signal: AbortSignal): Promise<SealCountsV1> => {
      if (key === null) {
        cache.retainPending([]);
        return new Map();
      }
      if (revision !== undefined && revision !== cache.revision) {
        cache.clear();
        cache.revision = revision;
      }
      signal.throwIfAborted();
      let scopes: SealTargetV1[];
      if (key.startsWith('account:')) {
        scopes = [{ kind: 'account', academicYear: 2026, accountId: key.slice(8) }];
      } else if (key.startsWith('accounts:')) {
        scopes = accountBatchesV1(key.slice(9));
      } else {
        scopes = key
            .slice(8)
            .split(',')
            .filter(Boolean)
            .map((id) => ({
              kind: 'class',
              academicYear: 2026,
              classId: Number(id),
            }));
      }
      const counts = new Map<string, number | null>();
      cache.retainPending(active ? scopes : []);
      if (!active) {
        for (const scope of scopes) {
          const saved = cache.entries.get(targetKeyV1(scope));
          for (const item of saved?.items ?? []) counts.set(item.accountId, item.seals);
        }
        return counts;
      }
      try {
        const groups = await Promise.all(scopes.map((scope) => cache.read(scope)));
        signal.throwIfAborted();
        for (const items of groups)
          for (const item of items) counts.set(item.accountId, item.seals);
      } catch (error) {
        if (!signal.aborted) {
          cache.clear();
        }
        throw error;
      }
      return counts;
    },
    [reader, key, cache, revision, active],
  );
  const read = useAccountsReadV1(
    load,
    key !== null && options.active !== false,
    true,
    LIVE_HEAVY_READ_INTERVAL_V1,
  );
  useEffect(() => {
    const clear = () => read.clear();
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, [read.clear]);
  if (key === null) return { state: 'idle' };
  return read.state.state === 'ready'
    ? {
        state: 'ready',
        counts: read.state.data,
        refreshing: read.refreshing,
        refreshError: read.refreshError,
      }
    : read.state;
}

export function sealLabelV1(count: number) {
  return `${count} ${count === 1 ? 'selo Brilhante' : 'selos Brilhante'}`;
}

function accountBatchesV1(ids: string): SealTargetV1[] {
  const values = ids.split(',').filter(Boolean);
  const batches: SealTargetV1[] = [];
  for (let offset = 0; offset < values.length; offset += ADMIN_ACCOUNTS_PAGE_SIZE_V2)
    batches.push({ accountIds: values.slice(offset, offset + ADMIN_ACCOUNTS_PAGE_SIZE_V2) });
  return batches;
}
