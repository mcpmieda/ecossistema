import { schoolDateTimeTextV1 } from '../../shared/locale-format-v1';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card } from '@heroui/react';
import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1';
type Sample = { state: string; generatedAt: string };
type State<T> = { data: T | null; loading: boolean; error: 'denied' | 'unavailable' | null };
const initial = <T,>(): State<T> => ({ data: null, loading: false, error: null });
class AccessLost extends Error {}
type Props<T extends Sample> = Readonly<{ title: string; description: string; openLabel: string; refreshLabel: string;
  route: string; bytes: number; freshMs?: number; validate: (input: unknown) => input is T;
  onDenied: () => void; children: (data: T) => ReactNode }>;
function Reader<T extends Sample>({ route, bytes, validate, onDenied, refreshLabel, freshMs = 120_000, children }: Props<T>) {
  const [state, setState] = useState<State<T>>(initial), [now, setNow] = useState(Date.now);
  const active = useRef<AbortController | null>(null), denied = useRef(false);
  const read = useCallback(async () => {
    if (active.current || denied.current || document.visibilityState === 'hidden') return;
    const controller = new AbortController(); active.current = controller;
    setState({ data: null, loading: true, error: null });
    try {
      const data = await healthDeadlineV1(async (signal) => {
        const response = await fetch(route, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (response.status === 401 || response.status === 403) throw new AccessLost();
        if (!response.ok) throw new Error('health-read-unavailable');
        const value = await readHealthJsonV1(response, signal, bytes);
        if (!validate(value)) throw new Error('health-read-invalid');
        return value;
      }, 6000, controller.signal);
      if (!controller.signal.aborted && active.current === controller) { setNow(Date.now()); setState({ data, loading: false, error: null }); }
    } catch (error) {
      if (controller.signal.aborted || active.current !== controller) return;
      denied.current = error instanceof AccessLost;
      setState({ data: null, loading: false, error: denied.current ? 'denied' : 'unavailable' });
      if (denied.current) onDenied();
    } finally { if (active.current === controller) active.current = null; }
  }, [route, bytes, validate, onDenied]);
  useEffect(() => {
    void read();
    const hide = () => { active.current?.abort(); active.current = null; setState({ ...initial<T>(), error: denied.current ? 'denied' : null }); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else setNow(Date.now()); };
    window.addEventListener('pagehide', hide); document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => { active.current?.abort(); active.current = null; clearInterval(timer);
      window.removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', visibility); };
  }, [read]);
  const age = state.data ? now - Date.parse(state.data.generatedAt) : Infinity;
  const fresh = age >= -5000 && age <= freshMs;
  let message = 'Consulte para obter os dados.';
  if (state.loading) message = 'Consultando…';
  else if (state.error === 'denied') message = 'Acesso não autorizado. Os dados foram removidos.';
  else if (state.error || state.data?.state === 'unavailable') message = 'Consulta indisponível. Nenhum valor foi estimado.';
  else if (state.data?.state === 'unconfigured') message = 'Fonte ainda não configurada.';
  else if (state.data && !fresh) message = 'Consulta desatualizada. Atualize para consultar os dados.';
  else if (state.data) message = `Consulta: ${schoolDateTimeTextV1(state.data.generatedAt)} (Bahia)`;
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3">
    <p className="text-xs text-muted" role={state.error ? 'alert' : 'status'}>{message}</p>
    <Button size="sm" variant="secondary" isDisabled={state.loading || denied.current} onPress={() => { void read(); }}>{refreshLabel}</Button>
  </div>{fresh && state.data?.state === 'ok' ? children(state.data) : null}</div>;
}
export function HealthOnDemandPanelV1<T extends Sample>(props: Props<T>) {
  const [open, setOpen] = useState(false);
  return <Card variant="default" className="mt-3 min-w-0 overflow-hidden"><Card.Header>
    <div className="flex flex-wrap items-center justify-between gap-3"><Card.Title>{props.title}</Card.Title>
      <Button size="sm" variant="secondary" aria-expanded={open} onPress={() => setOpen((v) => !v)}>{open ? 'Fechar consulta' : props.openLabel}</Button></div>
    <Card.Description>{props.description}</Card.Description>
  </Card.Header>{open ? <Card.Content><Reader {...props} /></Card.Content> : null}</Card>;
}
