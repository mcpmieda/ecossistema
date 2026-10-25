import { PortalClientErrorV1 } from './transport-v1';

export type PortalLoadStateV1<T> =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; data: T; refreshing?: boolean; refreshError?: PortalClientErrorV1 }
  | { state: 'error'; error: PortalClientErrorV1 };

/** A background failure keeps content verified in the last minute; denial, conflict and malformed
 * data are never hidden behind old content. */
function failedStateV1<T>(
  error: unknown,
  previous: { data: T } | null,
  verifiedAt: number,
): PortalLoadStateV1<T> {
  const failure =
    error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');
  const transient = ['network-error', 'unavailable', 'rate-limited'].includes(failure.state);
  if (previous && transient && Date.now() - verifiedAt <= 60_000)
    return { state: 'ready', data: previous.data, refreshing: false, refreshError: failure };
  return { state: 'error', error: failure };
}

/** A scope switch clears protected data immediately, even when a fetch ignores abort.
 * Background refresh is explicit and local to the same reader/context, never persistent cache.
 */
export function createLatestPortalRequestV1<T>(publish: (state: PortalLoadStateV1<T>) => void) {
  let generation = 0;
  let active: AbortController | undefined;
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
      if (state.state === 'ready') emit({ ...state, refreshing: false });
    },
    clear() {
      generation += 1;
      active?.abort();
      active = undefined;
      verifiedAt = 0;
      emit({ state: 'idle' });
    },
    async run(load: (signal: AbortSignal) => Promise<T>, options: { background?: boolean } = {}) {
      if (options.background && active) return;
      const current = ++generation;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const previous = options.background && state.state === 'ready' ? state : null;
      emit(
        previous ? { state: 'ready', data: previous.data, refreshing: true } : { state: 'loading' },
      );
      try {
        const data = await load(controller.signal);
        if (current === generation && !controller.signal.aborted) {
          verifiedAt = Date.now();
          emit({ state: 'ready', data });
          return true;
        }
      } catch (error) {
        if (current !== generation || controller.signal.aborted) return;
        emit(failedStateV1(error, previous, verifiedAt));
        return false;
      } finally {
        if (current === generation) active = undefined;
      }
    },
  };
}
