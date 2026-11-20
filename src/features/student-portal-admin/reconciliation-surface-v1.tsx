import { useCallback, useState } from 'react';
import type { ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { allowDraftNavigationV1 } from '../../shared/forms/draft-navigation-v1';
import { ClassTabsV1 } from '../../shared/ui/class-tabs-v1';
import type { PortalClientErrorV1, PortalFetchV1 } from '../student-portal/shared/transport-v1';
import { useAccountsReadV1 } from './accounts/accounts-read-v1';
import { AccountsErrorV1 } from './accounts/accounts-presentation-v1';
import { readClassOptionsV1 } from './accounts/class-filter-v1';
import { StudentReconciliationV1 } from './accounts/student-reconciliation-v1';
import type { PortalAdminIdentityV1 } from './shared/admin-identity-v1';
import {
  PortalAdminGateV1,
  panelCanWriteV1,
  usePanelClientsV1,
} from './shared/portal-admin-gate-v1';
import './shared/admin-page-v1.css';

const SCHOOL: ScopeV1 = { kind: 'school', academicYear: 2026 };

/** The Conciliação, a tab of the Importação: the Portal's session, the classes and the pending rows. */
export function ReconciliationSurfaceV1({
  fetcher,
  onLogin,
}: Readonly<{ fetcher?: PortalFetchV1; onLogin?: () => void }>) {
  return (
    <PortalAdminGateV1 title="Conciliação" fetcher={fetcher} onLogin={onLogin}>
      {(identity, onLost) => (
        <ReconciliationWorkspaceV1
          key={identity.identityKey + ':' + identity.capabilities.join(',')}
          identity={identity}
          onLost={onLost}
          fetcher={fetcher}
        />
      )}
    </PortalAdminGateV1>
  );
}

function ReconciliationWorkspaceV1({
  identity,
  onLost,
  fetcher,
}: Readonly<{
  identity: PortalAdminIdentityV1;
  onLost: (error: PortalClientErrorV1) => void;
  fetcher?: PortalFetchV1;
}>) {
  const clients = usePanelClientsV1(onLost, fetcher);
  const loadClasses = useCallback(
    (signal: AbortSignal) => readClassOptionsV1(clients.catalog, signal),
    [clients.catalog],
  );
  const classRead = useAccountsReadV1(loadClasses);
  const classItems = classRead.state.state === 'ready' ? classRead.state.data : [];
  const [classId, setClassId] = useState<number | null>(null);
  const canWrite = panelCanWriteV1(identity);
  const scope: ScopeV1 = classId === null ? SCHOOL : { kind: 'class', academicYear: 2026, classId };
  return (
    <section className="pa-admin-page">
      <ClassTabsV1
        items={classItems}
        selectedId={classId}
        allLabel="Todas as turmas"
        onChange={(id) => {
          if (allowDraftNavigationV1()) setClassId(id);
        }}
      >
        {classRead.state.state === 'error' ? (
          <AccountsErrorV1
            error={classRead.state.error}
            canReload={classRead.canReload}
            onReload={classRead.reload}
          />
        ) : null}
        {!canWrite && (
          <p className="text-xs text-muted">
            <output className="contents">Somente leitura</output>
          </p>
        )}
        <StudentReconciliationV1
          client={clients.reconciliation}
          scope={scope}
          canWrite={canWrite}
          accountClose={{ client: clients.client, reader: clients.reader }}
        />
      </ClassTabsV1>
    </section>
  );
}
