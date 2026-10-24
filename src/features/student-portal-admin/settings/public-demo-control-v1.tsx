import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import './public-demo-control-v1.css';
import {
  PUBLIC_DEMO_ADMIN_PATH_V1,
  PUBLIC_DEMO_URL_V1,
  publicDemoStateSchemaV1,
  type PublicDemoStateV1,
} from '../../../../shared/public-demo-control-v1';

async function request(path: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.headers.get('cache-control')?.includes('no-store')) throw new Error('unavailable');
  if (!response.ok && response.status !== 409) throw new Error('unavailable');
  return { status: response.status, value: (await response.json()) as unknown };
}

const enabledText = (enabled: boolean) => (enabled ? 'Ativada' : 'Desativada');

export function PublicDemoControlV1({ canWrite }: Readonly<{ canWrite: boolean }>) {
  const [state, setState] = useState<PublicDemoStateV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Consultando estado…');
  useEffect(() => {
    const controller = new AbortController();
    void request(PUBLIC_DEMO_ADMIN_PATH_V1, {}, controller.signal)
      .then(({ value }) => {
        if (!controller.signal.aborted) {
          setState(publicDemoStateSchemaV1.parse(value));
          setMessage('');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('Demonstração pública indisponível.');
      });
    return () => controller.abort();
  }, []);
  async function change() {
    if (!state || busy) return;
    setBusy(true);
    setMessage('Aguardando confirmação…');
    try {
      const { value, status } = await request(PUBLIC_DEMO_ADMIN_PATH_V1, {
        enabled: !state.enabled,
        expectedRevision: state.revision,
      });
      const result = value as { ok?: unknown; state?: unknown };
      if (typeof result.ok !== 'boolean' || (status === 409) === result.ok)
        throw new Error('invalid');
      setState(publicDemoStateSchemaV1.parse(result.state));
      setMessage(
        result.ok
          ? 'Estado confirmado.'
          : 'O estado mudou em outra sessão. Confira antes de tentar novamente.',
      );
    } catch {
      setState(null);
      setMessage('Não foi possível confirmar o estado. Reabra esta área para consultar novamente.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pa-public-demo" aria-label="Demonstração pública">
      <h2>Demonstração pública</h2>
      <p>Estado confirmado: {state ? enabledText(state.enabled) : 'Indisponível'}</p>
      <Button
        variant="secondary"
        isDisabled={!canWrite || !state || busy}
        onPress={() => void change()}
      >
        {state?.enabled ? 'Desativar demonstração' : 'Ativar demonstração'}
      </Button>
      <p role="status">{message}</p>
      {state?.enabled && (
        <a href={PUBLIC_DEMO_URL_V1} target="_blank" rel="noreferrer noopener">
          Abrir demonstração
        </a>
      )}
      <p>Desativar bloqueia novos acessos. Conteúdo já baixado não pode ser recolhido.</p>
    </section>
  );
}
