import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import {
  createLatestPortalRequestV1,
  type PortalLoadStateV1,
} from '../../student-portal/shared/latest-request-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';
import {
  publicationObservationV1,
  publicationSnapshotV1,
  type PublicationCommandV1,
  type PublicationSnapshotV1,
} from './publication-values-v1';

export const PUBLICATION_CHECKS_V1 = 7;
export const PUBLICATION_CHECK_DELAY_V1 = 10000;
type AcceptedV1 = {
  state: 'accepted';
  command: PublicationCommandV1;
  version: number;
  checks: number;
  observation: 'observing' | 'confirmed' | 'reported' | 'stopped' | 'unconfirmed';
};
export type PublicationMutationV1 =
  | { state: 'idle' }
  | { state: 'sending'; command: PublicationCommandV1 }
  | {
      state: 'error';
      command: PublicationCommandV1;
      error: PortalClientErrorV1;
      retryable: boolean;
      retryAt: number;
    }
  | AcceptedV1;
export interface PublicationViewV1 {
  load: PortalLoadStateV1<PublicationSnapshotV1>;
  refreshing: boolean;
  readRetryAt: number;
  mutation: PublicationMutationV1;
}
export const initialPublicationViewV1 = (): PublicationViewV1 => ({
  load: { state: 'idle' },
  refreshing: false,
  readRetryAt: 0,
  mutation: { state: 'idle' },
});
/** Read observation is bounded; it never retries a mutation or invents job completion. */
export function createPublicationControllerV1(
  client: PortalAdminClientV1,
  scope: ScopeV1,
  publish: (view: PublicationViewV1) => void,
  options: { now?: () => number; checkDelayMs?: number; maxChecks?: number } = {},
) {
  const ownScope = structuredClone(scope),
    ownKey = settingsScopeKeyV1(scope);
  const now = options.now ?? Date.now,
    delay = options.checkDelayMs ?? PUBLICATION_CHECK_DELAY_V1;
  const maxChecks = Math.max(
    1,
    Math.min(PUBLICATION_CHECKS_V1, options.maxChecks ?? PUBLICATION_CHECKS_V1),
  );
  let view = initialPublicationViewV1(),
    mutationGeneration = 0,
    observationGeneration = 0;
  let commandAbort: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let prepared: ReturnType<PortalAdminClientV1['prepareCommand']> | undefined;
  let intended: PublicationCommandV1 | undefined;
  const emit = () => publish({ ...view });
  const reader = createLatestPortalRequestV1<PublicationSnapshotV1>((next) => {
    let error;
    if (next.state === 'error') {
      error = next.error;
    } else if (next.state === 'ready') {
      error = next.refreshError;
    } else {
      error = undefined;
    }
    view = {
      ...view,
      load: next,
      refreshing: next.state === 'ready' && Boolean(next.refreshing),
      readRetryAt: error ? now() + (error.retryAfterSeconds ?? 0) * 1000 : 0,
    };
    emit();
  });
  const read = async (keepVisible = false) => {
    return reader.run(
      async (signal) => {
        const [publication, policy] = await Promise.all([
          client.query(
            { contractVersion: 1, operation: 'publication', scope: ownScope, page: { limit: 50 } },
            signal,
          ),
          client.query(
            { contractVersion: 1, operation: 'settings', scope: ownScope, page: { limit: 50 } },
            signal,
          ),
        ]);
        return publicationSnapshotV1(ownScope, publication, policy);
      },
      { background: keepVisible },
    );
  };
  function stopObservation() {
    observationGeneration++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  async function observe(generation: number) {
    if (generation !== observationGeneration || view.mutation.state !== 'accepted') return;
    const accepted = view.mutation;
    await read(true);
    if (generation !== observationGeneration || view.mutation.state !== 'accepted') return;
    const checks = accepted.checks + 1;
    if (view.load.state !== 'ready' || view.load.refreshError) {
      // Retained content cannot confirm a new decision after an unsuccessful read.
      let error;
      if (view.load.state === 'error') {
        error = view.load.error;
      } else if (view.load.state === 'ready') {
        error = view.load.refreshError;
      } else {
        error = undefined;
      }
      const retryable = error && ['network-error', 'unavailable'].includes(error.state);
      const observation = retryable && checks < maxChecks ? 'observing' : 'unconfirmed';
      view = { ...view, mutation: { ...accepted, checks, observation } };
      emit();
      if (observation === 'observing') {
        timer = setTimeout(
          () => {
            timer = undefined;
            void observe(generation);
          },
          Math.max(delay, view.readRetryAt - now()),
        );
      }
      return;
    }
    const observation = publicationObservationV1(ownScope, accepted.command, view.load.data.items);
    view = {
      ...view,
      mutation: {
        ...accepted,
        checks,
        observation: observation === 'waiting' ? 'observing' : observation,
      },
    };
    if (observation !== 'waiting') {
      emit();
      return;
    }
    if (checks >= maxChecks) {
      view = { ...view, mutation: { ...accepted, checks, observation: 'unconfirmed' } };
      emit();
      return;
    }
    emit();
    timer = setTimeout(() => {
      timer = undefined;
      void observe(generation);
    }, delay);
  }
  async function execute() {
    if (
      !prepared ||
      !intended ||
      view.mutation.state === 'sending' ||
      (view.mutation.state === 'error' && now() < view.mutation.retryAt)
    )
      return;
    const current = ++mutationGeneration,
      command = intended,
      operation = prepared;
    stopObservation();
    reader.cancel();
    const controller = new AbortController();
    commandAbort = controller;
    view = { ...view, mutation: { state: 'sending', command } };
    emit();
    try {
      const result = await operation.execute(controller.signal);
      if (current !== mutationGeneration || controller.signal.aborted) return;
      if (result.state !== 'committed') throw new PortalClientErrorV1('invalid-response');
      prepared = undefined;
      intended = undefined;
      commandAbort = undefined;
      view = {
        ...view,
        mutation: {
          state: 'accepted',
          command,
          version: result.version,
          checks: 0,
          observation: 'observing',
        },
      };
      emit();
      void observe(++observationGeneration);
    } catch (error) {
      if (current !== mutationGeneration || controller.signal.aborted) return;
      const failure =
        error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');
      const retryable = [
        'network-error',
        'invalid-response',
        'unavailable',
        'rate-limited',
      ].includes(failure.state);
      if (!retryable) {
        prepared = undefined;
        intended = undefined;
      }
      view = {
        ...view,
        mutation: {
          state: 'error',
          command,
          error: failure,
          retryable,
          retryAt: now() + (failure.retryAfterSeconds ?? 0) * 1000,
        },
      };
      emit();
    } finally {
      if (current === mutationGeneration) commandAbort = undefined;
    }
  }
  function reset() {
    mutationGeneration++;
    commandAbort?.abort();
    commandAbort = undefined;
    stopObservation();
    prepared = undefined;
    intended = undefined;
    reader.clear();
    view = initialPublicationViewV1();
    emit();
  }
  return {
    async refresh() {
      if (
        now() < view.readRetryAt ||
        view.refreshing ||
        view.mutation.state === 'sending' ||
        (view.mutation.state === 'accepted' && view.mutation.observation === 'observing') ||
        view.mutation.state === 'error'
      )
        return;
      if (
        view.load.state === 'error' &&
        !['network-error', 'unavailable', 'rate-limited'].includes(view.load.error.state)
      )
        return;
      return read(true);
    },
    async load() {
      if (
        now() < view.readRetryAt ||
        (view.mutation.state === 'error' && now() < view.mutation.retryAt)
      )
        return;
      reset();
      await read();
    },
    async submit(command: PublicationCommandV1) {
      if (
        view.mutation.state === 'sending' ||
        view.refreshing ||
        (view.mutation.state === 'accepted' && view.mutation.observation === 'observing')
      )
        return;
      if (
        !['publish', 'publish-update', 'unpublish'].includes(command.operation) ||
        settingsScopeKeyV1(command.scope) !== ownKey
      )
        throw new PortalClientErrorV1('invalid-request');
      if (view.load.state !== 'ready') throw new PortalClientErrorV1('invalid-request');
      prepared = client.prepareCommand(command);
      intended = structuredClone(command);
      await execute();
    },
    retry: execute,
    cancelObservation() {
      if (view.mutation.state !== 'accepted' || view.mutation.observation !== 'observing') return;
      const load = view.load,
        accepted = view.mutation;
      stopObservation();
      reader.clear();
      view = {
        ...view,
        load: load.state === 'ready' ? load : { state: 'idle' },
        refreshing: false,
        mutation: { ...accepted, observation: 'stopped' },
      };
      emit();
    },
    reset,
  };
}
