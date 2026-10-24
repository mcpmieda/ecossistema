import './student-accounts-v1.css';
import { AccountOpenContextV1 } from '../shared/account-open-v1';
import { Star } from 'lucide-react';
import { sealLabelV1, useSealCountsV1 } from './brilliant-seals-v1';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertDialog, Button, Card, Drawer, Tabs, Tooltip } from '@heroui/react';
import type { AdminAccountReadV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { PolicyScopeV1, ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { StudentPhotoPanelV1 } from '../../student-photos/student-photo-panel-v1';
import { allowDraftNavigationV1 } from '../../../shared/forms/draft-navigation-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';
import type { PortalAdminReadClientV2 } from './accounts-client-v2';
import {
  createAccountMutationV1,
  type AccountMutationStateV1,
  type AccountQrResultV1,
} from './account-mutation-v1';
import { useAccountsReadV1 } from './accounts-read-v1';
import { LiveRefreshScopeV1 } from '../../../shared/live-data/live-refresh-scope-v1';
import { AccountIdentityV1, AccountStatusV1, AccountsErrorV1 } from './accounts-presentation-v1';
import {
  ACCOUNT_ACTIONS_V1,
  accountAccessOriginV1,
  accountCredentialPreparableV1,
  firstAccessLabelV1,
  accountCommandV1,
  accountLinkLabelV1,
  accountManageableV1,
  accountPageMatchesV1,
  lastAuthenticationLabelV1,
  type AccountActionV1,
  type AccountCommandV1,
} from './accounts-values-v1';

export interface AccountSlotContextV1 {
  account: AdminAccountReadV2;
  accountsScopeVersion: number;
  scope: Extract<ScopeV1, { kind: 'account' }>;
  canWrite: boolean;
  refresh: () => void;
}
export type AccountSlotsV1 = Partial<
  Record<
    'birth' | 'credentials' | 'sessions' | 'publication' | 'closing' | 'audit' | 'settings',
    (context: AccountSlotContextV1) => ReactNode
  >
>;
export interface AccountDetailPropsV1 {
  accountId: string;
  parentScope: ScopeV1;
  reader: PortalAdminReadClientV2;
  client: PortalAdminClientV1;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
  onAuthorizationLost?: (error: PortalClientErrorV1) => void;
  onQr?: (result: AccountQrResultV1, signal: AbortSignal) => void | Promise<void>;
  onReprint?: (context: AccountSlotContextV1) => void;
  slots?: AccountSlotsV1;
  describeScope?: (scope: PolicyScopeV1) => string;
  initialSlot?: keyof AccountSlotsV1;
  /** The account as the list that opened the record already shows it: displayed at once, while
   * the record's own read confirms it. Actions and tabs wait for that read. */
  known?: AdminAccountReadV2;
}
const slotLabels = {
  birth: 'Nascimento',
  credentials: 'QR code',
  sessions: 'Sessões',
  publication: 'Notas publicadas',
  closing: 'Relatório de notas',
  audit: 'Auditoria',
  settings: 'Políticas',
} as const;
export function AccountDetailV1(props: Readonly<AccountDetailPropsV1>) {
  return (
    <Drawer.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open && allowDraftNavigationV1()) props.onClose();
      }}
    >
      <Drawer.Content placement="right">
        <Drawer.Dialog aria-label="Ficha do aluno" className="pa-student-drawer">
          <Drawer.Body>
            <AccountDetailBodyV1
              key={
                props.accountId +
                ':' +
                settingsScopeKeyV1(props.parentScope) +
                ':' +
                props.canWrite +
                ':' +
                (props.initialSlot ?? 'birth')
              }
              {...props}
            />
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
function AccountDetailBodyV1({
  accountId,
  parentScope,
  reader,
  client,
  canWrite,
  onClose,
  onChanged,
  onAuthorizationLost,
  onQr,
  onReprint,
  slots,
  describeScope,
  initialSlot,
  known,
}: Readonly<AccountDetailPropsV1>) {
  const ownScope = useMemo(
    () => ({ kind: 'account' as const, academicYear: 2026 as const, accountId }),
    [accountId],
  );
  const parentKey = settingsScopeKeyV1(parentScope);
  const parentClassId = parentScope.kind === 'class' ? parentScope.classId : null;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await reader.query(
        { contractVersion: 2, operation: 'accounts-read', scope: ownScope, page: { limit: 100 } },
        signal,
      );
      if (result.state !== 'accounts-read') throw new PortalClientErrorV1('invalid-response');
      accountPageMatchesV1(result, ownScope);
      const account = result.items[0] ?? null;
      if (account && parentClassId !== null && account.classId !== parentClassId)
        throw new PortalClientErrorV1('conflict');
      return { account, scopeVersion: result.scopeVersion };
    },
    [reader, ownScope, parentClassId],
  );
  const read = useAccountsReadV1(load, true, false);
  const [mutation, setMutation] = useState<AccountMutationStateV1>({ state: 'idle' });
  const [review, setReview] = useState<{
    action: AccountActionV1;
    command: AccountCommandV1;
    name: string;
  } | null>(null);
  const [activeSlot, setActiveSlot] = useState<keyof AccountSlotsV1>(() =>
    initialSlot && slots?.[initialSlot] ? initialSlot : 'birth',
  );
  const [openedSlots, setOpenedSlots] = useState<Set<keyof AccountSlotsV1>>(
    () => new Set([initialSlot && slots?.[initialSlot] ? initialSlot : 'birth']),
  );
  useEffect(() => {
    setOpenedSlots((previous) =>
      previous.has(activeSlot) ? previous : new Set([...previous, activeSlot]),
    );
  }, [activeSlot]);
  const [clock, setClock] = useState(0);
  const writer = useMemo(
    () => createAccountMutationV1(client, accountId, setMutation, onQr),
    [client, accountId, onQr],
  );
  const handledVersion = useRef<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || (read.state.state !== 'ready' && read.state.state !== 'error')) return;
    focused.current = true;
    heading.current?.focus({ preventScroll: true });
  }, [read.state.state]);
  useEffect(() => () => writer.clear(), [writer, parentKey]);
  useEffect(() => {
    if (mutation.state !== 'error') return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mutation]);
  useEffect(() => {
    if (mutation.state === 'committed' && handledVersion.current !== mutation.version) {
      handledVersion.current = mutation.version;
      read.reload();
      onChanged();
    }
  }, [mutation, read, onChanged]);
  const pending = mutation.state === 'pending';
  const failed = mutation.state === 'error';
  const protectedFailure =
    failed && ['unauthenticated', 'forbidden'].includes(mutation.error.state);
  useEffect(() => {
    const error =
      mutation.state === 'error'
        ? mutation.error
        : read.state.state === 'error'
          ? read.state.error
          : null;
    if (error && ['unauthenticated', 'forbidden'].includes(error.state))
      onAuthorizationLost?.(error);
  }, [mutation, read.state, onAuthorizationLost]);
  const snapshot = !protectedFailure && read.state.state === 'ready' ? read.state.data : null;
  const account = snapshot?.account ?? null;
  const waiting =
    !protectedFailure && (read.state.state === 'idle' || read.state.state === 'loading');
  // Until the record's own read first answers, what the list already shows is on screen. A later
  // reload never falls back to the list: it could be older than what this record has shown.
  const [answered, setAnswered] = useState(false);
  if (!answered && (read.state.state === 'ready' || read.state.state === 'error'))
    setAnswered(true);
  const shown =
    account ?? (waiting && !answered && known?.accountId === accountId ? known : null);
  const editable = canWrite && !!account && accountManageableV1(account) && !pending && !failed;
  function refresh() {
    if (pending || (failed && Date.now() < mutation.retryAt)) return;
    writer.clear();
    setReview(null);
    read.reload();
  }
  const context: AccountSlotContextV1 | null = account
    ? { account, accountsScopeVersion: snapshot!.scopeVersion, scope: ownScope, canWrite: editable, refresh }
    : null;
  return (
    <Card className="pa-account-detail" aria-label="Ficha da conta">
      <Card.Header>
        <h3 ref={heading} tabIndex={-1}>
          Ficha do aluno
        </h3>
        <Button
          variant="secondary"
          onPress={() => {
            if (allowDraftNavigationV1()) onClose();
          }}
        >
          Fechar ficha
        </Button>
      </Card.Header>
      <Card.Content>
        {mutation.state === 'committed' && (
          <div role="status" className="pa-account-notice">
            <p>Alteração salva.</p>
            {mutation.operation === 'account-reset' && (
              <p>
                Conta redefinida: o QR anterior, a senha e as sessões foram invalidados. Reimprima o
                QR atual e leia a nova imagem no Portal para voltar ao PIN.
              </p>
            )}
            {mutation.operation === 'password-reset' && (
              <p>
                Senha redefinida e sessões invalidadas. Leia novamente o mesmo QR no Portal para
                voltar ao PIN.
              </p>
            )}
            {mutation.artifact === 'preparing' && <p>Preparando a imagem do novo QR…</p>}
            {mutation.artifact === 'unavailable' && (
              <p>
                O novo QR foi gerado, mas o cartão não foi aberto. Use a reimpressão; não é
                necessário regenerar novamente.
              </p>
            )}
          </div>
        )}
        {failed && (
          <div role="alert" className="pa-account-notice">
            <p>
              {mutation.error.state === 'conflict'
                ? 'A conta mudou. Recarregue e revise uma nova ação.'
                : protectedFailure
                  ? 'A autorização administrativa terminou. Os dados desta ficha foram removidos.'
                  : mutation.retryable
                    ? 'Não foi possível confirmar a resposta. A ação pode ter sido concluída; repetir usa a mesma solicitação.'
                    : 'A ação foi recusada. Recarregue a ficha antes de decidir novamente.'}
            </p>
            {mutation.retryable && (
              <Button
                variant="secondary"
                isDisabled={clock < mutation.retryAt}
                onPress={() => {
                  void writer.retry();
                }}
              >
                Repetir mesma solicitação
              </Button>
            )}
            <Button variant="secondary" isDisabled={clock < mutation.retryAt} onPress={refresh}>
              Recarregar ficha
            </Button>
          </div>
        )}
        {pending && <p role="status">Salvando…</p>}
        {waiting && !shown && <p role="status">Carregando aluno…</p>}
        {!protectedFailure && read.state.state === 'error' && (
          <AccountsErrorV1
            error={read.state.error}
            canReload={read.canReload && !pending}
            onReload={refresh}
          />
        )}
        {!protectedFailure && read.state.state === 'ready' && !account && (
          <p role="status">
            Conta não encontrada neste escopo. Nenhuma conta foi criada ou associada pelo nome.
          </p>
        )}
        {shown && (
          <>
            <div className="pa-account-profile">
              <AccountIdentityV1 account={shown} detail />
              <RecordSealsV1 reader={reader} accountId={shown.accountId} />
            </div>
            <StudentPhotoPanelV1
              showAvatar={false}
              canWrite={canWrite}
              subject={{
                source: 'portal',
                academicYear: ownScope.academicYear,
                accountIds: [shown.accountId],
              }}
            />
            <AccountStatusV1 account={shown} />
            <dl className="pa-account-facts">
              <div>
                <dt>Acesso agora</dt>
                <dd>{shown.access.accessPermitted ? 'Permitido' : 'Não'}</dd>
              </div>
              <div>
                <dt>Primeiro acesso</dt>
                <dd>{firstAccessLabelV1(shown)}</dd>
              </div>
              <div>
                <dt>Último acesso</dt>
                <dd>{lastAuthenticationLabelV1(shown.lastAuthenticationAt)}</dd>
              </div>
              <div>
                <dt>Sessões ativas</dt>
                <dd>{shown.validSessionCount}</dd>
              </div>
            </dl>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>{accountLinkLabelV1(shown)}</span>
              <Tooltip>
                <Tooltip.Trigger>Origem do acesso</Tooltip.Trigger>
                <Tooltip.Content>
                  {accountAccessOriginV1(shown.access.source, describeScope)}
                </Tooltip.Content>
              </Tooltip>
            </div>
          </>
        )}
        {account && context && (
          <>
            {!canWrite && <p>Modo somente leitura.</p>}
            {account.eligibility === 'exit' ? (
              <p>Aluno com saída da escola: ficha somente para consulta.</p>
            ) : !accountManageableV1(account) ? (
              <p>
                As ações de credenciais estão indisponíveis para este vínculo. Corrija a origem ou
                use o procedimento administrativo próprio; não há associação por nome.
              </p>
            ) : null}
            <div className="pa-account-actions" aria-label="Ações de acesso">
              {(slots?.credentials || onReprint) && (
                <Button
                  variant="secondary"
                  isDisabled={
                    !editable ||
                    !accountCredentialPreparableV1(account) ||
                    !account.firstAccess.qrIssued
                  }
                  onPress={() => {
                    if (allowDraftNavigationV1()) {
                      if (slots?.credentials) setActiveSlot('credentials');
                      else onReprint?.(context);
                    }
                  }}
                >
                  Reimprimir QR atual
                </Button>
              )}
              {(
                [
                  'qr-regenerate',
                  account.blocked ? 'unblock' : 'block',
                  'password-reset',
                  'account-reset',
                ] as AccountActionV1[]
              ).map((action) => (
                <Button
                  key={action}
                  variant={action === 'account-reset' ? 'danger' : 'secondary'}
                  isDisabled={
                    !editable ||
                    ((['password-reset', 'account-reset'].includes(action) ||
                      (action === 'qr-regenerate' && account.state !== 'active')) &&
                      !account.firstAccess.recoveryReady)
                  }
                  onPress={() =>
                    setReview({
                      action,
                      command: accountCommandV1(account, action),
                      name: account.name || 'Nome indisponível',
                    })
                  }
                >
                  {ACCOUNT_ACTIONS_V1[action].label}
                </Button>
              ))}
            </div>
            {Object.keys(slots ?? {}).length ? (
              <Tabs
                selectedKey={activeSlot}
                onSelectionChange={(key) => {
                  if (key && key in slotLabels && allowDraftNavigationV1())
                    setActiveSlot(key as keyof AccountSlotsV1);
                }}
              >
                <Tabs.ListContainer className="max-w-full overflow-x-auto">
                  <Tabs.List aria-label="Dados do aluno">
                    {Object.entries(slotLabels)
                      .filter(([key]) => slots?.[key as keyof AccountSlotsV1])
                      .map(([key, label]) => (
                        <Tabs.Tab key={key} id={key}>
                          {label}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      ))}
                  </Tabs.List>
                </Tabs.ListContainer>
                {Object.keys(slotLabels)
                  .filter(
                    (key) => openedSlots.has(key as keyof AccountSlotsV1) || key === activeSlot,
                  )
                  .map((key) => (
                    <Tabs.Panel
                      key={key}
                      id={key}
                      shouldForceMount
                      className="pa-account-slot"
                      hidden={key !== activeSlot}
                    >
                      {/* Inside a record every row is this student: names are plain text, so a
                          click never stacks a second record over this one. */}
                      <AccountOpenContextV1.Provider value={null}>
                        <LiveRefreshScopeV1 active={key === activeSlot}>
                          {slots?.[key as keyof AccountSlotsV1]?.(context)}
                        </LiveRefreshScopeV1>
                      </AccountOpenContextV1.Provider>
                    </Tabs.Panel>
                  ))}
              </Tabs>
            ) : null}
          </>
        )}
        <AlertDialog.Backdrop
          isOpen={review !== null}
          isDismissable={false}
          isKeyboardDismissDisabled={pending}
          onOpenChange={(open) => {
            if (!open && !pending) setReview(null);
          }}
        >
          <AlertDialog.Container size="md" placement="center">
            <AlertDialog.Dialog className="pa-account-dialog">
              <AlertDialog.Header>
                <AlertDialog.Heading>
                  {review ? ACCOUNT_ACTIONS_V1[review.action].label : 'Revisar ação'}
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>{review?.name}</p>
                <p>{review && ACCOUNT_ACTIONS_V1[review.action].description}</p>
                <p>Mudanças em outra sessão exigem uma nova confirmação.</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  autoFocus
                  variant="secondary"
                  isDisabled={pending}
                  onPress={() => setReview(null)}
                >
                  Cancelar
                </Button>
                <Button
                  variant="danger"
                  isDisabled={!review || !editable}
                  onPress={() => {
                    if (!review || !editable) return;
                    const command = review.command;
                    setReview(null);
                    void writer.submit(command);
                  }}
                >
                  Confirmar ação
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </Card.Content>
    </Card>
  );
}

/** Beside the profile: the Selos brilhantes the student sees on the Portal (29/09/2026). */
function RecordSealsV1({ reader, accountId }: Readonly<{ reader: AccountDetailPropsV1['reader']; accountId: string }>) {
  const seals = useSealCountsV1(reader, { accountId });
  const count = seals.state === 'ready' ? seals.counts.get(accountId) : undefined;
  if (count === undefined || count === null) return null;
  return (
    <span className="pa-record-seals" aria-label={sealLabelV1(count)}>
      <Star size={16} fill="currentColor" aria-hidden="true" />
      <strong>{count}</strong>
      <span>{count === 1 ? 'selo Brilhante' : 'selos Brilhante'}</span>
    </span>
  );
}
