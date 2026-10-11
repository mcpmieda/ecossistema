import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Surface } from '@heroui/react';
import type {
  ReconciliationResponseV1,
  ReconciliationRequestV1,
  ReconciliationValidationErrorV1,
  ReportClassLinkV1,
} from '../../../../shared/student-identity/reconciliation-v1';
import { normalizeStudentNameV1 } from '../../../../shared/student-identity/reconciliation-normalization-v1';
import {
  createReconciliationActivationV1,
  createReconciliationClientV1,
  reconciliationMessageV1,
  reconciliationMutationV1,
  type PreparedReconciliationV1,
  type ReconciliationClientV1,
} from '../../student-portal-admin/shared/reconciliation-client-v1';
import { loadSheetJs } from './sheetjs-loader';
import { readStudentReportV1, type ReadStudentReportV1 } from './student-report-reader-v1';

type CatalogV1 = Extract<ReconciliationResponseV1, { operation: 'catalog' }>;
const defaultClient = createReconciliationClientV1();

export function ReportValidationErrorsV1({
  errors,
}: {
  errors: readonly ReconciliationValidationErrorV1[];
}) {
  return (
    <Alert status="danger">
      <Alert.Content>
        <Alert.Title>Relatório não importado.</Alert.Title>
        <ul className="my-3 space-y-2">
          {errors.map((error, index) => (
            <li key={`${error.sourceRow}:${error.field}:${index}`} className="break-words">
              <strong>
                {error.name} — {error.classLabel}
              </strong>
              : {error.reason}
              <span className="ml-2 text-xs text-muted">Linha {error.sourceRow}</span>
            </li>
          ))}
        </ul>
        <p>Corrija no Smecel e reenvie.</p>
      </Alert.Content>
    </Alert>
  );
}

export function PreparedReportV1({
  prepared,
  client,
  onCommitted,
  onStale,
  decision = false,
}: {
  prepared: PreparedReconciliationV1;
  client: ReconciliationClientV1;
  onCommitted: () => void;
  onStale?: () => void;
  decision?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState('');
  const activation = useRef<ReturnType<typeof createReconciliationActivationV1> | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const expired = Date.parse(prepared.expiresAt) <= Date.now();
  const awaiting = prepared.batchState === 'awaiting_relation';
  async function apply() {
    if (busy || awaiting || expired) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    activation.current ??= createReconciliationActivationV1(prepared, confirmed);
    try {
      const result = await activation.current(client, setRemaining, controller.signal);
      if (result.state === 'committed') onCommitted();
      else {
        setError(reconciliationMessageV1(result));
        if (result.state === 'conflict' || result.state === 'expired') onStale?.();
      }
    } catch {
      if (!controller.signal.aborted) setError('Resposta não confirmada. Tente novamente.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <Surface
      variant="secondary"
      className="mt-4 space-y-4 rounded-2xl p-4"
      aria-label={decision ? 'Conferência da decisão' : 'Conferência do relatório'}
    >
      <p role="status">
        {awaiting ? 'Aguardando Relação' : decision ? 'Decisão preparada' : 'Relatório preparado'} —{' '}
        {prepared.counts.rows} registros.
      </p>
      <p className="text-sm">
        {prepared.counts.linked} conciliados · {prepared.counts.pending} pendentes
      </p>
      <p className="text-sm">Prazo: {new Date(prepared.expiresAt).toLocaleString('pt-BR')}</p>
      {prepared.differences.length > 0 ? (
        <ul className="list-inside list-disc space-y-1 text-sm">
          {prepared.differences.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}
      {!awaiting && prepared.differences.length > 0 ? (
        <Checkbox
          isSelected={confirmed}
          isDisabled={busy || activation.current !== null}
          onChange={setConfirmed}
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <span>{decision ? 'Conferi as alterações' : 'Conferi as alterações do relatório'}</span>
          </Checkbox.Content>
        </Checkbox>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {expired ? <p role="alert">Prazo encerrado. Prepare novamente.</p> : null}
      {!awaiting ? (
        <Button
          isPending={busy}
          isDisabled={expired || (!confirmed && prepared.differences.length > 0)}
          onPress={() => void apply()}
        >
          {busy
            ? remaining === null
              ? 'Preparando…'
              : `Preparando atualização: ${remaining} restantes`
            : decision
              ? 'Confirmar decisão'
              : 'Aplicar relatório'}
        </Button>
      ) : (
        <p className="text-sm">
          Envie a Relação e confirme as turmas na aba Alunos antes do prazo.
        </p>
      )}
    </Surface>
  );
}

export function StudentReportImportV1({
  file,
  onClose,
  client = defaultClient,
}: {
  file: File;
  onClose: () => void;
  client?: ReconciliationClientV1;
}) {
  const [data, setData] = useState<{ report: ReadStudentReportV1; catalog: CatalogV1 } | null>(
    null,
  );
  const [links, setLinks] = useState<ReportClassLinkV1[]>([]);
  const [confirmYear, setConfirmYear] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<ReconciliationValidationErrorV1[]>([]);
  const [prepared, setPrepared] = useState<PreparedReconciliationV1 | null>(null);
  const [done, setDone] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const preparedRequest = useRef<{ signature: string; request: ReconciliationRequestV1 } | null>(
    null,
  );
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    setData(null);
    setPrepared(null);
    setDone(false);
    setConfirmYear(false);
    setError('');
    setErrors([]);
    setBusy(true);
    preparedRequest.current = null;
    async function load() {
      try {
        const [xlsx, catalog] = await Promise.all([
          loadSheetJs(),
          client.request(
            { contractVersion: 1, academicYear: 2026, operation: 'catalog' },
            current.signal,
          ),
        ]);
        if (catalog.state !== 'ready' || catalog.operation !== 'catalog')
          throw new Error(reconciliationMessageV1(catalog));
        const report = await readStudentReportV1(file, xlsx);
        current.signal.throwIfAborted();
        setData({ report, catalog });
        setLinks(
          report.classes.map((entry) => {
            const known = catalog.reportClasses.find(
              (item) =>
                item.label === entry.classLabel &&
                item.shift === entry.shift &&
                item.stageLabel === entry.stageLabel &&
                !item.reviewRequired,
            );
            return {
              classLabel: entry.classLabel,
              shift: entry.shift,
              stageLabel: entry.stageLabel,
              gradebookClassId: known?.classId ?? null,
              confirmRegular: false,
            };
          }),
        );
      } catch (cause) {
        if (!current.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Não foi possível ler o relatório.');
      } finally {
        if (!current.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => current.abort();
  }, [file, client]);
  const suggestions = useMemo(
    () =>
      data?.report.classes.map((entry) => {
        if (entry.classification.kind !== 'regular') return null;
        const code = normalizeStudentNameV1(entry.classLabel).split(' ')[0];
        const stage = entry.classification.stage;
        const matches = data.catalog.classes.filter(
          (item) => normalizeStudentNameV1(item.label) === code && item.stage === stage,
        );
        return matches.length === 1 ? matches[0]! : null;
      }) ?? [],
    [data],
  );
  async function prepare() {
    if (!data || busy) return;
    setBusy(true);
    setError('');
    setErrors([]);
    try {
      const signature = JSON.stringify([data.catalog.context, links, confirmYear]);
      if (preparedRequest.current?.signature !== signature)
        preparedRequest.current = {
          signature,
          request: {
            ...reconciliationMutationV1(data.catalog.context),
            operation: 'prepare',
            normalizationVersion: 1,
            sourceFormat: 'smecel-report-v1',
            date1904: data.report.date1904,
            sourceYear: data.report.sourceYear,
            confirmYear,
            sourceGeneratedAt: null,
            rows: data.report.rows,
            classLinks: links,
          },
        };
      const result = await client.request(
        preparedRequest.current.request,
        controller.current?.signal,
      );
      if (result.state === 'validation-failed') setErrors(result.errors);
      else if (
        result.state === 'ready' &&
        (result.operation === 'prepare' || result.operation === 'activate-pending')
      )
        setPrepared(result);
      else if (result.state === 'conflict' || result.state === 'expired') await refreshCatalog();
      else setError(reconciliationMessageV1(result));
    } catch {
      if (!controller.current?.signal.aborted)
        setError('Resposta não confirmada. Tente novamente.');
    } finally {
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  }
  async function refreshCatalog() {
    setPrepared(null);
    setError('A lista mudou. Confira as turmas e prepare novamente.');
    setBusy(true);
    try {
      const catalog = await client.request(
        { contractVersion: 1, academicYear: 2026, operation: 'catalog' },
        controller.current?.signal,
      );
      if (catalog.state !== 'ready' || catalog.operation !== 'catalog')
        throw new Error(reconciliationMessageV1(catalog));
      if (!controller.current?.signal.aborted)
        setData((previous) => (previous ? { ...previous, catalog } : null));
    } catch {
      if (!controller.current?.signal.aborted) {
        setData(null);
        setError('Consulta indisponível. Reabra o relatório.');
      }
    } finally {
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="mt-6 space-y-4 border-t border-default pt-5"
      aria-label="Relatório de alunos"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">Relatório</h3>
        <Button variant="ghost" size="sm" isDisabled={busy} onPress={onClose}>
          Fechar
        </Button>
      </div>
      {busy ? <p role="status">Lendo e preparando relatório…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {errors.length ? <ReportValidationErrorsV1 errors={errors} /> : null}
      {done ? (
        <p role="status">Relatório aplicado.</p>
      ) : prepared ? (
        <PreparedReportV1
          key={prepared.batchId}
          prepared={prepared}
          client={client}
          onCommitted={() => {
            setPrepared(null);
            setDone(true);
          }}
          onStale={() => void refreshCatalog()}
        />
      ) : data ? (
        <>
          <div className="space-y-3" role="group" aria-label="Ligação de turmas">
            {links.map((link, index) => (
              <div
                className="flex flex-wrap items-center gap-3 rounded-xl border border-default p-3"
                key={data.report.classes[index]!.key}
              >
                <strong className="min-w-44 flex-1 break-words">{link.classLabel}</strong>
                {data.catalog.context.relationAvailable ? (
                  <label className="flex flex-col gap-1 text-sm">
                    Turma da Relação
                    <select
                      className="rounded-lg border border-default bg-surface p-2"
                      aria-label={`Turma da Relação para ${link.classLabel}`}
                      value={link.gradebookClassId ?? ''}
                      disabled={busy}
                      onChange={(event) =>
                        setLinks((previous) =>
                          previous.map((item, at) =>
                            at === index
                              ? {
                                  ...item,
                                  gradebookClassId: event.target.value
                                    ? Number(event.target.value)
                                    : null,
                                  confirmRegular: false,
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      <option value="">Sem ligação</option>
                      {data.catalog.classes.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="text-sm">Aguardando Relação</span>
                )}
                {suggestions[index] && link.gradebookClassId === null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={busy}
                    onPress={() =>
                      setLinks((previous) =>
                        previous.map((item, at) =>
                          at === index
                            ? { ...item, gradebookClassId: suggestions[index]!.id }
                            : item,
                        ),
                      )
                    }
                  >
                    Ligar a {suggestions[index]!.label}
                  </Button>
                ) : null}
                {data.report.classes[index]!.classification.kind === 'unknown' ? (
                  <Checkbox
                    isSelected={link.confirmRegular}
                    isDisabled={busy || link.gradebookClassId === null}
                    onChange={(value) =>
                      setLinks((previous) =>
                        previous.map((item, at) =>
                          at === index ? { ...item, confirmRegular: value } : item,
                        ),
                      )
                    }
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <span>Confirmo turma regular</span>
                    </Checkbox.Content>
                  </Checkbox>
                ) : null}
              </div>
            ))}
          </div>
          {data.report.sourceYear === null ? (
            <Checkbox isSelected={confirmYear} isDisabled={busy} onChange={setConfirmYear}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span>Confirmo o ano de 2026</span>
              </Checkbox.Content>
            </Checkbox>
          ) : null}
          <Button
            isPending={busy}
            isDisabled={data.report.sourceYear === null && !confirmYear}
            onPress={() => void prepare()}
          >
            Preparar relatório
          </Button>
        </>
      ) : null}
    </section>
  );
}
