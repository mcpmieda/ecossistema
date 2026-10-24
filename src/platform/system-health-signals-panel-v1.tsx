import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Table } from '@heroui/react';
import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1';
import { isPortalSignalsPageV1, signalKeyV1, SIGNAL_BODY_BYTES_V1, type PortalSignalsPageV1, type PortalSignalPointV1 } from '../../shared/portal-signals-v1';
import { HEALTH_HISTORY_RETENTION_MS_V1 } from '../../shared/system-health-history-v1';
import { HealthCompactRowsV1 } from './system-health-compact-rows-v1';
const names: Record<PortalSignalPointV1['source'], string> = { challenge: 'Leitura do acesso', login: 'Entrada com senha',
  activation: 'Ativação', session: 'Verificação da sessão', profile: 'Carregamento dos dados',
  'browser-module': 'Navegador: módulo não carregou', 'browser-render': 'Navegador: erro na tela', 'browser-read': 'Navegador: falha de leitura' };
const outcomes = { ok: 'Respondeu', refused: 'Recusado / sem sessão', limited: 'Limite de tentativas', failed: 'Falha / indisponível' };
class SignalAccessError extends Error {}
type State = { data: PortalSignalsPageV1 | null; loading: boolean; error: 'denied' | 'unavailable' | null };
const initial = (): State => ({ data: null, loading: false, error: null });
function SignalReader({ onDenied }: Readonly<{ onDenied: () => void }>) {
  const [state, setState] = useState<State>(initial), [now, setNow] = useState(Date.now);
  const [important, setImportant] = useState(false);
  const active = useRef<AbortController | null>(null), denied = useRef(false);
  const read = useCallback(async (before: string | null) => {
    if (active.current || denied.current) return;
    const controller = new AbortController(); active.current = controller;
    setState({ data: null, loading: true, error: null });
    try {
      const data = await healthDeadlineV1(async (signal) => {
        const response = await fetch('/api/platform/system-health/signals', { method: 'POST', credentials: 'same-origin',
          cache: 'no-store', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ before }) });
        if (response.status === 401 || response.status === 403) throw new SignalAccessError();
        if (!response.ok) throw new Error('signals-unavailable');
        const value = await readHealthJsonV1(response, signal, SIGNAL_BODY_BYTES_V1);
        if (!isPortalSignalsPageV1(value) || (before !== null && value.points.some((point) => point.bucketAt >= before))) throw new Error('signals-invalid');
        return value;
      }, 5000, controller.signal);
      if (controller.signal.aborted || active.current !== controller) return;
      setNow(Date.now()); setState({ data, loading: false, error: null });
    } catch (error) {
      if (controller.signal.aborted || active.current !== controller) return;
      const lost = error instanceof SignalAccessError; denied.current = lost;
      setState({ data: null, loading: false, error: lost ? 'denied' : 'unavailable' });
      if (lost) onDenied();
    } finally { if (active.current === controller) active.current = null; }
  }, [onDenied]);
  useEffect(() => {
    void read(null);
    const hide = () => { active.current?.abort(); active.current = null; setState({ ...initial(), error: denied.current ? 'denied' : null }); };
    window.addEventListener('pagehide', hide);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => { active.current?.abort(); active.current = null; clearInterval(timer); window.removeEventListener('pagehide', hide); };
  }, [read]);
  let message = 'Observações recebidas; não representam todos os acessos nem quantidade de alunos.';
  if (state.loading) message = 'Consultando ocorrências…';
  else if (state.error === 'denied') message = 'Acesso às ocorrências não autorizado.';
  else if (state.error || state.data?.state === 'unavailable') message = 'Ocorrências indisponíveis.';
  else if (state.data?.state === 'unconfigured') message = 'Coleta de ocorrências ainda não configurada.';
  else if (!state.data?.points.length) message = 'Nenhuma observação disponível. Isso não confirma ausência de falhas.';
  else if (now - Date.parse(state.data.generatedAt) > 120_000 || Date.parse(state.data.generatedAt) > now + 5000) message = 'Consulta desatualizada. Atualize as ocorrências.';
  const points = state.data?.points.filter((point) => Date.parse(point.bucketAt) > now - HEALTH_HISTORY_RETENTION_MS_V1 && Date.parse(point.bucketAt) <= now + 5000) ?? [];
  const flagged = points.filter((p) => p.outcome === 'failed' || p.outcome === 'limited');
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p role={state.error ? 'alert' : 'status'} className="text-sm">{message}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" isDisabled={state.loading || denied.current} onPress={() => { void read(null); }}>Atualizar ocorrências</Button>
        {state.data?.nextBefore ? <Button size="sm" variant="secondary" isDisabled={state.loading} onPress={() => { void read(state.data!.nextBefore); }}>Ocorrências anteriores</Button> : null}</div>
    </div>
    {points.length ? <>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3"><Button size="sm" variant="secondary" aria-pressed={important}
        onPress={() => setImportant((v) => !v)}>Só falhas e limites</Button><p className="text-xs text-muted">{flagged.length} grupos destacados nesta consulta</p></div>
      <HealthCompactRowsV1 key={`${state.data?.generatedAt}|${state.data?.points[0]?.bucketAt}|${important}`} rows={important ? flagged : points} label="Páginas das ocorrências">
        {(visible) => <Table variant="secondary"><Table.ScrollContainer className="max-h-96 overflow-auto"><Table.Content aria-label="Ocorrências de entrada e carregamento">
          <Table.Header><Table.Column id="time" isRowHeader>Janela (Bahia)</Table.Column><Table.Column id="source">Etapa</Table.Column><Table.Column id="outcome">Resultado observado</Table.Column>
            <Table.Column id="samples">Observações</Table.Column><Table.Column id="max">Maior tempo</Table.Column><Table.Column id="slow">3 segundos ou mais</Table.Column></Table.Header>
          <Table.Body>{visible.map((point) => <Table.Row id={signalKeyV1(point)} key={signalKeyV1(point)}>
            <Table.Cell className="whitespace-nowrap py-2">{new Date(point.bucketAt).toLocaleString('pt-BR', { timeZone: 'America/Bahia' })}</Table.Cell>
            <Table.Cell className="py-2">{names[point.source]}</Table.Cell><Table.Cell className="py-2">{point.source.startsWith('browser-') ? 'Relato do navegador' : outcomes[point.outcome]}</Table.Cell>
            <Table.Cell className="py-2">{point.samples}{point.capped ? '+' : ''}</Table.Cell>
            <Table.Cell className="py-2">{point.source.startsWith('browser-') ? '—' : maxMsText(point.maxMs)}</Table.Cell>
            <Table.Cell className="py-2">{point.source.startsWith('browser-') ? '—' : point.slow}</Table.Cell>
          </Table.Row>)}</Table.Body>
        </Table.Content></Table.ScrollContainer></Table>}
      </HealthCompactRowsV1>
    </> : null}
  </>;
}
/** The slowest time; 60 s is the cap, so it may have been longer. */
const maxMsText = (ms: number) => `${ms}${ms === 60_000 ? '+' : ''} ms`;

export function SystemHealthSignalsPanelV1({ onDenied }: Readonly<{ onDenied: () => void }>) {
  const [open, setOpen] = useState(false);
  return <Card variant="default" className="mt-3 min-w-0 overflow-hidden"><Card.Header>
    <div className="flex flex-wrap items-center justify-between gap-3"><Card.Title>Entrada e carregamento</Card.Title>
      <Button size="sm" variant="secondary" aria-expanded={open} onPress={() => setOpen((value) => !value)}>{open ? 'Fechar ocorrências' : 'Ver ocorrências'}</Button></div>
    <Card.Description>Últimos 30 dias · observações parciais · 6 registros por página</Card.Description>
  </Card.Header>{open ? <Card.Content className="p-0"><SignalReader onDenied={onDenied} /></Card.Content> : null}</Card>;
}
