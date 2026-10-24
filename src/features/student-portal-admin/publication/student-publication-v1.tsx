import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Card, Chip, Modal, Spinner, Tooltip } from '@heroui/react';
import { StableReadStatusV1 } from '../../../shared/live-data/stable-read-status-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { settingsScopeKeyV1, settingsScopeLabelV1 } from '../settings/settings-values-v1';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import {
  PUBLICATION_CHECKS_V1,
  createPublicationControllerV1,
  initialPublicationViewV1,
  type PublicationMutationV1,
  type PublicationViewV1,
} from './publication-controller-v1';
import {
  PUBLICATION_LABELS_V1,
  disclosureAtV1,
  publicationRestrictionV1,
  publicationCommandV1,
  type PublicationCommandV1,
  type PublicationItemV1,
  type PublicationSnapshotV1,
} from './publication-values-v1';
import './student-publication-v1.css';

export interface StudentPublicationPropsV1 {
  readonly embedded?: boolean;
  readonly client: PortalAdminClientV1;
  readonly scope: ScopeV1;
  readonly canWrite: boolean;
  readonly scopeLabel?: string;
  readonly onOpenSettings?: () => void;
  readonly onOpenHealth?: () => void;
  /** Aba Notas: what students see now (chip) and the "Mostrar para os alunos" part per period. */
  readonly periodStatus?: (item: PublicationItemV1) => ReactNode;
  readonly periodExtra?: (item: PublicationItemV1) => ReactNode;
}
const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});
const dateLabel = (date: string | null) =>
  date === null ? 'Não definida' : dateFormatter.format(new Date(date));
type RestrictionV1 = ReturnType<typeof publicationRestrictionV1>;
/** "Liberar a partir de": the date, or why there is none. */
function releaseText(restriction: RestrictionV1, disclosure: string | null) {
  if (restriction === 'outside-single-schedule') return 'Fora da divulgação única';
  return disclosure ? dateLabel(disclosure) : 'Sem data definida';
}
/** "Regra de exibição": hidden by the policy, left out of the calendar, or included. */
function ruleText(restriction: RestrictionV1) {
  if (restriction === 'period-disabled') return 'Oculto pela política';
  return restriction === 'outside-single-schedule' ? 'Excluído do calendário' : 'Incluído';
}

function revisionLabel(revision: string | null) {
  if (revision === null) return 'Nenhuma';
  return revision.startsWith('mixed:') ? 'Mais de uma versão' : revision;
}
const termLabel = (period: string) =>
  period.startsWith('REC') ? `Recuperação ${period.slice(3)}` : `${period.slice(1)}º trimestre`;
function operationLabel(command: PublicationCommandV1) {
  if (command.operation === 'unpublish') return 'Retirar publicação';
  return 'Publicar as notas novas';
}
function confirmationLabel(command: PublicationCommandV1) {
  if (command.operation === 'unpublish') return 'Confirmar retirada';
  if (command.operation === 'publish-update') return 'Publicar as notas novas';
  return 'Confirmar publicação';
}

function publicationColorV1(item: PublicationItemV1) {
  if (item.state === 'update-pending') return 'warning' as const;
  if (item.state === 'published') return 'success' as const;
  return 'default' as const;
}
function PublicationActionsV1({
  item,
  autoUpdate,
  disabled,
  review,
}: Readonly<{
  item: PublicationItemV1;
  autoUpdate: boolean;
  disabled: boolean;
  review: (item: PublicationItemV1, operation: PublicationCommandV1['operation']) => void;
}>) {
  const hasData = item.state !== 'no-data' && item.availableRevision !== null;
  const published = item.publishedRevision !== null;
  // First publication is always explicit. After that, auto-update owns newer revisions.
  const canPublishFirst = hasData && !published;
  const canPublishManualUpdate =
    hasData && published && !autoUpdate && item.state === 'update-pending';
  return (
    <Card.Footer className="pa-publication-actions">
      {canPublishFirst ? (
        <Button
          size="sm"
          variant="primary"
          isDisabled={disabled}
          aria-label={`Publicar as notas novas de ${item.period}`}
          onPress={() => review(item, 'publish')}
        >
          Publicar as notas novas
        </Button>
      ) : null}
      {canPublishManualUpdate ? (
        <Button
          size="sm"
          isDisabled={disabled}
          aria-label={`Publicar as notas novas de ${item.period}`}
          onPress={() => review(item, 'publish-update')}
        >
          Publicar as notas novas
        </Button>
      ) : null}
      {published ? (
        <Button
          size="sm"
          variant="danger-soft"
          isDisabled={disabled}
          aria-label={`Retirar publicação de ${item.period}`}
          onPress={() => review(item, 'unpublish')}
        >
          Retirar
        </Button>
      ) : null}
    </Card.Footer>
  );
}

function publicationStepTextV1(item: PublicationItemV1, autoUpdate: boolean) {
  if (item.state === 'no-data') return 'Ainda não há notas deste período no Banco.';
  if (item.state === 'available') return 'Há notas no Banco prontas para publicar.';
  if (item.state === 'update-pending')
    return autoUpdate
      ? 'Publicada. As notas novas do Banco serão publicadas sozinhas.'
      : 'O Banco tem notas mais novas que ainda não foram publicadas.';
  return 'Publicada e igual ao Banco.';
}

function PublicationPeriodV1({
  item,
  data,
  canWrite,
  disabled,
  review,
  status,
  extra,
}: Readonly<{
  item: PublicationItemV1;
  data: PublicationSnapshotV1;
  canWrite: boolean;
  disabled: boolean;
  review: (item: PublicationItemV1, operation: PublicationCommandV1['operation']) => void;
  status?: ReactNode;
  extra?: ReactNode;
}>) {
  const disclosure = disclosureAtV1(data.settings, item.period);
  const restriction = publicationRestrictionV1(data.settings, item.period);
  const versions = (
    <Tooltip>
      <Tooltip.Trigger className="w-fit text-xs text-muted">Versões das notas</Tooltip.Trigger>
      <Tooltip.Content>
        Disponível: {revisionLabel(item.availableRevision)}
        <br />
        Publicada: {revisionLabel(item.publishedRevision)}
      </Tooltip.Content>
    </Tooltip>
  );
  // Aba Notas: two steps side by side, publish then show. A period without any data is one line.
  if (extra !== undefined) {
    const empty = item.state === 'no-data' && item.publishedRevision === null;
    return (
      <Card className={'pa-publication-card pa-grade-period' + (empty ? ' pa-grade-period--empty' : '')}>
        <Card.Header>
          <div className="pa-publication-heading">
            <h3>{termLabel(item.period)}</h3>
            {status}
          </div>
        </Card.Header>
        {empty ? null : (
          <Card.Content className="pa-grade-steps">
            <section className="pa-grade-step" aria-label={`Publicação de ${termLabel(item.period)}`}>
              <p className="pa-grade-step-title">1 · Publicação</p>
              <p className="pa-grade-step-text">
                <Chip size="sm" variant="soft" color={publicationColorV1(item)}>
                  {PUBLICATION_LABELS_V1[item.state]}
                </Chip>{' '}
                {publicationStepTextV1(item, data.settings.value.autoUpdate)}
              </p>
              {canWrite ? (
                <PublicationActionsV1
                  item={item}
                  autoUpdate={data.settings.value.autoUpdate}
                  disabled={disabled}
                  review={review}
                />
              ) : null}
              {versions}
            </section>
            <section className="pa-grade-step" aria-label={`Mostrar ${termLabel(item.period)}`}>
              <p className="pa-grade-step-title">2 · Mostrar para os alunos</p>
              {extra}
            </section>
          </Card.Content>
        )}
      </Card>
    );
  }
  return (
    <Card className="pa-publication-card">
      <Card.Header>
        <div className="pa-publication-heading">
          <h3>{termLabel(item.period)}</h3>
          <Chip size="sm" variant="soft" color={publicationColorV1(item)}>
            {PUBLICATION_LABELS_V1[item.state]}
          </Chip>
        </div>
      </Card.Header>
      <Card.Content>
        <dl className="pa-publication-details">
          <div>
            <dt>Liberar a partir de</dt>
            <dd>
              {releaseText(restriction, disclosure)}
            </dd>
          </div>
          <div>
            <dt>Regra de exibição</dt>
            <dd>
              {ruleText(restriction)}
            </dd>
          </div>
        </dl>
        {versions}
      </Card.Content>
      {canWrite ? (
        <PublicationActionsV1
          item={item}
          autoUpdate={data.settings.value.autoUpdate}
          disabled={disabled}
          review={review}
        />
      ) : null}
    </Card>
  );
}
type ErrorPublicationMutationV1 = Extract<PublicationMutationV1, { state: 'error' }>;
type AcceptedPublicationMutationV1 = Extract<PublicationMutationV1, { state: 'accepted' }>;

function publicationErrorMessageV1(mutation: ErrorPublicationMutationV1) {
  if (mutation.error.state === 'conflict')
    return 'A fonte, o escopo ou a configuração mudou. Recarregue e revise uma nova decisão; a revisão não será substituída automaticamente.';
  if (mutation.error.state === 'unauthenticated') return 'Sessão expirada. Entre novamente no ADM.';
  if (mutation.error.state === 'forbidden')
    return 'A operação não foi autorizada neste escopo. Recarregue para conferir o estado atual.';
  if (mutation.retryable)
    return 'O resultado da decisão não foi confirmado. Repetir mantém a mesma revisão e a mesma operação.';
  return 'Não foi possível validar a decisão. Recarregue o estado e revise antes de tentar novamente.';
}

function PublicationErrorFeedbackV1({
  mutation,
  onRetry,
  reload,
  clock,
  reloadDisabled,
}: Readonly<{
  mutation: ErrorPublicationMutationV1;
  onRetry: () => void;
  reload: () => void;
  clock: number;
  reloadDisabled: boolean;
}>) {
  return (
    <div role="alert" className="pa-publication-error">
      <p>{publicationErrorMessageV1(mutation)}</p>
      <div className="pa-publication-actions">
        {mutation.retryable ? (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={clock < mutation.retryAt}
            onPress={onRetry}
          >
            Tentar novamente
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" isDisabled={reloadDisabled} onPress={reload}>
          Recarregar
        </Button>
      </div>
    </div>
  );
}

function observationPendingTextV1(removed: boolean) {
  return removed
    ? 'Conferindo a retirada na leitura atual.'
    : 'Conferindo a edição liberada na consulta do servidor.';
}

function observationConfirmedTextV1(removed: boolean) {
  return removed ? 'Publicação retirada.' : 'Publicação confirmada.';
}

function observationReportedTextV1(removed: boolean) {
  return removed
    ? 'Publicação retirada para este grupo.'
    : 'Publicação confirmada para este grupo.';
}

function PublicationAcceptedFeedbackV1({
  mutation,
  scope,
  onCancel,
  reload,
  onOpenHealth,
  reloadDisabled,
}: Readonly<{
  mutation: AcceptedPublicationMutationV1;
  scope: ScopeV1;
  onCancel: () => void;
  reload: () => void;
  onOpenHealth?: () => void;
  reloadDisabled: boolean;
}>) {
  const removed = mutation.command.operation === 'unpublish';
  if (mutation.observation === 'observing')
    return (
      <>
        <p>{observationPendingTextV1(removed)}</p>
        <p>
          Consultas de acompanhamento: {mutation.checks} de até {PUBLICATION_CHECKS_V1}.
        </p>
        <Button size="sm" variant="outline" onPress={onCancel}>
          Parar acompanhamento
        </Button>
      </>
    );
  if (mutation.observation === 'confirmed') return <p>{observationConfirmedTextV1(removed)}</p>;
  if (mutation.observation === 'reported')
    return (
      <>
        <p>{observationReportedTextV1(removed)}</p>
        {!removed ? (
          <p>
            Publicação de {scope.kind === 'school' ? 'escola' : 'turma'} verificada. O acesso de
            cada aluno continua sujeito ao vínculo, ao calendário e às permissões vigentes.
          </p>
        ) : null}
      </>
    );
  const message =
    mutation.observation === 'stopped'
      ? 'Acompanhamento parado. Isso não cancela a decisão aceita nem o processamento no servidor.'
      : 'Não foi possível confirmar o estado atual. A decisão aceita foi preservada; consulte novamente sem criar outra publicação.';
  return (
    <>
      <p>{message}</p>
      <div className="pa-publication-actions">
        <Button size="sm" variant="secondary" isDisabled={reloadDisabled} onPress={reload}>
          Consultar estado atual
        </Button>
        {onOpenHealth ? (
          <Button size="sm" variant="ghost" onPress={onOpenHealth}>
            Ver saúde operacional
          </Button>
        ) : null}
      </div>
    </>
  );
}

function PublicationFeedbackV1({
  mutation,
  scope,
  onCancel,
  onRetry,
  reload,
  onOpenHealth,
  clock,
  reloadDisabled,
}: Readonly<{
  mutation: PublicationMutationV1;
  scope: ScopeV1;
  onCancel: () => void;
  onRetry: () => void;
  reload: () => void;
  onOpenHealth?: () => void;
  clock: number;
  reloadDisabled: boolean;
}>) {
  if (mutation.state === 'idle') return null;
  if (mutation.state === 'sending')
    return <output>Salvando publicação de {termLabel(mutation.command.period)}…</output>;
  if (mutation.state === 'error')
    return (
      <PublicationErrorFeedbackV1
        mutation={mutation}
        onRetry={onRetry}
        reload={reload}
        clock={clock}
        reloadDisabled={reloadDisabled}
      />
    );
  return (
    <div aria-live="polite" className="pa-publication-feedback">
      <p>
        <strong>{termLabel(mutation.command.period)}: solicitação aceita.</strong>
      </p>
      <PublicationAcceptedFeedbackV1
        mutation={mutation}
        scope={scope}
        onCancel={onCancel}
        reload={reload}
        onOpenHealth={onOpenHealth}
        reloadDisabled={reloadDisabled}
      />
    </div>
  );
}
function PublicationReviewV1({
  command,
  label,
  busy,
  onClose,
  onConfirm,
}: Readonly<{
  command: PublicationCommandV1;
  label: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  return (
    <Modal.Backdrop
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{operationLabel(command)}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="pa-publication-review">
            <p>
              <strong>{command.period}</strong> em {label}.
            </p>
            {'targetDataVersion' in command ? (
              <p>
                Revisão dos dados aprovada: <strong>{command.targetDataVersion}</strong>.
              </p>
            ) : null}
            {command.operation === 'unpublish' ? (
              <p>
                A retirada bloqueia a consulta deste período e pode ocultar também o resultado
                final. O histórico acadêmico e os demais períodos são preservados.
              </p>
            ) : (
              <>
                <p>
                  {command.operation === 'publish-update'
                    ? 'A versão mais recente das notas substituirá a versão atualmente exibida aos alunos.'
                    : 'Será publicada a versão atual das notas.'}
                </p>
                {command.operation === 'publish' && command.scope.kind !== 'account' ? (
                  <p>
                    Esta publicação vale para os alunos elegíveis deste grupo e substitui as
                    publicações anteriores abrangidas.
                  </p>
                ) : null}
                <p>
                  Datas futuras adiam a exibição. Sem data definida, a publicação manual libera as
                  notas conforme as permissões de acesso.
                </p>
              </>
            )}
          </Modal.Body>
          <Modal.Footer className="pa-publication-actions">
            <Button variant="ghost" isDisabled={busy} onPress={onClose}>
              Voltar
            </Button>
            <Button
              variant={command.operation === 'unpublish' ? 'danger' : 'primary'}
              isPending={busy}
              isDisabled={busy}
              onPress={onConfirm}
            >
              {confirmationLabel(command)}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
type ReadyPublicationLoadV1 = Extract<PublicationViewV1['load'], { state: 'ready' }>;
type ErrorPublicationLoadV1 = Extract<PublicationViewV1['load'], { state: 'error' }>;

function publicationLoadErrorMessageV1(error: ErrorPublicationLoadV1['error']) {
  if (error.state === 'unauthenticated') return 'Sessão expirada. Entre novamente no ADM.';
  if (error.state === 'forbidden') return 'Sem permissão para consultar este escopo.';
  return 'Consulta indisponível. Tente novamente.';
}

function PublicationPolicyV1({
  data,
  busy,
  reviewing,
  onOpenSettings,
}: Readonly<{
  data: PublicationSnapshotV1;
  busy: boolean;
  reviewing: boolean;
  onOpenSettings?: () => void;
}>) {
  return (
    <Card className="pa-publication-policy">
      <Card.Header>
        <h3>Exibição no Portal</h3>
      </Card.Header>
      <Card.Content>
        <dl className="pa-publication-details">
          <div>
            <dt>Atualização automática</dt>
            <dd>{data.settings.value.autoUpdate ? 'Ligada' : 'Desligada'}</dd>
          </div>
          <div>
            <dt>Notas exibidas</dt>
            <dd>{data.settings.value.showPartials ? 'Finais e parciais' : 'Somente finais'}</dd>
          </div>
          <div>
            <dt>Divulgação de resultado final</dt>
            <dd>{data.settings.value.showFinalResult ? 'Ligada' : 'Desligada'}</dd>
          </div>
          <div>
            <dt>Resultado final a partir de</dt>
            <dd>{dateLabel(data.settings.value.calendar.finalDisclosureAt)}</dd>
          </div>
        </dl>
        <Tooltip>
          <Tooltip.Trigger className="w-fit text-xs text-muted">Regras de acesso</Tooltip.Trigger>
          <Tooltip.Content>
            Publicação, datas e permissão de acesso são verificadas por aluno. Uma configuração
            individual pode substituir o padrão.
          </Tooltip.Content>
        </Tooltip>
      </Card.Content>
      {onOpenSettings ? (
        <Card.Footer>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy || reviewing}
            onPress={onOpenSettings}
          >
            Acesso e datas
          </Button>
        </Card.Footer>
      ) : null}
    </Card>
  );
}

function PublicationReadyV1({
  embedded,
  periodStatus,
  periodExtra,
  load,
  view,
  canWrite,
  busy,
  review,
  onOpenSettings,
  prepare,
}: Readonly<{
  embedded?: boolean;
  load: ReadyPublicationLoadV1;
  view: PublicationViewV1;
  canWrite: boolean;
  busy: boolean;
  review: PublicationCommandV1 | null;
  onOpenSettings?: () => void;
  prepare: (item: PublicationItemV1, operation: PublicationCommandV1['operation']) => void;
  periodStatus?: (item: PublicationItemV1) => ReactNode;
  periodExtra?: (item: PublicationItemV1) => ReactNode;
}>) {
  const disabled = busy || view.refreshing || review !== null || view.mutation.state === 'error';
  return (
    <>
      {!embedded ? (
        <PublicationPolicyV1
          data={load.data}
          busy={busy}
          reviewing={review !== null}
          onOpenSettings={onOpenSettings}
        />
      ) : null}
      <StableReadStatusV1 busy={view.refreshing}>
        Atualizando consulta do servidor
      </StableReadStatusV1>
      <div className="pa-publication-periods">
        {load.data.items.map((item) => (
          <PublicationPeriodV1
            key={item.period}
            item={item}
            data={load.data}
            canWrite={canWrite}
            disabled={disabled}
            review={prepare}
            status={periodStatus?.(item)}
            extra={periodExtra?.(item)}
          />
        ))}
      </div>
    </>
  );
}

function PublicationLoadV1({
  embedded,
  periodStatus,
  periodExtra,
  view,
  canWrite,
  busy,
  review,
  clock,
  retryAt,
  reload,
  onOpenSettings,
  prepare,
}: Readonly<{
  embedded?: boolean;
  view: PublicationViewV1;
  canWrite: boolean;
  busy: boolean;
  review: PublicationCommandV1 | null;
  clock: number;
  retryAt: number;
  reload: () => void;
  onOpenSettings?: () => void;
  prepare: (item: PublicationItemV1, operation: PublicationCommandV1['operation']) => void;
  periodStatus?: (item: PublicationItemV1) => ReactNode;
  periodExtra?: (item: PublicationItemV1) => ReactNode;
}>) {
  if (view.load.state === 'loading')
    return (
      <output className="pa-publication-loading">
        <Spinner size="sm" />
        Carregando publicações…
      </output>
    );
  if (view.load.state === 'error')
    return (
      <div role="alert" className="pa-publication-error">
        <p>{publicationLoadErrorMessageV1(view.load.error)}</p>
        <Button size="sm" variant="secondary" isDisabled={busy || clock < retryAt} onPress={reload}>
          Tentar novamente
        </Button>
      </div>
    );
  if (view.load.state === 'ready')
    return (
      <PublicationReadyV1
        embedded={embedded}
        periodStatus={periodStatus}
        periodExtra={periodExtra}
        load={view.load}
        view={view}
        canWrite={canWrite}
        busy={busy}
        review={review}
        onOpenSettings={onOpenSettings}
        prepare={prepare}
      />
    );
  return null;
}

function PublicationScopeV1({
  embedded,
  periodStatus,
  periodExtra,
  client,
  scope,
  canWrite,
  scopeLabel,
  onOpenSettings,
  onOpenHealth,
}: StudentPublicationPropsV1) {
  const [fixedScope] = useState(() => structuredClone(scope));
  const [view, setView] = useState(initialPublicationViewV1);
  const [review, setReview] = useState<PublicationCommandV1 | null>(null);
  const [notice, setNotice] = useState<string | null>(null),
    [clock, setClock] = useState(Date.now);
  const controller = useMemo(
    () => createPublicationControllerV1(client, fixedScope, setView),
    [client, fixedScope],
  );
  const label = scopeLabel ?? settingsScopeLabelV1(fixedScope);
  const retryAt = Math.max(
    view.readRetryAt,
    view.mutation.state === 'error' ? view.mutation.retryAt : 0,
  );
  const busy =
    view.mutation.state === 'sending' ||
    (view.mutation.state === 'accepted' && view.mutation.observation === 'observing');
  useEffect(() => {
    void controller.load();
    return () => controller.reset();
  }, [controller]);
  useLiveRefreshV1(controller.refresh, {
    domains: ['portal', 'gradebook'],
    canRefresh: () => review === null && view.mutation.state !== 'error' && !busy,
  });
  useEffect(() => {
    if (view.mutation.state === 'error' || view.mutation.state === 'accepted') setReview(null);
  }, [view.mutation.state]);
  useEffect(() => {
    if (view.mutation.state !== 'error' && view.load.state !== 'error') return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view.mutation, view.load.state, retryAt]);
  const reload = () => {
    setReview(null);
    setNotice(null);
    void controller.load();
  };
  function prepare(item: PublicationItemV1, operation: PublicationCommandV1['operation']) {
    if (!canWrite || busy || view.refreshing) return;
    try {
      setNotice(null);
      setReview(publicationCommandV1(fixedScope, item, operation, crypto.randomUUID()));
    } catch {
      setNotice('Não foi possível preparar a decisão com os dados atuais. Recarregue o estado.');
    }
  }
  async function confirm() {
    if (!canWrite || !review || busy) return;
    try {
      await controller.submit(review);
    } catch {
      setReview(null);
      setNotice('Não foi possível preparar a decisão. Recarregue o estado e revise novamente.');
    }
  }
  return (
    <section
      className={`pa-publication${embedded ? ' pa-publication--embedded' : ''}`}
      aria-label="Publicação de períodos do Portal do Aluno"
    >
      <header className="pa-publication-heading">
        <div>
          <h2>{periodExtra ? 'Trimestres e recuperações' : 'Notas publicadas'}</h2>
          {embedded ? null : <p>{label}</p>}
          {embedded && !periodExtra ? (
            <p>
              Publicar disponibiliza uma versão das notas. A exibição respeita as políticas e o
              calendário.
            </p>
          ) : null}
        </div>
        <LiveReadNoticeV1 failed={view.load.state === 'ready' && Boolean(view.load.refreshError)} />
      </header>
      {notice ? (
        <p role="alert" className="pa-publication-error">
          {notice}
        </p>
      ) : null}
      <PublicationFeedbackV1
        mutation={view.mutation}
        scope={fixedScope}
        onCancel={() => controller.cancelObservation()}
        onRetry={() => void controller.retry()}
        reload={reload}
        onOpenHealth={onOpenHealth}
        clock={clock}
        reloadDisabled={clock < retryAt}
      />
      <PublicationLoadV1
        embedded={embedded}
        periodStatus={periodStatus}
        periodExtra={periodExtra}
        view={view}
        canWrite={canWrite}
        busy={busy}
        review={review}
        clock={clock}
        retryAt={retryAt}
        reload={reload}
        onOpenSettings={onOpenSettings}
        prepare={prepare}
      />
      {review && canWrite ? (
        <PublicationReviewV1
          command={review}
          label={label}
          busy={view.mutation.state === 'sending'}
          onClose={() => setReview(null)}
          onConfirm={() => void confirm()}
        />
      ) : null}
    </section>
  );
}
/** Scope or authorization changes discard the preceding identity's drafts before paint. */
export function StudentPublicationV1(props: StudentPublicationPropsV1) {
  return (
    <PublicationScopeV1
      key={settingsScopeKeyV1(props.scope) + ':' + String(props.canWrite)}
      {...props}
    />
  );
}
