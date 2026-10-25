import type { z } from 'zod';
import {
  bulkPreviewResponseV1,
  type BulkPreviewQueryV1,
} from '../../../../shared/student-portal-contracts/bulk-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import {
  isAmbiguousPortalResponseV1,
  PortalClientErrorV1,
} from '../../student-portal/shared/transport-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';

type Preview = z.infer<typeof bulkPreviewResponseV1>;
export type BulkItemV1 = Preview['items'][number] & {
  result: 'pending' | 'committed' | 'failed' | 'unknown' | 'skipped';
  error?: string;
};
export type BulkStateV1 = {
  phase: 'idle' | 'loading' | 'review' | 'running' | 'paused' | 'unknown' | 'done' | 'error';
  items: BulkItemV1[];
  total: number;
  /** Accounts the operation writes to: the whole class, or only the rows selected in the table. */
  targets?: number;
  error?: string;
  retryAt?: number;
};
/** Accounts written at once. Each write stays an independent, idempotent command with its own
 * CAS version, so running a few in parallel only removes waiting between them.
 */
export const BULK_CONCURRENCY_V1 = 6;

type PreviewEntryV1 = { item: BulkItemV1; proof: string };

/** Each page belongs to the same, still valid preview: its action and scope, version and size. */
function checkPreviewPageV1(
  response: Preview,
  query: Omit<BulkPreviewQueryV1, 'page'>,
  first: Preview | undefined,
) {
  if (
    response.action !== query.action ||
    settingsScopeKeyV1(response.scope) !== settingsScopeKeyV1(query.scope)
  )
    throw new PortalClientErrorV1('invalid-response');
  const base = first ?? response;
  if (
    response.scopeVersion !== base.scopeVersion ||
    response.totalCount !== base.totalCount ||
    response.createdAt !== base.createdAt ||
    response.expiresAt !== base.expiresAt ||
    Date.parse(response.expiresAt) <= Date.now()
  )
    throw new PortalClientErrorV1('conflict');
  return base;
}

/** The page's accounts, each once and in the class asked for; ineligible ones are skipped. */
function collectPreviewItemsV1(
  response: Preview,
  query: Omit<BulkPreviewQueryV1, 'page'>,
  ids: Set<string>,
  all: PreviewEntryV1[],
) {
  for (const item of response.items) {
    if (
      ids.has(item.accountId) ||
      (query.scope.kind === 'class' && item.classId !== query.scope.classId)
    )
      throw new PortalClientErrorV1('invalid-response');
    ids.add(item.accountId);
    all.push({
      item: { ...item, result: item.ineligibility ? 'skipped' : 'pending' },
      proof: response.proof,
    });
  }
}

/** No more accounts than announced, and a next page only after a non-empty, unseen one. */
function checkPreviewProgressV1(
  response: Preview,
  first: Preview,
  collected: number,
  cursors: ReadonlySet<string>,
) {
  if (
    collected > first.totalCount ||
    (response.nextCursor && (!response.items.length || cursors.has(response.nextCursor)))
  )
    throw new PortalClientErrorV1('invalid-response');
}

export function createStudentBulkControllerV1(
  client: PortalAdminClientV1,
  publish: (state: BulkStateV1) => void,
  onAuthorizationLost: (error: PortalClientErrorV1) => void,
) {
  let state: BulkStateV1 = { phase: 'idle', items: [], total: 0 };
  let disposed = false,
    stop = false;
  let active: AbortController | undefined;
  let prepared: { index: number; command: ReturnType<PortalAdminClientV1['prepareCommand']> }[] =
    [];
  const emit = (next: BulkStateV1) => {
    state = next;
    if (!disposed) publish(next);
  };
  const denied = (error: PortalClientErrorV1) =>
    error.state === 'unauthenticated' || error.state === 'forbidden';
  const failure = (error: unknown) =>
    error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');
  /** With `selected` (non-empty), only those accounts are written; otherwise the whole class. */
  const preview = async (
    query: Omit<BulkPreviewQueryV1, 'page'>,
    selected?: ReadonlySet<string>,
  ) => {
    if (disposed || state.phase === 'running' || state.phase === 'unknown') return;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    prepared = [];
    stop = false;
    emit({ phase: 'loading', items: [], total: 0 });
    try {
      let first: Preview | undefined;
      let cursor: string | undefined;
      const ids = new Set<string>(),
        cursors = new Set<string>();
      const all: PreviewEntryV1[] = [];
      do {
        const response = bulkPreviewResponseV1.parse(
          await client.query(
            { ...query, page: { limit: 100, ...(cursor ? { cursor } : {}) } },
            controller.signal,
          ),
        );
        controller.signal.throwIfAborted();
        first = checkPreviewPageV1(response, query, first);
        collectPreviewItemsV1(response, query, ids, all);
        checkPreviewProgressV1(response, first, all.length, cursors);
        emit({ phase: 'loading', items: [], total: first.totalCount });
        cursor = response.nextCursor ?? undefined;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (!first || all.length !== first.totalCount)
        throw new PortalClientErrorV1('invalid-response');
      const chosen = selected?.size ? all.filter(({ item }) => selected.has(item.accountId)) : all;
      prepared = chosen.flatMap(({ item, proof }, index) =>
        item.ineligibility
          ? []
          : [
              {
                index,
                command: client.prepareCommand({
                  contractVersion: 1,
                  operation: 'bulk-execute',
                  action: query.action,
                  proof,
                  accountId: item.accountId,
                  expectedVersion: item.version,
                  idempotencyKey: crypto.randomUUID(),
                  confirmed: true,
                }),
              },
            ],
      );
      emit({
        phase: 'review',
        items: chosen.map(({ item }) => item),
        total: chosen.length,
        targets: prepared.length,
      });
    } catch (error) {
      if (controller.signal.aborted || disposed) return;
      const issue = failure(error);
      prepared = [];
      emit({ phase: 'error', items: [], total: 0, error: issue.state });
      if (denied(issue)) onAuthorizationLost(issue);
    } finally {
      if (active === controller) active = undefined;
    }
  };
  const run = async () => {
    if (
      disposed ||
      !['review', 'paused', 'unknown'].includes(state.phase) ||
      Date.now() < (state.retryAt ?? 0)
    )
      return;
    stop = false;
    const controller = new AbortController();
    active = controller;
    emit({ ...state, phase: 'running', error: undefined, retryAt: undefined });
    const mark = (index: number, change: Partial<BulkItemV1>) => {
      const items = state.items.slice();
      items[index] = { ...items[index]!, ...change };
      emit({ ...state, items });
    };
    // Pending and uncertain items resume with their original prepared command (same key/bytes).
    const queue = prepared.filter(({ index }) =>
      ['pending', 'unknown'].includes(state.items[index]!.result),
    );
    let uncertain: PortalClientErrorV1 | undefined;
    let lost: PortalClientErrorV1 | undefined;
    /** A write that failed: lost access stops every worker (false); a throttled or ambiguous answer
     * leaves the item unknown and pauses the run after the writes already sent. */
    const settle = (index: number, issue: PortalClientErrorV1) => {
      if (denied(issue)) {
        lost = issue;
        return false;
      }
      const unclear =
        issue.state === 'rate-limited' ||
        issue.state === 'unavailable' ||
        isAmbiguousPortalResponseV1(issue);
      mark(index, { result: unclear ? 'unknown' : 'failed', error: issue.state });
      if (unclear) uncertain = issue;
      return true;
    };
    const worker = async () => {
      while (!disposed && !stop && !uncertain && !lost && !controller.signal.aborted) {
        const entry = queue.shift();
        if (!entry) return;
        try {
          await entry.command.execute(controller.signal);
          controller.signal.throwIfAborted();
          mark(entry.index, { result: 'committed', error: undefined });
        } catch (error) {
          if (disposed || controller.signal.aborted || !settle(entry.index, failure(error))) return;
        }
      }
    };
    await Promise.all(Array.from({ length: BULK_CONCURRENCY_V1 }, () => worker()));
    if (active === controller) active = undefined;
    if (disposed || controller.signal.aborted) return;
    if (lost) {
      emit({ phase: 'error', items: [], total: 0, error: lost.state });
      prepared = [];
      onAuthorizationLost(lost);
      return;
    }
    if (uncertain) {
      emit({
        ...state,
        phase: 'unknown',
        error: uncertain.state,
        retryAt: Date.now() + (uncertain.retryAfterSeconds ?? 0) * 1000,
      });
      return;
    }
    const left = prepared.some(({ index }) =>
      ['pending', 'unknown'].includes(state.items[index]!.result),
    );
    emit({ ...state, phase: left ? 'paused' : 'done' });
  };
  return {
    preview,
    run,
    finish() {
      if (state.phase === 'paused') {
        prepared = [];
        emit({ ...state, phase: 'done' });
      }
    },
    /** Leaves a finished or failed operation; nothing is running at that point. */
    close() {
      if (['done', 'error'].includes(state.phase)) {
        prepared = [];
        emit({ phase: 'idle', items: [], total: 0 });
      }
    },
    cancel() {
      stop = true;
      if (state.phase === 'loading' || state.phase === 'review') {
        active?.abort();
        prepared = [];
        emit({ phase: 'idle', items: [], total: 0 });
      }
    },
    dispose() {
      disposed = true;
      stop = true;
      active?.abort();
      prepared = [];
      state = { phase: 'idle', items: [], total: 0 };
    },
  };
}
