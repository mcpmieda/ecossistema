import { Card, Chip, Label, ProgressBar, Surface, Table } from '@heroui/react';
import {
  Activity,
  CheckCircle2,
  Database,
  HeartPulse,
  PlugZap,
  RotateCcw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { PlatformSnapshotContract } from '../../shared/platform-contract';
import { EmptyState, formatDate, PageHeader } from './presentation';

type SignalStatus = 'ok' | 'attention' | 'unknown';

type OperationalSignal = {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  status: SignalStatus;
};

function SignalChip({ status }: Readonly<{ status: SignalStatus }>) {
  if (status === 'attention') {
    return (
      <Chip color="danger" variant="soft" size="sm">
        Atenção
      </Chip>
    );
  }
  if (status === 'unknown') {
    return (
      <Chip variant="soft" size="sm">
        Não verificado
      </Chip>
    );
  }
  return (
    <Chip color="success" variant="soft" size="sm">
      Sem sinal de falha
    </Chip>
  );
}

function auditDescription(failures: number, lastAuditAt: string) {
  if (failures > 0)
    return `${failures} evento(s) recente(s) possuem resultado explicitamente iniciado por erro ou falha.`;
  return lastAuditAt
    ? `Nenhum resultado explicitamente classificado como erro/falha nos eventos carregados. Último evento: ${formatDate(lastAuditAt)}.`
    : 'Nenhum evento recente foi carregado; não há evidência suficiente para inferir atividade.';
}

function auditStatus(failures: number, lastAuditAt: string) {
  if (lastAuditAt === '') return 'unknown';
  return failures > 0 ? 'attention' : 'ok';
}

export function OperationsPage({ snapshot }: Readonly<{ snapshot: PlatformSnapshotContract }>) {
  const operational = snapshot.operational;

  if (!operational) {
    return (
      <>
        <PageHeader
          eyebrow="Confiabilidade"
          title="Operação"
          description="Acompanhe a disponibilidade do núcleo, pontos de atenção e informações de recuperação."
        />
        <Card variant="default">
          <Card.Content className="p-0">
            <EmptyState
              icon={HeartPulse}
              title="Sinais operacionais não disponíveis"
              description="Seu perfil não possui a permissão necessária para consultar esta área."
            />
          </Card.Content>
        </Card>
      </>
    );
  }

  const attention = operational.status === 'attention';
  const registeredCount = snapshot.registeredModules.length;
  const healthCoverage =
    registeredCount === 0
      ? 0
      : Math.round((operational.healthContractsConfigured / registeredCount) * 100);
  const healthCoverageDescription =
    registeredCount === 0
      ? 'Nenhum sistema independente está registrado para monitoramento.'
      : `${operational.healthContractsConfigured} de ${registeredCount} sistema(s) registrado(s) possuem monitoramento configurado.`;

  const signals: OperationalSignal[] = [
    {
      id: 'foundation',
      icon: Database,
      title: 'Estrutura da plataforma',
      description: snapshot.foundation.expectedPlatformListsPresent
        ? 'As estruturas de dados necessárias ao Centro foram localizadas.'
        : `Ausentes: ${snapshot.foundation.missingPlatformLists.join(', ')}.`,
      status: snapshot.foundation.status === 'ok' ? 'ok' : 'attention',
    },
    {
      id: 'audit',
      icon: Activity,
      title: 'Auditoria recente',
      description:
        auditDescription(operational.recentAuditFailureCount, operational.lastAuditAt),
      status:
        auditStatus(operational.recentAuditFailureCount, operational.lastAuditAt),
    },
    {
      id: 'health',
      icon: PlugZap,
      title: 'Monitoramento dos sistemas',
      description: healthCoverageDescription,
      status: registeredCount === 0 || operational.healthContractsMissing > 0 ? 'unknown' : 'ok',
    },
    {
      id: 'recovery',
      icon: RotateCcw,
      title: 'Recuperação e restore',
      description:
        'O estado atual não contém evidência de teste de restauração. A ausência dessa evidência não é tratada como falha ativa, mas permanece um ponto de atenção.',
      status: 'unknown',
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Confiabilidade"
        title="Operação"
        description="Acompanhe a disponibilidade do núcleo, pontos de atenção e informações de recuperação."
      />

      <Surface variant="default" className="platform-card-surface rounded-3xl p-6 sm:p-7">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                {attention ? (
                  <TriangleAlert className="size-4 text-danger" />
                ) : (
                  <HeartPulse className="size-4 text-success" />
                )}
                Estado observado
              </div>
              <h3 className="mt-4 max-w-3xl text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">
                {attention
                  ? 'Há sinais que exigem atenção'
                  : 'Sem degradação observada no estado atual'}
              </h3>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
                Este estado considera somente as informações disponíveis e autorizadas. Ele não
                substitui verificações específicas dos sistemas externos nem os testes de
                recuperação.
              </p>
            </div>
            <Chip color={attention ? 'danger' : 'success'} variant="soft" size="sm">
              {attention ? 'Atenção' : 'Nominal'}
            </Chip>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Card variant="default" className="stagger-item">
              <Card.Header>
                <Card.Description>Estrutura obrigatória</Card.Description>
                <Card.Title className="text-xl">
                  {snapshot.foundation.expectedPlatformListsPresent ? 'Completa' : 'Incompleta'}
                </Card.Title>
              </Card.Header>
              <Card.Content className="text-xs leading-5 text-muted">
                {snapshot.foundation.expectedPlatformListsPresent
                  ? 'Todas as listas estruturais foram encontradas.'
                  : `${snapshot.foundation.missingPlatformLists.length} lista(s) obrigatória(s) ausente(s).`}
              </Card.Content>
            </Card>
            <Card variant="default" className="stagger-item">
              <Card.Header>
                <Card.Description>Falhas na auditoria recente</Card.Description>
                <Card.Title className="text-xl">{operational.recentAuditFailureCount}</Card.Title>
              </Card.Header>
              <Card.Content className="text-xs leading-5 text-muted">
                Entre os {snapshot.recentAudit.length} eventos recentes carregados.
              </Card.Content>
            </Card>
            <Card variant="default" className="stagger-item">
              <Card.Header>
                <Card.Description>Monitoramento configurado</Card.Description>
                <Card.Title className="text-xl">{operational.healthContractsConfigured}</Card.Title>
              </Card.Header>
              <Card.Content className="text-xs leading-5 text-muted">
                {registeredCount === 0
                  ? 'Nenhum sistema independente registrado.'
                  : `${operational.healthContractsMissing} sistema(s) sem monitoramento configurado.`}
              </Card.Content>
            </Card>
          </div>

          <Surface variant="secondary" className="rounded-2xl p-4">
            <ProgressBar
              value={healthCoverage}
              color={healthCoverage === 100 ? 'success' : 'accent'}
              aria-label="Cobertura de monitoramento"
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <Label className="text-xs font-medium">Cobertura de monitoramento</Label>
                <ProgressBar.Output className="text-xs font-semibold" />
              </div>
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
          </Surface>
        </div>
      </Surface>

      <Card variant="default" className="mt-5 overflow-hidden">
        <Card.Header className="border-b border-border/60">
          <Card.Title>Sinais observados</Card.Title>
          <Card.Description>
            Falha detectada, cobertura configurada e evidência ainda ausente em uma única leitura.
          </Card.Description>
        </Card.Header>
        <Card.Content className="p-0">
          <Table variant="secondary">
            <Table.ScrollContainer>
              <Table.Content aria-label="Sinais operacionais observados">
                <Table.Header>
                  <Table.Column id="signal" isRowHeader>Sinal</Table.Column>
                  <Table.Column id="evidence">Evidência</Table.Column>
                  <Table.Column id="status">Estado</Table.Column>
                </Table.Header>
                <Table.Body>
                  {signals.map((signal) => {
                    const Icon = signal.icon;
                    return (
                      <Table.Row id={signal.id} key={signal.id}>
                        <Table.Cell>
                          <div className="flex min-w-48 items-center gap-3">
                            <Surface
                              variant="secondary"
                              className="grid size-9 shrink-0 place-items-center rounded-xl"
                            >
                              <Icon className="size-4 text-muted" />
                            </Surface>
                            <span className="font-medium">{signal.title}</span>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="min-w-80 text-sm leading-5 text-muted">
                          {signal.description}
                        </Table.Cell>
                        <Table.Cell className="whitespace-nowrap">
                          <SignalChip status={signal.status} />
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Card.Content>
      </Card>

      <Card variant="default" className="mt-5 overflow-hidden">
        <Card.Header className="border-b border-border/60">
          <Card.Title>Cobertura dos sistemas registrados</Card.Title>
          <Card.Description>
            Acompanhamento das informações de integração e monitoramento cadastradas para cada
            sistema.
          </Card.Description>
        </Card.Header>
        <Card.Content className="p-0">
          {snapshot.registeredModules.length === 0 ? (
            <EmptyState
              icon={PlugZap}
              title="Nenhum sistema independente registrado"
              description="Quando sistemas forem incorporados ao Centro, a cobertura dos contratos de saúde aparecerá aqui sem transformar configuração em falsa prova de disponibilidade."
            />
          ) : (
            <Table variant="secondary">
              <Table.ScrollContainer>
                <Table.Content aria-label="Cobertura operacional dos sistemas registrados">
                  <Table.Header>
                    <Table.Column id="system" isRowHeader>Sistema</Table.Column>
                    <Table.Column id="state">Estado declarado</Table.Column>
                    <Table.Column id="health">Monitoramento</Table.Column>
                    <Table.Column id="updated">Atualização</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {snapshot.registeredModules.map((module) => (
                      <Table.Row id={module.id} key={module.id}>
                        <Table.Cell className="font-medium">{module.name}</Table.Cell>
                        <Table.Cell>
                          <Chip variant="soft" size="sm">
                            {module.status || 'sem estado'}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell>
                          {module.healthEndpoint.trim() ? (
                            <div className="flex items-center gap-2 text-sm">
                              <CheckCircle2 className="size-4 text-success" />
                              Configurado
                            </div>
                          ) : (
                            <span className="text-sm text-muted">Não configurado</span>
                          )}
                        </Table.Cell>
                        <Table.Cell className="whitespace-nowrap text-muted">
                          {formatDate(module.updatedAt)}
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
