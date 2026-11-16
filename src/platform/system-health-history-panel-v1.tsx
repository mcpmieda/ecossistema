import { schoolDateTimeTextV1 } from '../../shared/locale-format-v1';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, Table } from '@heroui/react';
import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1';
import { cappedHealthCountV1, type HealthStateV1 } from '../../shared/system-health-v1';
import { HEALTH_HISTORY_BODY_BYTES_V1, HEALTH_HISTORY_RETENTION_MS_V1, isPortalHistoryV1,
  portalHistoryChangeV1, portalHistoryFreshV1, portalHistoryPointStateV1,
  type PortalHistoryPointV1, type PortalHistoryV1 } from '../../shared/system-health-history-v1';
import { HealthCompactRowsV1 } from './system-health-compact-rows-v1';
type ReadState = { data: PortalHistoryV1 | null; boundary: PortalHistoryPointV1 | null;
  before: string | null; loading: boolean; error: 'denied' | 'unavailable' | null };
const initial = (): ReadState => ({ data: null, boundary: null, before: null, loading: false, error: null });
const labels: Record<HealthStateV1, string> = { normal: 'Normal', attention: 'Atenção', critical: 'Crítico', unknown: 'Sem confirmação' };
const colors = { normal: 'success', attention: 'warning', critical: 'danger', unknown: 'default' } as const;
const date = (at: string) => schoolDateTimeTextV1(at);
class HistoryAccessError extends Error {}
async function fetchHistory(before: string | null, controller: AbortController): Promise<PortalHistoryV1> {
  return healthDeadlineV1(async (signal) => {
    const response = await fetch('/api/platform/system-health/history', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ before }),
    });
    if (response.status === 401 || response.status === 403) throw new HistoryAccessError();
    if (!response.ok) throw new Error('history-unavailable');
    const data = await readHealthJsonV1(response, signal, HEALTH_HISTORY_BODY_BYTES_V1);
    if (!isPortalHistoryV1(data) || (before !== null
      && data.points.some((point) => Date.parse(point.bucketAt) >= Date.parse(before)))) throw new Error('history-unavailable');
    return data;
  }, 5_000, controller.signal);
}
function notice(state: ReadState, now: number): string {
  if (state.loading) return 'Consultando histórico…';
  if (state.error === 'denied') return 'Acesso ao histórico não autorizado.';
  if (state.error || state.data?.state === 'unavailable') return 'Histórico indisponível. Não há confirmação de normalidade.';
  if (!state.data) return 'Consulte o histórico para ver os registros.';
  if (state.data.state === 'unconfigured') return 'Histórico ainda não configurado.';
  if (!state.data.points.length) return 'Sem registros neste intervalo.';
  if (state.before !== null) return 'Registros anteriores.';
  if (!portalHistoryFreshV1(state.data, now)) return 'Confirmação expirada. Atualize o histórico.';
  const point = state.data.points[0]!, status = portalHistoryPointStateV1(point);
  if (status === 'critical') return 'A última verificação exige intervenção.';
  if (status === 'attention') return 'A última verificação encontrou pontos de atenção.';
  if (status === 'unknown') return 'Falha parcial: a amostra não confirma todos os sinais.';
  const change = portalHistoryChangeV1(point, state.data.points[1]);
  if (change === 'gap') return 'Coleta retomada após intervalo sem confirmação.';
  if (change === 'recovered') return 'Os sinais voltaram ao normal na última verificação.';
  return 'Última amostra sem ocorrência nos sinais verificados.';
}
function HistoryReader({ onDenied }: Readonly<{ onDenied: () => void }>) {
  const [state, setState] = useState<ReadState>(initial), [now, setNow] = useState(Date.now);
  const [important, setImportant] = useState(false);
  const active = useRef<AbortController | null>(null), denied = useRef(false);
  const read = useCallback(async (before: string | null, previous: PortalHistoryPointV1 | null = null) => {
    if (active.current || denied.current) return;
    const controller = new AbortController(); active.current = controller;
    const boundary = before !== null && previous?.bucketAt === before ? previous : null;
    setState({ data: null, boundary: null, before, loading: true, error: null });
    try {
      const data = await fetchHistory(before, controller);
      controller.signal.throwIfAborted();
      if (active.current !== controller) return;
      setNow(Date.now()); setState({ data, boundary: data.points.length ? boundary : null, before, loading: false, error: null });
    } catch (error) {
      if (controller.signal.aborted || active.current !== controller) return;
      const accessLost = error instanceof HistoryAccessError; denied.current = accessLost;
      setState({ data: null, boundary: null, before, loading: false, error: accessLost ? 'denied' : 'unavailable' });
      if (accessLost) onDenied();
    } finally { if (active.current === controller) active.current = null; }
  }, [onDenied]);
  useEffect(() => {
    void read(null);
    const hide = () => { active.current?.abort(); active.current = null; setState({ ...initial(), error: denied.current ? 'denied' : null }); };
    window.addEventListener('pagehide', hide);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => { active.current?.abort(); active.current = null; clearInterval(clock); window.removeEventListener('pagehide', hide); };
  }, [read]);
  const page = state.data?.points ?? [];
  const points = (page.length && state.boundary ? [state.boundary, ...page] : page)
    .filter((point) => Date.parse(point.observedAt) > now - HEALTH_HISTORY_RETENTION_MS_V1);
  // Classify before either filtering or visual pagination; hidden normal rows cannot create a gap.
  const classified = points.map((point, index) => ({ point, status: portalHistoryPointStateV1(point),
    change: portalHistoryChangeV1(point, points[index + 1]) }));
  const changes = classified.filter((r) => r.status !== 'normal' || r.change !== 'sample');
  const rows = important ? changes : classified;
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p role={state.error ? 'alert' : 'status'} className="text-sm">{notice(state, now)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" isDisabled={state.loading || denied.current} onPress={() => { void read(null); }}>Atualizar histórico</Button>
        {state.data?.nextBefore ? <Button size="sm" variant="secondary" isDisabled={state.loading}
          onPress={() => { void read(state.data!.nextBefore, state.data!.points.at(-1) ?? null); }}>Mais antigos</Button> : null}
      </div>
    </div>
    {points.length ? <>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3"><Button size="sm" variant="secondary" aria-pressed={important}
        onPress={() => setImportant((v) => !v)}>Só alterações e atenção</Button><p className="text-xs text-muted">{changes.length} registros destacados nesta consulta</p></div>
      <HealthCompactRowsV1 key={`${state.data?.generatedAt}|${state.before}|${important}`} rows={rows} label="Páginas do histórico">
        {(visible) => <Table variant="secondary"><Table.ScrollContainer className="max-h-96 overflow-auto"><Table.Content aria-label="Histórico operacional do Portal">
          <Table.Header><Table.Column id="date" isRowHeader>Verificação (Bahia)</Table.Column><Table.Column id="state">Estado na amostra</Table.Column>
            <Table.Column id="publication">Publicações aguardando</Table.Column><Table.Column id="connections">Conexões em espera</Table.Column><Table.Column id="duration">Leitura de filas</Table.Column></Table.Header>
          <Table.Body>{visible.map(({ point, status, change }) => <Table.Row id={point.bucketAt} key={point.bucketAt}>
            <Table.Cell className="whitespace-nowrap py-2">{date(point.observedAt)}</Table.Cell>
            <Table.Cell className="py-2"><Chip size="sm" variant="soft" color={colors[status]}>{labels[status]}</Chip>
              {change === 'gap' ? <p className="mt-1 text-xs text-muted">Intervalo sem confirmação</p> : null}
              {change === 'recovered' ? <p className="mt-1 text-xs text-muted">Recuperação observada</p> : null}</Table.Cell>
            <Table.Cell className="py-2">{cappedHealthCountV1(point.publicationDue)}</Table.Cell><Table.Cell className="py-2">{point.waitingConnections.toLocaleString('pt-BR')}</Table.Cell>
            <Table.Cell className="whitespace-nowrap py-2">{point.readDurationMs.toLocaleString('pt-BR')} ms</Table.Cell>
          </Table.Row>)}</Table.Body>
        </Table.Content></Table.ScrollContainer></Table>}
      </HealthCompactRowsV1>
    </> : null}
  </>;
}
export function SystemHealthHistoryPanelV1({ onDenied }: Readonly<{ onDenied: () => void }>) {
  const [open, setOpen] = useState(false);
  return <Card variant="default" className="mt-3 min-w-0 overflow-hidden"><Card.Header>
    <div className="flex flex-wrap items-center justify-between gap-3"><Card.Title>Histórico operacional</Card.Title>
      <Button size="sm" variant="secondary" aria-expanded={open} onPress={() => setOpen((value) => !value)}>{open ? 'Fechar histórico' : 'Ver histórico'}</Button></div>
    <Card.Description>Últimos 30 dias · configuração e filas · 6 registros por página</Card.Description>
  </Card.Header>{open ? <Card.Content className="p-0"><HistoryReader onDenied={onDenied} /></Card.Content> : null}</Card>;
}
