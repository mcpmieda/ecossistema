import { useEffect, useRef, useState } from 'react';
import { Alert, Button, ProgressBar, Surface } from '@heroui/react';
import { Check, FileSpreadsheet, Upload, Users } from 'lucide-react';
import { abbreviateSha256 } from './file-manifest';
import { MAX_NOTES_IMPORT_FILES } from './import-batch';
import {
  useImportBatch,
  type ImportFlowProgressV9,
  isMasterRelationResult,
  type ImportPersistenceStateV9,
} from './use-import-batch';
import { ImportDiagnosticsPanelV1 } from './import-diagnostics-panel-v1';
import { actionableGradebookImportDiagnosticsV1 } from './import-diagnostics-v1';
import { WorkbookInspector } from './workbook-inspector';
import type { ImportTimingSummaryV1 } from './import-timing-report-v1';
import { StudentReportImportV1 } from './student-report-import-v1';
import { RelationMovementReviewV9 } from './relation-movement-review-v9';

function FileHash({ sha256 }: { sha256: string }) {
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer">
        SHA-256 <code>{abbreviateSha256(sha256)}</code>
      </summary>
      <code className="mt-2 block break-all">{sha256}</code>
    </details>
  );
}

const PROGRESS_STAGE = {
  preparing: ['Preparando e calculando SHA-256', 10],
  recognizing: ['Reconhecendo estrutura', 20],
  roster: ['Organizando alunos', 35],
  grades: ['Processando notas', 65],
  recovery: ['Processando recuperação', 75],
  compacting: ['Preparando dados', 85],
  saving: ['Salvando no Banco', 95],
  completed: ['Concluído', 100],
} as const;

function progressValue(progress: ImportFlowProgressV9): number {
  const [, base] = PROGRESS_STAGE[progress.stage];
  if (progress.stage === 'completed') return 100;
  const fraction = progress.total > 0 ? Math.min(1, progress.current / progress.total) : 0;
  const next =
    progress.stage === 'preparing'
      ? 20
      : progress.stage === 'recognizing'
        ? 35
        : progress.stage === 'roster'
          ? 65
          : progress.stage === 'grades'
            ? 75
            : progress.stage === 'recovery'
              ? 85
              : progress.stage === 'compacting'
                ? 95
                : 100;
  return Math.round(base + (next - base) * fraction);
}

function persistenceLabel(state: ImportPersistenceStateV9 | undefined): string {
  if (!state) return 'Aguardando';
  switch (state.state) {
    case 'recognized':
      return 'Reconhecido';
    case 'processing':
      return 'Processando localmente';
    case 'persisting':
      return 'Salvando';
    case 'auth-required':
      return 'Sessão expirada';
    case 'confirmation-required':
      return 'Confirmação pendente';
    case 'movement-review':
      return state.cancelled ? 'Conferência cancelada' : 'Conferência de movimentações';
    case 'failed':
      return state.kind === 'validation'
        ? 'Bloqueado para correção'
        : `Indisponível: ${state.message}`;
    case 'completed': {
      const labels = {
        applied: 'Aplicado',
        'no-changes': 'Sem mudanças acadêmicas',
        'review-required': 'Revisão necessária',
        blocked: 'Bloqueado',
        conflict: 'Conflito',
        'invalid-request': 'Pedido inválido',
        'not-authorized': 'Não autorizado',
        unavailable: 'Indisponível',
      } as const;
      return labels[state.response.state];
    }
  }
}

function persistenceDescription(
  state: Extract<ImportPersistenceStateV9, { state: 'completed' }>,
): string {
  const response = state.response;
  const issue = 'reason' in response ? ` Motivo técnico: ${response.reason}.` : '';
  if (!('summary' in response)) return issue.trim();
  if (response.state === 'no-changes') {
    const auditWrites = response.summary.committedWrites.importBatchVersions;
    return auditWrites > 0
      ? `Nenhuma nota, resultado ou cadastro acadêmico foi alterado. ${auditWrites} registro(s) técnico(s) da tentativa foram gravados para auditoria.${issue}`
      : `Nenhuma nota, resultado ou cadastro acadêmico foi alterado.${issue}`;
  }
  return `${response.summary.committedWrites.total} gravação(ões) confirmadas no lote atômico, incluindo registros técnicos de auditoria.${issue}`;
}

function PersistenceResult({ state }: { state: ImportPersistenceStateV9 | undefined }) {
  if (!state) return null;
  if (state.state === 'auth-required') {
    return (
      <Alert status="warning" className="mt-5">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Sessão expirada durante o lote</Alert.Title>
          <Alert.Description>
            O arquivo permanece reconhecido somente nesta aba e ainda não foi reenviado. Renove a
            sessão em outra aba e retome apenas os pendentes.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  if (state.state === 'confirmation-required') {
    return (
      <Alert status="warning" className="mt-5">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Gravação sem confirmação — lote pausado</Alert.Title>
          <Alert.Description>
            A resposta não confirmou o resultado. A planilha pode já ter sido gravada; isso não
            significa perda nem falha acadêmica. Retome os pendentes para reconciliar o mesmo
            conteúdo com o estado oficial, sem reenviar os arquivos já confirmados nesta aba.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  if (state.state === 'failed') {
    if (state.kind === 'validation') {
      return (
        <Alert status="danger" className="mt-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Planilha bloqueada para correção</Alert.Title>
            <Alert.Description>
              {state.message} Nenhum dado deste arquivo foi enviado.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      );
    }
    return (
      <Alert status="danger" className="mt-5">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Importação não aplicada</Alert.Title>
          <Alert.Description>{state.message}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  if (state.state !== 'completed') return null;
  const response = state.response;
  const success = response.state === 'applied' || response.state === 'no-changes';
  return (
    <Alert status={success ? 'success' : 'warning'} className="mt-5">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{persistenceLabel(state)}</Alert.Title>
        <Alert.Description>{persistenceDescription(state)}</Alert.Description>
        {'warnings' in response && response.warnings?.length ? (
          <ul className="mt-2 space-y-1 text-sm">
            {response.warnings.map((warning) => (
              <li key={`${warning.classCode}:${warning.number}:${warning.relatedClassCode}`}>
                Movimentação ligada entre {warning.classCode} e {warning.relatedClassCode}. Confira
                a grafia.
              </li>
            ))}
          </ul>
        ) : null}
      </Alert.Content>
    </Alert>
  );
}

export function TimingDiagnostics({
  visible,
  summary,
  getReport,
}: {
  visible: boolean;
  summary: ImportTimingSummaryV1;
  getReport: () => string;
}) {
  const mounted = useRef(true);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [manualText, setManualText] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A manual snapshot belongs to the clicked run, not a later selection/resume.
  const copyRun = useRef(summary.runOrdinal);
  useEffect(() => {
    copyRun.current = summary.runOrdinal;
    setManualText(null);
    setCopyStatus('idle');
  }, [summary.runOrdinal]);
  async function copyReport() {
    const ordinal = summary.runOrdinal;
    let text: string | null = null;
    setCopyStatus('copying');
    try {
      text = getReport();
      if (!globalThis.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await globalThis.navigator.clipboard.writeText(text);
      if (mounted.current && copyRun.current === ordinal) {
        setManualText(null);
        setCopyStatus('copied');
      }
    } catch {
      if (mounted.current && copyRun.current === ordinal) {
        setManualText(text);
        setCopyStatus('failed');
      }
    }
  }
  if (!visible) return null;
  return (
    <Surface variant="secondary" className="mt-3 rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <p className="text-sm font-medium">Diagnóstico de tempo</p>
          <p className="mt-1 text-xs text-muted">
            Tempos e contagens ficam somente em memória. Novo lote substitui o relatório; recarregar
            ou fechar a tela apaga o histórico.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={summary.runOrdinal === null || copyStatus === 'copying'}
          onPress={() => {
            void copyReport();
          }}
        >
          Copiar diagnóstico
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        {summary.status === 'in-progress'
          ? 'Em andamento'
          : summary.status === 'paused'
            ? 'Pausado'
            : 'Finalizado'}
        {summary.diagnosticFailures > 0 ? ' · Diagnóstico parcial' : ''}
        {summary.discardedEvents > 0
          ? ` · ${summary.discardedEvents} eventos recentes descartados`
          : ''}
        {summary.omittedResumes > 0
          ? ` · ${summary.omittedResumes} retomadas intermediárias omitidas`
          : ''}
      </p>
      <p role="status" aria-live="polite" className="mt-2 text-sm">
        {copyStatus === 'copied'
          ? 'Diagnóstico copiado.'
          : copyStatus === 'failed'
            ? manualText === null
              ? 'Não foi possível obter o diagnóstico.'
              : 'Não foi possível copiar. Selecione o texto abaixo para copiar manualmente.'
            : copyStatus === 'copying'
              ? 'Copiando diagnóstico…'
              : ''}
      </p>
      {manualText !== null && (
        <label className="mt-2 block text-sm">
          Diagnóstico para cópia manual
          <textarea
            readOnly
            value={manualText}
            rows={8}
            className="mt-2 w-full rounded-xl border border-default p-3 font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </Surface>
  );
}

/** The three server refusals a Relação resolves: missing year, class or student number. */
const waitsForRelationV1 = (state: ImportPersistenceStateV9 | undefined) =>
  state?.state === 'completed' &&
  state.response.state === 'blocked' &&
  state.response.reason.includes('Relação');

const savedV1 = (state: ImportPersistenceStateV9 | undefined) =>
  state?.state === 'completed' &&
  (state.response.state === 'applied' || state.response.state === 'no-changes');
/** What each button shows: resting, sent in this tab, or the next thing the import needs. */
type ImportStepToneV1 = 'idle' | 'done' | 'call';
const STEP_CLASS_V1: Record<ImportStepToneV1, string> = {
  idle: '',
  done: 'import-step--done',
  call: 'import-step--call',
};

export function NotesImportPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const reportInputRef = useRef<HTMLInputElement>(null);
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [asked, setAsked] = useState<'relation' | 'marks'>('marks');
  // Sent in this tab. A batch decides only for the kind of file it carried.
  const [sent, setSent] = useState({ relation: false, marks: false });
  // Grade workbooks the server refused for want of the Relação stay in this tab; the next
  // selection carries them along, and a batch always sends its Relação first.
  const batchFiles = useRef<readonly File[]>([]);
  const [waiting, setWaiting] = useState<readonly File[]>([]);
  // The waiting workbooks did not fit beside the selection: they follow once its Relação is in.
  const deferred = useRef(false);
  const {
    authorizationRequired,
    cancelMovementReview,
    confirmMovementReview,
    diagnosticAuditFailures,
    error,
    failures,
    handleFiles,
    loading,
    pendingPersistenceCount,
    progress,
    persistence,
    results,
    resumePendingPersistence,
    selectedId,
    selectedResult,
    setSelectedId,
    sourceDiagnostics,
    timingReportSummary,
    getTimingReport,
    totals,
  } = useImportBatch();

  useEffect(() => {
    if (loading) return;
    const decided = new Map(
      results.map((result) => [result.manifest.fileName, persistence[result.id]]),
    );
    // A workbook leaves the wait only with an answer of its own: one held because the
    // Relação of its batch was refused, or left out of the batch, keeps waiting.
    setWaiting((current) =>
      batchFiles.current.filter((file) => {
        const state = decided.get(file.name);
        return (
          waitsForRelationV1(state) ||
          (current.some((item) => item.name === file.name) && state?.state !== 'completed')
        );
      }),
    );
    if (results.length === 0) return;
    const relations = results.filter(isMasterRelationResult);
    const marks = results.filter((result) => !isMasterRelationResult(result));
    const allSaved = (group: typeof results) =>
      group.every((result) => savedV1(persistence[result.id]));
    setSent((current) => ({
      relation: relations.length ? allSaved(relations) : current.relation,
      marks: marks.length ? allSaved(marks) : current.marks,
    }));
    if (deferred.current && relations.length > 0 && allSaved(relations)) {
      deferred.current = false;
      const held = batchFiles.current.filter((file) => !decided.has(file.name));
      if (held.length > 0) {
        batchFiles.current = held;
        void handleFiles(held);
      }
    }
  }, [loading, results, persistence]);
  // The Relação is asked for while workbooks wait on it; the workbooks once it is in.
  const relationTone: ImportStepToneV1 = sent.relation
    ? 'done'
    : waiting.length > 0
      ? 'call'
      : 'idle';
  const marksTone: ImportStepToneV1 = sent.marks
    ? 'done'
    : sent.relation && waiting.length === 0
      ? 'call'
      : 'idle';
  const pick = (kind: 'relation' | 'marks') => {
    setAsked(kind);
    inputRef.current?.click();
  };
  const importSelected = (selected: readonly File[]) => {
    const chosen = new Set(selected.map((file) => file.name));
    const held = waiting.filter((file) => !chosen.has(file.name));
    batchFiles.current = [...selected, ...held];
    // Over the batch limit, the selection goes alone and the waiting workbooks follow it.
    deferred.current = held.length > 0 && batchFiles.current.length > MAX_NOTES_IMPORT_FILES;
    return handleFiles(deferred.current ? selected : batchFiles.current);
  };

  const selectedPersistence = selectedResult ? persistence[selectedResult.id] : undefined;
  const selectedDiagnostics = selectedResult
    ? actionableGradebookImportDiagnosticsV1(sourceDiagnostics[selectedResult.id] ?? [])
    : [];

  return (
    <Surface variant="default" className="platform-card-surface rounded-3xl p-6 sm:p-7">
      <input
        ref={reportInputRef}
        type="file"
        className="hidden"
        accept=".xlsx,.xls,.xlsb"
        aria-label="Selecionar Relatório"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) setReportFile(file);
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        accept=".xlsx,.xlsb,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.ms-excel.sheet.binary.macroEnabled.12"
        onChange={(event) => {
          const input = event.currentTarget;
          if (input.files?.length) {
            void importSelected(Array.from(input.files)).finally(() => {
              input.value = '';
            });
          }
        }}
      />

      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="size-5 text-accent" />
            <h3 className="text-lg font-semibold">Importar planilhas</h3>
          </div>
        </div>
        {/* Both buttons run the same import; the Relação usually lives in another folder. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant={relationTone === 'call' ? 'primary' : 'secondary'}
            className={STEP_CLASS_V1[relationTone]}
            isPending={loading && asked === 'relation'}
            isDisabled={loading}
            onPress={() => pick('relation')}
          >
            {relationTone === 'done' ? <Check className="size-4" /> : <Users className="size-4" />}
            {relationTone === 'done' ? 'Relação enviada' : 'Selecionar Relação'}
          </Button>
          <Button
            variant={marksTone === 'call' ? 'primary' : 'secondary'}
            className={STEP_CLASS_V1[marksTone]}
            isPending={loading && asked === 'marks'}
            isDisabled={loading}
            onPress={() => pick('marks')}
          >
            {marksTone === 'done' ? <Check className="size-4" /> : <Upload className="size-4" />}
            {marksTone === 'done' ? 'Planilhas enviadas' : 'Selecionar planilhas'}
          </Button>
          <Button
            variant="secondary"
            isDisabled={loading}
            onPress={() => reportInputRef.current?.click()}
          >
            <FileSpreadsheet className="size-4" />
            Relatório
          </Button>
        </div>
      </div>

      {reportFile ? (
        <StudentReportImportV1
          key={`${reportFile.name}:${reportFile.lastModified}`}
          file={reportFile}
          onClose={() => setReportFile(null)}
        />
      ) : null}

      {waiting.length > 0 && !loading && (
        <Alert status="warning" className="mt-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {waiting.length === 1
                ? '1 planilha aguardando a Relação'
                : `${waiting.length} planilhas aguardando a Relação`}
            </Alert.Title>
            <Alert.Description>{waiting.map((file) => file.name).join(' · ')}</Alert.Description>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onPress={() => pick('relation')}>
                <Users className="size-4" />
                Selecionar Relação
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  batchFiles.current = [];
                  setWaiting([]);
                }}
              >
                Descartar
              </Button>
            </div>
          </Alert.Content>
        </Alert>
      )}

      {progress && (
        <Surface variant="secondary" className="mt-5 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">{PROGRESS_STAGE[progress.stage][0]}</span>
            <span className="text-muted">{progressValue(progress)}%</span>
          </div>
          <ProgressBar
            className="mt-3"
            value={progressValue(progress)}
            color={progress.stage === 'completed' ? 'success' : 'accent'}
            aria-label="Progresso da importação"
          />
          <p className="mt-2 truncate text-xs text-muted">{progress.fileName}</p>
        </Surface>
      )}

      {error && (
        <Alert status="danger" className="mt-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Não foi possível concluir a importação</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {pendingPersistenceCount > 0 && (!loading || authorizationRequired) && (
        <Surface variant="secondary" className="mt-5 rounded-2xl p-4">
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>
                {authorizationRequired
                  ? 'Sessão expirada — lote pausado'
                  : 'Importação pausada — pendentes preservados'}
              </Alert.Title>
              <Alert.Description>
                Os arquivos reconhecidos continuam somente na memória desta aba.{' '}
                {authorizationRequired && 'Renove a sessão em outra aba e volte aqui. '}
                Retome os {pendingPersistenceCount} arquivo(s) pendente(s). Itens já concluídos não
                serão reenviados.
              </Alert.Description>
            </Alert.Content>
          </Alert>
          <div className="mt-3 flex flex-wrap gap-2">
            {authorizationRequired && (
              <Button
                variant="secondary"
                onPress={() => {
                  globalThis.open('/auth/login', '_blank', 'noopener,noreferrer');
                }}
              >
                Renovar sessão
              </Button>
            )}
            <Button
              variant="primary"
              isPending={loading}
              isDisabled={loading || pendingPersistenceCount === 0}
              onPress={() => void resumePendingPersistence()}
            >
              Retomar pendentes
            </Button>
          </div>
        </Surface>
      )}

      {(results.length > 0 || failures.length > 0) && (
        <div className="mt-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['Arquivos', results.length + failures.length, `limite ${MAX_NOTES_IMPORT_FILES}`],
              [
                'Reconhecidos',
                results.length,
                failures.length ? `${failures.length} com erro` : 'sem erros de leitura',
              ],
              ['Turmas', totals.classes, 'somadas no lote'],
              ['Alunos', totals.students, `${totals.gradeSheets} guias reconhecidas`],
            ].map(([label, value, detail]) => (
              <Surface key={String(label)} variant="secondary" className="rounded-2xl p-4">
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
                  {label}
                </p>
                <p className="mt-2 text-2xl font-semibold">{value}</p>
                <p className="mt-1 text-xs text-muted">{detail}</p>
              </Surface>
            ))}
          </div>

          {failures.length > 0 && (
            <Alert status="warning" className="mt-4">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{failures.length} arquivo(s) não reconhecido(s)</Alert.Title>
                <Alert.Description>
                  {failures.map((failure) => `${failure.fileName}: ${failure.message}`).join(' · ')}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            {results.map((result) => {
              const diagnostics = actionableGradebookImportDiagnosticsV1(
                sourceDiagnostics[result.id] ?? [],
              );
              const blocking = diagnostics.filter(
                (value) => value.severity === 'blocking-error',
              ).length;
              const warnings = diagnostics.filter((value) => value.severity === 'warning').length;
              return (
                <Surface key={result.id} variant="secondary" className="rounded-2xl p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="mr-auto font-medium">{result.manifest.fileName}</p>
                    <span className="text-xs font-medium">
                      {persistenceLabel(persistence[result.id])}
                    </span>
                  </div>
                  <FileHash sha256={result.manifest.sha256} />
                  <p className="mt-2 text-xs text-muted">
                    Vazio = Não fez · 0 = Tirou zero · 0,1 = nota numérica
                  </p>
                  {blocking > 0 && (
                    <p className="mt-2 text-xs font-semibold text-danger">
                      {blocking} problema(s) bloqueante(s) — corrigir antes de importar
                    </p>
                  )}
                  {warnings > 0 && (
                    <p className="mt-1 text-xs font-medium">
                      {warnings} aviso(s) de origem/lançamento — revisar
                    </p>
                  )}
                </Surface>
              );
            })}
            {failures.map((failure) => (
              <Surface key={failure.id} variant="secondary" className="rounded-2xl p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="mr-auto font-medium">{failure.fileName}</p>
                  <span className="text-xs font-medium text-danger">Falha isolada</span>
                </div>
                {failure.manifest ? (
                  <FileHash sha256={failure.manifest.sha256} />
                ) : (
                  <p className="mt-2 text-xs text-muted">Manifesto indisponível</p>
                )}
                <p className="mt-2 text-xs text-muted">
                  {failure.stage === 'preparation' ? 'Preparação/hash' : 'Reconhecimento'} ·{' '}
                  {failure.diagnostic.code}: {failure.message}
                </p>
              </Surface>
            ))}
          </div>

          {results.length > 0 && (
            <div className="mt-5 overflow-x-auto pb-1">
              <div className="flex min-w-max gap-2">
                {results.map((result) => (
                  <Button
                    key={result.id}
                    variant={selectedId === result.id ? 'secondary' : 'ghost'}
                    size="sm"
                    onPress={() => setSelectedId(result.id)}
                  >
                    <FileSpreadsheet className="size-4" />
                    {result.summary.fileName}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {selectedResult && (
            <>
              <WorkbookInspector result={selectedResult} />
              <ImportDiagnosticsPanelV1
                diagnostics={selectedDiagnostics}
                auditFailure={diagnosticAuditFailures[selectedResult.id]}
              />
              <PersistenceResult state={selectedPersistence} />
              {selectedPersistence?.state === 'movement-review' && selectedPersistence.review ? (
                <RelationMovementReviewV9
                  key={`${selectedResult.id}:${selectedPersistence.review.digest}`}
                  review={selectedPersistence.review}
                  busy={loading}
                  onConfirm={(confirmation) =>
                    void confirmMovementReview(selectedResult.id, confirmation)
                  }
                  onCancel={() => cancelMovementReview(selectedResult.id)}
                />
              ) : null}
              {selectedPersistence?.state === 'movement-review' && !selectedPersistence.review ? (
                <Alert status="warning" className="mt-5">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{persistenceLabel(selectedPersistence)}</Alert.Title>
                    <Alert.Description>{selectedPersistence.message}</Alert.Description>
                    <Button
                      variant="secondary"
                      className="mt-3"
                      isDisabled={loading}
                      onPress={() => void resumePendingPersistence()}
                    >
                      Conferir novamente
                    </Button>
                  </Alert.Content>
                </Alert>
              ) : null}
            </>
          )}
        </div>
      )}
      <TimingDiagnostics
        visible={timingReportSummary.runOrdinal !== null}
        summary={timingReportSummary}
        getReport={getTimingReport}
      />
    </Surface>
  );
}
