import {
  adminCommandV1,
  type AdminCommandV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
export type RevokeCommandV1 = Extract<AdminCommandV1, { operation: 'sessions-revoke' }>;
export type SessionMutationStateV1 =
  | { state: 'idle' | 'pending' | 'expired' }
  | { state: 'committed'; version: number }
  | { state: 'error'; error: PortalClientErrorV1; retryable: boolean; retryAt: number };
/** Only this explicit revocation intent is retained for uncertain receipt replay (under 24h). */
export function createSessionMutationV1(
  client: PortalAdminClientV1,
  canWrite: boolean,
  publish: (state: SessionMutationStateV1) => void,
  now = Date.now,
) {
  let prepared: ReturnType<PortalAdminClientV1['prepareCommand']> | undefined;
  let active: AbortController | undefined,
    generation = 0,
    retryAt = 0,
    started = 0,
    expected = 0;
  const clear = () => {
    generation++;
    active?.abort();
    active = undefined;
    prepared = undefined;
    retryAt = 0;
    publish({ state: 'idle' });
  };
  async function run() {
    if (!canWrite || active || !prepared || now() < retryAt) return;
    if (now() - started >= 23 * 3_600_000) {
      clear();
      publish({ state: 'expired' });
      return;
    }
    const current = ++generation,
      controller = new AbortController(),
      command = prepared;
    active = controller;
    publish({ state: 'pending' });
    try {
      const result = await command.execute(controller.signal);
      if (generation !== current || controller.signal.aborted) return;
      if (result.state !== 'committed' || result.version < expected)
        throw new PortalClientErrorV1('invalid-response');
      prepared = undefined;
      publish({ state: 'committed', version: result.version });
    } catch (error) {
      if (generation !== current || controller.signal.aborted) return;
      const failure =
        error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');
      const retryable = [
        'network-error',
        'invalid-response',
        'unavailable',
        'rate-limited',
      ].includes(failure.state);
      retryAt = now() + (failure.retryAfterSeconds ?? 0) * 1000;
      if (!retryable) prepared = undefined;
      publish({ state: 'error', error: failure, retryable, retryAt });
    } finally {
      if (generation === current) active = undefined;
    }
  }
  return {
    async submit(input: RevokeCommandV1) {
      if (!canWrite || active || prepared) return;
      const command = adminCommandV1.parse(input);
      if (command.operation !== 'sessions-revoke' || command.scope.kind === 'school')
        throw new PortalClientErrorV1('invalid-request');
      prepared = client.prepareCommand(command);
      started = now();
      expected = command.expectedVersion;
      retryAt = 0;
      await run();
    },
    retry: run,
    clear,
  };
}
