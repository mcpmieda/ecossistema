import { useEffect, useRef, useState } from 'react';
import { Button, Chip, Input, Label, Modal, ProgressBar, TextField } from '@heroui/react';
import { useDraftNavigationGuardV1 } from '../../../shared/forms/draft-navigation-v1';
import type { BulkPreviewQueryV1 } from '../../../../shared/student-portal-contracts/bulk-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import type { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { createStudentBulkControllerV1, type BulkStateV1 } from './student-bulk-controller-v1';

const actions = {
  'qr-regenerate': 'Mudar QR',
  'password-reset': 'Redefinir senhas',
  'account-reset': 'Redefinir contas',
  block: 'Bloquear acesso',
} as const;
const consequences = {
  'account-reset':
    'As contas voltarão ao primeiro acesso; senha, QR e sessões atuais serão invalidados.',
  'password-reset': 'As senhas serão redefinidas e as sessões atuais encerradas.',
  'qr-regenerate': 'Os QR anteriores deixarão de funcionar e as sessões atuais serão encerradas.',
  block: 'O acesso será bloqueado e as sessões atuais encerradas.',
} as const;
const results = {
  pending: 'Pendente',
  committed: 'Concluído',
  failed: 'Não realizado',
  unknown: 'Resultado não confirmado',
  skipped: 'Não elegível',
} as const;
const errors: Record<string, string> = {
  conflict: 'Conflito; conta preservada.',
  forbidden: 'Sem autorização.',
  'invalid-request': 'Solicitação recusada.',
  unavailable: 'Serviço indisponível.',
  'network-error': 'Resposta não recebida.',
  'rate-limited': 'Aguarde para tentar novamente.',
};

type BulkActionV1 = BulkPreviewQueryV1['action'];
type BulkControllerV1 = ReturnType<typeof createStudentBulkControllerV1>;

/** The review: how many students, what happens to them, and the typed confirmation. */
function BulkReviewV1({
  action,
  targets,
  skipped,
  required,
  confirmation,
  onConfirmationChange,
}: Readonly<{
  action: BulkActionV1;
  targets: number;
  skipped: number;
  required: string;
  confirmation: string;
  onConfirmationChange: (value: string) => void;
}>) {
  const setConfirmation = onConfirmationChange;
  return (
    <>
      <p className="pa-bulk-dialog__count">
        <output className="contents">
          <strong>{targets}</strong>{' '}
          {targets === 1 ? 'aluno será afetado' : 'alunos serão afetados'}
          {skipped ? ` · ${skipped} não elegíveis ficam de fora` : ''}
        </output>
      </p>
      <p className="pa-bulk-dialog__consequence">{consequences[action]}</p>
      {targets > 0 ? (
        <TextField value={confirmation} onChange={setConfirmation} autoFocus>
          <Label>Digite {required} para confirmar</Label>
          <Input autoComplete="off" className="pa-bulk-dialog__confirm" />
        </TextField>
      ) : (
        <p>Nenhuma conta elegível para esta operação.</p>
      )}
    </>
  );
}

/** The run: progress, the counts, a pause or an unconfirmed result, and the accounts not done. */
function BulkProgressV1({
  state,
  targets,
  counts,
}: Readonly<{
  state: BulkStateV1;
  targets: number;
  counts: {
    completed: number;
    failed: number;
    unclear: number;
    skipped: number;
    processed: number;
    percent: number;
  };
}>) {
  const { completed, failed, unclear, skipped, processed, percent } = counts;
  const problems = state.items.filter(
    (item) => item.result === 'failed' || item.result === 'unknown',
  );
  return (
    <>
      <ProgressBar
        value={percent}
        color={state.phase === 'done' && !failed ? 'success' : 'accent'}
        aria-label="Progresso da operação"
      >
        <div className="flex items-center justify-between gap-3">
          <Label>
            {processed} de {targets} contas
          </Label>
          <ProgressBar.Output />
        </div>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      <p>
        <output className="contents">
          {completed} concluídos · {failed} não realizados
          {unclear ? ` · ${unclear} sem confirmação` : ''}
          {skipped ? ` · ${skipped} não elegíveis` : ''}
        </output>
      </p>
      {state.phase === 'paused' ? (
        <p>
          <output className="contents">
            Execução pausada. Os itens concluídos foram mantidos.
          </output>
        </p>
      ) : null}
      {state.phase === 'unknown' ? (
        <p>
          <output className="contents">
            Resultado não confirmado. Confirme a mesma tentativa antes de continuar.
          </output>
        </p>
      ) : null}
      {problems.length ? (
        <ul aria-label="Contas não concluídas" className="pa-bulk-dialog__problems">
          {problems.map((item) => (
            <li key={item.accountId}>
              {item.name} · {item.classLabel} — {results[item.result]}
              {item.error ? ` · ${errors[item.error] ?? 'Solicitação recusada.'}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The dialog's buttons for each phase: cancel, confirm, stop, continue, retry or close. */
function BulkActionsV1({
  state,
  action,
  ready,
  targets,
  clock,
  controller,
}: Readonly<{
  state: BulkStateV1;
  action: BulkActionV1;
  ready: boolean;
  targets: number;
  clock: number;
  controller: BulkControllerV1 | null;
}>) {
  return (
    <>
      {state.phase === 'loading' || state.phase === 'review' ? (
        <Button variant="secondary" onPress={() => controller?.cancel()}>
          Cancelar
        </Button>
      ) : null}
      {state.phase === 'review' && targets > 0 ? (
        <Button variant="danger" isDisabled={!ready} onPress={() => void controller?.run()}>
          Confirmar {actions[action].charAt(0).toLowerCase() + actions[action].slice(1)}
        </Button>
      ) : null}
      {state.phase === 'running' ? (
        <Button variant="secondary" onPress={() => controller?.cancel()}>
          Parar próximos itens
        </Button>
      ) : null}
      {state.phase === 'paused' ? (
        <>
          <Button variant="secondary" onPress={() => controller?.finish()}>
            Encerrar lote sem executar pendentes
          </Button>
          <Button onPress={() => void controller?.run()}>Continuar itens pendentes</Button>
        </>
      ) : null}
      {state.phase === 'unknown' ? (
        <Button isDisabled={clock < (state.retryAt ?? 0)} onPress={() => void controller?.run()}>
          Retentar mesma operação
        </Button>
      ) : null}
      {state.phase === 'done' || state.phase === 'error' ? (
        <Button onPress={() => controller?.close()}>Fechar</Button>
      ) : null}
    </>
  );
}

/** How many accounts each result has, and the share of the targets already processed. */
function bulkCountsV1(state: BulkStateV1, targets: number) {
  const count = (result: keyof typeof results) =>
    state.items.filter((item) => item.result === result).length;
  const skipped = count('skipped');
  const completed = count('committed');
  const failed = count('failed');
  const unclear = count('unknown');
  const processed = completed + failed;
  const percent = targets ? Math.round((processed / targets) * 100) : 0;
  return { skipped, completed, failed, unclear, processed, percent };
}

/** Bulk writes open in a full-screen dialog: counts instead of a name list, a typed confirmation
 * and a progress bar. With rows selected in the table only those accounts are written; with none
 * selected the whole class is (owner decision, 26/09/2026).
 */
export function StudentBulkV1({
  client,
  scope,
  scopeLabel,
  canWrite,
  selected,
  onAuthorizationLost,
}: Readonly<{
  client: PortalAdminClientV1;
  scope: BulkPreviewQueryV1['scope'];
  scopeLabel: string;
  canWrite: boolean;
  selected?: ReadonlySet<string>;
  onAuthorizationLost: (error: PortalClientErrorV1) => void;
}>) {
  const [action, setAction] = useState<BulkPreviewQueryV1['action']>('qr-regenerate');
  const [state, setState] = useState<BulkStateV1>({ phase: 'idle', items: [], total: 0 });
  const [confirmation, setConfirmation] = useState('');
  const [clock, setClock] = useState(Date.now);
  const callback = useRef(onAuthorizationLost);
  callback.current = onAuthorizationLost;
  const controller = useRef<ReturnType<typeof createStudentBulkControllerV1> | null>(null);
  useEffect(() => {
    const current = createStudentBulkControllerV1(client, setState, (error) =>
      callback.current(error),
    );
    controller.current = current;
    setState({ phase: 'idle', items: [], total: 0 });
    return () => {
      current.dispose();
      controller.current = null;
    };
  }, [client]);
  useEffect(() => {
    if (!state.retryAt) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, state.retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state.retryAt]);
  const locked = ['loading', 'review', 'running', 'paused', 'unknown'].includes(state.phase);
  useDraftNavigationGuardV1(locked);
  const selection = selected?.size ?? 0;
  const targets = state.targets ?? 0;
  const { skipped, completed, failed, unclear, processed, percent } = bulkCountsV1(state, targets);
  const required = actions[action].toUpperCase();
  const executing = ['running', 'paused', 'unknown', 'done'].includes(state.phase);
  const start = (next: BulkPreviewQueryV1['action']) => {
    if (!canWrite || locked) return;
    setAction(next);
    setConfirmation('');
    void controller.current?.preview(
      { contractVersion: 1, operation: 'bulk-preview', scope, action: next },
      selected,
    );
  };
  const leave = () => {
    if (state.phase === 'loading' || state.phase === 'review') controller.current?.cancel();
    else controller.current?.close();
  };
  return (
    <section
      className="pa-account-bulk-section"
      data-phase={state.phase}
      aria-label="Operações em massa"
    >
      <h3>Operações em massa</h3>
      <div className="pa-account-bulk-content">
        <p>
          {scopeLabel} · {selection ? `${selection} selecionados` : 'Turma inteira'}
        </p>
        <div className="flex flex-wrap gap-2" aria-label="Operação em massa">
          {Object.entries(actions).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant="secondary"
              isDisabled={!canWrite || locked}
              onPress={() => start(key as BulkPreviewQueryV1['action'])}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {state.phase === 'idle' ? null : (
        <Modal.Backdrop
          isOpen
          isDismissable={false}
          onOpenChange={(next) => {
            if (!next) leave();
          }}
        >
          <Modal.Container size="full">
            <Modal.Dialog aria-label={actions[action]} className="pa-bulk-dialog">
              <Modal.Header className="pa-bulk-dialog__edge">
                <Modal.Heading>{actions[action]}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="pa-bulk-dialog__body">
                <div className="flex flex-wrap gap-2">
                  <Chip variant="soft" color="accent">
                    {scopeLabel}
                  </Chip>
                  <Chip variant="soft">{selection ? 'Somente selecionados' : 'Turma inteira'}</Chip>
                </div>
                {state.phase === 'loading' ? (
                  <ProgressBar isIndeterminate aria-label="Preparando a operação">
                    <Label>
                      Preparando a operação{state.total ? ` · ${state.total} contas` : ''}…
                    </Label>
                    <ProgressBar.Track>
                      <ProgressBar.Fill />
                    </ProgressBar.Track>
                  </ProgressBar>
                ) : null}
                {state.phase === 'review' ? (
                  <BulkReviewV1
                    action={action}
                    targets={targets}
                    skipped={skipped}
                    required={required}
                    confirmation={confirmation}
                    onConfirmationChange={setConfirmation}
                  />
                ) : null}
                {executing ? (
                  <BulkProgressV1
                    state={state}
                    targets={targets}
                    counts={{ completed, failed, unclear, skipped, processed, percent }}
                  />
                ) : null}
                {state.phase === 'error' ? (
                  <p role="alert">
                    Não foi possível carregar a operação.{' '}
                    {errors[state.error ?? ''] ?? 'Solicitação recusada.'}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="pa-bulk-dialog__edge">
                <BulkActionsV1
                  state={state}
                  action={action}
                  ready={confirmation === required}
                  targets={targets}
                  clock={clock}
                  controller={controller.current}
                />
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      )}
    </section>
  );
}
