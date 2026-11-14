import { SCHOOL_TIME_ZONE_V1 } from '../../shared/school-time-zone-v1';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card } from '@heroui/react';
import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1';
import { CAPACITY_BODY_BYTES_V1, CAPACITY_ROUTE_V1, capacitySampleFreshV1, isPortalCapacitySampleV1,
  type PortalCapacityMetricsV1, type PortalCapacitySampleV1 } from '../../shared/portal-capacity-v1';

class CapacityAccessError extends Error {}
type State = { data: PortalCapacitySampleV1 | null; loading: boolean; error: 'denied' | 'unavailable' | null };
const initial = (): State => ({ data: null, loading: false, error: null });
const count = (value: number) => value.toLocaleString('pt-BR');
function CapacityValues({ metrics }: Readonly<{ metrics: PortalCapacityMetricsV1 }>) {
  const values = [
    ['Tamanho do banco', `${(metrics.databaseBytes / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB`],
    ['Conexões do Portal', `${count(metrics.portalConnections)} · ${count(metrics.portalActive)} em atividade`],
    ['Aguardando liberação', count(metrics.portalWaiting)],
    ['Limite da conta do Portal', metrics.portalConnectionLimit === null ? 'Sem limite próprio' : count(metrics.portalConnectionLimit)],
    ['Limite compartilhado do servidor', count(metrics.serverMaxConnections)],
    ['Reservadas para administração', count(metrics.serverReservedConnections)],
  ];
  return <dl aria-label="Medição do banco e conexões" className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {values.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 break-words font-medium">{value}</dd></div>)}
  </dl>;
}
function messageFor(state: State, fresh: boolean) {
  if (state.loading) return 'Consultando banco e conexões…';
  if (state.error === 'denied') return 'Acesso à medição não autorizado.';
  if (state.error || state.data?.state === 'unavailable') return 'Medição indisponível. Nenhum valor foi estimado.';
  if (state.data?.state === 'unconfigured') return 'Medição ainda não configurada.';
  if (!state.data) return 'Consulte os dados para obter uma medição.';
  if (!fresh) return 'Medição desatualizada. Atualize os dados.';
  return 'Medição pontual; não confirma a disponibilidade completa do Portal.';
}
function CapacityReader({ onDenied }: Readonly<{ onDenied: () => void }>) {
  const [state, setState] = useState<State>(initial), [now, setNow] = useState(Date.now);
  const active = useRef<AbortController | null>(null), denied = useRef(false);
  const read = useCallback(async () => {
    if (active.current || denied.current) return;
    const controller = new AbortController(); active.current = controller;
    setState({ data: null, loading: true, error: null });
    try {
      const data = await healthDeadlineV1(async (signal) => {
        const response = await fetch(CAPACITY_ROUTE_V1, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (response.status === 401 || response.status === 403) throw new CapacityAccessError();
        if (!response.ok) throw new Error('capacity-unavailable');
        const value = await readHealthJsonV1(response, signal, CAPACITY_BODY_BYTES_V1);
        if (!isPortalCapacitySampleV1(value)) throw new Error('capacity-invalid');
        return value;
      }, 5000, controller.signal);
      if (controller.signal.aborted || active.current !== controller) return;
      setNow(Date.now()); setState({ data, loading: false, error: null });
    } catch (error) {
      if (controller.signal.aborted || active.current !== controller) return;
      const lost = error instanceof CapacityAccessError; denied.current = lost;
      setState({ data: null, loading: false, error: lost ? 'denied' : 'unavailable' });
      if (lost) onDenied();
    } finally { if (active.current === controller) active.current = null; }
  }, [onDenied]);
  useEffect(() => {
    void read();
    const hide = () => { active.current?.abort(); active.current = null; setState(initial()); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else setNow(Date.now()); };
    window.addEventListener('pagehide', hide); document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      active.current?.abort(); active.current = null; clearInterval(timer);
      window.removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', visibility);
    };
  }, [read]);
  const fresh = state.data !== null && capacitySampleFreshV1(state.data, now);
  const metrics = fresh && state.data?.state === 'ok' ? state.data.metrics : null;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role={state.error ? 'alert' : 'status'} className="text-sm">{messageFor(state, fresh)}</p>
      <Button size="sm" variant="secondary" isDisabled={state.loading || denied.current} onPress={() => { void read(); }}>Atualizar medição</Button>
    </div>
    {state.data?.state === 'ok' ? <p className="text-xs text-muted">Medição: {new Date(state.data.observedAt).toLocaleString('pt-BR', { timeZone: SCHOOL_TIME_ZONE_V1 })} (Bahia)</p> : null}
    {metrics ? <><CapacityValues metrics={metrics} />
      <p className="text-xs text-muted">Conexões não são alunos online e incluem esta consulta. Limites configurados não indicam vagas livres ou cotas do plano.</p></> : null}
  </div>;
}
export function SystemHealthCapacityPanelV1({ onDenied }: Readonly<{ onDenied: () => void }>) {
  const [open, setOpen] = useState(false);
  return <Card variant="default" className="mt-5 min-w-0 overflow-hidden"><Card.Header>
    <div className="flex flex-wrap items-center justify-between gap-3"><Card.Title>Banco de dados e conexões</Card.Title>
      <Button size="sm" variant="secondary" aria-expanded={open} onPress={() => setOpen((value) => !value)}>{open ? 'Fechar medição' : 'Ver banco e conexões'}</Button></div>
    <Card.Description>Supabase / PostgreSQL · consulta sob demanda · medições reutilizadas por até 60 segundos</Card.Description>
  </Card.Header>{open ? <Card.Content><CapacityReader onDenied={onDenied} /></Card.Content> : null}</Card>;
}
