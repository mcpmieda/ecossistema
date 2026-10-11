import { useCallback, useEffect, useRef, useState } from 'react';
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
import { StudentNameV1 } from '../shared/account-open-v1';
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

export function StudentReconciliationV1({
  client,
  scope,
  canWrite,
}: {
  client: ReconciliationClientV1;
  scope: ScopeV1;
  canWrite: boolean;
}) {
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
  const active = useRef<AbortController | null>(null);
  const detailRead = useRef<AbortController | null>(null);
  const classId = scope.kind === 'class' ? scope.classId : null;
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
        const result = await client.request(
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
          setError(cause instanceof Error ? cause.message : 'Consulta indisponível.');
        }
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    },
    [client, classId, query],
  );
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setItems([]);
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
  }, [client, load, refresh]);
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
        setError(cause instanceof Error ? cause.message : 'Consulta indisponível.');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
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
      if (result.state === 'committed') reload();
      else if (
        result.state === 'ready' &&
        (result.operation === 'prepare' || result.operation === 'activate-pending')
      )
        setPrepared(result);
      else {
        setError(reconciliationMessageV1(result));
        if (result.state === 'conflict' || result.state === 'expired') {
          setNotice(reconciliationMessageV1(result));
          reload();
        }
      }
    } catch {
      if (!active.current?.signal.aborted) setError('Resposta não confirmada. Tente novamente.');
    } finally {
      if (!active.current?.signal.aborted) setBusy(false);
    }
  }
  const back = () => {
    detailRead.current?.abort();
    setSelected(null);
    setDetail(null);
    setPrepared(null);
    setPendingBatch(null);
    setBusy(false);
  };
  return (
    <section className="space-y-4" aria-label="Alunos e conciliação">
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
              Nome exibido
              <select
                className="rounded-lg border border-default bg-surface p-2"
                aria-label="Fonte do nome exibido"
                value={context.nameSource}
                disabled={busy || !canWrite || Boolean(mutationRetry)}
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
      {error ? <p role="alert">{error}</p> : null}
      {notice && notice !== error ? <p role="alert">{notice}</p> : null}
      {mutationRetry && !busy ? (
        <Button variant="secondary" onPress={() => void mutate(mutationRetry)}>
          Repetir mesma solicitação
        </Button>
      ) : null}
      {busy ? <p role="status">Carregando…</p> : null}
      {selected ? (
        <Card>
          <Card.Content className="space-y-4">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy || Boolean(mutationRetry)}
              onPress={back}
            >
              Voltar aos alunos
            </Button>
            <h3 className="break-words text-lg font-semibold">{selected.name}</h3>
            {selected.kind === 'person' && selected.relationName !== selected.name ? (
              <p className="break-words text-sm">Relação: {selected.relationName}</p>
            ) : null}
            {selected.kind === 'person' && selected.accountId ? (
              <StudentNameV1
                accountId={selected.accountId}
                name={selected.name}
                parentScope={scope}
              >
                Acesso ao Portal
              </StudentNameV1>
            ) : null}
            {prepared ? (
              <PreparedReportV1
                key={prepared.batchId}
                client={client}
                prepared={prepared}
                decision={!pendingBatch}
                onCommitted={reload}
                onStale={reload}
              />
            ) : detail ? (
              <ReconciliationDetailV1
                detail={detail}
                selected={selected}
                canWrite={canWrite}
                busy={busy || Boolean(mutationRetry)}
                mutate={mutate}
              />
            ) : pendingBatch && catalog && context ? (
              <PendingBatchV1
                key={pendingBatch}
                batchId={pendingBatch}
                catalog={catalog}
                context={context}
                canWrite={canWrite}
                busy={busy || Boolean(mutationRetry)}
                mutate={mutate}
              />
            ) : null}
          </Card.Content>
        </Card>
      ) : (
        <>
          {items.length === 0 && !busy ? (
            <p className="text-sm text-muted">Nenhum aluno ou pendência encontrado.</p>
          ) : items.length ? (
            <Table variant="secondary">
              <Table.ScrollContainer tabIndex={0} role="region" aria-label="Alunos e pendências">
                <Table.Content aria-label="Alunos e pendências">
                  <Table.Header>
                    <Table.Column isRowHeader>Aluno</Table.Column>
                    <Table.Column>Turma</Table.Column>
                    <Table.Column>Conciliação</Table.Column>
                    <Table.Column>Portal / prazo</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {items.map((item) => (
                      <Table.Row
                        key={item.kind === 'person' ? item.studentUid : item.id}
                        id={item.kind === 'person' ? item.studentUid : item.id}
                      >
                        <Table.Cell>
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
                        <Table.Cell>
                          {item.kind === 'person'
                            ? stateLabelV1(item.reconciliation)
                            : stateLabelV1(item.reason)}
                        </Table.Cell>
                        <Table.Cell>
                          {item.kind === 'person' ? (
                            item.portal === 'with-portal' ? (
                              'Com Portal'
                            ) : (
                              'Sem Portal'
                            )
                          ) : item.expiresAt ? (
                            <span>
                              {item.warning ? 'Prazo próximo: ' : 'Até '}
                              {dateLabelV1(item.expiresAt)}
                              {item.warning ? '. Reenvie após a expiração.' : ''}
                            </span>
                          ) : (
                            '—'
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          ) : null}
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
              busy={busy || Boolean(mutationRetry)}
              mutate={mutate}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function ReconciliationDetailV1({
  detail,
  selected,
  canWrite,
  busy,
  mutate,
}: {
  detail: DetailV1;
  selected: ReconciliationListItemV1;
  canWrite: boolean;
  busy: boolean;
  mutate: (input: ReconciliationRequestV1) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{
    source: DetailV1['sources'][number];
    uid: string;
    action: 'associate' | 'reject' | 'separate' | 'release' | 'confirm';
  } | null>(null);
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
          {canWrite && !source.studentUid ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="max-w-full rounded-lg border border-default bg-surface p-2"
                aria-label={`Aluno da Relação para ${source.name}`}
                value={chosen[source.id] ?? ''}
                disabled={busy}
                onChange={(event) =>
                  setChosen((previous) => ({ ...previous, [source.id]: event.target.value }))
                }
              >
                <option value="">Escolha o aluno da Relação</option>
                {detail.candidates.map((candidate) => (
                  <option key={candidate.studentUid} value={candidate.studentUid}>
                    {candidate.name} — {candidate.classLabel}
                  </option>
                ))}
              </select>
              {(['associate', 'reject', 'release'] as const).map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant="secondary"
                  isDisabled={busy || !chosen[source.id]}
                  onPress={() => setConfirm({ source, uid: chosen[source.id]!, action })}
                >
                  {action === 'associate'
                    ? 'Vincular'
                    : action === 'reject'
                      ? 'Rejeitar'
                      : 'Liberar rejeição'}
                </Button>
              ))}
            </div>
          ) : canWrite && source.studentUid ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                isDisabled={busy}
                onPress={() => setConfirm({ source, uid: source.studentUid!, action: 'separate' })}
              >
                Separar
              </Button>
              {source.reviewRequired ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => setConfirm({ source, uid: source.studentUid!, action: 'confirm' })}
                >
                  Confirmar vínculo
                </Button>
              ) : null}
              {selected.kind === 'person' &&
              (source.observationId !== detail.selectedObservationId ||
                selected.reconciliation === 'pending' ||
                selected.reconciliation === 'review-required') ? (
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
          ) : null}
        </div>
      ))}
      {confirm ? (
        <div
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="reconciliation-confirm-title"
          className="space-y-3 rounded-xl border border-default p-4"
        >
          <h4 id="reconciliation-confirm-title" className="font-semibold">
            Confirmar{' '}
            {confirm.action === 'separate'
              ? 'separação'
              : confirm.action === 'reject'
                ? 'rejeição'
                : confirm.action === 'release'
                  ? 'liberação da rejeição'
                  : 'vínculo'}
            ?
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
            <Button variant="secondary" isDisabled={busy} onPress={() => setConfirm(null)}>
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
}: {
  batchId: string;
  catalog: CatalogV1;
  context: ReconciliationContextV1;
  canWrite: boolean;
  busy: boolean;
  mutate: (input: ReconciliationRequestV1) => Promise<void>;
}) {
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
}: {
  catalog: CatalogV1;
  context: ReconciliationContextV1;
  busy: boolean;
  mutate: (input: ReconciliationRequestV1) => Promise<void>;
}) {
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
