import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Button, Card, SearchField, Table } from '@heroui/react';
import type {
  ReconciliationContextV1,
  ReconciliationListItemV1,
  ReconciliationRequestV1,
  ReconciliationResponseV1,
  ReportClassLinkV1,
} from '../../../../shared/student-identity/reconciliation-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import {
  reconciliationMessageV1,
  reconciliationMutationV1,
  type PreparedReconciliationV1,
  type ReconciliationClientV1,
} from '../shared/reconciliation-client-v1';
import { AutomaticReportPanelV1 } from './automatic-report-v1';
import { StudentNameV1 } from '../shared/account-open-v1';
import { readReconciliationListV1 } from './reconciliation-list-read-v1';
import { PreparedReportV1 } from '../../gradebook/import/student-report-import-v1';

type CatalogV1 = Extract<ReconciliationResponseV1, { operation: 'catalog' }>;
type DetailV1 = Extract<ReconciliationResponseV1, { operation: 'detail' }>;
const statusV1: Record<string, string> = {
  'without-report': 'Sem registro Smecel',
  pending: 'Pendente',
  reconciled: 'Conciliado',
  'review-required': 'Revisão necessária',
  'missing-current-report': 'Ausente no relatório atual',
  awaiting_relation: 'Aguardando Relação',
  class_unlinked: 'Turma sem ligação',
  birth_conflict: 'Nascimento divergente',
  homonym: 'Homônimo',
  identity_conflict: 'Conferir identidade',
  source_conflict: 'Conferir matrícula',
  source_review: 'Revisão necessária',
  rejected: 'Associação rejeitada',
  sibling_candidate: 'Conferir identidade',
  no_match: 'Sem correspondência',
  profile_conflict: 'Escolher dados cadastrais',
};
const stateLabelV1 = (value: string) => statusV1[value] ?? 'Pendente';
const dateLabelV1 = (value: string) =>
  value.includes('T')
    ? new Date(value).toLocaleString('pt-BR')
    : value.split('-').reverse().join('/');

type MutateV1 = (input: ReconciliationRequestV1) => Promise<void>;
type DecisionActionV1 = 'associate' | 'reject' | 'separate' | 'release' | 'confirm';
const actionLabelV1 = {
  associate: 'Vincular',
  reject: 'Rejeitar',
  release: 'Liberar rejeição',
} as const;
const confirmNounV1: Record<DecisionActionV1, string> = {
  separate: 'separação',
  reject: 'rejeição',
  release: 'liberação da rejeição',
  associate: 'vínculo',
  confirm: 'vínculo',
};
const itemKeyV1 = (item: ReconciliationListItemV1) =>
  item.kind === 'person' ? item.studentUid : item.id;
const itemStateV1 = (item: ReconciliationListItemV1) =>
  stateLabelV1(item.kind === 'person' ? item.reconciliation : item.reason);

function focusVisibleV1(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
  element?.scrollIntoView?.({ block: 'nearest' });
}

function ReconciliationFeedbackV1({
  message,
  busy,
  focus,
}: Readonly<{ message: string; busy: boolean; focus: boolean }>) {
  const target = useRef<HTMLParagraphElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (focus && !busy && !focused.current) {
      focusVisibleV1(target.current);
      focused.current = true;
    }
  }, [busy, focus]);
  return (
    <p ref={target} role="alert" tabIndex={-1}>
      {message}
    </p>
  );
}

function PortalCellV1({ item }: Readonly<{ item: ReconciliationListItemV1 }>) {
  if (item.kind === 'person')
    return <>{item.portal === 'with-portal' ? 'Com Portal' : 'Sem Portal'}</>;
  if (!item.expiresAt) return <>—</>;
  return (
    <span>
      {item.warning ? 'Prazo próximo: ' : 'Até '}
      {dateLabelV1(item.expiresAt)}
      {item.warning ? '. Reenvie após a expiração.' : ''}
    </span>
  );
}

function ReconciliationListV1({
  items,
  busy,
  open,
  returnFocus,
  pendingOnly,
  hideEmpty,
}: Readonly<{
  items: readonly ReconciliationListItemV1[];
  busy: boolean;
  open: (item: ReconciliationListItemV1) => Promise<void>;
  returnFocus: RefObject<string | null>;
  pendingOnly: boolean;
  hideEmpty: boolean;
}>) {
  const [focusTarget, setFocusTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (focusTarget?.isConnected && returnFocus.current) {
      // Let the grid establish its focused cell before moving focus to its button.
      focusVisibleV1(focusTarget);
      returnFocus.current = null;
    }
  }, [focusTarget, returnFocus]);
  if (items.length === 0)
    return busy || hideEmpty ? null : (
      <p className="text-sm text-muted">
        {pendingOnly ? 'Nenhuma pendência encontrada.' : 'Nenhum aluno ou pendência encontrado.'}
      </p>
    );
  return (
    <Table variant="secondary">
      <Table.ScrollContainer
        tabIndex={0}
        role="region"
        aria-label={pendingOnly ? 'Pendências de conciliação' : 'Alunos e pendências'}
      >
        <Table.Content
          aria-label={pendingOnly ? 'Pendências de conciliação' : 'Alunos e pendências'}
        >
          <Table.Header>
            <Table.Column isRowHeader>Aluno</Table.Column>
            <Table.Column>Turma</Table.Column>
            <Table.Column>Conciliação</Table.Column>
            <Table.Column>Portal / prazo</Table.Column>
          </Table.Header>
          <Table.Body>
            {items.map((item) => (
              <Table.Row key={itemKeyV1(item)} id={itemKeyV1(item)}>
                <Table.Cell
                  focusMode="child"
                  ref={(element) => {
                    if (element && returnFocus.current === itemKeyV1(item)) {
                      setFocusTarget(element);
                    }
                  }}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto whitespace-normal text-left"
                    onPress={() => void open(item)}
                  >
                    <strong className="break-words">{item.name}</strong>
                  </Button>
                  {item.kind === 'person' && item.possibleSamePerson ? (
                    <p className="text-xs">Mesmo nome em outra turma</p>
                  ) : null}
                </Table.Cell>
                <Table.Cell>{item.classLabel ?? '—'}</Table.Cell>
                <Table.Cell>{itemStateV1(item)}</Table.Cell>
                <Table.Cell>
                  <PortalCellV1 item={item} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

export function StudentReconciliationV1({
  client,
  scope,
  canWrite,
  showPortalAccess = true,
  pendingOnly = false,
}: Readonly<{
  client: ReconciliationClientV1;
  scope: ScopeV1;
  canWrite: boolean;
  showPortalAccess?: boolean;
  pendingOnly?: boolean;
}>) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<ReconciliationListItemV1[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [context, setContext] = useState<ReconciliationContextV1 | null>(null);
  const [catalog, setCatalog] = useState<CatalogV1 | null>(null);
  const [detail, setDetail] = useState<DetailV1 | null>(null);
  const [selected, setSelected] = useState<ReconciliationListItemV1 | null>(null);
  const [prepared, setPrepared] = useState<PreparedReconciliationV1 | null>(null);
  const [pendingBatch, setPendingBatch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mutationRetry, setMutationRetry] = useState<ReconciliationRequestV1 | null>(null);
  const [notice, setNotice] = useState('');
  const [focusFeedback, setFocusFeedback] = useState(false);
  const active = useRef<AbortController | null>(null);
  const detailRead = useRef<AbortController | null>(null);
  const returnFocus = useRef<string | null>(null);
  const classId = scope.kind === 'class' ? scope.classId : null;
  const locked = busy || Boolean(mutationRetry);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const reload = useCallback(() => {
    setDetail(null);
    setSelected(null);
    setPrepared(null);
    setPendingBatch(null);
    setRefresh((value) => value + 1);
  }, []);
  const load = useCallback(
    async (next: string | null, signal: AbortSignal) => {
      setBusy(true);
      setError('');
      try {
        const result = await readReconciliationListV1(
          client,
          {
            contractVersion: 1,
            academicYear: 2026,
            operation: 'list',
            classId,
            search: query,
            cursor: next,
            limit: 50,
          },
          signal,
          pendingOnly,
        );
        signal.throwIfAborted();
        if (result.state !== 'ready' || result.operation !== 'list')
          throw new Error(reconciliationMessageV1(result));
        setContext(result.context);
        setItems((previous) => (next ? [...previous, ...result.items] : result.items));
        setCursor(result.nextCursor);
      } catch (cause) {
        if (!signal.aborted) {
          setItems([]);
          setCursor(null);
          setDetail(null);
          setSelected(null);
          setPendingBatch(null);
          setPrepared(null);
          setContext(null);
          setCatalog(null);
          setFocusFeedback(false);
          setError(cause instanceof Error ? cause.message : 'Consulta indisponível.');
        }
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    },
    [client, classId, query, pendingOnly],
  );
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setItems([]);
    if (pendingOnly) {
      setCursor(null);
      setContext(null);
    }
    setDetail(null);
    setSelected(null);
    setPendingBatch(null);
    setPrepared(null);
    void load(null, controller.signal);
    void client
      .request({ contractVersion: 1, academicYear: 2026, operation: 'catalog' }, controller.signal)
      .then((result) => {
        if (
          !controller.signal.aborted &&
          result.state === 'ready' &&
          result.operation === 'catalog'
        )
          setCatalog(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalog(null);
      });
    return () => {
      controller.abort();
      detailRead.current?.abort();
    };
  }, [client, load, refresh, pendingOnly]);
  async function open(item: ReconciliationListItemV1) {
    setNotice('');
    detailRead.current?.abort();
    setDetail(null);
    setSelected(item);
    setPrepared(null);
    setError('');
    setPendingBatch(null);
    if (item.kind === 'external' && !item.sourceId) {
      setPendingBatch(item.batchId);
      return;
    }
    const controller = new AbortController();
    detailRead.current = controller;
    setBusy(true);
    try {
      const result = await client.request(
        {
          contractVersion: 1,
          academicYear: 2026,
          operation: 'detail',
          ...(item.kind === 'person'
            ? { studentUid: item.studentUid }
            : { sourceId: item.sourceId! }),
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (result.state !== 'ready' || result.operation !== 'detail')
        throw new Error(reconciliationMessageV1(result));
      setDetail(result);
      setContext(result.context);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSelected(null);
        setFocusFeedback(true);
        setError(cause instanceof Error ? cause.message : 'Consulta indisponível.');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function settle(result: ReconciliationResponseV1) {
    if (result.state === 'committed') {
      reload();
      return;
    }
    if (
      result.state === 'ready' &&
      (result.operation === 'prepare' || result.operation === 'activate-pending')
    ) {
      setPrepared(result);
      return;
    }
    setFocusFeedback(true);
    if (result.state === 'conflict' || result.state === 'expired') {
      setNotice(reconciliationMessageV1(result));
      reload();
      return;
    }
    setError(reconciliationMessageV1(result));
  }
  async function mutate(request: ReconciliationRequestV1) {
    if (busy || (mutationRetry && mutationRetry !== request)) return;
    setBusy(true);
    setMutationRetry(request);
    setNotice('');
    setError('');
    try {
      const result = await client.request(request, active.current?.signal);
      setMutationRetry(null);
      settle(result);
    } catch {
      if (!active.current?.signal.aborted) {
        setFocusFeedback(true);
        setError('Resposta não confirmada. Tente novamente.');
      }
    } finally {
      if (!active.current?.signal.aborted) setBusy(false);
    }
  }
  const back = () => {
    returnFocus.current = selected ? itemKeyV1(selected) : null;
    detailRead.current?.abort();
    setSelected(null);
    setDetail(null);
    setPrepared(null);
    setPendingBatch(null);
    setBusy(false);
  };
  function selectedContent(current: ReconciliationListItemV1) {
    if (prepared)
      return (
        <PreparedReportV1
          key={prepared.batchId}
          client={client}
          prepared={prepared}
          decision={!pendingBatch}
          onCommitted={reload}
          onStale={reload}
        />
      );
    if (detail)
      return (
        <ReconciliationDetailV1
          detail={detail}
          selected={current}
          canWrite={canWrite}
          busy={locked}
          mutate={mutate}
        />
      );
    if (pendingBatch && catalog && context)
      return (
        <PendingBatchV1
          key={pendingBatch}
          batchId={pendingBatch}
          catalog={catalog}
          context={context}
          canWrite={canWrite}
          busy={locked}
          mutate={mutate}
        />
      );
    return null;
  }
  function selectedCard(current: ReconciliationListItemV1) {
    return (
      <Card>
        <Card.Content className="space-y-4">
          <Button size="sm" variant="secondary" isDisabled={locked} onPress={back}>
            Voltar aos alunos
          </Button>
          <h3 ref={focusVisibleV1} tabIndex={-1} className="break-words text-lg font-semibold">
            {current.name}
          </h3>
          {current.kind === 'person' && current.relationName !== current.name ? (
            <p className="break-words text-sm">Relação: {current.relationName}</p>
          ) : null}
          {showPortalAccess && current.kind === 'person' && current.accountId ? (
            <StudentNameV1 accountId={current.accountId} name={current.name} parentScope={scope}>
              Acesso ao Portal
            </StudentNameV1>
          ) : null}
          {selectedContent(current)}
        </Card.Content>
      </Card>
    );
  }
  function listSection() {
    return (
      <>
        {pendingOnly && context && !error ? (
          <p className="text-sm text-muted">
            <output className="contents">
              {items.length} {items.length === 1 ? 'pendência carregada' : 'pendências carregadas'}
            </output>
          </p>
        ) : null}
        <ReconciliationListV1
          items={items}
          busy={busy}
          open={open}
          returnFocus={returnFocus}
          pendingOnly={pendingOnly}
          hideEmpty={pendingOnly && (Boolean(error) || context === null)}
        />
        {cursor ? (
          <Button
            variant="secondary"
            isPending={busy}
            onPress={() => {
              if (active.current) void load(cursor, active.current.signal);
            }}
          >
            Carregar mais
          </Button>
        ) : null}
        {catalog && canWrite ? (
          <ClassLinksV1
            catalog={catalog}
            context={context ?? catalog.context}
            busy={locked}
            mutate={mutate}
          />
        ) : null}
      </>
    );
  }
  return (
    <section
      className="space-y-4"
      aria-label={pendingOnly ? 'Conciliação' : 'Alunos e conciliação'}
    >
      {pendingOnly ? <AutomaticReportPanelV1 client={client} refresh={refresh} /> : null}
      <Card>
        <Card.Content className="flex flex-wrap items-center gap-3">
          <SearchField
            aria-label="Buscar aluno ou pendência"
            value={search}
            onChange={setSearch}
            className="min-w-48 flex-1"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input maxLength={200} placeholder="Buscar aluno" />
              <SearchField.ClearButton aria-label="Limpar busca" />
            </SearchField.Group>
          </SearchField>
          <Button variant="secondary" isDisabled={busy} onPress={reload}>
            Atualizar
          </Button>
          {context ? (
            <label className="flex items-center gap-2 text-sm">
              <span>Nome exibido</span>
              <select
                className="rounded-lg border border-default bg-surface p-2"
                aria-label="Fonte do nome exibido"
                value={context.nameSource}
                disabled={locked || !canWrite}
                onChange={(event) =>
                  void mutate({
                    ...reconciliationMutationV1(context),
                    operation: 'name-source',
                    nameSource: event.target.value as 'relation' | 'report',
                  })
                }
              >
                <option value="report">Relatório</option>
                <option value="relation">Relação</option>
              </select>
            </label>
          ) : null}
        </Card.Content>
      </Card>
      {error || notice ? (
        <ReconciliationFeedbackV1
          key={error || notice}
          message={error || notice}
          busy={busy}
          focus={focusFeedback}
        />
      ) : null}
      {mutationRetry && !busy ? (
        <Button variant="secondary" onPress={() => void mutate(mutationRetry)}>
          Repetir mesma solicitação
        </Button>
      ) : null}
      {busy ? <output className="block">Carregando…</output> : null}
      {selected ? selectedCard(selected) : listSection()}
    </section>
  );
}

interface PendingConfirmationV1 {
  readonly source: DetailV1['sources'][number];
  readonly uid: string;
  readonly action: DecisionActionV1;
}

function SourceActionsV1({
  detail,
  selected,
  source,
  busy,
  choice,
  onChoice,
  onConfirm,
  mutate,
}: Readonly<{
  detail: DetailV1;
  selected: ReconciliationListItemV1;
  source: DetailV1['sources'][number];
  busy: boolean;
  choice: string;
  onChoice: (studentUid: string) => void;
  onConfirm: (confirmation: PendingConfirmationV1, trigger: Element) => void;
  mutate: MutateV1;
}>) {
  const linkedUid = source.studentUid;
  const choiceDescriptionId = useId();
  const candidate = detail.candidates.find((item) => item.studentUid === choice);
  if (!linkedUid)
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select
          className="max-w-full rounded-lg border border-default bg-surface p-2"
          aria-label={`Aluno da Relação para ${source.name}`}
          aria-describedby={candidate ? choiceDescriptionId : undefined}
          value={choice}
          disabled={busy}
          onChange={(event) => onChoice(event.target.value)}
        >
          <option value="">Escolha o aluno da Relação</option>
          {detail.candidates.map((candidate) => (
            <option key={candidate.studentUid} value={candidate.studentUid}>
              {candidate.name} — {candidate.classLabel}
            </option>
          ))}
        </select>
        {candidate ? (
          <p
            id={choiceDescriptionId}
            className="w-full min-w-0 break-words text-sm"
            aria-live="polite"
          >
            {candidate.name} - {candidate.classLabel}
          </p>
        ) : null}
        {(['associate', 'reject', 'release'] as const).map((action) => (
          <Button
            key={action}
            size="sm"
            variant="secondary"
            isDisabled={busy || !choice}
            onPress={(event) => onConfirm({ source, uid: choice, action }, event.target)}
          >
            {actionLabelV1[action]}
          </Button>
        ))}
      </div>
    );
  const canSelectData =
    selected.kind === 'person' &&
    (source.observationId !== detail.selectedObservationId ||
      selected.reconciliation === 'pending' ||
      selected.reconciliation === 'review-required');
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="secondary"
        isDisabled={busy}
        onPress={(event) => onConfirm({ source, uid: linkedUid, action: 'separate' }, event.target)}
      >
        Separar
      </Button>
      {source.reviewRequired ? (
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy}
          onPress={(event) =>
            onConfirm({ source, uid: linkedUid, action: 'confirm' }, event.target)
          }
        >
          Confirmar vínculo
        </Button>
      ) : null}
      {canSelectData && selected.kind === 'person' ? (
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy || source.reviewRequired}
          onPress={() =>
            void mutate({
              ...reconciliationMutationV1(detail.context),
              operation: 'select-observation',
              studentUid: selected.studentUid,
              observationId: source.observationId,
            })
          }
        >
          Usar estes dados
        </Button>
      ) : null}
    </div>
  );
}

function ReconciliationDetailV1({
  detail,
  selected,
  canWrite,
  busy,
  mutate,
}: Readonly<{
  detail: DetailV1;
  selected: ReconciliationListItemV1;
  canWrite: boolean;
  busy: boolean;
  mutate: MutateV1;
}>) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<PendingConfirmationV1 | null>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  function cancelConfirmation() {
    setConfirm(null);
    focusVisibleV1(confirmationTrigger.current);
  }
  return (
    <>
      {detail.sources.length === 0 ? <p>Sem registro Smecel.</p> : null}
      {detail.sources.map((source) => (
        <div key={source.id} className="space-y-3 rounded-xl border border-default p-4">
          <strong className="break-words">
            {source.name} — {source.classLabel}
          </strong>
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt>Nascimento</dt>
              <dd>{dateLabelV1(source.birthDate)}</dd>
            </div>
            <div>
              <dt>Filiação 1</dt>
              <dd className="break-words">{source.filiation1 ?? '—'}</dd>
            </div>
            <div>
              <dt>INEP</dt>
              <dd>{source.inep ?? '—'}</dd>
            </div>
          </dl>
          {canWrite ? (
            <SourceActionsV1
              detail={detail}
              selected={selected}
              source={source}
              busy={busy}
              choice={chosen[source.id] ?? ''}
              onChoice={(uid) => setChosen((previous) => ({ ...previous, [source.id]: uid }))}
              onConfirm={(confirmation, trigger) => {
                confirmationTrigger.current = trigger instanceof HTMLElement ? trigger : null;
                setConfirm(confirmation);
              }}
              mutate={mutate}
            />
          ) : null}
        </div>
      ))}
      {confirm ? (
        <div // NOSONAR an alert dialog closes with Escape (WAI-ARIA dialog pattern)
          ref={focusVisibleV1}
          tabIndex={-1}
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="reconciliation-confirm-title"
          className="space-y-3 rounded-xl border border-default p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              event.stopPropagation();
              cancelConfirmation();
            }
          }}
        >
          <h4 id="reconciliation-confirm-title" className="font-semibold">
            Confirmar {confirmNounV1[confirm.action]}?
          </h4>
          <p className="break-words">
            {confirm.source.name} — {confirm.source.classLabel}
          </p>
          <div className="flex gap-2">
            <Button
              isDisabled={busy}
              onPress={() => {
                const command = {
                  ...reconciliationMutationV1(detail.context),
                  operation: 'resolve' as const,
                  sourceId: confirm.source.id,
                  studentUid: confirm.uid,
                  action: confirm.action,
                  expectedLinkVersion: confirm.source.version,
                  revertsDecisionId:
                    confirm.action === 'separate' ? confirm.source.decisionId : null,
                };
                setConfirm(null);
                void mutate(command);
              }}
            >
              Confirmar
            </Button>
            <Button variant="secondary" isDisabled={busy} onPress={cancelConfirmation}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
      {detail.history.length ? (
        <details>
          <summary className="cursor-pointer text-sm">Histórico de decisões</summary>
          <ul className="mt-3 space-y-2 text-sm">
            {detail.history.map((entry) => (
              <li key={entry.id}>
                {dateLabelV1(entry.at)} — {entry.action}: {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function PendingBatchV1({
  batchId,
  catalog,
  context,
  canWrite,
  busy,
  mutate,
}: Readonly<{
  batchId: string;
  catalog: CatalogV1;
  context: ReconciliationContextV1;
  canWrite: boolean;
  busy: boolean;
  mutate: MutateV1;
}>) {
  const [links, setLinks] = useState<ReportClassLinkV1[]>(() =>
    catalog.reportClasses
      .filter((item) => item.id.startsWith(`pending:${batchId}:`))
      .map((item) => ({
        classLabel: item.label,
        shift: item.shift,
        stageLabel: item.stageLabel,
        gradebookClassId: item.classId,
        confirmRegular: false,
      })),
  );
  return (
    <div className="space-y-3">
      <p>Aguardando confirmação das turmas.</p>
      {links.map((link, index) => (
        <label
          key={`${link.classLabel}:${link.shift}`}
          className="flex flex-wrap items-center gap-3 text-sm"
        >
          <strong className="min-w-44 flex-1">{link.classLabel}</strong>
          <select
            aria-label={`Ligação de ${link.classLabel}`}
            className="rounded-lg border border-default bg-surface p-2"
            value={link.gradebookClassId ?? ''}
            disabled={!canWrite || busy || !context.relationAvailable}
            onChange={(event) =>
              setLinks((previous) =>
                previous.map((item, at) =>
                  at === index
                    ? {
                        ...item,
                        gradebookClassId: event.target.value ? Number(event.target.value) : null,
                      }
                    : item,
                ),
              )
            }
          >
            <option value="">Sem ligação</option>
            {catalog.classes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <Button
        isDisabled={
          !canWrite ||
          busy ||
          !context.relationAvailable ||
          !links.some((item) => item.gradebookClassId !== null)
        }
        onPress={() =>
          void mutate({
            ...reconciliationMutationV1(context),
            operation: 'activate-pending',
            batchId,
            classLinks: links,
          })
        }
      >
        Confirmar turmas e preparar
      </Button>
    </div>
  );
}

function ClassLinksV1({
  catalog,
  context,
  busy,
  mutate,
}: Readonly<{
  catalog: CatalogV1;
  context: ReconciliationContextV1;
  busy: boolean;
  mutate: MutateV1;
}>) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const activeClasses = catalog.reportClasses.filter((item) => !item.id.startsWith('pending:'));
  if (!activeClasses.length) return null;
  return (
    <details>
      <summary className="cursor-pointer text-sm">Ligações de turmas</summary>
      <div className="mt-3 space-y-3">
        {activeClasses.map((source) => (
          <div key={source.id} className="flex flex-wrap items-center gap-2">
            <strong className="min-w-44 flex-1">{source.label}</strong>
            <select
              className="rounded-lg border border-default bg-surface p-2"
              aria-label={`Alterar ligação de ${source.label}`}
              value={edits[source.id] ?? String(source.classId ?? '')}
              disabled={busy}
              onChange={(event) =>
                setEdits((previous) => ({ ...previous, [source.id]: event.target.value }))
              }
            >
              <option value="">Sem ligação</option>
              {catalog.classes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={
                busy ||
                edits[source.id] === undefined ||
                edits[source.id] === String(source.classId ?? '')
              }
              onPress={() =>
                void mutate({
                  ...reconciliationMutationV1(context),
                  operation: 'class-link',
                  reportClassId: source.id,
                  gradebookClassId: edits[source.id] ? Number(edits[source.id]) : null,
                })
              }
            >
              Salvar ligação
            </Button>
            {source.reviewRequired ? <span className="text-sm">Revisão necessária</span> : null}
          </div>
        ))}
      </div>
    </details>
  );
}
