import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Input, Label, TextField } from '@heroui/react';
import type { AdminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import {
  createLatestPortalRequestV1,
  type PortalLoadStateV1,
} from '../../student-portal/shared/latest-request-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { createSettingsMutationV1, type SettingsMutationStateV1 } from './settings-mutation-v1';
import { SettingsCheckboxV1 } from './settings-editors-v1';
type PreviewResponseV1 = Extract<AdminResponseV1, { state: 'links-preview' }>;
type PreviewV1 = Pick<PreviewResponseV1, 'count' | 'version' | 'expiresAt'>;
const CONFIRMATION = 'ENCERRAR VÍNCULOS 2026';
const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'medium',
});

const closureRetryText = (retryable: boolean) =>
  retryable
    ? 'O resultado do encerramento ainda não foi confirmado. Repetir mantém exatamente a mesma operação.'
    : 'A operação não foi autorizada ou não pôde ser validada. Recarregue o estado antes de tentar novamente.';

/** School-only composition. Preview token never enters the rendered state, storage or logs. */
export function LinkClosureV1({
  client,
  disabled,
  onClosed,
  onBusyChange,
}: Readonly<{
  client: PortalAdminClientV1;
  disabled: boolean;
  onClosed: () => void;
  onBusyChange: (busy: boolean) => void;
}>) {
  const proof = useRef<PreviewResponseV1 | null>(null);
  const [load, setLoad] = useState<PortalLoadStateV1<PreviewV1>>({ state: 'idle' });
  const [mutation, setMutation] = useState<SettingsMutationStateV1>({ state: 'idle' });
  const [text, setText] = useState(''),
    [understood, setUnderstood] = useState(false);
  const [expired, setExpired] = useState(false),
    [clock, setClock] = useState(Date.now);
  const reader = useMemo(() => createLatestPortalRequestV1<PreviewV1>(setLoad), []);
  const writer = useMemo(() => createSettingsMutationV1(client, setMutation), [client]);
  const busy = load.state === 'loading' || mutation.state === 'pending';
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(
    () => () => {
      proof.current = null;
      reader.clear();
      writer.clear();
    },
    [reader, writer],
  );
  useEffect(() => {
    if (load.state !== 'ready') return;
    const timer = setTimeout(
      () => {
        proof.current = null;
        setExpired(true);
      },
      Math.max(0, Date.parse(load.data.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (mutation.state !== 'error' || !mutation.retryable) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mutation]);
  useEffect(() => {
    if (mutation.state !== 'committed') return;
    proof.current = null;
    reader.clear();
    writer.clear();
    onClosed();
  }, [mutation, onClosed, reader, writer]);
  const preview = useCallback(async () => {
    if (disabled || busy) return;
    proof.current = null;
    writer.clear();
    setExpired(false);
    setText('');
    setUnderstood(false);
    await reader.run(async (signal) => {
      const result = await client.query(
        {
          contractVersion: 1,
          operation: 'links-preview',
          scope: { kind: 'school', academicYear: 2026 },
          page: { limit: 50 },
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.state !== 'links-preview') throw new PortalClientErrorV1('invalid-response');
      proof.current = result;
      return { count: result.count, version: result.version, expiresAt: result.expiresAt };
    });
  }, [busy, client, disabled, reader, writer]);
  async function closeLinks() {
    const current = proof.current;
    if (
      disabled ||
      busy ||
      !current ||
      expired ||
      Date.parse(current.expiresAt) <= Date.now() ||
      current.count === 0 ||
      text !== CONFIRMATION ||
      !understood
    )
      return;
    await writer.submit({
      contractVersion: 1,
      operation: 'links-close',
      academicYear: 2026,
      expectedVersion: current.version,
      expectedCount: current.count,
      previewToken: current.previewToken,
      idempotencyKey: crypto.randomUUID(),
      confirmed: true,
    });
    setText('');
    setUnderstood(false);
  }
  return (
    <Card className="pa-settings-danger">
      <Card.Header>
        <h3>Encerrar vínculos de 2026</h3>
        <p>
          Área de risco: encerra todos os vínculos atuais do Portal neste ano, revoga o acesso e
          impede a recriação automática por importação. O histórico é preservado. Redefinir uma
          conta é uma ação diferente; esta operação não executa reset acadêmico.
        </p>
      </Card.Header>
      <Card.Content>
        <Button
          variant="outline"
          size="sm"
          isDisabled={disabled || busy || mutation.state === 'error'}
          onPress={() => void preview()}
        >
          Preparar prévia de encerramento
        </Button>
        {load.state === 'loading' ? (
          <p>
            <output className="contents">Preparando prévia atual de 2026</output>
          </p>
        ) : null}
        {load.state === 'error' ? (
          <p role="alert" className="pa-settings-error">
            Não foi possível preparar a prévia. Verifique a sessão e tente novamente.
          </p>
        ) : null}
        {load.state === 'ready' ? (
          <div className="pa-settings-calendar">
            <p>
              <strong>{load.data.count.toLocaleString('pt-BR')} vínculos</strong> no escopo Escola ·
              2026.
            </p>
            <p>
              Versão da prévia: {load.data.version}. Válida até{' '}
              {dateFormatter.format(new Date(load.data.expiresAt))} (São Paulo).
            </p>
            {expired ? (
              <p role="alert" className="pa-settings-error">
                A prévia expirou. Prepare uma nova antes de confirmar.
              </p>
            ) : null}
            {!expired && load.data.count === 0 ? (
              <p>
                <output className="contents">Não há vínculos atuais para encerrar.</output>
              </p>
            ) : null}
            {!expired && load.data.count !== 0 ? (
              <>
                <TextField isDisabled={disabled || busy || mutation.state === 'error'}>
                  <Label>Digite {CONFIRMATION} para confirmar</Label>
                  <Input
                    value={text}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setText(event.currentTarget.value)}
                  />
                </TextField>
                <SettingsCheckboxV1
                  label={`Entendo que os ${load.data.count} vínculos de 2026 serão encerrados e o acesso será revogado.`}
                  selected={understood}
                  disabled={disabled || busy || mutation.state === 'error'}
                  onChange={setUnderstood}
                />
                <Button
                  variant="danger"
                  isPending={mutation.state === 'pending'}
                  isDisabled={
                    disabled ||
                    busy ||
                    mutation.state === 'error' ||
                    !understood ||
                    text !== CONFIRMATION
                  }
                  onPress={() => void closeLinks()}
                >
                  Encerrar os vínculos de 2026
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {mutation.state === 'error' ? (
          <div className="pa-settings-error" role="alert">
            <p>
              {mutation.error.state === 'conflict'
                ? 'Os vínculos ou a prévia mudaram. Prepare uma nova prévia e confira a contagem.'
                : closureRetryText(mutation.retryable)}
            </p>
            {mutation.retryable ? (
              <Button
                size="sm"
                variant="secondary"
                isDisabled={disabled || clock < mutation.retryAt}
                onPress={() => void writer.retry()}
              >
                Repetir o mesmo encerramento
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" isDisabled={disabled} onPress={() => void preview()}>
              Consultar uma nova prévia
            </Button>
          </div>
        ) : null}
      </Card.Content>
    </Card>
  );
}
