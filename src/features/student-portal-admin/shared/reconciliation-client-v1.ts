import {
  RECONCILIATION_ROUTE_V1,
  REPORT_BODY_BYTES_V1,
  reconciliationRequestV1,
  reconciliationResponseV1,
  type ReconciliationContextV1,
  type ReconciliationRequestV1,
  type ReconciliationResponseV1,
} from '../../../../shared/student-identity/reconciliation-v1';
import { notifyLiveChangeV1 } from '../../../shared/live-data/live-refresh-v1';
import {
  hasPortalNoStoreV1,
  isAmbiguousPortalResponseV1,
  PortalClientErrorV1,
  portalRequestBodyV1,
  type PortalTransportOptionsV1,
} from '../../student-portal/shared/transport-v1';

export function createReconciliationClientV1(options: PortalTransportOptionsV1 = {}) {
  const fetcher = options.fetch ?? ((path: string, init: RequestInit) => fetch(path, init));
  let retryAt = 0;
  const send = async (body: string, signal?: AbortSignal): Promise<ReconciliationResponseV1> => {
    signal?.throwIfAborted();
    if (options.respectRetryAfter && retryAt > Date.now()) {
      throw new PortalClientErrorV1('rate-limited', 429, Math.ceil((retryAt - Date.now()) / 1000));
    }
    let response: Response;
    try {
      response = await fetcher(RECONCILIATION_ROUTE_V1, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body,
      });
    } catch {
      signal?.throwIfAborted();
      throw new PortalClientErrorV1('network-error');
    }
    signal?.throwIfAborted();
    if (response.status === 401 || response.status === 403) {
      if (response.status === 401) options.onUnauthorized?.();
      throw new PortalClientErrorV1(
        response.status === 401 ? 'unauthenticated' : 'forbidden',
        response.status,
      );
    }
    const retry = response.headers.get('Retry-After');
    const delay = retry
      ? Math.max(
          1,
          Math.min(
            86400,
            /^\d+$/u.test(retry)
              ? Number(retry)
              : Math.ceil((Date.parse(retry) - Date.now()) / 1000),
          ),
        )
      : undefined;
    if (response.status === 429) {
      const seconds = delay && Number.isFinite(delay) ? delay : 60;
      retryAt = Date.now() + seconds * 1000;
      throw new PortalClientErrorV1('rate-limited', 429, seconds);
    }
    let raw: unknown;
    try {
      if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
        throw new Error();
      raw = await response.json();
    } catch {
      throw new PortalClientErrorV1('invalid-response', response.status, delay);
    }
    signal?.throwIfAborted();
    const parsed = reconciliationResponseV1.safeParse(raw);
    if (!parsed.success || !hasPortalNoStoreV1(response.headers))
      throw new PortalClientErrorV1('invalid-response', response.status, delay);
    const expectedStatus =
      parsed.data.state === 'invalid-request'
        ? 400
        : parsed.data.state === 'unavailable'
          ? 503
          : parsed.data.state === 'conflict' || parsed.data.state === 'expired'
            ? 409
            : 200;
    if (response.status !== expectedStatus)
      throw new PortalClientErrorV1('invalid-response', response.status, delay);
    return parsed.data;
  };
  return {
    async request(
      input: ReconciliationRequestV1,
      signal?: AbortSignal,
    ): Promise<ReconciliationResponseV1> {
      const body = portalRequestBodyV1(reconciliationRequestV1, input);
      if (new TextEncoder().encode(body).byteLength > REPORT_BODY_BYTES_V1)
        throw new PortalClientErrorV1('invalid-request');
      let response: ReconciliationResponseV1;
      try {
        response = await send(body, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!isAmbiguousPortalResponseV1(error)) throw error;
        response = await send(body, signal);
      }
      if (response.state === 'committed') {
        notifyLiveChangeV1('gradebook');
        notifyLiveChangeV1('portal');
      }
      return response;
    },
  };
}
export type ReconciliationClientV1 = ReturnType<typeof createReconciliationClientV1>;
export type PreparedReconciliationV1 = Extract<
  ReconciliationResponseV1,
  { operation: 'prepare' | 'activate-pending' }
>;
export function reconciliationMutationV1(context: ReconciliationContextV1) {
  return {
    contractVersion: 1 as const,
    academicYear: 2026 as const,
    generation: context.generation,
    expectedRevision: context.revision,
    idempotencyKey: crypto.randomUUID(),
  };
}
export function reconciliationMessageV1(response: ReconciliationResponseV1): string {
  if (response.state === 'conflict') return 'Dados alterados. Confira novamente.';
  if (response.state === 'expired') return 'Prazo encerrado. Prepare novamente.';
  if (response.state === 'not-authorized') return 'Acesso não autorizado.';
  if (response.state === 'invalid-request') return 'Confira os dados e tente novamente.';
  return 'Não foi possível concluir. Tente novamente.';
}

/** The same final request survives an ambiguous response; staging never publishes a partial batch. */
export function createReconciliationActivationV1(
  prepared: PreparedReconciliationV1,
  confirmDifferences: boolean,
) {
  let ready = prepared.credentialsReady;
  const apply: Extract<ReconciliationRequestV1, { operation: 'apply' }> = {
    ...reconciliationMutationV1(prepared.context),
    operation: 'apply',
    batchId: prepared.batchId,
    confirmDifferences,
  };
  return async (
    client: ReconciliationClientV1,
    progress: (remaining: number) => void,
    signal?: AbortSignal,
  ) => {
    let previous = Number.POSITIVE_INFINITY;
    while (!ready) {
      signal?.throwIfAborted();
      const result = await client.request(
        {
          ...reconciliationMutationV1(prepared.context),
          operation: 'stage',
          batchId: prepared.batchId,
        },
        signal,
      );
      if (result.state !== 'ready' || result.operation !== 'stage') return result;
      ready = result.ready;
      progress(result.remaining);
      if (!ready && result.remaining >= previous)
        throw new Error('Preparação sem avanço. Tente novamente.');
      previous = result.remaining;
    }
    return client.request(apply, signal);
  };
}
