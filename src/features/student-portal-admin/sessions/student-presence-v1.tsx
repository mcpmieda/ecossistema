import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { AdminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import {
  createLatestPortalRequestV1,
  type PortalLoadStateV1,
} from '../../student-portal/shared/latest-request-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import {
  authorizationLostV1,
  operationDateV1,
  type OperationsPropsV1,
} from '../overview/operations-values-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';

type Props = Pick<
  OperationsPropsV1,
  'client' | 'scope' | 'identityKey' | 'canWrite' | 'onAuthorizationLost'
>;
type Presence = Extract<AdminResponseV1, { state: 'presence' }>;
export function StudentPresenceV1(props: Readonly<Props>) {
  return (
    <PresenceBodyV1
      key={props.identityKey + settingsScopeKeyV1(props.scope) + props.canWrite}
      {...props}
    />
  );
}
function PresenceBodyV1({ client, scope, onAuthorizationLost }: Readonly<Props>) {
  const [state, setState] = useState<PortalLoadStateV1<Presence>>({ state: 'idle' });
  const denied = useRef(false);
  const callback = useRef(onAuthorizationLost);
  callback.current = onAuthorizationLost;
  const reader = useMemo(() => createLatestPortalRequestV1<Presence>(setState), []);
  const read = () => {
    if (denied.current) return;
    return reader.run(async (signal) => {
      try {
        const response = await client.query(
          { contractVersion: 1, operation: 'presence', scope, page: { limit: 1 } },
          signal,
        );
        signal.throwIfAborted();
        if (response.state !== 'presence') throw new PortalClientErrorV1('invalid-response');
        return response;
      } catch (error) {
        if (!signal.aborted && error instanceof PortalClientErrorV1 && authorizationLostV1(error)) {
          denied.current = true;
          callback.current?.(error);
        }
        throw error;
      }
    });
  };
  useEffect(() => {
    void read();
    const hide = () => reader.clear();
    window.addEventListener('pagehide', hide);
    return () => {
      reader.clear();
      window.removeEventListener('pagehide', hide);
    };
  }, [client, reader]);
  return (
    <section
      aria-label="Conectados recentemente"
      className="flex items-center justify-between gap-3 py-3"
    >
      <div>
        <p>
          Conectados recentemente:{' '}
          <output aria-label="Quantidade de alunos conectados">
            {state.state === 'ready' ? state.data.connectedStudents : '—'}
          </output>
        </p>
        <p className="text-xs text-muted">Conexões observadas nos últimos 60 segundos.</p>
        {state.state === 'ready' && (
          <time className="text-xs text-muted" dateTime={state.data.observedAt}>
            {operationDateV1(state.data.observedAt)}
          </time>
        )}
        {state.state === 'error' && (
          <p>
            <output className="contents">Não foi possível consultar as conexões.</output>
          </p>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        isDisabled={state.state === 'loading' || denied.current}
        onPress={() => {
          void read();
        }}
      >
        Atualizar conexões
      </Button>
    </section>
  );
}
