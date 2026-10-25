import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Label, Radio, RadioGroup, TextField } from '@heroui/react';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import type { AdminAccountReadV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import { accountCredentialPreparableV1 } from '../accounts/accounts-values-v1';
import { createQrOperationV1, type QrOperationStateV1, type QrRendererV1 } from './qr-operation-v1';
import { PRINT_MODES_V1, type PrintModeV1 } from './qr-values-v1';
import { qrFilenameV1 } from './qr-filename-v1';
import type { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { QrCardArtSourceV1 } from './qr-access-card-pdf-v1';

type QrBatchLayoutV1 = 'card' | 'compact';

/** A failed request before the file: the class changed, or the result is not confirmed. */
const batchFailureText = (state: string) =>
  state === 'conflict'
    ? 'A turma mudou. Recarregue a lista e revise os alunos antes de gerar.'
    : 'Não foi possível confirmar o resultado. Não gere outra solicitação sem revisar.';

const selectionCountLabelV1 = (wholeList: boolean, count: number) =>
  wholeList ? `Lista inteira · ${count}` : `${count} selecionados`;

/** The compact QR: what it carries, and an optional instruction below it. */
function QrCompactOptionsV1({
  mode,
  onMode,
  withInstruction,
  onWithInstruction,
  instruction,
  onInstruction,
  disabled,
}: Readonly<{
  mode: PrintModeV1;
  onMode: (mode: PrintModeV1) => void;
  withInstruction: boolean;
  onWithInstruction: (value: boolean) => void;
  instruction: string;
  onInstruction: (value: string) => void;
  disabled: boolean;
}>) {
  return (
    <>
      <RadioGroup
        value={mode}
        onChange={(value) => onMode(value as PrintModeV1)}
        orientation="horizontal"
        isDisabled={disabled}
      >
        <Label>Conteúdo do QR</Label>
        {(Object.entries(PRINT_MODES_V1) as [PrintModeV1, string][]).map(([value, text]) => (
          <Radio key={value} value={value}>
            <Radio.Content>
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              <span>{text}</span>
            </Radio.Content>
          </Radio>
        ))}
      </RadioGroup>
      <Checkbox isSelected={withInstruction} onChange={onWithInstruction} isDisabled={disabled}>
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <span>Adicionar instrução ao cartão</span>
        </Checkbox.Content>
      </Checkbox>
      {withInstruction ? (
        <TextField value={instruction} onChange={onInstruction} isDisabled={disabled}>
          <Label>Instrução abaixo do QR</Label>
          <Input maxLength={240} placeholder="Texto opcional, somente neste navegador" />
        </TextField>
      ) : null}
    </>
  );
}

/** Progress while the QR and the PDF are prepared, a download that did not start, or the failure
 * with its retry. */
function QrBatchStatusV1({
  state,
  clock,
  onRetry,
  onReload,
}: Readonly<{
  state: QrOperationStateV1;
  clock: number;
  onRetry: () => void;
  onReload: () => void;
}>) {
  return (
    <>
      {state.state === 'requesting' || state.state === 'rendering' ? (
        <p>
          <output className="contents">
            {state.state === 'rendering'
              ? `Gerando PDF: ${state.completed} de ${state.total}`
              : `Preparando QR: ${state.completed} de ${state.count}`}
          </output>
        </p>
      ) : null}
      {state.state === 'ready' && state.downloadFailed ? (
        <p role="alert">O PDF está pronto, mas o download não começou.</p>
      ) : null}
      {state.state === 'error' ? (
        <div role="alert">
          <p>
            {state.stage === 'render'
              ? 'O servidor confirmou os QR. Tentar novamente gera somente o arquivo.'
              : batchFailureText(state.error.state)}
          </p>
          {state.retryable ? (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={clock < state.retryAt}
              onPress={onRetry}
            >
              Repetir mesma solicitação
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={clock < state.retryAt}
              onPress={onReload}
            >
              Recarregar disponibilidade
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}

export function QrBatchToolsV1({
  client,
  accounts,
  selected,
  onSelectAll,
  academicYear,
  classId,
  scopeVersion,
  label,
  canWrite,
  pendingBirth,
  hasMore,
  onCommitted,
  onAuthorizationLost,
  renderArtifact,
}: Readonly<{
  client: PortalAdminClientV1;
  accounts: AdminAccountReadV2[];
  selected: Set<string>;
  /** Omitted where the list itself selects (the header checkbox of the accounts table). */
  onSelectAll?: (selected: boolean) => void;
  academicYear: number;
  classId: number;
  scopeVersion: number;
  label: string;
  canWrite: boolean;
  pendingBirth: boolean;
  hasMore: boolean;
  onCommitted: () => void;
  onAuthorizationLost?: (error: PortalClientErrorV1) => void;
  renderArtifact?: QrRendererV1;
}>) {
  const [state, setState] = useState<QrOperationStateV1>({ state: 'idle' });
  const [layout, setLayout] = useState<QrBatchLayoutV1>('card');
  const [mode, setMode] = useState<PrintModeV1>('qr-name-class');
  const [withInstruction, setWithInstruction] = useState(false),
    [instruction, setInstruction] = useState('');
  const [clock, setClock] = useState(Date.now);
  const capture = useRef({
    instruction: '',
    filename: '',
    run: '',
    selectionKey: '',
    layout: 'card' as QrBatchLayoutV1,
  });
  // Card art (portrait, name, class) is painted from the click onwards, while the server is
  // still issuing the credentials; the QR itself is drawn as vector once the cards arrive.
  const art = useRef<
    { controller: AbortController; source: Promise<QrCardArtSourceV1> } | undefined
  >(undefined);
  const stopArt = useCallback(() => {
    art.current?.controller.abort();
    art.current = undefined;
  }, []);
  const callbacks = useRef({ onAuthorizationLost, onCommitted });
  callbacks.current = { onAuthorizationLost, onCommitted };
  const render = useCallback<QrRendererV1>(
    async (cards, format, signal, progress) => {
      if (renderArtifact) return renderArtifact(cards, format, signal, progress);
      signal.throwIfAborted();
      if (capture.current.layout === 'card') {
        const { renderQrAccessCardsPdfV1 } = await import('./qr-access-card-pdf-v1');
        const prepared = await art.current?.source;
        signal.throwIfAborted();
        try {
          // Each progress update re-renders the student list; a few per second are enough.
          let shownAt = 0;
          const throttledProgress = (completed: number, total: number) => {
            const now = performance.now();
            if (completed !== 0 && completed !== total && now - shownAt < 250) return;
            shownAt = now;
            progress(completed, total);
          };
          return await renderQrAccessCardsPdfV1(
            cards,
            academicYear,
            signal,
            throttledProgress,
            undefined,
            prepared,
          );
        } finally {
          stopArt(); // The PDF holds what it needs; drop the in-memory portraits and art.
        }
      }
      const { renderQrPdfV1 } = await import('./qr-artifacts-v1');
      signal.throwIfAborted();
      return renderQrPdfV1(cards, signal, progress, capture.current.instruction);
    },
    [renderArtifact, academicYear, stopArt],
  );
  const operation = useMemo(
    () =>
      createQrOperationV1({
        client,
        canWrite,
        publish: setState,
        render,
        retainUntilClear: true,
        onAuthorizationLost: (error) => callbacks.current.onAuthorizationLost?.(error),
      }),
    [client, canWrite, render],
  );
  const autoDownloaded = useRef('');
  useEffect(() => {
    // Code only (no data): the first click must not wait for the PDF chunk to download.
    if (canWrite && !renderArtifact) void import('./qr-access-card-pdf-v1').catch(() => {});
  }, [canWrite, renderArtifact]);
  useEffect(() => {
    const clear = () => operation.clear();
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      operation.clear();
      stopArt();
    };
  }, [operation, stopArt]);
  useEffect(() => {
    if (
      state.state !== 'ready' ||
      !capture.current.run ||
      autoDownloaded.current === capture.current.run
    )
      return;
    autoDownloaded.current = capture.current.run;
    operation.download(capture.current.filename);
    callbacks.current.onCommitted();
  }, [state, operation]);
  useEffect(() => {
    if (state.state !== 'error') return;
    setClock(Date.now());
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, state.retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);
  const working = state.state === 'requesting' || state.state === 'rendering';
  const unresolved = state.state === 'error';
  // Where the list selects, nothing ticked means the whole list, as in the bulk operations. A
  // list still loading more rows is not whole, so it keeps asking for an explicit selection.
  const wholeList = !onSelectAll && selected.size === 0 && !hasMore;
  const chosen = accounts.filter(
    (account) =>
      (wholeList || selected.has(account.accountId)) && accountCredentialPreparableV1(account),
  );
  const requestMode = layout === 'card' ? 'qr-name-class' : mode;
  const selectionKey = JSON.stringify([
    chosen.map((account) => account.accountId).sort((left, right) => left.localeCompare(right)),
    layout,
    requestMode,
    layout === 'compact' && withInstruction ? instruction.trim().slice(0, 240) : '',
  ]);
  const readyForSelection =
    state.state === 'ready' && capture.current.selectionKey === selectionKey;
  function generate() {
    if (!canWrite || working || unresolved || pendingBirth || !chosen.length) return;
    const idempotencyKey = crypto.randomUUID();
    capture.current = {
      instruction: layout === 'compact' && withInstruction ? instruction.trim().slice(0, 240) : '',
      filename: qrFilenameV1(label, 'pdf'),
      run: idempotencyKey,
      selectionKey,
      layout,
    };
    operation.clear();
    stopArt();
    if (layout === 'card' && !renderArtifact) {
      const controller = new AbortController();
      const identities = chosen.map(({ accountId, name, classLabel }) => ({
        accountId,
        name,
        classLabel,
      }));
      art.current = {
        controller,
        source: import('./qr-access-card-pdf-v1').then(({ prepareQrCardArtV1 }) =>
          prepareQrCardArtV1(identities, academicYear, controller.signal),
        ),
      };
    }
    void operation.submit(
      {
        contractVersion: 1,
        operation: 'qr-batch',
        classId,
        expectedVersion: scopeVersion,
        accountIds: chosen.map((account) => account.accountId),
        mode: requestMode,
        confirmed: true,
        idempotencyKey,
      },
      'pdf',
    );
  }
  return (
    <div className="pa-qr-batch-tools" aria-label="Opções do PDF de QR">
      <RadioGroup
        value={layout}
        onChange={(value) => setLayout(value as QrBatchLayoutV1)}
        orientation="horizontal"
        isDisabled={!canWrite || working || unresolved}
      >
        <Label>Formato do PDF</Label>
        {(
          [
            ['card', 'Cartão completo · 9,35 × 5,9 cm'],
            ['compact', 'QR compacto'],
          ] as const
        ).map(([value, text]) => (
          <Radio key={value} value={value}>
            <Radio.Content>
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              <span>{text}</span>
            </Radio.Content>
          </Radio>
        ))}
      </RadioGroup>
      {layout === 'compact' ? (
        <QrCompactOptionsV1
          mode={mode}
          onMode={setMode}
          withInstruction={withInstruction}
          onWithInstruction={setWithInstruction}
          instruction={instruction}
          onInstruction={setInstruction}
          disabled={!canWrite || working || unresolved}
        />
      ) : null}
      <div className="pa-credentials-actions">
        {onSelectAll ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!canWrite || working || unresolved}
              onPress={() => onSelectAll(true)}
            >
              {hasMore ? 'Selecionar exibidos' : 'Selecionar lista'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!selected.size || working || unresolved}
              onPress={() => onSelectAll(false)}
            >
              Limpar
            </Button>
          </>
        ) : null}
        <span>
          <output className="contents">{selectionCountLabelV1(wholeList, chosen.length)}</output>
        </span>
        <Button
          size="sm"
          isDisabled={
            !canWrite ||
            (!readyForSelection && (working || unresolved || pendingBirth || !chosen.length))
          }
          onPress={
            readyForSelection ? () => operation.download(capture.current.filename) : generate
          }
        >
          {readyForSelection ? 'Baixar PDF pronto' : 'Baixar PDF'}
        </Button>
        {state.state === 'ready' ? (
          <Button size="sm" variant="secondary" onPress={() => operation.clear()}>
            Preparar outro PDF
          </Button>
        ) : null}
      </div>
      <QrBatchStatusV1
        state={state}
        clock={clock}
        onRetry={() => void operation.retry()}
        onReload={() => {
          operation.clear();
          callbacks.current.onCommitted();
        }}
      />
    </div>
  );
}
