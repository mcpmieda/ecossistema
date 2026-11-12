import { PortalClientErrorV1 } from './transport-v1';

export type PortalLoadStateV1<T> =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; data: T; refreshing?: boolean; refreshError?: PortalClientErrorV1 }
  | { state: 'error'; error: PortalClientErrorV1 };

/** A background failure keeps content verified in the last minute (a silent read keeps it with
 * its notice); denial, conflict and malformed data are never hidden behind old content. */
function failedStateV1<T>(
  error: unknown,
  previous: { data: T } | null,
  retained: boolean,
): PortalLoadStateV1<T> {
  const failure =
    error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');
  const transient = ['network-error', 'unavailable', 'rate-limited'].includes(failure.state);
  if (previous && transient && retained)
    return { state: 'ready', data: previous.data, refreshing: false, refreshError: failure };
  return { state: 'error', error: failure };
}

/** Same JSON values, arrays, Maps and Sets: an identical answer keeps what is on screen. */
function sameReadV1(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
    return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (left instanceof Map && right instanceof Map)
    return (
      left.size === right.size &&
      [...left].every(([key, value]) => right.has(key) && sameReadV1(value, right.get(key)))
    );
  if (left instanceof Set && right instanceof Set)
    return left.size === right.size && [...left].every((value) => right.has(value));
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameReadV1((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

type ReadOptionsV1 = { background?: boolean; silent?: boolean };
type ReadyStateV1<T> = Extract<PortalLoadStateV1<T>, { state: 'ready' }>;

/** A silent read never waits for another read; a read someone asked for replaces it. */
function yieldsToRunningReadV1(options: ReadOptionsV1, activeSilent: boolean): boolean {
  if (options.silent) return true;
  return Boolean(options.background) && !activeSilent;
}

/** What shows while a read runs: the content refreshing, or the loading state. */
function startedStateV1<T>(previous: ReadyStateV1<T> | null): PortalLoadStateV1<T> {
  return previous ? { state: 'ready', data: previous.data, refreshing: true } : { state: 'loading' };
}

/** What a finished read shows. A silent read that brought the same answer publishes nothing,
 * unless it clears the notice of an earlier failure. */
function settledStateV1<T>(previous: ReadyStateV1<T> | null, data: T, silent: boolean): PortalLoadStateV1<T> | null {
  if (!silent || !previous || !sameReadV1(previous.data, data)) return { state: 'ready', data };
  return previous.refreshError ? { state: 'ready', data: previous.data } : null;
}

/** A scope switch clears protected data immediately, even when a fetch ignores abort.
 * Background refresh is explicit and local to the same reader/context, never persistent cache.
 * A silent read (the window came back) shows nothing while it runs and publishes only a change.
 */
export function createLatestPortalRequestV1<T>(publish: (state: PortalLoadStateV1<T>) => void) {
  let generation = 0;
  let active: AbortController | undefined;
  let activeSilent = false;
  let state: PortalLoadStateV1<T> = { state: 'idle' };
  let verifiedAt = 0;
  const emit = (next: PortalLoadStateV1<T>) => {
    state = next;
    publish(next);
  };
  return {
    cancel() {
      generation += 1;
      active?.abort();
      active = undefined;
      activeSilent = false;
      if (state.state === 'ready') emit({ ...state, refreshing: false });
    },
    clear() {
      generation += 1;
      active?.abort();
      active = undefined;
      activeSilent = false;
      verifiedAt = 0;
      emit({ state: 'idle' });
    },
    async run(
      load: (signal: AbortSignal) => Promise<T>,
      options: { background?: boolean; silent?: boolean } = {},
    ) {
      if (active && yieldsToRunningReadV1(options, activeSilent)) return;
      const current = ++generation;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      activeSilent = Boolean(options.silent);
      const previous =
        (options.background || options.silent) && state.state === 'ready' ? state : null;
      if (!options.silent) emit(startedStateV1(previous));
      try {
        const data = await load(controller.signal);
        if (current === generation && !controller.signal.aborted) {
          verifiedAt = Date.now();
          const next = settledStateV1(previous, data, Boolean(options.silent));
          if (next) emit(next);
          return true;
        }
      } catch (error) {
        if (current !== generation || controller.signal.aborted) return;
        emit(failedStateV1(error, previous, options.silent || Date.now() - verifiedAt <= 60_000));
        return false;
      } finally {
        if (current === generation) {
          active = undefined;
          activeSilent = false;
        }
      }
    },
  };
}
