import {
  activateRequestV1,
  passwordV1,
  pinV1,
} from '../../../../shared/student-portal-contracts/auth-v1';
import type { PortalSelfClientV1 } from '../shared/self-client-v1';
import { isAmbiguousPortalResponseV1, PortalClientErrorV1 } from '../shared/transport-v1';
import { validateStudentQrV1 } from './qr-input-v1';

export type StudentAuthStepV1 = 'scan' | 'pin' | 'password' | 'risk' | 'create' | 'authenticated';
export interface StudentAuthStateV1 {
  step: StudentAuthStepV1;
  needsRisk: boolean;
  pending?: boolean;
  revision: number;
  message?: string;
  retryAt?: number;
  expiresAt?: string;
}
export const INITIAL_AUTH_STATE_V1: StudentAuthStateV1 = {
  step: 'scan',
  needsRisk: false,
  revision: 0,
};
function failureMessage(error: unknown, attemptedStep?: StudentAuthStepV1): string {
  if (error instanceof PortalClientErrorV1) {
    if (error.state === 'rate-limited') return 'Muitas tentativas. Aguarde antes de tentar novamente.';
    if (error.state === 'access-closed') return 'Acesso ao Portal fechado.';
    if (error.state === 'unavailable') return 'O serviço de acesso está temporariamente indisponível. Tente novamente.';
    if (error.state === 'network-error') return 'Não foi possível conectar. Tente novamente.';
  }
  if (attemptedStep === 'create')
    return 'Não foi possível concluir o acesso. Leia o QR novamente.';
  return 'Não foi possível entrar. Confira os dados e tente novamente.';
}

/** Only presentation state is published. QR and one-use proof stay in this short-lived closure. */
export function createStudentAuthFlowV1(
  client: PortalSelfClientV1,
  publish: (state: StudentAuthStateV1) => void,
  authenticated: () => void,
  now: () => number = Date.now,
) {
  let state = INITIAL_AUTH_STATE_V1;
  let qr: string | undefined,
    proof: string | undefined,
    proofExpiresAt = 0;
  let generation = 0,
    active: AbortController | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const emit = (next: Omit<StudentAuthStateV1, 'revision'>) => {
    state = { ...next, revision: state.revision + (next.pending ? 0 : 1) };
    if (!disposed) publish(state);
  };
  const invalidate = () => {
    generation++;
    active?.abort();
    active = undefined;
    clearTimeout(expiryTimer);
    proof = undefined;
    proofExpiresAt = 0;
  };
  const reset = (message?: string) => {
    invalidate();
    qr = undefined;
    emit({ step: 'scan', needsRisk: false, message });
  };
  const challengeResult = (
    result: Awaited<ReturnType<PortalSelfClientV1['challenge']>>,
    needsRisk: boolean,
  ) => {
    if (result.state === 'credential-required')
      emit({ step: result.next, needsRisk: needsRisk || result.next === 'risk' });
    else {
      proof = result.challenge;
      proofExpiresAt = Date.parse(result.expiresAt);
      if (proofExpiresAt <= now()) {
        reset('O prazo para criar a senha terminou. Leia o QR novamente.');
        return;
      }
      emit({ step: 'create', needsRisk: false, expiresAt: result.expiresAt });
      expiryTimer = setTimeout(
        () => reset('O prazo para criar a senha terminou. Leia o QR novamente.'),
        Math.min(2147483647, proofExpiresAt - now()),
      );
    }
  };
  const run = async (
    action: (signal: AbortSignal) => Promise<void>,
    fallback: StudentAuthStepV1,
    risk: boolean,
  ) => {
    if (disposed || state.pending || (state.retryAt && state.retryAt > now())) return;
    const attemptedStep = state.step;
    const current = ++generation;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    emit({ ...state, pending: true, message: undefined, needsRisk: risk });
    try {
      await action(controller.signal);
    } catch (error) {
      if (current === generation && !controller.signal.aborted) {
        const delay = error instanceof PortalClientErrorV1 ? error.retryAfterSeconds : undefined;
        emit({
          step: fallback,
          needsRisk: risk,
          message: failureMessage(error, attemptedStep),
          ...(delay ? { retryAt: now() + delay * 1000 } : {}),
        });
      }
    } finally {
      if (current === generation) active = undefined;
    }
  };
  const ensureCurrent = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (disposed) throw new DOMException('Cancelled', 'AbortError');
  };
  const success = (signal: AbortSignal) => {
    ensureCurrent(signal);
    invalidate();
    qr = undefined;
    emit({ step: 'authenticated', needsRisk: false });
    authenticated();
  };
  return {
    reset,
    dispose() {
      disposed = true;
      invalidate();
      qr = undefined;
    },
    async begin(candidate: string) {
      reset();
      qr = validateStudentQrV1(candidate);
      await run(
        async (signal) => {
          const result = await client.challenge({ contractVersion: 1, qr: qr! }, signal);
          ensureCurrent(signal);
          challengeResult(result, false);
        },
        'scan',
        false,
      );
    },
    async risk(token: string) {
      if (state.step !== 'risk' || !qr || !token) return;
      await run(
        async (signal) => {
          const result = await client.challenge(
            { contractVersion: 1, qr: qr!, riskToken: token },
            signal,
          );
          ensureCurrent(signal);
          challengeResult(result, true);
        },
        'risk',
        true,
      );
    },
    async pin(value: string, riskToken?: string) {
      if (
        state.step !== 'pin' ||
        !qr ||
        !pinV1.safeParse(value).success ||
        (state.needsRisk && !riskToken)
      )
        return;
      const risk = state.needsRisk;
      await run(
        async (signal) => {
          const result = await client.challenge(
            { contractVersion: 1, qr: qr!, pin: value, ...(riskToken ? { riskToken } : {}) },
            signal,
          );
          ensureCurrent(signal);
          challengeResult(result, risk);
        },
        'pin',
        risk,
      );
    },
    async login(value: string, keepConnected: boolean, riskToken?: string) {
      if (
        state.step !== 'password' ||
        !qr ||
        !passwordV1.safeParse(value).success ||
        (state.needsRisk && !riskToken)
      )
        return;
      const risk = state.needsRisk;
      await run(
        async (signal) => {
          try {
            await client.login(
              {
                contractVersion: 1,
                qr: qr!,
                password: value,
                keepConnected,
                ...(riskToken ? { riskToken } : {}),
              },
              signal,
            );
            success(signal);
          } catch (error) {
            ensureCurrent(signal);
            if (!(error instanceof PortalClientErrorV1) || error.state !== 'unauthenticated')
              throw error;
            // Ask the server again; do not guess whether risk/PIN/reset is now required.
            let result: Awaited<ReturnType<PortalSelfClientV1['challenge']>>;
            try {
              result = await client.challenge({ contractVersion: 1, qr: qr! }, signal);
            } catch (discoveryError) {
              ensureCurrent(signal);
              if (
                discoveryError instanceof PortalClientErrorV1 &&
                discoveryError.state === 'unauthenticated'
              ) {
                reset('Não foi possível usar este QR. Leia o cartão atual para continuar.');
                return;
              }
              throw discoveryError;
            }
            ensureCurrent(signal);
            challengeResult(result, risk);
            if (state.step === 'password') emit({ ...state, message: failureMessage(error) });
          }
        },
        'password',
        risk,
      );
    },
    async activate(password: string, confirmation: string, keepConnected: boolean) {
      if (state.step !== 'create' || !proof) return;
      if (proofExpiresAt <= now()) {
        reset('O prazo para criar a senha terminou. Leia o QR novamente.');
        return;
      }
      const input = {
        contractVersion: 1 as const,
        challenge: proof,
        password,
        confirmation,
        keepConnected,
      };
      if (!activateRequestV1.safeParse(input).success) return;
      clearTimeout(expiryTimer);
      proof = undefined;
      const retryActivation = async (signal: AbortSignal, confirmLogin: () => Promise<unknown>) => {
        try {
          await client.activate(input, signal);
          success(signal);
        } catch (retryError) {
          ensureCurrent(signal);
          if (!isAmbiguousPortalResponseV1(retryError)) {
            qr = undefined;
            throw retryError;
          }
          // The bounded replay may also have committed before losing its response.
          try {
            await confirmLogin();
            success(signal);
          } catch (finalError) {
            qr = undefined;
            throw finalError;
          }
        }
      };
      await run(
        async (signal) => {
          try {
            await client.activate(input, signal);
            success(signal);
          } catch (error) {
            ensureCurrent(signal);
            if (!isAmbiguousPortalResponseV1(error)) {
              qr = undefined;
              throw error;
            }
            const confirmLogin = () =>
              client.login(
                {
                  contractVersion: 1,
                  qr: qr!,
                  password,
                  keepConnected,
                },
                signal,
              );
            try {
              // If activation committed but its response was lost, the chosen password confirms it.
              await confirmLogin();
              success(signal);
              return;
            } catch (confirmationError) {
              ensureCurrent(signal);
              if (
                !(confirmationError instanceof PortalClientErrorV1) ||
                confirmationError.state !== 'unauthenticated'
              ) {
                qr = undefined;
                throw confirmationError;
              }
            }
            // A 401 confirmation proves that activation did not commit; the proof is still usable.
            await retryActivation(signal, confirmLogin);
          }
        },
        'scan',
        false,
      );
    },
  };
}
