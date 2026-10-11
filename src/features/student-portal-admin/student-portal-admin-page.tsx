import { PanelScopeContextV1 } from './shared/panel-scope-v1';
import { PublicDemoControlV1 } from './settings/public-demo-control-v1';
import { AccountClosingPreviewV1 } from './accounts/account-closing-preview-v1';
import { PortalScopeTabsV1 } from './settings/policy-scope-tabs-v1';
import { readClassOptionsV1 } from './accounts/class-filter-v1';
import { useAccountsReadV1 } from './accounts/accounts-read-v1';
import { AccountsErrorV1 } from './accounts/accounts-presentation-v1';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Tabs } from '@heroui/react';
import { allowDraftNavigationV1 } from '../../shared/forms/draft-navigation-v1';
import type { PolicyScopeV1, ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { CustomizationRowV1 } from '../../../shared/student-portal-contracts/customizations-v1';
import { notifyLiveChangeV1 } from '../../shared/live-data/live-refresh-v1';
import type { CustomizationAreaV1 } from './settings/customization-values-v1';
import {
  portalSectionFromHash,
  studentPortalHref,
  studentPortalSections,
  type StudentPortalSection,
} from '../../platform/student-portal-module';
import { createPortalAdminClientV1 } from './shared/admin-client-v1';
import { createReconciliationClientV1 } from './shared/reconciliation-client-v1';
import {
  authorizationAwareFetchV1,
  usePortalAdminIdentityV1,
  type PortalAdminIdentityV1,
} from './shared/admin-identity-v1';
import { useAccountQrHandoffV1 } from './shared/qr-handoff-v1';
import {
  createPortalAdminReadClientV2,
  createPortalClassCatalogV2,
} from './accounts/accounts-client-v2';
import {
  AccountDetailV1,
  type AccountSlotContextV1,
  type AccountSlotsV1,
} from './accounts/account-detail-v1';
import { PortalClientErrorV1, type PortalFetchV1 } from '../student-portal/shared/transport-v1';
import { AccountOpenContextV1 } from './shared/account-open-v1';
import './shared/admin-page-v1.css';
import { preloadedSectionV1, usePreloadedSectionsV1 } from '../../shared/ui/preloaded-section-v1';
import { useAdministrativeLiveV1 } from '../../shared/live-data/administrative-live-v1';
import {
  claimPanelHashV1,
  panelHashAccountIdV1,
  readPanelHashParamV1,
  writePanelHashParamsV1,
} from './shared/panel-hash-v1';
import {
  LiveRefreshAutomaticV1Provider,
  LiveRefreshScopeV1,
} from '../../shared/live-data/live-refresh-scope-v1';

const StudentAccountsV1 = preloadedSectionV1(() =>
  import('./accounts/student-accounts-v1').then((module) => module.StudentAccountsV1),
);
const StudentBirthYearsV1 = preloadedSectionV1(() =>
  import('./birth-year/student-birth-years-v1').then((module) => module.StudentBirthYearsV1),
);
const StudentCredentialsV1 = preloadedSectionV1(() =>
  import('./credentials/student-credentials-v1').then((module) => module.StudentCredentialsV1),
);
const StudentSettingsV1 = preloadedSectionV1(() =>
  import('./settings/student-settings-v1').then((module) => module.StudentSettingsV1),
);
const StudentSessionsV1 = preloadedSectionV1(() =>
  import('./sessions/student-sessions-v1').then((module) => module.StudentSessionsV1),
);
const StudentAuditV1 = preloadedSectionV1(() =>
  import('./audit/student-audit-v1').then((module) => module.StudentAuditV1),
);
const StudentOverviewV1 = preloadedSectionV1(() =>
  import('./overview/student-overview-v1').then((module) => module.StudentOverviewV1),
);
const CustomizationTargetV1 = preloadedSectionV1(() =>
  import('./settings/customization-target-v1').then((module) => module.CustomizationTargetV1),
);
const StudentPoliciesV1 = preloadedSectionV1(() =>
  import('./settings/student-policies-v1').then((module) => module.StudentPoliciesV1),
);
const AuditWorkspaceV1 = preloadedSectionV1(() =>
  import('./audit/audit-workspace-v1').then((module) => module.AuditWorkspaceV1),
);
const PANEL_SECTIONS_V1 = [
  StudentOverviewV1,
  StudentAccountsV1,
  StudentPoliciesV1,
  StudentSessionsV1,
  AuditWorkspaceV1,
  StudentAuditV1,
  StudentSettingsV1,
  StudentBirthYearsV1,
  StudentCredentialsV1,
  CustomizationTargetV1,
];
// The area in the address is the first one shown: ask for it at once, while the session is
// still being checked.
if (typeof window !== 'undefined') {
  const opened = portalSectionFromHash(window.location.hash);
  if (opened === 'accounts' || opened === 'credentials') StudentAccountsV1.preload();
  else if (opened === 'birth') StudentBirthYearsV1.preload();
  else if (opened === 'sessions') StudentSessionsV1.preload();
  else if (opened === 'audit') AuditWorkspaceV1.preload();
  else if (opened === 'policies' || opened === 'publication') StudentPoliciesV1.preload();
  else if (opened === 'settings') StudentSettingsV1.preload();
  else StudentOverviewV1.preload();
}
const sectionFallback = (
  <output className="block py-6 text-sm text-muted">Carregando área do Painel…</output>
);
const SCHOOL: ScopeV1 = { kind: 'school', academicYear: 2026 };
type SectionScope = { section: StudentPortalSection; scope: ScopeV1; label: string };
const enterInstitutionalLogin = () => window.location.replace('/auth/login');
const customizationChanged = () => notifyLiveChangeV1('portal');
/** Owner decision 28/09/2026: automatic reads paused during the first school-wide access; the
 * administrator reloads manually. Initial reads and explicit reloads are unchanged. */
export const PORTAL_ADMIN_AUTO_REFRESH_V1 = false;
/** Administrative Portal entry; heavyweight sections load only when the selected route needs them. */
export function StudentPortalAdminPage({
  fetcher,
  onLogin = enterInstitutionalLogin,
}: {
  fetcher?: PortalFetchV1;
  onLogin?: () => void;
}) {
  const auth = usePortalAdminIdentityV1(fetcher);
  const unauthenticated =
    auth.state.state === 'error' && auth.state.error.state === 'unauthenticated';
  useEffect(() => {
    if (unauthenticated) onLogin();
  }, [unauthenticated, onLogin]);
  if (unauthenticated) return <p role="status">Abrindo entrada institucional…</p>;
  if (auth.state.state !== 'ready')
    return (
      <section className="pa-admin-page">
        <h1>Painel do Aluno</h1>
        {auth.state.state === 'checking' ? (
          <p role="status">Verificando sessão administrativa…</p>
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
  return (
    <LiveRefreshAutomaticV1Provider enabled={PORTAL_ADMIN_AUTO_REFRESH_V1}>
      <PortalWorkspace
        key={auth.state.identity.identityKey + ':' + auth.state.identity.capabilities.join(',')}
        identity={auth.state.identity}
        onLost={auth.lost}
        fetcher={fetcher}
      />
    </LiveRefreshAutomaticV1Provider>
  );
}
type ShiftKeyV1 = Extract<PolicyScopeV1, { kind: 'shift' }>['shift'];
const PANEL_SHIFTS_V1: readonly ShiftKeyV1[] = ['MATUTINO', 'VESPERTINO', 'NOTURNO'];
/** Class, shift and a record opened outside the accounts list, restored after a reload. */
function panelStateFromHashV1() {
  const classId = Number(readPanelHashParamV1('turma'));
  const shift = readPanelHashParamV1('turno');
  return {
    classId: Number.isSafeInteger(classId) && classId > 0 ? classId : null,
    shift: PANEL_SHIFTS_V1.find((item) => item === shift) ?? null,
    accountId: panelHashAccountIdV1('ficha'),
  };
}

/** Keeps identity, scope and drafts mounted while section bundles are loaded on demand. */
function PortalWorkspace({
  identity,
  onLost,
  fetcher,
}: {
  identity: PortalAdminIdentityV1;
  onLost: (error: PortalClientErrorV1) => void;
  fetcher?: PortalFetchV1;
}) {
  const [section, setSection] = useState(() => portalSectionFromHash(window.location.hash));
  usePreloadedSectionsV1(PANEL_SECTIONS_V1);
  useAdministrativeLiveV1({
    identityKey: identity.identityKey,
    onAuthorizationLost: () => onLost(new PortalClientErrorV1('unauthenticated', 401)),
  });
  const panelAuthority = identity.identityKey + ':' + identity.capabilities.join(',');
  const initialPanel = useMemo(() => {
    claimPanelHashV1(panelAuthority);
    return panelStateFromHashV1();
  }, [panelAuthority]);
  const [selectedClass, setSelectedClass] = useState<{ id: number; label: string } | null>(() =>
    initialPanel.classId === null ? null : { id: initialPanel.classId, label: '' },
  );
  const [selectedShift, setSelectedShift] = useState<ShiftKeyV1 | null>(initialPanel.shift);
  const [target, setTarget] = useState<AccountSlotContextV1 | null>(null);
  const [customizationTarget, setCustomizationTarget] = useState<{
    row: CustomizationRowV1;
    area: CustomizationAreaV1;
  } | null>(null);
  const [sectionScope, setSectionScope] = useState<SectionScope | null>(null);
  const pendingScope = useRef<SectionScope | null>(null);
  const qr = useAccountQrHandoffV1();
  const [openedAccount, setOpenedAccount] = useState<{ id: string; parentScope: ScopeV1 } | null>(
    () =>
      initialPanel.accountId === null
        ? null
        : {
            id: initialPanel.accountId,
            parentScope:
              initialPanel.classId === null
                ? SCHOOL
                : { kind: 'class', academicYear: 2026, classId: initialPanel.classId },
          },
  );
  useEffect(() => {
    const change = () => {
      const next = portalSectionFromHash(window.location.hash);
      setSection(next);
      setSectionScope(pendingScope.current?.section === next ? pendingScope.current : null);
      pendingScope.current = null;
      setTarget(null);
      setOpenedAccount(null);
      setCustomizationTarget(null);
      qr.clear();
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, [qr.clear]);
  const clients = useMemo(() => {
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
  const loadClasses = useCallback(
    (signal: AbortSignal) => readClassOptionsV1(clients.catalog, signal),
    [clients.catalog],
  );
  const classRead = useAccountsReadV1(loadClasses);
  const classItems = classRead.state.state === 'ready' ? classRead.state.data : [];
  // A class restored from the address takes its label from the catalog, or is dropped if gone.
  useEffect(() => {
    if (classRead.state.state !== 'ready' || !selectedClass || selectedClass.label) return;
    setSelectedClass(classRead.state.data.find((item) => item.id === selectedClass.id) ?? null);
  }, [classRead.state, selectedClass]);
  useEffect(() => {
    writePanelHashParamsV1({
      turma: selectedClass ? String(selectedClass.id) : null,
      turno: selectedShift,
      ficha: openedAccount?.id ?? null,
    });
  }, [section, selectedClass, selectedShift, openedAccount]);
  const panelScope = useMemo(
    () => ({
      scope: selectedClass
        ? { kind: 'class' as const, academicYear: 2026 as const, classId: selectedClass.id }
        : SCHOOL,
      label: selectedClass ? selectedClass.label || 'Turma' : 'Escola',
    }),
    [selectedClass],
  );
  const common = useMemo(
    () => ({
      ...clients,
      scope: panelScope.scope,
      scopeLabel: panelScope.label,
      identityKey: identity.identityKey,
      canWrite: identity.capabilities.includes('platform.settings.write'),
      onAuthorizationLost: onLost,
    }),
    [clients, identity, onLost, panelScope],
  );
  const openCustomization = useCallback((row: CustomizationRowV1, area: CustomizationAreaV1) => {
    if (allowDraftNavigationV1()) setCustomizationTarget({ row, area });
  }, []);
  const closeCustomization = () => {
    setCustomizationTarget(null);
    customizationChanged();
  };
  const slots = useMemo<AccountSlotsV1>(
    () => ({
      birth: (context) => (
        <StudentBirthYearsV1
          {...common}
          scope={context.scope}
          scopeLabel={context.account.name}
          initialAccount={{ account: context.account, scopeVersion: context.accountsScopeVersion }}
          canWrite={context.canWrite}
        />
      ),
      credentials: (context) => (
        <StudentCredentialsV1
          {...common}
          refreshKey={context.account.version}
          scope={context.scope}
          scopeLabel={context.account.name}
          canWrite={context.canWrite}
        />
      ),
      sessions: (context) => (
        <StudentSessionsV1
          {...common}
          scope={context.scope}
          scopeLabel={context.account.name}
          canWrite={context.canWrite}
        />
      ),
      closing: (context) => (
        <AccountClosingPreviewV1 reader={common.reader} scope={context.scope} />
      ),
      audit: (context) => (
        <StudentAuditV1
          {...common}
          scope={context.scope}
          scopeLabel={context.account.name}
          canWrite={context.canWrite}
        />
      ),
      settings: (context) => (
        <StudentPoliciesV1
          client={common.client}
          reader={common.reader}
          scope={context.scope}
          scopeLabel={context.account.name}
          canWrite={context.canWrite}
          onCommitted={context.refresh}
        />
      ),
    }),
    [common],
  );
  const reprint = useCallback((context: AccountSlotContextV1) => {
    setCustomizationTarget(null);
    setTarget(context);
  }, []);
  let content: ReactNode;
  if (target)
    content = (
      <>
        <Button variant="secondary" onPress={() => setTarget(null)}>
          Voltar às contas
        </Button>
        <StudentCredentialsV1
          {...common}
          scope={target.scope}
          scopeLabel={target.account.name}
          canWrite={target.canWrite}
        />
      </>
    );
  else
    switch (section) {
      case 'accounts':
      case 'credentials':
        content = (
          <StudentAccountsV1
            key={section}
            {...common}
            showAccountsInitially={section === 'credentials'}
            slots={slots}
            onQr={qr.accept}
            onReprint={reprint}
          />
        );
        break;
      case 'birth':
        content = <StudentBirthYearsV1 {...common} />;
        break;
      case 'sessions':
        // Sessions are read for the whole school only (owner decision 07/10/2026).
        content = <StudentSessionsV1 {...common} scope={SCHOOL} scopeLabel="Toda a escola" />;
        break;
      case 'audit':
        content = <AuditWorkspaceV1 {...common} />;
        break;
      case 'publication':
      case 'policies':
        content = (
          <>
            <StudentPoliciesV1
              client={common.client}
              reader={common.reader}
              scope={
                selectedShift
                  ? { kind: 'shift', academicYear: 2026, shift: selectedShift }
                  : (sectionScope?.scope ?? common.scope)
              }
              scopeLabel={selectedShift ? undefined : (sectionScope?.label ?? common.scopeLabel)}
              onCommitted={customizationChanged}
              canWrite={common.canWrite}
              onOpenCustomization={openCustomization}
            />
          </>
        );
        break;
      case 'settings':
        content = (
          <>
            <PublicDemoControlV1 canWrite={common.canWrite} />
            <StudentSettingsV1
              client={common.client}
              scope={SCHOOL}
              scopeLabel="Toda a escola · 2026"
              canWrite={common.canWrite}
              area="general"
            />
          </>
        );
        break;
      default:
        content = (
          <StudentOverviewV1
            {...common}
            scope={sectionScope?.scope ?? common.scope}
            scopeLabel={sectionScope?.label ?? common.scopeLabel}
          />
        );
    }
  return (
    <AccountOpenContextV1.Provider
      value={(id, parentScope = common.scope) => {
        setCustomizationTarget(null);
        setOpenedAccount({ id, parentScope });
      }}
    >
      <PanelScopeContextV1.Provider value={panelScope}>
        <section className="pa-admin-page">
          <header className="pa-admin-header">
            <h1>Painel do Aluno</h1>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => window.open('/portal-demo.html', '_blank', 'noopener')}
            >
              Visão do aluno (demo)
            </Button>
          </header>
          <Tabs
            selectedKey={section === 'credentials' ? 'accounts' : section}
            onSelectionChange={(key) => {
              const next = studentPortalSections.find((item) => item.id === key);
              if (!next || !allowDraftNavigationV1()) return;
              pendingScope.current = null;
              setCustomizationTarget(null);
              setOpenedAccount(null);
              if (section === next.id) {
                setTarget(null);
                setSectionScope(null);
                qr.clear();
              } else window.location.hash = studentPortalHref(next.id);
            }}
          >
            <Tabs.ListContainer className="pa-area-tabs max-w-full overflow-x-auto">
              <Tabs.List aria-label="Áreas do Painel do Aluno">
                {studentPortalSections
                  .filter((item) => item.id !== 'credentials')
                  .map((item) => (
                    <Tabs.Tab key={item.id} id={item.id}>
                      {item.label}
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  ))}
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel
              id={section === 'credentials' ? 'accounts' : section}
              className="pa-admin-content"
            >
              {section === 'sessions' || section === 'settings' ? (
                <>
                  {!common.canWrite && (
                    <p role="status" className="text-xs text-muted">
                      Somente leitura
                    </p>
                  )}
                  <Suspense fallback={sectionFallback}>
                    <LiveRefreshScopeV1 active={!customizationTarget && !openedAccount}>
                      <div key={section}>{content}</div>
                    </LiveRefreshScopeV1>
                  </Suspense>
                </>
              ) : (
                <PortalScopeTabsV1
                  policies={section === 'policies' || section === 'publication'}
                  reader={clients.reader}
                  selectedShift={selectedShift}
                  onShiftChange={(shift) => {
                    if (!allowDraftNavigationV1()) return;
                    writePanelHashParamsV1({ aluno: null });
                    setSelectedShift(shift);
                    setSelectedClass(null);
                    setSectionScope(null);
                    setTarget(null);
                    setCustomizationTarget(null);
                    setOpenedAccount(null);
                    qr.clear();
                  }}
                  items={classItems}
                  selectedId={selectedClass?.id ?? null}
                  allLabel="Todas as turmas"
                  onChange={(id) => {
                    if (!allowDraftNavigationV1()) return;
                    // A record open in the previous class must not reopen in the next list.
                    writePanelHashParamsV1({ aluno: null });
                    setSelectedShift(null);
                    setSelectedClass(classItems.find((item) => item.id === id) ?? null);
                    setSectionScope(null);
                    setTarget(null);
                    setCustomizationTarget(null);
                    setOpenedAccount(null);
                    qr.clear();
                  }}
                >
                  {classRead.state.state === 'error' ? (
                    <AccountsErrorV1
                      error={classRead.state.error}
                      canReload={classRead.canReload}
                      onReload={classRead.reload}
                    />
                  ) : null}
                  {!common.canWrite && (
                    <p role="status" className="text-xs text-muted">
                      Somente leitura
                    </p>
                  )}
                  {sectionScope && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        if (allowDraftNavigationV1()) setSectionScope(null);
                      }}
                    >
                      {selectedClass ? `Voltar à turma ${selectedClass.label}` : 'Toda a escola'}
                    </Button>
                  )}
                  <Suspense fallback={sectionFallback}>
                    <LiveRefreshScopeV1 active={!customizationTarget && !openedAccount}>
                      <div key={section}>{content}</div>
                    </LiveRefreshScopeV1>
                  </Suspense>
                </PortalScopeTabsV1>
              )}
            </Tabs.Panel>
          </Tabs>
          {customizationTarget ? (
            <Suspense fallback={sectionFallback}>
              <CustomizationTargetV1
                key={customizationTarget.row.id + ':' + customizationTarget.area}
                row={customizationTarget.row}
                area={customizationTarget.area}
                client={clients.client}
                reader={clients.reader}
                canWrite={common.canWrite}
                slots={slots}
                onClose={closeCustomization}
                onChanged={customizationChanged}
                onAuthorizationLost={onLost}
                onQr={qr.accept}
                onReprint={reprint}
              />
            </Suspense>
          ) : null}
          {openedAccount && (
            <AccountDetailV1
              accountId={openedAccount.id}
              parentScope={openedAccount.parentScope}
              reader={clients.reader}
              client={clients.client}
              canWrite={common.canWrite}
              slots={slots}
              onQr={qr.accept}
              onChanged={customizationChanged}
              onAuthorizationLost={onLost}
              onClose={() => {
                setOpenedAccount(null);
                qr.clear();
              }}
            />
          )}
          {qr.dialog}
        </section>
      </PanelScopeContextV1.Provider>
    </AccountOpenContextV1.Provider>
  );
}
