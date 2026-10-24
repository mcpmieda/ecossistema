import { StudentNameV1 } from '../shared/account-open-v1';
import { StudentPresenceV1 } from './student-presence-v1';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertDialog, Button, Card, Chip, Table, Tooltip } from '@heroui/react';
import type { AdminReadResponseV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';
import { AccountsErrorV1 } from '../accounts/accounts-presentation-v1';
import { OperationsScopeV1 } from '../overview/operations-scope-v1';
import {
  operationDateV1,
  authorizationLostV1,
  type OperationsPropsV1,
} from '../overview/operations-values-v1';
import { useContinuousReadV1, ContinuousEndV1 } from '../shared/continuous-read-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { StudentAvatarV1 } from '../shared/student-avatar-v1';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { LiveRefreshScopeV1 } from '../../../shared/live-data/live-refresh-scope-v1';
import {
  createSessionMutationV1,
  type RevokeCommandV1,
  type SessionMutationStateV1,
} from './session-mutation-v1';

type SessionsPageV2 = Extract<AdminReadResponseV2, { state: 'sessions-read' }>;
type SessionRowV2 = SessionsPageV2['items'][number];
const labels = {
  valid: 'Ativa',
  expired: 'Expirou',
  revoked: 'Encerrada',
  unavailable: 'Sem acesso',
} as const;
export function StudentSessionsV1(props: Readonly<OperationsPropsV1>) {
  return (
    <OperationsScopeV1 {...props}>
      {(scope, label, onAuthorizationLost) => (
        <SessionsBodyV1
          key={props.identityKey + settingsScopeKeyV1(scope) + props.canWrite}
          {...props}
          scope={scope}
          scopeLabel={label}
          onAuthorizationLost={onAuthorizationLost}
        />
      )}
    </OperationsScopeV1>
  );
}
function SessionsBodyV1(props: Readonly<OperationsPropsV1>) {
  const parentScope = props.scope;
  const [revision, setRevision] = useState(0);
  const [mutation, setMutation] = useState<SessionMutationStateV1>({ state: 'idle' });
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<PortalClientErrorV1 | null>(null);
  const [prepareRetryAt, setPrepareRetryAt] = useState(0);
  const [review, setReview] = useState<{
    command: RevokeCommandV1;
    label: string;
    count: number;
    at: string;
  } | null>(null);
  const [clock, setClock] = useState(Date.now);
  const pendingReview = useRef<AbortController | null>(null);
  const returnFocus = useRef<Element | null>(null);
  const scopeKey = settingsScopeKeyV1(props.scope);
  const load = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const data = await props.reader.query(
        {
          contractVersion: 2,
          operation: 'sessions-read',
          sessionView: 'active',
          scope: props.scope,
          page: { limit: 100, ...(cursor ? { cursor } : {}) },
        },
        signal,
      );
      if (
        data.state !== 'sessions-read' ||
        data.sessionView !== 'active' ||
        data.items.some((item) => item.validity !== 'valid') ||
        settingsScopeKeyV1(data.scope) !== scopeKey ||
        new Set(data.items.map((s) => s.sessionId)).size !== data.items.length ||
        (parentScope.kind === 'account' &&
          data.items.some((s) => s.accountId !== parentScope.accountId.toLowerCase()))
      )
        throw new PortalClientErrorV1('invalid-response');
      return data;
    },
    [props.reader, scopeKey, revision],
  );
  const read = useContinuousReadV1(load, 'sessionId', props.onAuthorizationLost, true, false);
  const operation = useMemo(
    () => createSessionMutationV1(props.client, props.canWrite, setMutation),
    [props.client, props.canWrite],
  );
  useEffect(
    () => () => {
      operation.clear();
      pendingReview.current?.abort();
    },
    [operation],
  );
  useEffect(() => {
    if (mutation.state === 'committed') {
      read.clear();
      setRevision((v) => v + 1);
    }
    if (mutation.state === 'error' && authorizationLostV1(mutation.error))
      props.onAuthorizationLost?.(mutation.error);
  }, [mutation]);
  useEffect(() => {
    if (mutation.state !== 'error' && !prepareError) return;
    setClock(Date.now());
    const deadline = Math.max(prepareRetryAt, mutation.state === 'error' ? mutation.retryAt : 0);
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [mutation, prepareError, prepareRetryAt]);
  const data = read.state.state === 'ready' ? read.state.data : null;
  const busy =
    clock < prepareRetryAt ||
    preparing ||
    !!review ||
    mutation.state === 'pending' ||
    (mutation.state === 'error' && mutation.retryable);
  function cancelReview() {
    pendingReview.current?.abort();
    pendingReview.current = null;
    setPreparing(false);
    setReview(null);
    requestAnimationFrame(() => {
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    });
  }
  async function prepare(scope: ScopeV1, label: string, sessionId?: string) {
    if (!props.canWrite || busy || scope.kind === 'school') return;
    returnFocus.current = document.activeElement;
    const controller = new AbortController();
    pendingReview.current?.abort();
    pendingReview.current = controller;
    setPreparing(true);
    setPrepareError(null);
    operation.clear();
    try {
      const fresh = await props.reader.query(
        { contractVersion: 2, operation: 'sessions-read', scope, page: { limit: 100 } },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (
        fresh.state !== 'sessions-read' ||
        settingsScopeKeyV1(fresh.scope) !== settingsScopeKeyV1(scope)
      )
        throw new PortalClientErrorV1('invalid-response');
      if (
        scope.kind === 'account' &&
        (fresh.items.some((s) => s.accountId !== scope.accountId) ||
          (parentScope.kind === 'class' &&
            fresh.items.some((s) => s.classId !== parentScope.classId)))
      )
        throw new PortalClientErrorV1('conflict');
      if (fresh.revocableCount === 0) throw new PortalClientErrorV1('conflict');
      setReview({
        label,
        count: sessionId ? 1 : fresh.revocableCount,
        at: fresh.observedAt,
        command: {
          contractVersion: 1,
          operation: 'sessions-revoke',
          scope,
          ...(sessionId ? { sessionId } : {}),
          expectedVersion: fresh.version,
          idempotencyKey: crypto.randomUUID(),
          confirmed: true,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure =
        error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');
      if (authorizationLostV1(failure)) props.onAuthorizationLost?.(failure);
      else setPrepareError(failure);
      setPrepareRetryAt(Date.now() + (failure.retryAfterSeconds ?? 0) * 1000);
    } finally {
      if (pendingReview.current === controller) {
        pendingReview.current = null;
        setPreparing(false);
      }
    }
  }
  function accountAction(row: SessionRowV2, individual: boolean) {
    void prepare(
      { kind: 'account', academicYear: 2026, accountId: row.accountId },
      individual
        ? 'Sessão de ' + (row.name || 'aluno selecionado')
        : 'Todas as sessões de ' + (row.name || 'aluno selecionado'),
      individual ? row.sessionId : undefined,
    );
  }
  return (
    <Card className="pa-operations-card pa-flat">
      <Card.Header>
        <div className="pa-operations-header">
          <div>
            <p className="text-xs text-muted">{props.scopeLabel}</p>
          </div>
          <LiveReadNoticeV1 failed={Boolean(read.refreshError)} />
        </div>
      </Card.Header>
      <Card.Content>
        <StudentPresenceV1 {...props} />
        {read.state.state === 'loading' && <p role="status">Consultando sessões…</p>}
        {read.state.state === 'error' && (
          <AccountsErrorV1
            error={read.state.error}
            canReload={!busy && read.canReload}
            onReload={read.reload}
          />
        )}
        {prepareError && (
          <AccountsErrorV1
            error={prepareError}
            canReload={clock >= prepareRetryAt}
            onReload={() => {
              setPrepareError(null);
              read.reload();
            }}
          />
        )}
        {preparing && (
          <div role="status">
            Conferindo acessos…{' '}
            <Button variant="secondary" onPress={cancelReview}>
              Cancelar
            </Button>
          </div>
        )}
        {mutation.state === 'pending' && <p role="status">Encerrando sessões…</p>}
        {mutation.state === 'committed' && <p role="status">Sessões encerradas.</p>}
        {mutation.state === 'expired' && (
          <p role="alert">
            O prazo de retomada terminou. Consulte o estado antes de uma nova decisão.
          </p>
        )}
        {mutation.state === 'error' && (
          <div role="alert">
            <p>
              {mutation.error.state === 'conflict'
                ? 'O estado mudou. Consulte novamente antes de confirmar.'
                : mutation.retryable
                  ? 'Não foi possível confirmar a resposta. Retomar repete somente a mesma solicitação.'
                  : 'A solicitação não pôde ser concluída.'}
            </p>
            <div className="pa-operations-actions">
              {mutation.retryable && (
                <Button
                  isDisabled={clock < mutation.retryAt}
                  onPress={() => void operation.retry()}
                >
                  Retomar encerramento
                </Button>
              )}
              <Button
                variant="secondary"
                isDisabled={clock < mutation.retryAt}
                onPress={() => {
                  operation.clear();
                  read.reload();
                }}
              >
                Consultar novamente
              </Button>
            </div>
          </div>
        )}
        {data && (
          <>
            {props.scope.kind !== 'school' && (
              <Button
                variant="danger"
                isDisabled={!props.canWrite || busy || data.revocableCount === 0}
                onPress={() =>
                  void prepare(
                    props.scope,
                    props.scope.kind === 'class'
                      ? 'Todas as sessões da turma ' + props.scopeLabel
                      : 'Todas as sessões da conta ' + props.scopeLabel,
                  )
                }
              >
                {props.scope.kind === 'class'
                  ? 'Encerrar sessões da turma'
                  : 'Encerrar todas do aluno'}
              </Button>
            )}
            {!props.canWrite && <p className="text-xs text-muted">Somente leitura</p>}
            <SessionFeedV1
              title="Sessões ativas"
              data={data}
              busy={busy}
              canWrite={props.canWrite}
              scope={props.scope}
              onAction={accountAction}
              end={
                <ContinuousEndV1
                  more={read.more}
                  busy={busy || read.refreshing}
                  failed={Boolean(read.refreshError)}
                  loadMore={read.loadMore}
                  retry={read.reload}
                />
              }
            />
          </>
        )}
        <VisibleSessionHistoryV1
          {...props}
          revision={revision}
          busy={busy}
          onAction={accountAction}
        />
        {review && (
          <AlertDialog.Backdrop
            isOpen
            isDismissable={false}
            isKeyboardDismissDisabled={false}
            onOpenChange={(open) => {
              if (!open) cancelReview();
            }}
          >
            <AlertDialog.Container>
              <AlertDialog.Dialog className="pa-operations-dialog">
                <AlertDialog.Header>
                  <AlertDialog.Heading>Confirmar encerramento de sessões</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>{review.label}</p>
                  <p>
                    {review.count} sessão(ões) na consulta de {operationDateV1(review.at)}.
                  </p>
                  <p>
                    {review.command.sessionId
                      ? 'A ação abrange somente a sessão selecionada.'
                      : 'A ação abrange todas as sessões existentes neste escopo no momento da confirmação no servidor, inclusive expiradas.'}
                  </p>
                  <p>
                    Senha e QR permanecem. Um novo login permitido pode criar outra sessão depois.
                  </p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button autoFocus variant="secondary" onPress={cancelReview}>
                    Cancelar
                  </Button>
                  <Button
                    variant="danger"
                    onPress={() => {
                      const captured = review.command;
                      setReview(null);
                      read.clear();
                      void operation.submit(captured);
                    }}
                  >
                    Encerrar sessões
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        )}
      </Card.Content>
    </Card>
  );
}

function VisibleSessionHistoryV1(
  props: OperationsPropsV1 & {
    revision: number;
    busy: boolean;
    onAction: (row: SessionRowV2, individual: boolean) => void;
  },
) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [visitedRevision, setVisitedRevision] = useState<number | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (visible) setVisitedRevision(props.revision);
  }, [visible, props.revision]);
  const mounted = visible || visitedRevision === props.revision;
  return (
    <div ref={ref} className="pa-session-history">
      {mounted ? (
        <LiveRefreshScopeV1 active={visible}>
          <SessionHistoryV1 key={props.revision} {...props} />
        </LiveRefreshScopeV1>
      ) : (
        <h3>Histórico de sessões</h3>
      )}
    </div>
  );
}

function SessionHistoryV1(
  props: OperationsPropsV1 & {
    busy: boolean;
    onAction: (row: SessionRowV2, individual: boolean) => void;
  },
) {
  const scope = props.scope;
  const scopeKey = settingsScopeKeyV1(props.scope);
  const load = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const result = await props.reader.query(
        {
          contractVersion: 2,
          operation: 'sessions-read',
          sessionView: 'history',
          scope: props.scope,
          page: { limit: 100, ...(cursor ? { cursor } : {}) },
        },
        signal,
      );
      if (
        result.state !== 'sessions-read' ||
        result.sessionView !== 'history' ||
        settingsScopeKeyV1(result.scope) !== scopeKey ||
        result.items.some((item) => item.validity === 'valid') ||
        (scope.kind === 'account' &&
          result.items.some((item) => item.accountId !== scope.accountId.toLowerCase()))
      )
        throw new PortalClientErrorV1('invalid-response');
      return result;
    },
    [props.reader, scopeKey],
  );
  const read = useContinuousReadV1(load, 'sessionId', props.onAuthorizationLost, true, false);
  const data = read.state.state === 'ready' ? read.state.data : null;
  return (
    <>
      {read.state.state === 'loading' ? <p role="status">Carregando histórico…</p> : null}
      {read.state.state === 'error' ? (
        <AccountsErrorV1
          error={read.state.error}
          canReload={!props.busy && read.canReload}
          onReload={read.reload}
        />
      ) : null}
      {data ? (
        <SessionFeedV1
          title="Histórico de sessões"
          data={data}
          busy={props.busy}
          canWrite={props.canWrite}
          scope={props.scope}
          onAction={props.onAction}
          end={
            <ContinuousEndV1
              more={read.more}
              busy={props.busy || read.refreshing}
              failed={Boolean(read.refreshError)}
              loadMore={read.loadMore}
              retry={read.reload}
            />
          }
        />
      ) : null}
    </>
  );
}

function SessionFeedV1({
  title,
  data,
  busy,
  canWrite,
  scope,
  onAction,
  end,
}: Readonly<{
  title: string;
  data: SessionsPageV2;
  busy: boolean;
  canWrite: boolean;
  scope: ScopeV1;
  onAction: (row: SessionRowV2, individual: boolean) => void;
  end: React.ReactNode;
}>) {
  const active = data.sessionView === 'active';
  return (
    <section className="pa-session-feed" aria-label={title}>
      <div className="pa-operations-header">
        <h3>{title}</h3>
        <Chip size="sm" color={active ? 'success' : 'default'} variant="soft">
          <Chip.Label>{data.items.length} sessões</Chip.Label>
        </Chip>
      </div>
      {!data.items.length ? (
        <p className="text-sm text-muted">
          {data.nextCursor
            ? 'Carregando registros…'
            : active
              ? 'Nenhuma sessão ativa.'
              : 'Nenhuma sessão no histórico.'}
        </p>
      ) : (
        <Table variant="secondary">
          <Table.ScrollContainer
            className="pa-operations-scroll"
            tabIndex={0}
            role="region"
            aria-label={`Rolagem: ${title}`}
          >
            <Table.Content aria-label={title}>
              <Table.Header>
                <Table.Column id="student" isRowHeader>
                  Aluno
                </Table.Column>
                <Table.Column id="state">Situação</Table.Column>
                <Table.Column id="created">Início</Table.Column>
                <Table.Column id="end">
                  {active ? 'Válida até' : 'Encerramento / validade'}
                </Table.Column>
                <Table.Column id="action">
                  <span className="sr-only">Encerrar</span>
                </Table.Column>
              </Table.Header>
              <Table.Body>
                {data.items.map((row) => (
                  <Table.Row key={row.sessionId} id={row.sessionId}>
                    <Table.Cell>
                      <div className="pa-account-identity">
                        <StudentAvatarV1 id={row.accountId} />
                        <div>
                          <StudentNameV1
                            accountId={row.accountId}
                            name={row.name || 'Nome indisponível'}
                            parentScope={scope}
                          >
                            <strong>{row.name || 'Nome indisponível'}</strong>
                          </StudentNameV1>
                          {scope.kind === 'school' ? (
                            <span>{row.classLabel || 'Turma indisponível'}</span>
                          ) : null}
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Tooltip>
                        <Tooltip.Trigger>
                          <Chip
                            size="sm"
                            color={
                              row.validity === 'valid'
                                ? 'success'
                                : row.validity === 'unavailable'
                                  ? 'warning'
                                  : 'default'
                            }
                            variant="soft"
                          >
                            <Chip.Label>{labels[row.validity]}</Chip.Label>
                          </Chip>
                        </Tooltip.Trigger>
                        <Tooltip.Content>
                          {row.persistent ? 'Manter conectado' : 'Acesso temporário'}
                        </Tooltip.Content>
                      </Tooltip>
                    </Table.Cell>
                    <Table.Cell>{operationDateV1(row.createdAt)}</Table.Cell>
                    <Table.Cell>
                      <Tooltip>
                        <Tooltip.Trigger>
                          {operationDateV1(row.revokedAt ?? row.effectiveExpiresAt)}
                        </Tooltip.Trigger>
                        <Tooltip.Content>
                          Validade original: {operationDateV1(row.expiresAt)}
                        </Tooltip.Content>
                      </Tooltip>
                    </Table.Cell>
                    <Table.Cell>
                      {row.validity === 'valid' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={
                            !canWrite ||
                            busy ||
                            (scope.kind === 'class' && row.classId !== scope.classId)
                          }
                          aria-label={`Encerrar sessão de ${row.name || 'aluno'}`}
                          onPress={() => onAction(row, true)}
                        >
                          Encerrar
                        </Button>
                      ) : null}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
            {end}
          </Table.ScrollContainer>
        </Table>
      )}
      {!data.items.length ? end : null}
    </section>
  );
}
