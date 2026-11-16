import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  platformSnapshotSchemaV2,
  type PlatformSnapshotV2,
} from '../../shared/platform-snapshot-v2';

export type PlatformLoadStateV2 =
  | { status: 'loading' }
  | { status: 'error'; message: string; correlationId?: string }
  | { status: 'ready'; snapshot: PlatformSnapshotV2 };
export const PLATFORM_BOOTSTRAP_TIMEOUT_MS_V2 = 10_000;
const BOOTSTRAP_PATH_V2 = '/api/platform/bootstrap';
const EARLY_READ_TTL_MS_V1 = 15_000;
const earlyReads = new Map<string, { at: number; response: Promise<Response> }>();
/** Starts the read together with the identity check so the first open does not wait for it.
 * The early answer is used once, only while fresh and successful; anything else is read again. */
export function prefetchPlatformDataV2(fetcher: typeof fetch = fetch, now = Date.now) {
  const response = fetcher(BOOTSTRAP_PATH_V2, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  response.catch(() => undefined);
  earlyReads.set(BOOTSTRAP_PATH_V2, { at: now(), response });
}
async function takeEarlyReadV1(path: string, now: () => number): Promise<Response | undefined> {
  const early = earlyReads.get(path);
  earlyReads.delete(path);
  if (!early || now() - early.at > EARLY_READ_TTL_MS_V1) return undefined;
  try {
    const response = await early.response;
    return response.ok ? response : undefined;
  } catch {
    return undefined;
  }
}
/** What a reading says, without what every reading changes (its time and its correlation). */
function snapshotContentV2(snapshot: PlatformSnapshotV2 | undefined): string {
  if (!snapshot) return '';
  const { generatedAt: _generatedAt, correlationId: _correlationId, ...content } = snapshot;
  return JSON.stringify(content);
}
/** When the Centro last read the platform data successfully, even if nothing changed. Only the footer
 * listens, so a reading with the same content does not render the screens again. */
let checkedAtV2 = '';
const checkedListenersV2 = new Set<() => void>();
function markCheckedV2(at: string) {
  if (at === checkedAtV2) return;
  checkedAtV2 = at;
  for (const listener of checkedListenersV2) listener();
}
export function usePlatformCheckedAtV2(): string {
  return useSyncExternalStore(
    (listener) => {
      checkedListenersV2.add(listener);
      return () => {
        checkedListenersV2.delete(listener);
      };
    },
    () => checkedAtV2,
    () => checkedAtV2,
  );
}
class ReadError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt = 0,
  ) {
    super('Platform data unavailable');
  }
}
/** Authenticated read of the authorized modules. There is no persisted permission cache or fallback user. */
export function createPlatformDataV2(
  publish: (state: PlatformLoadStateV2) => void,
  fetcher: typeof fetch = fetch,
  now = Date.now,
) {
  let generation = 0,
    stopped = false,
    retryAt = 0,
    pending = false;
  let snapshot: PlatformSnapshotV2 | undefined;
  let abort: AbortController | undefined;
  /** What was last published: a reading that says the same is not published again. */
  let published = '';
  const emit = () => {
    if (stopped || !snapshot) return;
    const shown = snapshotContentV2(snapshot);
    if (shown === published) return;
    published = shown;
    publish({ status: 'ready', snapshot });
  };
  async function read(parent: AbortSignal): Promise<PlatformSnapshotV2> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('Platform request timed out', 'TimeoutError')),
      PLATFORM_BOOTSTRAP_TIMEOUT_MS_V2,
    );
    const signal = AbortSignal.any([parent, timeout.signal]);
    let onAbort!: () => void;
    try {
      return await Promise.race([
        (async () => {
          signal.throwIfAborted();
          const response =
            (await takeEarlyReadV1(BOOTSTRAP_PATH_V2, now)) ??
            (await fetcher(BOOTSTRAP_PATH_V2, {
              credentials: 'same-origin',
              cache: 'no-store',
              redirect: 'error',
              signal,
            }));
          signal.throwIfAborted();
          if (!response.ok) {
            const header = response.headers.get('Retry-After');
            let deadline;
            if (header && /^\d+$/u.test(header)) {
              deadline = now() + Number(header) * 1000;
            } else if (header) {
              deadline = Date.parse(header);
            } else {
              deadline = 0;
            }
            throw new ReadError(response.status, Number.isFinite(deadline) ? deadline : 0);
          }
          const result = platformSnapshotSchemaV2.safeParse(await response.json());
          signal.throwIfAborted();
          if (!result.success) throw new ReadError(502);
          return result.data;
        })(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  function failAuthorization(error: unknown) {
    if (!(error instanceof ReadError) || ![401, 403].includes(error.status)) return false;
    stopped = true;
    snapshot = undefined;
    abort?.abort();
    publish({
      status: 'error',
      message: 'Sua autorização precisa ser verificada novamente. Entre novamente no Centro.',
    });
    return true;
  }
  /** A return of focus reads again in 2 min at the soonest; after a failure it follows the
   * server's Retry-After (30 s at least) and the page shown stays. */
  async function refresh() {
    if (stopped || pending || !snapshot || now() < retryAt) return;
    const own = generation,
      controller = new AbortController();
    abort = controller;
    pending = true;
    try {
      const value = await read(controller.signal);
      if (controller.signal.aborted || own !== generation || stopped) return;
      // The same content keeps the object already shown, so the screens do not render again.
      if (snapshotContentV2(value) !== snapshotContentV2(snapshot)) snapshot = value;
      markCheckedV2(value.generatedAt);
      retryAt = now() + 120_000;
      emit();
    } catch (error) {
      if (controller.signal.aborted || own !== generation || stopped) return;
      if (failAuthorization(error)) return;
      retryAt = Math.max(now() + 30_000, error instanceof ReadError ? error.retryAt : 0);
    } finally {
      if (own === generation) pending = false;
    }
  }
  async function start() {
    generation++;
    stopped = false;
    snapshot = undefined;
    pending = false;
    retryAt = 0;
    published = '';
    abort?.abort();
    publish({ status: 'loading' });
    const own = generation,
      controller = new AbortController();
    abort = controller;
    try {
      const value = await read(controller.signal);
      if (controller.signal.aborted || own !== generation || stopped) return;
      snapshot = value;
      markCheckedV2(value.generatedAt);
      retryAt = now() + 120_000;
      emit();
    } catch (error) {
      if (controller.signal.aborted || own !== generation || stopped) return;
      if (failAuthorization(error)) return;
      stopped = true;
      publish({
        status: 'error',
        message: 'Não foi possível carregar os módulos autorizados. Tente novamente.',
      });
    }
  }
  return {
    start,
    refresh,
    dispose() {
      generation++;
      stopped = true;
      snapshot = undefined;
      abort?.abort();
    },
  };
}
export function usePlatformDataV2() {
  const [loadState, setLoadState] = useState<PlatformLoadStateV2>({ status: 'loading' });
  const current = useRef<ReturnType<typeof createPlatformDataV2> | null>(null);
  useEffect(() => {
    const controller = createPlatformDataV2(setLoadState);
    current.current = controller;
    // No clock (ADMIN_AUTOMATIC_READS_V1 is off): read again only when the window comes back.
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void controller.refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    void controller.start();
    return () => {
      controller.dispose();
      current.current = null;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return {
    loadState,
    reload: () =>
      loadState.status === 'error' ? current.current?.start() : current.current?.refresh(),
  };
}
