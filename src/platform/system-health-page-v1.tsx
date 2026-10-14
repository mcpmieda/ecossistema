import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button, Card, Chip, Surface, Table } from '@heroui/react';
import { Activity, Database, Globe, HeartPulse, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { PlatformSnapshotV2 } from '../../shared/platform-snapshot-v2';
import { cappedHealthCountV1, sampleIsFreshV1, systemHealthStateV1, type HealthStateV1,
  type PortalMaintenanceSampleV1, type PortalMonitorSampleV1, type PublicEntrySampleV1,
  type SystemHealthSnapshotV1 } from '../../shared/system-health-v1';
import { createHealthMonitorV1 } from './system-health-controller-v1';
import { SystemHealthAnalysisV1 } from './system-health-analysis-v1';
import { usePlatformIdentityV1 } from './platform-identity-v1';
import { PageHeader } from './presentation';
const PlatformEvidence = lazy(() => import('./operations-page').then((module) => ({ default: module.OperationsPage })));
const labels: Record<HealthStateV1, string> = { normal: 'Normal', attention: 'Atenção', critical: 'Crítico', unknown: 'Sem dados' };
const colors = { normal: 'success', attention: 'warning', critical: 'danger', unknown: 'default' } as const;
const date = (value: string) => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Bahia' });
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
const wait = (ms: number) => ms < 60_000 ? duration(ms) : `${Math.floor(ms / 60_000).toLocaleString('pt-BR')} min`;
function Status({ state }: Readonly<{ state: HealthStateV1 }>) {
  return <Chip size="sm" variant="soft" color={colors[state]}>{labels[state]}</Chip>;
}
function Metric({ title, value, detail, state, icon: Icon }: Readonly<{
  title: string; value: string; detail: string; state: HealthStateV1; icon: typeof Activity;
}>) {
  return <Card variant="default" className="min-w-0"><Card.Header>
    <div className="flex items-start justify-between gap-3"><Icon className="size-5 shrink-0 text-muted" aria-hidden="true" /><Status state={state} /></div>
    <Card.Description className="mt-2">{title}</Card.Description><Card.Title className="break-words text-2xl">{value}</Card.Title>
  </Card.Header><Card.Content className="text-sm text-muted"><details><summary className="cursor-pointer text-xs">Detalhes</summary><p className="mt-2">{detail}</p></details></Card.Content></Card>;
}
function useMonitor(onDenied: () => void) {
  const monitor = useMemo(() => createHealthMonitorV1({ onDenied }), [onDenied]);
  const [now, setNow] = useState(Date.now);
  const subscribe = useCallback((listener: () => void) => monitor.subscribe(() => { setNow(Date.now()); listener(); }), [monitor]);
  const state = useSyncExternalStore(subscribe, monitor.getState, monitor.getState);
  useEffect(() => {
    const available = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;
    const change = () => { monitor.setAvailable(available()); setNow(Date.now()); };
    const hide = () => monitor.stop(), show = () => { change(); monitor.start(); };
    monitor.setAvailable(available()); monitor.start();
    window.addEventListener('online', change); window.addEventListener('offline', change);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', change);
    const clock = setInterval(() => { if (available()) setNow(Date.now()); }, 15_000);
    return () => {
      monitor.stop(); clearInterval(clock);
      window.removeEventListener('online', change); window.removeEventListener('offline', change);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', change);
    };
  }, [monitor]);
  return { ...state, now, refresh: monitor.refresh };
}
function usable(snapshot: SystemHealthSnapshotV1 | null, now: number): boolean {
  return snapshot !== null && sampleIsFreshV1(snapshot.generatedAt, now)
    && (!snapshot.portal || sampleIsFreshV1(snapshot.portal.observedAt, now))
    && (!snapshot.publicEntry.observedAt || sampleIsFreshV1(snapshot.publicEntry.observedAt, now));
}
const COVERAGE = [
  { id: 'public-entry', name: 'Entrada pública', source: 'Verificação HTTP da página inicial', limit: 'Não confirma login ou execução das telas.' },
  { id: 'database', name: 'Banco e filas do Portal', source: 'Leitura privada e histórico de 30 dias', limit: 'Resumo de 24 horas e medições de banco sob demanda.' },
  { id: 'providers', name: 'Cloudflare e Supabase', source: 'Estado global público e banco nativo', limit: 'CPU, memória, tráfego e cotas da conta ainda não integrados.' },
  { id: 'functional', name: 'Login e telas do aluno', source: 'Teste funcional: não configurado', limit: 'Verificação autenticada protegida ainda pendente.' },
  { id: 'browser', name: 'Erros no navegador', source: 'Recepção e agregação implementadas', limit: 'Observações parciais; não representam todos os erros.' },
  { id: 'alerting', name: 'Avisos e histórico', source: 'Consulta no histórico operacional', limit: 'Coleta de configuração e filas a cada 5 minutos; sem aviso externo.' },
] as const;
function HealthSummary({ monitor, current }: Readonly<{ monitor: ReturnType<typeof useMonitor>; current: SystemHealthSnapshotV1 | null }>) {
  const overall = current ? systemHealthStateV1(current, monitor.now) : 'unknown';
  const title = { normal: 'Verificações básicas normais', attention: 'Há pontos de atenção',
    critical: 'Uma verificação exige intervenção', unknown: 'Não há confirmação suficiente' }[overall];
  return <><Surface variant="default" className="platform-card-surface rounded-3xl p-5 sm:p-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0">
      <div className="flex flex-wrap items-center gap-3"><HeartPulse className="size-5" aria-hidden="true" /><Status state={overall} /><Chip size="sm" variant="soft">Cobertura parcial</Chip></div>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm text-muted">Login completo e telas no navegador ainda não verificados.</p>
      <p className="mt-3 text-xs text-muted">{monitor.snapshot ? `Última coleta: ${date(monitor.snapshot.generatedAt)} (Bahia)` : 'Nenhuma coleta disponível.'}</p>
    </div><Button variant="secondary" onPress={() => { void monitor.refresh(); }} isDisabled={monitor.loading || monitor.paused || monitor.error === 'denied'}>
      <RefreshCw className="size-4" aria-hidden="true" />{monitor.loading ? 'Verificando…' : 'Atualizar'}</Button></div>
    <p className="mt-3 text-xs text-muted">Atualização a cada 60 segundos enquanto esta área estiver aberta e visível. Dados com mais de 2 minutos deixam de confirmar o estado atual.</p>
  </Surface>
    {monitor.error === 'denied' ? <p role="alert" className="mt-4 text-danger">Acesso ao monitoramento não autorizado. Os dados foram removidos; reabra a área após verificar sua sessão.</p> : null}
    {monitor.error === 'unavailable' ? <p role="alert" className="mt-4 text-warning">Não foi possível atualizar. A última coleta não está sendo usada como confirmação de normalidade.</p> : null}
    {monitor.paused ? <output className="mt-4 block text-muted">Atualização pausada.</output> : null}
  </>;
}
function PublicEntryMetric({ entry }: Readonly<{ entry: PublicEntrySampleV1 | null }>) {
  let state: HealthStateV1 = 'unknown', value = 'Sem confirmação';
  if (entry?.outcome === 'ok') { state = 'normal'; value = 'Respondeu'; }
  else if (entry?.outcome === 'http-error' || entry?.outcome === 'unexpected-response') { state = 'critical'; value = 'Resposta inesperada'; }
  return <Metric icon={Globe} title="Entrada pública" value={value} state={state}
    detail="Página inicial via HTTP. Não confirma a execução das telas ou um login completo." />;
}
function PortalAccessMetric({ portal }: Readonly<{ portal: PortalMonitorSampleV1 | null }>) {
  let state: HealthStateV1 = 'unknown', value = 'Sem dados';
  if (portal) { value = portal.servingEnabled ? 'Habilitado' : 'Desabilitado'; state = portal.servingEnabled && portal.credentialsConfigured ? 'normal' : 'attention'; }
  return <Metric icon={ShieldCheck} title="Acesso do Portal" value={value} state={state}
    detail={portal && !portal.credentialsConfigured ? 'A configuração de credenciais está incompleta.' : 'Estado da configuração; não equivale a um teste de entrada do aluno.'} />;
}
function DatabaseMetric({ portal }: Readonly<{ portal: PortalMonitorSampleV1 | null }>) {
  let state: HealthStateV1 = 'unknown', value = 'Sem dados';
  if (portal?.database === 'ok') { state = 'normal'; value = duration(portal.readDurationMs); }
  else if (portal?.database === 'unavailable') { state = 'critical'; value = 'Não concluída'; }
  return <Metric icon={Database} title="Leitura técnica do banco" value={value} state={state}
    detail="Caminho Portal → Hyperdrive → PostgreSQL. Uma falha aqui não identifica sozinha o fornecedor responsável." />;
}
function PublicationMetric({ maintenance }: Readonly<{ maintenance: PortalMaintenanceSampleV1 | null }>) {
  let state: HealthStateV1 = 'unknown';
  if (maintenance) state = maintenance.backlog ? 'attention' : 'normal';
  if (maintenance?.exhausted) state = 'critical';
  return <Metric icon={Activity} title="Publicações aguardando" value={maintenance ? cappedHealthCountV1(maintenance.publicationDue) : '—'}
    state={state} detail={maintenance?.exhausted ? 'Há publicação que esgotou as tentativas e exige verificação.' : 'Itens disponíveis para processamento, sem contar tarefas futuras ou ocupadas.'} />;
}
function LiveMetric({ maintenance }: Readonly<{ maintenance: PortalMaintenanceSampleV1 | null }>) {
  let state: HealthStateV1 = 'unknown';
  if (maintenance?.liveOutboxAvailable) state = maintenance.liveBacklog ? 'attention' : 'normal';
  return <Metric icon={RefreshCw} title="Avisos de atualização" value={maintenance?.liveOutboxAvailable ? cappedHealthCountV1(maintenance.livePending) : '—'}
    state={state} detail="Avisos de atualização usados pelas telas administrativas. Ausência da estrutura não é tratada como zero." />;
}
function LockMetric({ maintenance }: Readonly<{ maintenance: PortalMaintenanceSampleV1 | null }>) {
  let state: HealthStateV1 = 'unknown';
  if (maintenance) state = maintenance.oldestWaitingQueryMs >= 1000 ? 'attention' : 'normal';
  return <Metric icon={TriangleAlert} title="Conexões em espera" value={maintenance ? maintenance.waitingConnections.toLocaleString('pt-BR') : '—'}
    state={state} detail="Conexões do Portal aguardando liberação de bloqueios. Limites configurados em Banco de dados e conexões." />;
}
function QueueTable({ maintenance }: Readonly<{ maintenance: PortalMaintenanceSampleV1 | null }>) {
  const queueRows = [
    { id: 'publication', name: 'Publicações prontas para processamento', value: maintenance ? cappedHealthCountV1(maintenance.publicationDue) : '—',
      age: maintenance ? wait(maintenance.oldestPublicationDueMs) : '—', detail: 'Itens já vencidos e sem execução protegida por outra operação.' },
    { id: 'live', name: 'Avisos de atualização pendentes', value: maintenance?.liveOutboxAvailable ? cappedHealthCountV1(maintenance.livePending) : '—',
      age: maintenance?.liveOutboxAvailable ? wait(maintenance.oldestLiveDueMs) : '—', detail: 'Espera calculada apenas sobre avisos vencidos e livres para envio.' },
    { id: 'retry', name: 'Avisos em nova tentativa', value: maintenance?.liveOutboxAvailable ? cappedHealthCountV1(maintenance.liveRetrying) : '—',
      age: '—', detail: 'Parte dos avisos pendentes; não deve ser somada ao total.' },
    { id: 'locks', name: 'Conexões esperando liberação', value: maintenance ? maintenance.waitingConnections.toLocaleString('pt-BR') : '—',
      age: maintenance ? wait(maintenance.oldestWaitingQueryMs) : '—', detail: 'Tempo desde o início da consulta em espera. Não representa todas as conexões do banco.' },
  ];
  return <Card variant="default" className="mt-5 min-w-0 overflow-hidden"><Card.Header><Card.Title>Filas e banco</Card.Title>
    <Card.Description>Última amostra · “1.000+” indica limite da leitura, não capacidade.</Card.Description></Card.Header>
    <Card.Content className="p-0"><Table variant="secondary"><Table.ScrollContainer><Table.Content aria-label="Filas e espera do Portal">
      <Table.Header><Table.Column id="metric" isRowHeader>Sinal</Table.Column><Table.Column id="value">Quantidade</Table.Column><Table.Column id="age">Maior espera observada</Table.Column></Table.Header>
      <Table.Body>{queueRows.map((row) => <Table.Row id={row.id} key={row.id}><Table.Cell className="py-2"><p className="min-w-48 font-medium">{row.name}</p>
        <details><summary className="mt-1 cursor-pointer text-xs text-muted">Detalhes</summary><p className="mt-1 max-w-xl text-xs text-muted">{row.detail}</p></details></Table.Cell>
        <Table.Cell className="whitespace-nowrap py-2">{row.value}</Table.Cell><Table.Cell className="whitespace-nowrap py-2">{row.age}</Table.Cell></Table.Row>)}</Table.Body>
    </Table.Content></Table.ScrollContainer></Table></Card.Content></Card>;
}
function CleanupNotice({ maintenance }: Readonly<{ maintenance: PortalMaintenanceSampleV1 | null }>) {
  if (!maintenance || (maintenance.expiredIp === 0 && maintenance.expiredAudit === 0)) return null;
  return <Card variant="default" className="mt-5"><Card.Header><Card.Title>Limpeza de registros técnicos</Card.Title></Card.Header>
    <Card.Content className="text-sm">Há registros técnicos vencidos aguardando limpeza. Verifique a manutenção agendada; esta tela não executa exclusões.</Card.Content></Card>;
}
function AdministrativeEvidence({ platform }: Readonly<{ platform: PlatformSnapshotV2 }>) {
  const [evidence, setEvidence] = useState(false);
  const available = platform.operational !== null && !platform.unavailableSections?.some((section) => ['lists', 'modules', 'audit'].includes(section));
  let content = null;
  if (evidence) content = available
    ? <div className="mt-3"><Suspense fallback={<output className="block">Carregando evidências…</output>}><PlatformEvidence snapshot={platform} /></Suspense></div>
    : <p className="p-3 text-sm text-muted">Evidências administrativas indisponíveis. O monitoramento do Portal usa uma consulta independente.</p>;
  return <details className="mt-5" onToggle={(event) => setEvidence(event.currentTarget.open)}>
    <summary className="cursor-pointer rounded-xl p-3 font-medium focus-visible:outline focus-visible:outline-2">Evidências do Centro ADM</summary>{content}</details>;
}
function Workspace({ snapshot: platform, onDenied }: Readonly<{ snapshot: PlatformSnapshotV2; onDenied: () => void }>) {
  const monitor = useMonitor(onDenied);
  const current = usable(monitor.snapshot, monitor.now) && !monitor.error && !monitor.paused ? monitor.snapshot : null;
  const portal = current?.portal ?? null, maintenance = portal?.maintenance ?? null;
  return <section className="min-w-0" aria-label="Monitoramento do Portal do Aluno">
    <PageHeader eyebrow="Operação" title="Saúde do Sistema" description="Portal do Aluno" titleInBar /><HealthSummary monitor={monitor} current={current} />
    <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3"><PublicEntryMetric entry={current?.publicEntry ?? null} />
      <PortalAccessMetric portal={portal} /><DatabaseMetric portal={portal} /><PublicationMetric maintenance={maintenance} />
      <LiveMetric maintenance={maintenance} /><LockMetric maintenance={maintenance} /></div>
    <QueueTable maintenance={maintenance} /><CleanupNotice maintenance={maintenance} />
    {monitor.error !== 'denied' ? <SystemHealthAnalysisV1 onDenied={onDenied} /> : null}
    <details className="mt-4 rounded-2xl border border-default p-4"><summary className="cursor-pointer font-medium">Cobertura e preparação para a abertura</summary>
      <dl className="mt-4 grid gap-4 md:grid-cols-2">{COVERAGE.map((item) => <div key={item.id} className="min-w-0">
        <dt className="font-medium">{item.name}</dt><dd className="mt-1 text-sm text-muted">{item.source}<br />{item.limit}</dd></div>)}</dl>
    </details><AdministrativeEvidence platform={platform} />
  </section>;
}
export function SystemHealthPageV1({ snapshot }: Readonly<{ snapshot: PlatformSnapshotV2 }>) {
  const { identity, accessError, retry, recheck } = usePlatformIdentityV1();
  if (!identity?.authenticated || !identity.identityKey || !identity.capabilities?.includes('platform.health.read')
    || !identity.capabilities.includes('platform.settings.read')) return <section>
    <PageHeader eyebrow="Operação" title="Saúde do Sistema" description="Portal do Aluno" titleInBar /><Card><Card.Content>
      <output className="block">{accessError || identity ? 'Acesso ao monitoramento não autorizado.' : 'Verificando acesso…'}</output>
      {accessError ? <Button className="mt-3" variant="secondary" onPress={retry}>Verificar acesso</Button> : null}</Card.Content></Card></section>;
  return <Workspace key={identity.identityKey} snapshot={snapshot} onDenied={recheck} />;
}
