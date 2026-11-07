interface OperationalWorkspaceRequestTicket {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  complete(): void;
}

interface OperationalWorkspaceRequestGate {
  begin(key: string): OperationalWorkspaceRequestTicket | null;
  invalidate(): void;
}

interface ActiveRequest {
  readonly key: string;
  readonly generation: number;
  readonly controller: AbortController;
}

/**
 * Keeps at most one request active for a UI concern and makes stale completions observable.
 * Repeating the exact same request while it is still pending is ignored.
 */
export function createOperationalWorkspaceRequestGate(): OperationalWorkspaceRequestGate {
  let generation = 0;
  let active: ActiveRequest | null = null;

  return {
    begin(key) {
      if (active?.key === key && !active.controller.signal.aborted) return null;

      active?.controller.abort();
      const controller = new AbortController();
      const requestGeneration = ++generation;
      active = { key, generation: requestGeneration, controller };

      return {
        signal: controller.signal,
        isCurrent() {
          return generation === requestGeneration && !controller.signal.aborted;
        },
        complete() {
          if (active?.generation === requestGeneration) active = null;
        },
      };
    },
    invalidate() {
      generation += 1;
      active?.controller.abort();
      active = null;
    },
  };
}
