import { Suspense, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  Select,
  Skeleton,
  Spinner,
  Surface,
  Table,
} from '@heroui/react';
import {
  Activity,
  Clock3,
  Database,
  Settings2,
} from 'lucide-react';
import {
  normalizePlatformRoute,
  type PlatformRoute,
  type PlatformSnapshotContract,
} from '../../shared/platform-contract';
import type { PlatformSnapshotV2 } from '../../shared/platform-snapshot-v2';
import type { PlatformAuxiliaryStateV2 } from './platform-data-v2';
import { MicrosoftSettingsSectionV1 } from './microsoft-settings-section-v1';
import { preloadedSectionV1, usePreloadedSectionsV1 } from '../shared/ui/preloaded-section-v1';
import { NotesPage } from './notes-page';
import { GradebookYearProvider, GradebookYearSelectV1 } from './gradebook-year-provider';
const SystemHealthPage = preloadedSectionV1(() =>
  import('./system-health-page-v1').then((module) => module.SystemHealthPageV1),
);
const StudentPortalAdminPage = preloadedSectionV1(() =>
  import('../features/student-portal-admin/student-portal-admin-page').then(
    (module) => module.StudentPortalAdminPage,
  ),
);
const ROUTE_PAGES_V1 = [StudentPortalAdminPage, SystemHealthPage];
// The page in the address is needed as soon as the session is confirmed: ask for it at once,
// while the session is still being checked.
if (typeof window !== 'undefined') {
  const opened = normalizePlatformRoute(window.location.hash.replace(/^#\/?/u, ''));
  if (opened === 'painel-do-aluno') StudentPortalAdminPage.preload();
  if (opened === 'operacao') SystemHealthPage.preload();
}
import { EmptyState, formatDate, PageHeader, shortCorrelation } from './presentation';

function AuditPage({ snapshot }: { snapshot: PlatformSnapshotContract }) {
  return (
    <>
      <PageHeader
        eyebrow="Rastreabilidade"
        title="Auditoria"
        titleInBar
        description="Eventos administrativos disponíveis para consulta, sem expor detalhes sensíveis no navegador."
      />
      <Card variant="default" className="overflow-hidden">
        <Card.Header className="border-b border-border/60">
          <Card.Title>Atividade recente</Card.Title>
          <Card.Description>Consulta somente leitura.</Card.Description>
        </Card.Header>
        <Card.Content className="p-0">
          {snapshot.recentAudit.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="Nenhum evento administrativo registrado"
              description="A estrutura de auditoria está pronta; novos eventos aparecerão quando operações auditáveis forem ativadas."
            />
          ) : (
            <Table variant="secondary">
              <Table.ScrollContainer>
                <Table.Content aria-label="Atividade administrativa recente">
                  <Table.Header>
                    <Table.Column id="when">Quando</Table.Column>
                    <Table.Column id="module">Módulo</Table.Column>
                    <Table.Column id="action">Ação</Table.Column>
                    <Table.Column id="result">Resultado</Table.Column>
                    <Table.Column id="correlation">Correlação</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {snapshot.recentAudit.map((entry) => (
                      <Table.Row id={entry.id} key={entry.id}>
                        <Table.Cell className="whitespace-nowrap">
                          {formatDate(entry.occurredAt)}
                        </Table.Cell>
                        <Table.Cell>{entry.module}</Table.Cell>
                        <Table.Cell>{entry.action}</Table.Cell>
                        <Table.Cell>
                          <Chip variant="soft" size="sm">
                            {entry.result || '—'}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs text-muted">
                          {shortCorrelation(entry.correlationId)}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </Card.Content>
      </Card>
    </>
  );
}

type SessionPolicy = {
  version: 1;
  policy: 'absolute';
  defaultDurationHours: number;
  allowedDurationsHours: readonly number[];
  currentDurationHours: number;
  configured: boolean;
  authenticatedAt: string;
  expiresAt: string;
};

type SessionPolicyState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: SessionPolicy };

function sessionDurationLabel(hours: number): string {
  return `${hours} horas`;
}

function SessionDurationSetting() {
  const [state, setState] = useState<SessionPolicyState>({ status: 'loading' });
  const [selectedHours, setSelectedHours] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/platform/settings/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Não foi possível consultar a política de sessão.');
        return (await response.json()) as SessionPolicy;
      })
      .then((value) => {
        setSelectedHours(value.currentDurationHours);
        setState({ status: 'ready', value });
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setState({ status: 'error', message: error.message });
      });
    return () => controller.abort();
  }, []);

  async function save() {
    if (state.status !== 'ready' || selectedHours === null) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const response = await fetch('/api/platform/settings/session', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationHours: selectedHours }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? 'Entre novamente para aplicar esse limite com segurança.'
            : 'Não foi possível atualizar a duração da sessão.',
        );
      }
      const value = (await response.json()) as SessionPolicy;
      setState({ status: 'ready', value });
      setSelectedHours(value.currentDurationHours);
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Não foi possível atualizar a sessão.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card variant="default" className="overflow-hidden">
      <Card.Header className="border-b border-border/60">
        <div className="flex w-full flex-wrap items-start gap-3">
          <Surface
            variant="secondary"
            className="grid size-11 shrink-0 place-items-center rounded-2xl"
          >
            <Clock3 className="size-5 text-accent" />
          </Surface>
          <div className="min-w-0 flex-1">
            <Card.Title>Duração da sessão administrativa</Card.Title>
            <Card.Description>
              Defina por quanto tempo este navegador permanece autenticado após cada entrada.
            </Card.Description>
          </div>
          <Chip color="accent" variant="soft" size="sm">
            Segurança
          </Chip>
        </div>
      </Card.Header>
      <Card.Content className="p-5 sm:p-6">
        {state.status === 'loading' && (
          <div className="flex min-h-28 items-center justify-center gap-3 text-sm text-muted">
            <Spinner size="sm" color="accent" />
            Consultando a sessão atual
          </div>
        )}

        {state.status === 'error' && (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Configuração indisponível</Alert.Title>
              <Alert.Description>{state.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {state.status === 'ready' && (
          <div className="grid items-end gap-5 lg:grid-cols-[minmax(260px,420px)_minmax(0,1fr)_auto]">
            <Select
              selectedKey={selectedHours === null ? null : String(selectedHours)}
              onSelectionChange={(key) => {
                if (key !== null) {
                  setSelectedHours(Number(key));
                  setSaved(false);
                  setSaveError(null);
                }
              }}
            >
              <Label>Limite absoluto</Label>
              <Select.Trigger className="min-h-11 w-full">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {state.value.allowedDurationsHours.map((hours) => (
                    <ListBox.Item
                      key={hours}
                      id={String(hours)}
                      textValue={sessionDurationLabel(hours)}
                    >
                      {sessionDurationLabel(hours)}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            <div className="grid gap-1 text-sm">
              <span className="font-medium">
                Sessão atual: {sessionDurationLabel(state.value.currentDurationHours)}
              </span>
              <span className="text-muted">Expira em {formatDate(state.value.expiresAt)}</span>
              <span className="text-xs text-muted">
                A atividade não renova o prazo indefinidamente. Ao final, será necessário entrar
                novamente.
              </span>
            </div>

            <Button
              variant="primary"
              onPress={save}
              isPending={saving}
              isDisabled={
                state.value.configured && selectedHours === state.value.currentDurationHours
              }
            >
              Aplicar duração
            </Button>
          </div>
        )}

        {saved && state.status === 'ready' && (
          <Alert status="success" className="mt-5">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Duração aplicada</Alert.Title>
              <Alert.Description>
                A sessão atual e as próximas entradas deste usuário neste navegador usarão esse
                limite.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {saveError && state.status === 'ready' && (
          <Alert status="danger" className="mt-5">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Alteração não aplicada</Alert.Title>
              <Alert.Description>{saveError}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </Card.Content>
    </Card>
  );
}

function SettingsPage({ snapshot, auxiliary }: Readonly<{
  snapshot: PlatformSnapshotV2;
  auxiliary: PlatformAuxiliaryStateV2;
}>) {
  return (
    <>
      <PageHeader
        eyebrow="Governança"
        title="Configurações"
        titleInBar
        description="Consulte as configurações administrativas e seu estado de vigência."
      />

      <Card variant="default" className="mb-5 overflow-hidden">
        <Card.Header className="border-b border-border/60">
          <Card.Title>Ano letivo</Card.Title>
        </Card.Header>
        <Card.Content className="p-5 sm:p-6">
          <GradebookYearProvider>
            <GradebookYearSelectV1 />
          </GradebookYearProvider>
        </Card.Content>
      </Card>

      <SessionDurationSetting />

      <MicrosoftSettingsSectionV1
        title="Registro de configurações"
        section="configurations"
        snapshot={snapshot}
        auxiliary={auxiliary}
      >
      <Card variant="default" className="mt-5 overflow-hidden">
        <Card.Header className="border-b border-border/60">
          <Card.Title>Registro de configurações</Card.Title>
          <Card.Description>Chave, escopo, versão e estado de vigência.</Card.Description>
        </Card.Header>
        <Card.Content className="p-0">
          {snapshot.configurations.length === 0 ? (
            <EmptyState
              icon={Settings2}
              title="Nenhuma configuração cadastrada"
              description="O registro institucional está disponível para receber parâmetros versionados quando suas regras forem definidas."
            />
          ) : (
            <Table variant="secondary">
              <Table.ScrollContainer>
                <Table.Content aria-label="Configurações institucionais">
                  <Table.Header>
                    <Table.Column id="key">Chave</Table.Column>
                    <Table.Column id="scope">Escopo</Table.Column>
                    <Table.Column id="version">Versão</Table.Column>
                    <Table.Column id="state">Estado</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {snapshot.configurations.map((configuration) => (
                      <Table.Row id={configuration.id} key={configuration.id}>
                        <Table.Cell className="font-medium">{configuration.key}</Table.Cell>
                        <Table.Cell className="text-muted">{configuration.scope}</Table.Cell>
                        <Table.Cell>{configuration.version || '—'}</Table.Cell>
                        <Table.Cell>
                          <Chip
                            color={configuration.active ? 'success' : 'default'}
                            variant="soft"
                            size="sm"
                          >
                            {configuration.active ? 'Ativa' : 'Inativa'}
                          </Chip>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </Card.Content>
      </Card>
      </MicrosoftSettingsSectionV1>

      <MicrosoftSettingsSectionV1
        title="Migrações registradas"
        section="migrations"
        snapshot={snapshot}
        auxiliary={auxiliary}
      >
      <Card variant="default" className="mt-5 overflow-hidden">
        <Card.Header className="border-b border-border/60">
          <Card.Title>Migrações registradas</Card.Title>
          <Card.Description>
            {snapshot.migrations.length} registro(s) encontrado(s).
          </Card.Description>
        </Card.Header>
        <Card.Content className="p-0">
          {snapshot.migrations.length === 0 ? (
            <EmptyState
              icon={Database}
              title="Nenhuma migração registrada"
              description="Nenhuma migração de módulo foi necessária até o momento."
            />
          ) : (
            <Table variant="secondary">
              <Table.ScrollContainer>
                <Table.Content aria-label="Migrações registradas">
                  <Table.Header>
                    <Table.Column id="version">Versão</Table.Column>
                    <Table.Column id="module">Módulo</Table.Column>
                    <Table.Column id="applied">Aplicada em</Table.Column>
                    <Table.Column id="result">Resultado</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {snapshot.migrations.map((migration) => (
                      <Table.Row id={migration.id} key={migration.id}>
                        <Table.Cell className="font-medium">
                          {migration.version || 'Versão não informada'}
                        </Table.Cell>
                        <Table.Cell className="text-muted">{migration.module}</Table.Cell>
                        <Table.Cell className="whitespace-nowrap">
                          {formatDate(migration.appliedAt)}
                        </Table.Cell>
                        <Table.Cell>
                          <Chip variant="soft" size="sm">
                            {migration.result || '—'}
                          </Chip>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </Card.Content>
      </Card>
      </MicrosoftSettingsSectionV1>
    </>
  );
}

export function PageContent({
  route,
  section,
  snapshot,
  auxiliary = 'ready',
}: {
  route: PlatformRoute;
  /** The section of the open service; Auditoria is a section of Saúde do Sistema. */
  section?: string;
  snapshot: PlatformSnapshotV2;
  auxiliary?: PlatformAuxiliaryStateV2;
}) {
  usePreloadedSectionsV1(ROUTE_PAGES_V1);
  switch (route) {
    case 'painel-do-aluno':
      return <Suspense fallback={<p role="status">Carregando Painel do Aluno…</p>}><StudentPortalAdminPage /></Suspense>;
    case 'operacao':
      if (section === 'audit') return <AuditPage snapshot={snapshot} />;
      return <Suspense fallback={<output className="block">Carregando Saúde…</output>}><SystemHealthPage snapshot={snapshot} /></Suspense>;
    case 'configuracoes':
      return <SettingsPage snapshot={snapshot} auxiliary={auxiliary} />;
    default:
      return <NotesPage />;
  }
}

export function LoadingWorkspace() {
  return (
    <Surface
      variant="default"
      className="platform-card-surface platform-loading-panel rounded-3xl p-5 sm:p-7"
      role="status"
      aria-label="Carregando dados institucionais"
    >
      <div className="flex flex-col items-center py-8 text-center">
        <div className="loading-orbit">
          <Spinner color="accent" size="lg" />
        </div>
        <Chip color="accent" variant="soft" size="sm" className="mt-5">
          Preparando o Centro
        </Chip>
        <h2 className="mt-4 text-2xl font-semibold tracking-[-0.04em]">
          Carregando dados institucionais
        </h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted">
          O shell já está disponível enquanto o snapshot autorizado é preparado.
        </p>
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,.55fr)]">
        <Skeleton className="stagger-item min-h-64 rounded-3xl" />
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
          <Skeleton className="stagger-item h-24 rounded-3xl" />
          <Skeleton className="stagger-item h-24 rounded-3xl" />
          <Skeleton className="stagger-item h-24 rounded-3xl" />
        </div>
      </div>
      <Skeleton className="stagger-item mt-4 h-60 rounded-3xl" />
    </Surface>
  );
}