import { Alert, Button } from '@heroui/react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { PortalClientErrorV1, type PortalFetchV1 } from '../../student-portal/shared/transport-v1';
import {
  createPortalAdminReadClientV2,
  createPortalClassCatalogV2,
} from '../accounts/accounts-client-v2';
import { createPortalAdminClientV1 } from './admin-client-v1';
import {
  authorizationAwareFetchV1,
  usePortalAdminIdentityV1,
  type PortalAdminIdentityV1,
} from './admin-identity-v1';
import { createReconciliationClientV1 } from './reconciliation-client-v1';

const enterInstitutionalLogin = () => window.location.replace('/auth/login');

/**
 * The Portal's administrative session, shared by the Painel do Aluno and the Conciliação: it opens
 * the institutional login when there is no session and shows why the area cannot be read.
 */
export function PortalAdminGateV1({
  title,
  fetcher,
  onLogin = enterInstitutionalLogin,
  children,
}: Readonly<{
  title: string;
  fetcher?: PortalFetchV1;
  onLogin?: () => void;
  children: (
    identity: PortalAdminIdentityV1,
    onLost: (error: PortalClientErrorV1) => void,
  ) => ReactNode;
}>) {
  const auth = usePortalAdminIdentityV1(fetcher);
  const unauthenticated =
    auth.state.state === 'error' && auth.state.error.state === 'unauthenticated';
  useEffect(() => {
    if (unauthenticated) onLogin();
  }, [unauthenticated, onLogin]);
  if (unauthenticated)
    return (
      <p>
        <output className="contents">Abrindo entrada institucional…</output>
      </p>
    );
  if (auth.state.state !== 'ready')
    return (
      <section className="pa-admin-page">
        <h1>{title}</h1>
        {auth.state.state === 'checking' ? (
          <p>
            <output className="contents">Verificando sessão administrativa…</output>
          </p>
        ) : (
          <Alert status="warning">
            <Alert.Content>
              <Alert.Title>
                {auth.state.state === 'paused'
                  ? 'Consulta pausada'
                  : 'Acesso administrativo indisponível'}
              </Alert.Title>
              <Alert.Description>
                Confirme sua sessão para consultar o Portal de 2026.
              </Alert.Description>
              <Button
                onPress={() => {
                  void auth.refresh();
                }}
              >
                Tentar novamente
              </Button>
            </Alert.Content>
          </Alert>
        )}
      </section>
    );
  return children(auth.state.identity, auth.lost);
}

/** The administrative clients over one authorization-aware fetch; a lost session is reported. */
export function usePanelClientsV1(
  onLost: (error: PortalClientErrorV1) => void,
  fetcher?: PortalFetchV1,
) {
  return useMemo(() => {
    const send = authorizationAwareFetchV1(onLost, fetcher);
    const catalog = createPortalClassCatalogV2();
    return {
      client: createPortalAdminClientV1({ fetch: send, respectRetryAfter: true }),
      reconciliation: createReconciliationClientV1({ fetch: send, respectRetryAfter: true }),
      reader: createPortalAdminReadClientV2({ fetch: send, respectRetryAfter: true }),
      catalog: (async (...args: Parameters<typeof catalog>) => {
        try {
          return await catalog(...args);
        } catch (error) {
          if (
            !args[2]?.aborted &&
            error instanceof PortalClientErrorV1 &&
            error.state === 'forbidden'
          )
            onLost(error);
          throw error;
        }
      }) as typeof catalog,
    };
  }, [fetcher, onLost]);
}

/**
 * The administrator writes; so does a person given the area (#1513). A settings reader without
 * write is read-only.
 */
export function panelCanWriteV1(identity: PortalAdminIdentityV1): boolean {
  return (
    identity.capabilities.includes('platform.settings.write') ||
    (identity.capabilities.includes('area.painel-do-aluno') &&
      !identity.capabilities.includes('platform.settings.read'))
  );
}
