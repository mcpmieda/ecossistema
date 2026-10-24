import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  Label,
  Spinner,
  Surface,
  TextArea,
  TextField,
} from '@heroui/react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Eye,
  FileWarning,
  History,
  MessageSquarePlus,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1,
  IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1,
  IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1,
  type ImportDiagnosticTreatmentActionV1,
  type ImportDiagnosticTreatmentHistoryCursorV1,
  type ImportDiagnosticTreatmentRecordV1,
} from '../../../../shared/gradebook-contracts/audit/import-diagnostic-treatment-v1';
import type { GradebookImportDiagnosticsAuditRecordV1 } from '../../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import { listGradebookImportDiagnosticsAuditV1 } from '../import/import-diagnostics-client-v1';
import {
  importDiagnosticTreatmentIdempotencyKeyV1,
  requestImportDiagnosticTreatmentV1,
} from './import-diagnostic-treatment-client-v1';

type LoadState = 'loading' | 'ready' | 'empty' | 'not-authorized' | 'unavailable';
type TreatmentState = 'idle' | 'loading' | 'ready' | 'not-authorized' | 'unavailable';
type HistoryState = 'idle' | 'loading' | 'ready' | 'empty' | 'not-authorized' | 'unavailable';
type SeverityFilter = 'all' | 'blocking-error' | 'warning';

const PAGE_SIZE = 50;

const DIAGNOSTIC_LABELS: Readonly<Record<string, string>> = {
  'invalid-text': 'Texto em campo de nota',
  'negative-grade': 'Nota negativa',
  'invalid-precision': 'Precisão inválida',
  'invalid-maximum': 'Máximo inválido',
  'duplicate-student-number': 'Número de aluno duplicado',
  'source-unavailable': 'Valor de origem indisponível',
  'above-maximum': 'Nota acima do máximo',
};

function instant(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date)
    : value;
}

function findingIdentity(value: { readonly fileName: string; readonly key: string }): string {
  return `${value.fileName}\0${value.key}`;
}

function findingLocation(value: GradebookImportDiagnosticsAuditRecordV1): string {
  const student =
    value.studentNumber === undefined
      ? null
      : `${value.studentNumber}. ${value.studentName ?? 'Aluno não identificado'}`;
  return [student, value.classCode, value.subject, value.period, value.fieldLabel]
    .filter(Boolean)
    .join(' · ');
}

function treatmentLocation(value: ImportDiagnosticTreatmentRecordV1): string {
  const student =
    value.studentNumber === null
      ? null
      : `${value.studentNumber}. ${value.studentName ?? 'Aluno não identificado'}`;
  return [student, value.classCode, value.subject, value.period, value.fieldLabel]
    .filter(Boolean)
    .join(' · ');
}

function StateAlert({ state, year }: { readonly state: Exclude<LoadState, 'loading' | 'ready'>; readonly year: number | null }) {
  if (state === 'not-authorized') {
    return (
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Acesso não autorizado</Alert.Title>
          <Alert.Description>
            Sua sessão não pode consultar a Auditoria do Banco de Notas.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  if (state === 'unavailable') {
    return (
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Auditoria indisponível</Alert.Title>
          <Alert.Description>
            A consulta relacional falhou. Nenhum achado substituto foi criado.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }
  return (
    <Alert status="success">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>Nenhum achado atual</Alert.Title>
        <Alert.Description>
          O recorte de {year ?? 'ano selecionado'} não possui erro ou aviso de importação pendente.
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

function TreatmentTimeline({
  values,
}: {
  readonly values: readonly ImportDiagnosticTreatmentRecordV1[];
}) {
  if (values.length === 0) return null;
  return (
    <details className="mt-4 rounded-xl border border-border/60 bg-surface/70 px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold text-primary">
        Tratamento humano · {values.length} registro(s)
      </summary>
      <ol className="mt-3 grid gap-2 border-l border-border pl-4">
        {values.map((item) => (
          <li key={item.id} className="relative text-xs text-muted">
            <span
              aria-hidden="true"
              className="absolute -left-[1.15rem] top-1 size-2 rounded-full bg-primary"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Chip
                size="sm"
                variant="soft"
                color={
                  item.action === IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.acknowledged
                    ? 'accent'
                    : 'default'
                }
              >
                {item.actionLabel}
              </Chip>
              <span>{instant(item.recordedAt)}</span>
            </div>
            {item.note && (
              <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{item.note}</p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

interface FindingProps {
  readonly value: GradebookImportDiagnosticsAuditRecordV1;
  readonly treatments: readonly ImportDiagnosticTreatmentRecordV1[];
  readonly treatmentState: TreatmentState;
  readonly busy: boolean;
  readonly feedback: string | null;
  readonly onRecord: (
    value: GradebookImportDiagnosticsAuditRecordV1,
    action: ImportDiagnosticTreatmentActionV1,
    note: string | null,
  ) => Promise<boolean>;
  readonly onDraftChange: (id: number, dirty: boolean) => void;
}

function Finding({ value, treatments, treatmentState, busy, feedback, onRecord, onDraftChange }: FindingProps) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const blocking = value.severity === 'blocking-error';
  const recognized = treatments.some(
    (item) => item.action === IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.acknowledged,
  );
  const treatmentUnavailable = treatmentState !== 'ready';

  const submitNote = async () => {
    const normalized = note.trim();
    if (normalized.length < 3) return;
    if (await onRecord(value, IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.note, normalized)) {
      setNote('');
      setNoteOpen(false);
      onDraftChange(value.id, false);
    }
  };

  return (
    <li className="relative pb-5 last:pb-0">
      <span
        aria-hidden="true"
        className={`absolute -left-[1.85rem] mt-1 size-4 rounded-full ring-4 ring-surface ${blocking ? 'bg-danger' : 'bg-warning'}`}
      />
      <Surface variant="secondary" className="rounded-2xl border border-border/60 p-4 sm:p-5">
        <div className="flex flex-wrap items-start gap-2">
          <div className="mr-auto min-w-0">
            <p className="font-semibold">{DIAGNOSTIC_LABELS[value.code] ?? value.code}</p>
            <p className="mt-1 break-words text-sm text-muted">
              {findingLocation(value) || value.fileName}
            </p>
          </div>
          <Chip size="sm" color={blocking ? 'danger' : 'warning'} variant="soft">
            {blocking ? 'Erro bloqueante' : 'Aviso'}
          </Chip>
          <Chip size="sm" variant="soft">
            {value.observations} observação(ões)
          </Chip>
          {recognized && (
            <Chip size="sm" color="success" variant="soft">
              Reconhecido
            </Chip>
          )}
        </div>
        <p className="mt-3 text-sm">{value.message}</p>
        {value.cause && (
          <p className="mt-2 text-sm text-muted">
            <strong className="font-medium text-foreground">O que aconteceu:</strong> {value.cause}
          </p>
        )}
        <p className="mt-2 text-sm text-muted">
          <strong className="font-medium text-foreground">Ação sugerida:</strong>{' '}
          {value.recommendedAction}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>Primeira observação: {instant(value.firstObservedAt)}</span>
          <span>Última observação: {instant(value.lastObservedAt)}</span>
          <span className="truncate">Fonte: {value.fileName}</span>
        </div>
        {(value.sheetName || value.cellAddress || value.foundValue) && (
          <details className="mt-3 text-xs text-muted">
            <summary className="cursor-pointer font-medium">Detalhes técnicos</summary>
            <p className="mt-2 break-words">
              {[
                value.sheetName,
                value.cellAddress,
                value.foundValue && `valor: ${value.foundValue}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </details>
        )}

        <TreatmentTimeline values={treatments} />

        <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
          <Button
            size="sm"
            variant={recognized ? 'secondary' : 'outline'}
            isDisabled={busy || treatmentUnavailable || recognized}
            isPending={busy && !noteOpen}
            onPress={() =>
              void onRecord(value, IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.acknowledged, null)
            }
          >
            <Eye className="size-4" />
            {recognized ? 'Reconhecido' : 'Reconhecer'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy || treatmentUnavailable}
            aria-expanded={noteOpen}
            onPress={() => setNoteOpen((current) => { const next = !current; onDraftChange(value.id, next); return next; })}
          >
            <MessageSquarePlus className="size-4" />
            Adicionar anotação
          </Button>
        </div>

        {noteOpen && (
          <div className="mt-3 grid gap-3 rounded-xl border border-border/60 bg-surface p-3">
            <TextField fullWidth>
              <Label htmlFor={`audit-note-${value.id}`} className="text-xs font-semibold">
                Anotação de tratamento
              </Label>
              <TextArea
                id={`audit-note-${value.id}`}
                rows={3}
                maxLength={IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1.noteCharacters}
                value={note}
                onChange={(event) => { onDraftChange(value.id, true); setNote(event.currentTarget.value); }}
                placeholder="Registre o acompanhamento realizado. A anotação não altera a nota nem oculta a pendência."
              />
            </TextField>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted">
                {note.trim().length}/2.000 caracteres · mínimo 3
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
                  onPress={() => {
                    setNote('');
                    setNoteOpen(false);
                    onDraftChange(value.id, false);
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={busy || note.trim().length < 3}
                  isPending={busy}
                  onPress={() => void submitNote()}
                >
                  Registrar anotação
                </Button>
              </div>
            </div>
          </div>
        )}
        {feedback && (
          <p className="mt-3 text-xs text-muted"><output className="contents" aria-live="polite">
            {feedback}
          </output></p>
        )}
      </Surface>
    </li>
  );
}

interface TreatmentHistoryProps {
  readonly year: number | null;
  readonly state: HistoryState;
  readonly values: readonly ImportDiagnosticTreatmentRecordV1[];
  readonly nextCursor: ImportDiagnosticTreatmentHistoryCursorV1 | null;
  readonly onLoad: (cursor?: ImportDiagnosticTreatmentHistoryCursorV1 | null) => void;
}

function TreatmentHistory({ year, state, values, nextCursor, onLoad }: TreatmentHistoryProps) {
  return (
    <Card>
      <Card.Header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div className="mr-auto">
          <div className="flex items-center gap-2 text-primary">
            <History className="size-5" />
            <Card.Title>Histórico de tratamento</Card.Title>
          </div>
          <Card.Description>
            Registros humanos preservados mesmo depois que a pendência sai da lista atual.
          </Card.Description>
        </div>
        {(state === 'idle' || state === 'unavailable') && <Button
          size="sm"
          variant="secondary"
          onPress={() => onLoad(null)}
        >
          <RefreshCw className="size-4" />
          {state === 'idle' ? 'Carregar histórico' : 'Tentar histórico novamente'}
        </Button>}
      </Card.Header>
      <Card.Content>
        {state === 'idle' && (
          <p className="text-sm text-muted">
            Carregue o histórico somente quando precisar consultá-lo.
          </p>
        )}
        {state === 'loading' && values.length === 0 && (
          <output className="flex items-center gap-2 text-sm text-muted">
            <Spinner size="sm" />
            Consultando registros…
          </output>
        )}
        {state === 'empty' && (
          <p className="text-sm text-muted">Nenhuma ação humana foi registrada em {year ?? 'este ano'}.</p>
        )}
        {state === 'not-authorized' && (
          <p className="text-sm text-warning">Sua sessão não pode consultar o histórico.</p>
        )}
        {state === 'unavailable' && (
          <p className="text-sm text-danger">O histórico está temporariamente indisponível.</p>
        )}
        {values.length > 0 && (
          <ol className="grid gap-3">
            {values.map((item) => (
              <li key={item.id}>
                <Surface variant="secondary" className="rounded-xl border border-border/60 p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <Chip
                      size="sm"
                      variant="soft"
                      color={
                        item.action === IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.acknowledged
                          ? 'accent'
                          : 'default'
                      }
                    >
                      {item.actionLabel}
                    </Chip>
                    <Chip size="sm" variant="soft" color={item.current ? 'warning' : 'success'}>
                      {item.current ? 'Ainda pendente' : 'Fora das pendências'}
                    </Chip>
                    <span className="ml-auto text-xs text-muted">{instant(item.recordedAt)}</span>
                  </div>
                  <p className="mt-2 text-sm font-medium">
                    {DIAGNOSTIC_LABELS[item.code] ?? item.code}
                  </p>
                  <p className="mt-1 break-words text-xs text-muted">
                    {treatmentLocation(item) || item.fileName}
                  </p>
                  {item.note && (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.note}</p>
                  )}
                </Surface>
              </li>
            ))}
          </ol>
        )}
        {nextCursor !== null && (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              isDisabled={state === 'loading'}
              onPress={() => onLoad(nextCursor)}
            >
              Carregar mais registros
            </Button>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

export function RelationalCurrentAuditPageV2() {
  const year = useGradebookYear()?.year ?? null;
  const [state, setState] = useState<LoadState>('loading');
  const [items, setItems] = useState<readonly GradebookImportDiagnosticsAuditRecordV1[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [treatmentState, setTreatmentState] = useState<TreatmentState>('idle');
  const [treatments, setTreatments] = useState<readonly ImportDiagnosticTreatmentRecordV1[]>([]);
  const [busyTreatments, setBusyTreatments] = useState<ReadonlySet<number>>(() => new Set());
  const [feedback, setFeedback] = useState<Readonly<Record<number, string>>>({});
  const [historyState, setHistoryState] = useState<HistoryState>('idle');
  const [history, setHistory] = useState<readonly ImportDiagnosticTreatmentRecordV1[]>([]);
  const [draftFindings, setDraftFindings] = useState<ReadonlySet<number>>(() => new Set());
  const [stale, setStale] = useState(false);
  const [historyNextCursor, setHistoryNextCursor] =
    useState<ImportDiagnosticTreatmentHistoryCursorV1 | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const historyRequestRef = useRef<AbortController | null>(null);
  const draftFindingsRef = useRef<ReadonlySet<number>>(new Set());
  const treatmentRetryKeysRef = useRef(new Map<string, string>());

  const mergeTreatments = useCallback((incoming: readonly ImportDiagnosticTreatmentRecordV1[]) => {
    setTreatments((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      incoming.forEach((item) => byId.set(item.id, item));
      return [...byId.values()].sort((left, right) =>
        right.recordedAt.localeCompare(left.recordedAt),
      );
    });
  }, []);

  const loadTreatments = useCallback(
    async (
      findings: readonly GradebookImportDiagnosticsAuditRecordV1[],
      signal: AbortSignal,
      append = false,
    ) => {
      if (!append) setTreatments([]);
      if (findings.length === 0) {
        setTreatmentState('ready');
        return true;
      }
      setTreatmentState('loading');
      try {
        const response = await requestImportDiagnosticTreatmentV1(
          {
            contractVersion: IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1,
            operation: 'context',
            year: year!,
            findings: findings.map((item) => ({ fileName: item.fileName, key: item.key })),
          },
          signal,
        );
        if (signal.aborted) return;
        if (response.state !== 'ready' || response.operation !== 'context') {
          setTreatmentState(response.state === 'not-authorized' ? 'not-authorized' : 'unavailable');
          return false;
        }
        mergeTreatments(response.items);
        setTreatmentState('ready');
        return true;
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setTreatmentState('unavailable');
          return false;
        }
      }
    },
    [mergeTreatments, year],
  );

  const load = useCallback(async (background = false) => {
    requestRef.current?.abort();
    if (!background) {
      setLoadingMore(false); setItems([]); setNextOffset(null); setFeedback({});
    }
    if (year === null) {
      setState('loading');
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    if (!background) setState('loading');
    try {
      const response = await listGradebookImportDiagnosticsAuditV1(
        { academicYear: year, limit: PAGE_SIZE, offset: 0 },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (response.state === 'not-authorized') { setItems([]); setState('not-authorized'); return false; }
      if (response.state !== 'ready') {
        if (background) setStale(true);
        else setState('unavailable');
        return false;
      }
      if (background && draftFindingsRef.current.size > 0) return;
      setItems(response.items);
      setNextOffset(response.nextOffset);
      setState(response.items.length === 0 ? 'empty' : 'ready');
      const treatmentsLoaded = await loadTreatments(response.items, controller.signal);
      if (treatmentsLoaded !== true) {
        if (background && treatmentsLoaded === false) setStale(true);
        return treatmentsLoaded;
      }
      setStale(false);
      return true;
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        if (background) setStale(true); else setState('unavailable');
        return false;
      }
    }
  }, [loadTreatments, year]);

  const loadMore = useCallback(async () => {
    if (year === null || nextOffset === null || loadingMore) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadingMore(true);
    try {
      const response = await listGradebookImportDiagnosticsAuditV1(
        { academicYear: year, limit: PAGE_SIZE, offset: nextOffset },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (response.state !== 'ready') {
        setState(response.state === 'not-authorized' ? 'not-authorized' : 'unavailable');
        return;
      }
      setItems((current) => [...current, ...response.items]);
      setNextOffset(response.nextOffset);
      await loadTreatments(response.items, controller.signal, true);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setState('unavailable');
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [loadTreatments, loadingMore, nextOffset, year]);

  const recordTreatment = useCallback(
    async (
      value: GradebookImportDiagnosticsAuditRecordV1,
      action: ImportDiagnosticTreatmentActionV1,
      note: string | null,
    ): Promise<boolean> => {
      if (year === null) return false;
      const retryIdentity = `${value.id}\0${String(action)}\0${note ?? ''}`;
      const idempotencyKey =
        treatmentRetryKeysRef.current.get(retryIdentity) ??
        importDiagnosticTreatmentIdempotencyKeyV1();
      treatmentRetryKeysRef.current.set(retryIdentity, idempotencyKey);
      setBusyTreatments((current) => new Set(current).add(value.id));
      setFeedback((current) => ({ ...current, [value.id]: '' }));
      try {
        const response = await requestImportDiagnosticTreatmentV1({
          contractVersion: IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1,
          operation: 'record',
          year,
          diagnosticId: value.id,
          action,
          note,
          idempotencyKey,
        });
        if (response.state !== 'ready' || response.operation !== 'record') {
          if (response.state !== 'unavailable') treatmentRetryKeysRef.current.delete(retryIdentity);
          let message: 'O achado já saiu das pendências. Atualize a Auditoria.' | 'Sua sessão não pode registrar tratamento.' | 'Não foi possível registrar a ação. Tente novamente.';
          if (response.state === 'not-found') {
            message = 'O achado já saiu das pendências. Atualize a Auditoria.';
          } else if (response.state === 'not-authorized') {
            message = 'Sua sessão não pode registrar tratamento.';
          } else {
            message = 'Não foi possível registrar a ação. Tente novamente.';
          }
          setFeedback((current) => ({ ...current, [value.id]: message }));
          return false;
        }
        mergeTreatments([response.item]);
        treatmentRetryKeysRef.current.delete(retryIdentity);
        setTreatmentState('ready');
        if (historyState !== 'idle') {
          setHistory((current) => [
            response.item,
            ...current.filter((item) => item.id !== response.item.id),
          ]);
          setHistoryState('ready');
        }
        setFeedback((current) => ({
          ...current,
          [value.id]: 'Ação registrada e preservada no histórico.',
        }));
        return true;
      } catch {
        setFeedback((current) => ({
          ...current,
          [value.id]: 'Não foi possível registrar a ação. Tente novamente.',
        }));
        return false;
      } finally {
        setBusyTreatments((current) => {
          const next = new Set(current);
          next.delete(value.id);
          return next;
        });
      }
    },
    [historyState, mergeTreatments, year],
  );

  const loadHistory = useCallback(
    async (cursor: ImportDiagnosticTreatmentHistoryCursorV1 | null = null, background = false) => {
      if (year === null) return;
      historyRequestRef.current?.abort();
      const controller = new AbortController();
      historyRequestRef.current = controller;
      if (cursor === null && !background) {
        setHistory([]);
        setHistoryNextCursor(null);
      }
      if (!background) setHistoryState('loading');
      try {
        const response = await requestImportDiagnosticTreatmentV1(
          {
            contractVersion: IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1,
            operation: 'history',
            year,
            limit: IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1.historyPage,
            cursor,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (response.state !== 'ready' || response.operation !== 'history') {
          if (response.state === 'not-authorized') { setHistory([]); setHistoryState('not-authorized'); }
          else if (background) setStale(true); else setHistoryState('unavailable');
          return false;
        }
        if (background && draftFindingsRef.current.size > 0) return;
        setHistory((current) =>
          cursor === null ? response.items : [...current, ...response.items],
        );
        setHistoryNextCursor(response.nextCursor);
        setHistoryState(response.items.length === 0 && cursor === null ? 'empty' : 'ready');
        setStale(false);
        return true;
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          if (background) setStale(true); else setHistoryState('unavailable');
          return false;
        }
      }
    },
    [year],
  );

  useEffect(() => {
    void load();
    return () => {
      requestRef.current?.abort();
      historyRequestRef.current?.abort();
    };
  }, [load]);

  useLiveRefreshV1(async () => {
    const refreshed = await load(true);
    if (refreshed !== true) return refreshed;
    if ((historyState === 'ready' || historyState === 'empty') && draftFindings.size === 0)
      return loadHistory(null, true);
    return true;
  }, {
    domains: ['gradebook'], enabled: year !== null,
    canRefresh: () => state !== 'loading' && !loadingMore && busyTreatments.size === 0 && draftFindings.size === 0,
  });

  const treatmentsByFinding = useMemo(() => {
    const grouped = new Map<string, ImportDiagnosticTreatmentRecordV1[]>();
    treatments.forEach((item) => {
      const identity = findingIdentity(item);
      const existing = grouped.get(identity) ?? [];
      existing.push(item);
      grouped.set(identity, existing);
    });
    return grouped;
  }, [treatments]);
  const visibleItems = useMemo(
    () => (severity === 'all' ? items : items.filter((item) => item.severity === severity)),
    [items, severity],
  );
  const blocking = items.filter((item) => item.severity === 'blocking-error').length;
  const warnings = items.length - blocking;
  const sources = new Set(items.map((item) => item.fileName)).size;

  return (
    <div className="grid min-w-0 gap-6" aria-busy={state === 'loading' || loadingMore}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
            <ShieldAlert className="size-4" /> Auditoria atual
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">
            Pendências da fonte em linguagem escolar
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
            Achados atuais das planilhas do ano selecionado. A Auditoria explica e sugere; nenhuma correção é
            executada automaticamente.
          </p>
        </div>
        <Chip size="lg" variant="soft">
          Ano letivo {year ?? '—'}
        </Chip>
      </header>

      <Alert status="default">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Achado atual e histórico continuam separados</Alert.Title>
          <Alert.Description>
            Ao corrigir e reimportar a fonte, o problema sai das pendências. Reconhecimentos e
            anotações permanecem no histórico e nunca alteram notas ou escondem achados.
          </Alert.Description>
        </Alert.Content>
      </Alert>

      {state === 'loading' && (
        <output
          className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted"
        >
          <Spinner size="sm" /> Consultando achados atuais…
        </output>
      )}
      {(state === 'empty' || state === 'not-authorized' || state === 'unavailable') && (
        <StateAlert state={state} year={year} />
      )}
      <LiveReadNoticeV1 failed={stale} />

      {state === 'ready' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Card className="border border-sky-200/70 bg-sky-50/70 dark:border-sky-900/70 dark:bg-sky-950/25">
              <Card.Content className="p-4">
                <Clock3 className="size-5 text-sky-600" />
                <p className="mt-3 text-3xl font-semibold">{items.length}</p>
                <p className="text-xs text-muted">achados carregados nesta sessão</p>
              </Card.Content>
            </Card>
            <Card className="border border-rose-200/70 bg-rose-50/70 dark:border-rose-900/70 dark:bg-rose-950/25">
              <Card.Content className="p-4">
                <AlertTriangle className="size-5 text-rose-600" />
                <p className="mt-3 text-3xl font-semibold">{blocking}</p>
                <p className="text-xs text-muted">erros bloqueantes carregados</p>
              </Card.Content>
            </Card>
            <Card className="border border-amber-200/70 bg-amber-50/70 dark:border-amber-900/70 dark:bg-amber-950/25">
              <Card.Content className="p-4">
                <FileWarning className="size-5 text-amber-600" />
                <p className="mt-3 text-3xl font-semibold">{warnings}</p>
                <p className="text-xs text-muted">avisos carregados</p>
              </Card.Content>
            </Card>
            <Card className="border border-emerald-200/70 bg-emerald-50/70 dark:border-emerald-900/70 dark:bg-emerald-950/25">
              <Card.Content className="p-4">
                <CheckCircle2 className="size-5 text-emerald-600" />
                <p className="mt-3 text-3xl font-semibold">{sources}</p>
                <p className="text-xs text-muted">fontes representadas</p>
              </Card.Content>
            </Card>
          </div>

          {treatmentState === 'loading' && (
            <p className="text-xs text-muted"><output className="contents">
              Carregando o tratamento humano dos achados visíveis…
            </output></p>
          )}
          {treatmentState === 'unavailable' && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Tratamento temporariamente indisponível</Alert.Title>
                <Alert.Description>
                  Os achados atuais continuam somente leitura; nenhuma ação foi simulada.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}
          {treatmentState === 'not-authorized' && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Tratamento não autorizado</Alert.Title>
                <Alert.Description>
                  Sua sessão pode consultar os achados, mas não registrar ações.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}

          <Card>
            <Card.Header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <div className="mr-auto">
                <Card.Title>Pendências atuais</Card.Title>
                <Card.Description>
                  Filtro aplicado somente aos itens já carregados.
                </Card.Description>
              </div>
              <div
                className="flex flex-wrap gap-2"
                aria-label="Filtrar gravidade dos itens carregados"
              >
                {(
                  [
                    ['all', 'Todos'],
                    ['blocking-error', 'Bloqueantes'],
                    ['warning', 'Avisos'],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={severity === value ? 'primary' : 'outline'}
                    aria-pressed={severity === value}
                    onPress={() => setSeverity(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </Card.Header>
            <Card.Content>
              {visibleItems.length === 0 ? (
                <p className="text-sm text-muted">Nenhum item carregado corresponde ao filtro.</p>
              ) : (
                <ol className="relative ml-3 border-l border-border pl-6">
                  {visibleItems.map((item) => (
                    <Finding
                      key={item.id}
                      value={item}
                      treatments={treatmentsByFinding.get(findingIdentity(item)) ?? []}
                      treatmentState={treatmentState}
                      busy={busyTreatments.has(item.id)}
                      feedback={feedback[item.id] || null}
                      onRecord={recordTreatment}
                      onDraftChange={(id, dirty) =>
                        setDraftFindings((current) => {
                          const next = new Set(current);
                          if (dirty) next.add(id);
                          else next.delete(id);
                          draftFindingsRef.current = next;
                          return next;
                        })
                      }
                    />
                  ))}
                </ol>
              )}
              {nextOffset !== null && (
                <div className="mt-5 flex justify-center">
                  <Button
                    variant="secondary"
                    isPending={loadingMore}
                    isDisabled={loadingMore}
                    onPress={() => void loadMore()}
                  >
                    Carregar mais 50
                  </Button>
                </div>
              )}
            </Card.Content>
          </Card>
        </>
      )}

      {(state === 'ready' || state === 'empty') && (
        <TreatmentHistory
          year={year}
          state={historyState}
          values={history}
          nextCursor={historyNextCursor}
          onLoad={(offset) => void loadHistory(offset)}
        />
      )}
    </div>
  );
}
