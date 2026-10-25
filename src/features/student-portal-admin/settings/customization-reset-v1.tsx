import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Modal } from '@heroui/react';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { CustomizationResetChoiceV1 } from './customization-values-v1';

function resetFailureTextV1(denied: boolean, conflict: boolean, retryable: boolean) {
  if (denied) return 'A autorização terminou. Feche e entre novamente.';
  if (conflict) return 'A configuração mudou. Feche, confira os dados atualizados e revise novamente.';
  if (retryable)
    return 'A confirmação não chegou. Tentar novamente repete a mesma solicitação, sem criar outra alteração.';
  return 'Não foi possível aplicar a alteração. Feche e consulte os dados novamente.';
}

/** Review one captured difference. Retries retain identical command bytes and CAS; never
 * silently rebase an open confirmation on a background refresh. */
export function CustomizationResetV1({ client, label, choices, canWrite, onClose, onCommitted }: Readonly<{
  client: PortalAdminClientV1;
  label: string;
  choices: readonly CustomizationResetChoiceV1[];
  canWrite: boolean;
  onClose: () => void;
  onCommitted: () => void;
}>) {
  const [selected, setSelected] = useState(choices.length === 1 ? choices[0]!.id : '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PortalClientErrorV1 | null>(null);
  const [clock, setClock] = useState(Date.now);
  const active = useRef<AbortController | null>(null);
  const prepared = useRef<ReturnType<PortalAdminClientV1['prepareCommand']> | null>(null);
  const retryAt = useRef(0);
  const committed = useRef(onCommitted);
  committed.current = onCommitted;
  const choice = choices.find((item) => item.id === selected);
  const retryable = failure !== null && ['network-error', 'unavailable', 'invalid-response', 'rate-limited'].includes(failure.state);
  const denied = failure?.state === 'forbidden' || failure?.state === 'unauthenticated';
  useEffect(() => () => { active.current?.abort(); prepared.current = null; }, [client, canWrite]);
  useEffect(() => {
    if (!failure || Date.now() >= retryAt.current) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [failure]);
  async function submit(retry = false) {
    if (!canWrite || busy || active.current || !choice || Date.now() < retryAt.current) return;
    if (retry && (!retryable || !prepared.current)) return;
    if (!retry && failure) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setFailure(null);
    try {
      if (!retry) prepared.current = client.prepareCommand(choice.command(crypto.randomUUID()));
      const result = await prepared.current!.execute(controller.signal);
      if (controller.signal.aborted) return;
      if (result.state !== 'committed') throw new PortalClientErrorV1('invalid-response');
      prepared.current = null;
      committed.current();
    } catch (error) {
      if (controller.signal.aborted) return;
      const value = error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');
      retryAt.current = Date.now() + (value.retryAfterSeconds ?? 0) * 1000;
      setClock(Date.now());
      setFailure(value);
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const failureText = resetFailureTextV1(denied, failure?.state === 'conflict', retryable);
  // One action button: retry the same request, or confirm while nothing has failed.
  let action: ReactNode = null;
  if (!denied && retryable)
    action = <Button isDisabled={!canWrite || busy || clock < retryAt.current}
      isPending={busy} onPress={() => void submit(true)}>Tentar novamente</Button>;
  else if (!failure)
    action = <Button variant="danger" isDisabled={!canWrite || !choice || busy}
      isPending={busy} onPress={() => void submit()}>Confirmar retorno ao padrão</Button>;
  return (
    <Modal.Backdrop isOpen isDismissable={!busy} isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label="Voltar ao padrão">
          <Modal.Header><Modal.Heading>Voltar ao padrão</Modal.Heading></Modal.Header>
          <Modal.Body className="grid gap-3">
            {!denied ? <p><strong>{label}</strong></p> : null}
            {!denied && choices.length > 1 ? (
              <fieldset disabled={busy || failure !== null} className="grid gap-2">
                <legend className="mb-2">Escolha qual personalização desfazer</legend>
                {choices.map((item) => (
                  <label key={item.id} className="flex items-center gap-2">
                    <input type="radio" name="customization-reset-choice" value={item.id}
                      checked={selected === item.id} onChange={() => setSelected(item.id)} />
                    {item.label}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {!denied && choice ? (
              <div className="grid gap-2 rounded-xl border border-separator p-3 text-sm">
                <strong>{choice.label}</strong>
                <div><span className="text-muted">Personalização atual: </span>{choice.current}</div>
                <div><span className="text-muted">Após voltar ao padrão: </span>{choice.inherited}</div>
              </div>
            ) : null}
            {!denied ? <p className="text-sm text-muted">Somente a opção selecionada será redefinida. As demais personalizações, notas e registros de auditoria serão preservados. O alvo passará a acompanhar o padrão aplicável, inclusive suas próximas alterações.</p> : null}
            {failure ? (
              <p role="alert">{failureText}</p>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" isDisabled={busy} onPress={onClose}>{failure ? 'Fechar e atualizar' : 'Cancelar'}</Button>
            {action}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
