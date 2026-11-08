import { useCallback, useEffect, useRef } from 'react';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import type { PortalAdminReadClientV2, PortalClassCatalogV2 } from '../accounts/accounts-client-v2';
import { useAccountsReadV1 } from '../accounts/accounts-read-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';

export interface OperationsPropsV1 {
  client: PortalAdminClientV1;
  reader: PortalAdminReadClientV2;
  scope: ScopeV1;
  identityKey: string;
  canWrite: boolean;
  scopeLabel?: string;
  catalog?: PortalClassCatalogV2;
  onAuthorizationLost?: (error: PortalClientErrorV1) => void;
}
const operationDateFormatterV1 = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'medium',
});
export const operationDateV1 = (value: string | null) =>
  value === null ? 'Não disponível' : operationDateFormatterV1.format(new Date(value));
export const authorizationLostV1 = (error: PortalClientErrorV1) =>
  error.state === 'unauthenticated' || error.state === 'forbidden';
export function useOperationalReadV1<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onAuthorizationLost?: OperationsPropsV1['onAuthorizationLost'],
  active = true,
) {
  const callback = useRef(onAuthorizationLost);
  const retryDeadline = useRef(0);
  useEffect(() => {
    callback.current = onAuthorizationLost;
  }, [onAuthorizationLost]);
  const guarded = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await load(signal);
      } catch (error) {
        if (!signal.aborted && error instanceof PortalClientErrorV1)
          retryDeadline.current = Date.now() + (error.retryAfterSeconds ?? 0) * 1000;
        if (!signal.aborted && error instanceof PortalClientErrorV1 && authorizationLostV1(error))
          callback.current?.(error);
        throw error;
      }
    },
    [load],
  );
  const read = useAccountsReadV1(guarded, active);
  useEffect(() => {
    const clear = () => read.clear();
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, [read.clear]);
  return {
    ...read,
    canReload: read.canReload && Date.now() >= retryDeadline.current,
    reload: () => {
      if (Date.now() >= retryDeadline.current) read.reload();
    },
  };
}
