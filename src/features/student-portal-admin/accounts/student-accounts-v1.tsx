import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Button, Card, Checkbox, Tooltip, SearchField, Table } from '@heroui/react';
import { ArrowDownAZ, Clock, Star } from 'lucide-react';
import {
  sealLabelV1,
  useSealCountsV1,
  useSealCountsCacheV1,
  type SealCountsV1,
  type SealCountsCacheV1,
  type SealReadStateV1,
} from './brilliant-seals-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import {
  type AdminAccountReadV2,
  type AdminReadQueryV2,
  ADMIN_ACCOUNTS_PAGE_SIZE_V2,
} from '../../../../shared/student-portal-contracts/admin-read-v2';

import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';
import type { PortalAdminReadClientV2, PortalClassCatalogV2 } from './accounts-client-v2';
import { AccountDetailV1, type AccountDetailPropsV1 } from './account-detail-v1';
import { StudentBulkV1 } from './student-bulk-v1';
import { allowDraftNavigationV1 } from '../../../shared/forms/draft-navigation-v1';
import { ClassFilterV1 } from './class-filter-v1';
import { useContinuousReadV1, ContinuousEndV1 } from '../shared/continuous-read-v1';
import { AccountIdentityV1, AccountStatusV1, AccountsErrorV1 } from './accounts-presentation-v1';
import {
  accountCredentialPreparableV1,
  firstAccessLabelV1,
  accountPageMatchesV1,
  lastAuthenticationLabelV1,
} from './accounts-values-v1';
import { QrBatchToolsV1 } from '../credentials/qr-batch-tools-v1';
import { primePhotoMemoryV1 } from '../../student-photos/photo-memory-v1';
import { studentAvatarPhotoV1 } from '../shared/student-avatar-v1';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useLiveRefreshScopeV1 } from '../../../shared/live-data/live-refresh-scope-v1';
import {
  panelHashAccountIdV1,
  readPanelFirstRowsV1,
  readPanelHashParamV1,
  writePanelFirstRowsV1,
  writePanelHashParamsV1,
} from '../shared/panel-hash-v1';

import {
  AccountFilterTagsV1,
  ACCOUNT_STATE_OPTIONS_V1,
  ACCOUNT_BLOCK_OPTIONS_V1,
  matchesAccountFiltersV1,
} from './account-filters-v1';
import './student-accounts-v1.css';
import '../credentials/student-credentials-v1.css';

export interface StudentAccountsPropsV1 extends Pick<
  AccountDetailPropsV1,
  'slots' | 'onQr' | 'onReprint' | 'describeScope'
> {
  reader: PortalAdminReadClientV2;
  client: PortalAdminClientV1;
  catalog: PortalClassCatalogV2;
  scope: ScopeV1;
  canWrite: boolean;
  identityKey: string;
  scopeLabel?: string;
}
const SCHOOL_V1: ScopeV1 = { kind: 'school', academicYear: 2026 };
/** A class is a view of the school collection: changing class keeps what was already read. */
const readScopeV1 = (scope: ScopeV1) => (scope.kind === 'account' ? scope : SCHOOL_V1);
/** The account's access right now, as the table says it. */
function accessText(access: { state: string; accessPermitted?: boolean }) {
  if (access.state !== 'resolved') return 'Indisponível';
  return access.accessPermitted ? 'Permitido' : 'Fechado';
}

export function StudentAccountsV1(props: Readonly<StudentAccountsPropsV1>) {
  const authority = `${props.identityKey}:${props.canWrite}`;
  const [restorationAuthority, setRestorationAuthority] = useState<string | null>(authority);
  // Retire restoration before a new authority can mount a reader for the previous record.
  if (restorationAuthority !== null && restorationAuthority !== authority)
    setRestorationAuthority(null);
  const restoreAccountFromHash = restorationAuthority === authority;
  return (
    <AccountsBodyV1
      key={
        props.identityKey +
        ':' +
        settingsScopeKeyV1(readScopeV1(props.scope)) +
        ':' +
        props.canWrite
      }
      {...props}
      restoreAccountFromHash={restoreAccountFromHash}
    />
  );
}
/** Classificação da lista (owner request 29/09/2026). */
type AccountOrderV1 = 'name' | 'seals' | 'last-access';
const ACCOUNT_ORDERS_V1: readonly { id: AccountOrderV1; label: string; icon: ReactNode }[] = [
  { id: 'name', label: 'Nome (A–Z)', icon: <ArrowDownAZ size={13} aria-hidden /> },
  { id: 'seals', label: 'Selos Brilhante', icon: <Star size={13} aria-hidden /> },
  { id: 'last-access', label: 'Último acesso', icon: <Clock size={13} aria-hidden /> },
];
type AccountsBodyPropsV1 = StudentAccountsPropsV1 & { restoreAccountFromHash: boolean };
function AccountsBodyV1(props: AccountsBodyPropsV1) {
  const sealCache = useSealCountsCacheV1(props.reader);
  const [name, setName] = useState('');
  const [order, setOrder] = useState<AccountOrderV1>('name');
  const orderKeys = useMemo(() => new Set<string>([order]), [order]);
  const [states, setStates] = useState<Set<string>>(() => new Set());
  const [blocks, setBlocks] = useState<Set<string>>(() => new Set());
  const [selectedClass, setSelectedClass] = useState<{ id: number; label: string } | null>(null);
  const [qrMount, setQrMount] = useState<HTMLDivElement | null>(null);
  const [bulkMount, setBulkMount] = useState<HTMLDivElement | null>(null);
  // The controls answer the click at once; the list follows without blocking them.
  const listOrder = useDeferredValue(order);
  const listStates = useDeferredValue(states);
  const listBlocks = useDeferredValue(blocks);
  const listSearch = useDeferredValue(name.trim());
  // The class comes from the panel, or from this list's own tabs when it stands alone.
  let classId;
  if (props.scope.kind === 'class') {
    classId = props.scope.classId;
  } else if (props.scope.kind === 'school') {
    classId = selectedClass?.id ?? null;
  } else {
    classId = null;
  }
  const listClassId = useDeferredValue(classId);
  const listClassLabel = useDeferredValue(
    props.scope.kind === 'class' ? props.scopeLabel : selectedClass?.label,
  );
  const classSelected = classId !== null;
  // One read brings the school; class, search, Situação and Bloqueio narrow what is already in
  // memory, so each of them answers without a request.
  const readScope = readScopeV1(props.scope);
  const query = useMemo<AdminReadQueryV2>(
    () => ({
      contractVersion: 2,
      operation: 'accounts-read',
      scope: readScope,
      page: { limit: ADMIN_ACCOUNTS_PAGE_SIZE_V2 },
    }),
    [readScope],
  );
  return (
    <section className="pa-accounts" aria-label="Contas do Portal de 2026">
      <Card
        className={`pa-account-controls-card${classSelected ? ' pa-account-controls-card--class' : ''}`}
      >
        <Card.Content className="pa-account-controls">
          <div className="pa-account-filters">
            {props.scope.kind === 'school' && (
              <ClassFilterV1
                catalog={props.catalog}
                selected={selectedClass}
                onChange={(value) => {
                  if (allowDraftNavigationV1()) setSelectedClass(value);
                }}
              />
            )}
            <SearchField
              className="pa-account-search min-w-48"
              aria-label="Buscar aluno"
              value={name}
              onChange={(value) => {
                if (allowDraftNavigationV1()) setName(value);
              }}
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input maxLength={200} placeholder="Buscar aluno" />
                <SearchField.ClearButton aria-label="Limpar busca" />
              </SearchField.Group>
            </SearchField>
            <AccountFilterTagsV1
              single
              label="Classificar por"
              selected={orderKeys}
              onChange={(value) => {
                const next = ACCOUNT_ORDERS_V1.find((item) => value.has(item.id));
                if (next) setOrder(next.id);
              }}
              options={ACCOUNT_ORDERS_V1}
            />
            <fieldset className="min-w-auto pa-account-filter-row" aria-label="Filtros">
              <span className="pa-account-rail" aria-hidden>
                Filtros
              </span>
              <AccountFilterTagsV1
                label="Situação"
                selected={states}
                onChange={(value) => {
                  if (allowDraftNavigationV1()) setStates(value);
                }}
                options={ACCOUNT_STATE_OPTIONS_V1}
              />
              <AccountFilterTagsV1
                label="Bloqueio"
                selected={blocks}
                onChange={(value) => {
                  if (allowDraftNavigationV1()) setBlocks(value);
                }}
                options={ACCOUNT_BLOCK_OPTIONS_V1}
              />
            </fieldset>
          </div>
          {classSelected && <div ref={setQrMount} className="pa-account-qr-mount" />}
          {classSelected && <div ref={setBulkMount} className="pa-account-bulk-mount" />}
        </Card.Content>
      </Card>
      <AccountsResultsV1
        key={JSON.stringify(query)}
        {...props}
        query={query}
        sealCache={sealCache}
        order={listOrder}
        states={listStates}
        blocks={listBlocks}
        search={listSearch}
        classId={listClassId}
        qrMount={qrMount}
        bulkMount={bulkMount}
        bulkScopeLabel={
          listClassLabel ?? props.scopeLabel ?? (listClassId === null ? 'Escola' : 'Turma')
        }
      />
    </section>
  );
}
function orderAccountsV1<
  T extends { accountId: string; name: string; lastAuthenticationAt: string | null },
>(items: readonly T[], order: AccountOrderV1, seals: SealCountsV1 | null): T[] {
  if (order === 'name') return [...items];
  const byName = (left: T, right: T) => left.name.localeCompare(right.name, 'pt-BR');
  if (order === 'last-access')
    return [...items].sort(
      (left, right) =>
        (right.lastAuthenticationAt ?? '').localeCompare(left.lastAuthenticationAt ?? '') ||
        byName(left, right),
    );
  if (!seals) return [...items];
  return [...items].sort(
    (left, right) =>
      (seals.get(right.accountId) ?? -1) - (seals.get(left.accountId) ?? -1) || byName(left, right),
  );
}
function SealCountV1({ count }: Readonly<{ count: number | null | undefined }>) {
  if (count === undefined || count === null) return null;
  return (
    <span className="pa-seal-count" aria-label={sealLabelV1(count)}>
      <Star size={12} fill="currentColor" aria-hidden="true" />
      {count}
    </span>
  );
}
type AccountRowV1 = AdminAccountReadV2 & { seals: number | null | undefined };
/** Rows on screen grow with the scroll: every row mounted is paid again on each sort, filter,
 * selection and re-read. Without an observer nothing would ask for more, so all rows mount. */
const ROW_WINDOW_V1 = 60;
const rowWindowV1 = () =>
  typeof IntersectionObserver === 'undefined' ? ADMIN_ACCOUNTS_PAGE_SIZE_V2 : ROW_WINDOW_V1;
/** An account whose content did not change keeps its row object across re-reads, filters and
 * sorting: React Aria re-renders only the rows that are new or different. */
function useStableRowsV1() {
  const saved = useRef(
    new Map<
      string,
      {
        account: AdminAccountReadV2;
        content: string;
        seals: AccountRowV1['seals'];
        row: AccountRowV1;
      }
    >(),
  );
  return useCallback((account: AdminAccountReadV2, seals: AccountRowV1['seals']) => {
    const previous = saved.current.get(account.accountId);
    if (previous?.account === account && previous.seals === seals) return previous.row;
    const content = JSON.stringify(account);
    const row =
      previous?.content === content && previous.seals === seals
        ? previous.row
        : { ...account, seals };
    saved.current.set(account.accountId, { account, content, seals, row });
    return row;
  }, []);
}
const NO_SELECTION_V1: Set<string> = new Set();
/** Maintenance of saved photos, asked for by the address: `manutencao=miniaturas`. */
const AvatarBackfillPanelV1 = lazy(() =>
  import('../../student-photos/avatar-backfill-panel-v1').then((module) => ({
    default: module.AvatarBackfillPanelV1,
  })),
);
/** Accents and case do not separate what the operator types from the official name. */
const foldNameV1 = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR');
/** The accounts a view shows, before ordering: one rule for the list and for what it asks ahead. */
function narrowAccountsV1<T extends AdminAccountReadV2>(
  items: readonly T[],
  view: { search: string; states: ReadonlySet<string>; blocks: ReadonlySet<string> },
): T[] {
  const search = foldNameV1(view.search);
  return items.filter(
    (item) =>
      matchesAccountFiltersV1(item, view.states, view.blocks) &&
      (!search || foldNameV1(item.name).includes(search)),
  );
}
const inClassV1 = <T extends AdminAccountReadV2>(items: readonly T[], classId: number | null) =>
  classId === null ? [...items] : items.filter((item) => item.classId === classId);

/** The view a reload brings back: plain alphabetical order, no filter, the address's scope. */
function restorableViewV1(view: {
  order: AccountOrderV1;
  search: string;
  states: ReadonlySet<string>;
  blocks: ReadonlySet<string>;
  classId: number | null;
  scope: ScopeV1;
}) {
  return (
    view.order === 'name' &&
    view.search === '' &&
    view.states.size === 0 &&
    view.blocks.size === 0 &&
    (view.classId === null || view.scope.kind === 'class')
  );
}

/** A ranking or anything that narrows the list: it needs the complete collection. */
function narrowedViewV1(view: {
  order: AccountOrderV1;
  search: string;
  states: ReadonlySet<string>;
  blocks: ReadonlySet<string>;
  classId: number | null;
}) {
  return (
    view.order !== 'name' ||
    view.classId !== null ||
    view.search !== '' ||
    view.states.size > 0 ||
    view.blocks.size > 0
  );
}

function sealErrorV1(seals: SealReadStateV1) {
  if (seals.state === 'error') return seals.error;
  if (seals.state === 'ready') return seals.refreshError;
  return undefined;
}

/** "N alunos", with what is still being read; just "Alunos" before the first page. */
function listCountV1(
  current: { nextCursor: string | null } | null,
  count: number,
  order: AccountOrderV1,
  sealsState: SealReadStateV1['state'],
) {
  if (!current) return 'Alunos';
  const loadingNote = current.nextCursor ? ' · lista em carregamento' : '';
  const sealsNote = order === 'seals' && sealsState === 'loading' ? ' · contando selos' : '';
  return `${count} ${count === 1 ? 'aluno' : 'alunos'}${loadingNote}${sealsNote}`;
}

function liveReadFailedV1(
  refreshError: unknown,
  order: AccountOrderV1,
  sealError: PortalClientErrorV1 | undefined,
) {
  return Boolean(refreshError || (order === 'seals' && sealError));
}

/** A selection that belongs to one view: another view shows none, and the old keys are
 * discarded so returning to that view cannot restore a previous selection. */
function useOwnedSelectionV1(owner: string) {
  const [selection, setSelection] = useState({ owner: '', keys: NO_SELECTION_V1 });
  if (selection.owner !== owner && selection.keys.size > 0)
    setSelection({ owner, keys: NO_SELECTION_V1 });
  const selected = selection.owner === owner ? selection.keys : NO_SELECTION_V1;
  const setSelected = (keys: Set<string>) => setSelection({ owner, keys });
  return [selected, setSelected] as const;
}

/** Seals are counted only to order by them, once the accounts are listed. */
function sealTargetV1(order: AccountOrderV1, listed: boolean, accountIds: readonly string[]) {
  return order === 'seals' && listed && accountIds.length ? { accountIds } : null;
}

function readySealCountsV1(seals: SealReadStateV1) {
  return seals.state === 'ready' ? seals.counts : null;
}

/** The first read in progress, or why the list cannot be shown. */
function AccountsReadNoticesV1({
  readState,
  authorizationError,
  canReload,
  onReload,
}: Readonly<{
  readState:
    { state: 'error'; error: PortalClientErrorV1 } | { state: 'idle' | 'loading' | 'ready' };
  authorizationError: PortalClientErrorV1 | null;
  canReload: boolean;
  onReload: () => void;
}>) {
  return (
    <>
      {(readState.state === 'idle' || readState.state === 'loading') && (
        <p>
          <output className="contents">Consultando contas…</output>
        </p>
      )}
      {(authorizationError || readState.state === 'error') && (
        <AccountsErrorV1
          error={accountsErrorV1(authorizationError, readState)}
          canReload={canReload}
          onReload={onReload}
        />
      )}
    </>
  );
}

function accountsErrorV1(
  authorizationError: PortalClientErrorV1 | null,
  state: { state: 'error'; error: PortalClientErrorV1 } | { state: 'idle' | 'loading' | 'ready' },
) {
  return (
    authorizationError ??
    (state.state === 'error' ? state.error : new PortalClientErrorV1('forbidden'))
  );
}

/** Only accounts that can get a QR enter the selection ("all" means all of those). */
function qrSelectionV1(keys: 'all' | Iterable<unknown>, eligible: ReadonlySet<string>) {
  return new Set(
    keys === 'all' ? eligible : [...keys].map(String).filter((id) => eligible.has(id)),
  );
}

/** Focus returns to the row that opened the record, or to the list when that row is gone. */
function focusBackV1(trigger: HTMLElement | null, list: HTMLElement | null) {
  (trigger?.isConnected ? trigger : list)?.focus();
}

/** The QR tools of the chosen class, or what is missing for them. */
function AccountsQrSectionV1({
  qrClass,
  current,
  client,
  accounts,
  selected,
  label,
  canWrite,
  pendingBirth,
  onCommitted,
  onAuthorizationLost,
}: Readonly<{
  qrClass: Extract<ScopeV1, { kind: 'class' }> | null;
  current: { scopeVersion: number; nextCursor: string | null } | null;
  client: PortalAdminClientV1;
  accounts: Parameters<typeof QrBatchToolsV1>[0]['accounts'];
  selected: Set<string>;
  label: string;
  canWrite: boolean;
  pendingBirth: boolean;
  onCommitted: () => void;
  onAuthorizationLost: (error: PortalClientErrorV1) => void;
}>) {
  return (
    <section className="pa-account-qr-panel" aria-label="QR code">
      <h2>QR code</h2>
      {qrClass && current ? (
        <QrBatchToolsV1
          key={qrClass.classId}
          client={client}
          accounts={accounts}
          selected={selected}
          academicYear={qrClass.academicYear}
          classId={qrClass.classId}
          scopeVersion={current.scopeVersion}
          label={label}
          canWrite={canWrite}
          pendingBirth={pendingBirth}
          hasMore={Boolean(current.nextCursor)}
          onCommitted={onCommitted}
          onAuthorizationLost={onAuthorizationLost}
        />
      ) : (
        <p className="text-sm text-muted">
          {qrClass ? 'Carregando opções de QR…' : 'Selecione uma turma para gerar PDF.'}
        </p>
      )}
    </section>
  );
}

type AccountRowContextV1 = {
  selectedId: string | null;
  selectable: boolean;
  open: (accountId: string, trigger: HTMLElement) => void;
};

/** One account in the table; a class adds the selection cell. */
function accountRowV1(account: AccountRowV1, row: AccountRowContextV1) {
  return (
    <Table.Row
      id={account.accountId}
      key={account.accountId}
      className={row.selectedId === account.accountId ? 'pa-account-selected' : undefined}
    >
      {row.selectable ? (
        <Table.Cell>
          <Checkbox slot="selection" aria-label="Selecionar para QR">
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
            </Checkbox.Content>
          </Checkbox>
        </Table.Cell>
      ) : null}
      <Table.Cell>
        <Button
          variant="ghost"
          size="sm"
          className="pa-student-name"
          aria-label={'Abrir ficha de ' + (account.name || 'conta sem nome')}
          onPress={(event) => row.open(account.accountId, event.target as HTMLElement)}
        >
          <AccountIdentityV1 account={account} />
        </Button>
      </Table.Cell>
      <Table.Cell>
        <AccountStatusV1 account={account} />
        <SealCountV1 count={account.seals} />
        {account.state !== 'active' && (
          <span className="text-xs text-muted">{firstAccessLabelV1(account)}</span>
        )}
      </Table.Cell>
      <Table.Cell>{accessText(account.access)}</Table.Cell>
      <Table.Cell>{lastAuthenticationLabelV1(account.lastAuthenticationAt)}</Table.Cell>
      <Table.Cell>{account.validSessionCount}</Table.Cell>
    </Table.Row>
  );
}

const AccountsResultsV1 = memo(function AccountsResultsV1(
  props: AccountsBodyPropsV1 & {
    query: AdminReadQueryV2;
    sealCache: SealCountsCacheV1;
    order: AccountOrderV1;
    states: Set<string>;
    blocks: Set<string>;
    search: string;
    classId: number | null;
    qrMount: HTMLDivElement | null;
    bulkMount: HTMLDivElement | null;
    bulkScopeLabel: string;
  },
) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [rowWindow] = useState(rowWindowV1);
  // The class chosen in the school list is a view of the same collection, with its own tools.
  const scope = useMemo<ScopeV1>(
    () =>
      props.query.scope.kind === 'school' && props.classId !== null
        ? { kind: 'class', academicYear: 2026, classId: props.classId }
        : props.query.scope,
    [props.query.scope, props.classId],
  );
  const narrowed = [props.classId ?? '', props.search, ...props.states, '', ...props.blocks].join(
    '|',
  );
  // A new order or filter starts again from the first rows.
  const view = props.order + '|' + narrowed;
  const [shown, setShown] = useState({ view, limit: rowWindow });
  const visibleLimit = shown.view === view ? shown.limit : rowWindow;
  // Each request for more triples the rows, so the end of a long list is two scrolls away.
  const showMoreRows = () => setShown({ view, limit: visibleLimit * 3 });
  const stableRow = useStableRowsV1();
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    props.restoreAccountFromHash ? panelHashAccountIdV1('aluno') : null,
  );
  const rankingActive = useLiveRefreshScopeV1() && selectedId === null;
  useEffect(() => writePanelHashParamsV1({ aluno: selectedId }), [selectedId]);
  // Leaving the list (another area) forgets the record, so a reload does not reopen it elsewhere.
  useEffect(() => () => writePanelHashParamsV1({ aluno: null }), []);
  const [photoMaintenance] = useState(() => readPanelHashParamV1('manutencao') === 'miniaturas');
  const maintenance = photoMaintenance && props.canWrite && props.query.scope.kind === 'school';
  const selectedTrigger = useRef<HTMLElement | null>(null);
  const listControl = useRef<HTMLDivElement>(null);
  const [authorizationError, setAuthorizationError] = useState<PortalClientErrorV1 | null>(null);
  // The view a reload brings back: order and filters start again, the scope returns from the
  // address. Its first rows are most likely the ones left on screen, so after a reload their
  // photos are asked for together with the list and the rows mount with them.
  const restorable = restorableViewV1(props);
  const rowsView = props.identityKey + '|' + settingsScopeKeyV1(props.scope);
  useEffect(() => {
    if (!restorable) return;
    try {
      primePhotoMemoryV1(
        readPanelFirstRowsV1(rowsView, ROW_WINDOW_V1).map((accountId) =>
          studentAvatarPhotoV1(accountId),
        ),
      );
    } catch {
      /* Photos are optional; the rows ask when they mount. */
    }
    // Only when the list mounts: any later view is shown from what was already read.
  }, []);
  // The photos of the first rows are asked for when the accounts arrive, before the rows mount,
  // so both appear together. Ordering by seals waits for the counts and is left to the rows.
  const askPhotosAhead = useRef<(items: readonly AdminAccountReadV2[]) => void>(() => undefined);
  askPhotosAhead.current = (items) => {
    if (props.order === 'seals') return;
    const first = orderAccountsV1(
      narrowAccountsV1(inClassV1(items, props.classId), props),
      props.order,
      null,
    ).slice(0, rowWindow);
    try {
      primePhotoMemoryV1(first.map((account) => studentAvatarPhotoV1(account.accountId)));
    } catch {
      /* Photos are optional; the rows ask again when they mount. */
    }
  };
  const load = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const result = await props.reader.query(
        {
          ...props.query,
          page: { limit: ADMIN_ACCOUNTS_PAGE_SIZE_V2, ...(cursor ? { cursor } : {}) },
        },
        signal,
      );
      if (result.state !== 'accounts-read') throw new PortalClientErrorV1('invalid-response');
      const page = accountPageMatchesV1(result, props.query.scope);
      if (!cursor && !signal.aborted) askPhotosAhead.current(page.items);
      return page;
    },
    [props.reader, props.query, refreshVersion],
  );
  const read = useContinuousReadV1(
    load,
    'accountId',
    undefined,
    rankingActive,
    false,
    ADMIN_ACCOUNTS_PAGE_SIZE_V2,
  );
  const current = !authorizationError && read.state.state === 'ready' ? read.state.data : null;
  // A row hidden by a filter never stays selected for a QR or bulk operation.
  const selectionOwner = (current?.scopeVersion ?? '') + '|' + narrowed;
  const [selectedQr, setSelectedQr] = useOwnedSelectionV1(selectionOwner);
  const classItems = useMemo(
    () => inClassV1(current?.items ?? [], props.classId),
    [current?.items, props.classId],
  );
  const filteredItems = useMemo(
    () =>
      narrowAccountsV1(classItems, {
        search: props.search,
        states: props.states,
        blocks: props.blocks,
      }),
    [classItems, props.search, props.states, props.blocks],
  );
  // Rankings and anything that narrows the list need the complete collection; plain
  // alphabetical browsing reads only visited pages.
  const { more, refreshing, loadMore } = read;
  const wholeCollection = maintenance || narrowedViewV1(props);
  useEffect(() => {
    if (wholeCollection && !authorizationError && more && !refreshing && !read.refreshError)
      loadMore();
  }, [wholeCollection, authorizationError, more, refreshing, read.refreshError, loadMore]);
  const sealAccountIds = useMemo(() => classItems.map((item) => item.accountId), [classItems]);
  const photoSubjects = useMemo(
    () =>
      maintenance
        ? classItems.map((item) => ({
            source: 'portal' as const,
            academicYear: 2026,
            accountIds: [item.accountId],
          }))
        : [],
    [maintenance, classItems],
  );
  const seals = useSealCountsV1(
    props.reader,
    sealTargetV1(props.order, current !== null, sealAccountIds),
    { active: rankingActive, revision: current?.scopeVersion, cache: props.sealCache },
  );
  const sealCounts = readySealCountsV1(seals);
  // The seal count travels inside each row: React Aria re-renders a row only when its item changes.
  const orderedItems = useMemo(
    () =>
      orderAccountsV1(filteredItems, props.order, sealCounts).map((account) =>
        stableRow(
          account,
          props.order === 'seals' ? sealCounts?.get(account.accountId) : undefined,
        ),
      ),
    [filteredItems, props.order, sealCounts, stableRow],
  );
  const visibleItems = useMemo(
    () => orderedItems.slice(0, visibleLimit),
    [orderedItems, visibleLimit],
  );
  const firstRows = useMemo(
    () =>
      visibleItems
        .slice(0, ROW_WINDOW_V1)
        .map((account) => account.accountId)
        .join(','),
    [visibleItems],
  );
  const listed = current !== null;
  useEffect(() => {
    if (restorable && listed)
      writePanelFirstRowsV1(rowsView, firstRows ? firstRows.split(',') : []);
  }, [restorable, listed, rowsView, firstRows]);
  const moreRows = rankingActive && (orderedItems.length > visibleLimit || read.more);
  const loadRows = () => {
    if (orderedItems.length > visibleLimit) showMoreRows();
    else if (read.more && read.canReload) {
      showMoreRows();
      read.loadMore();
    }
  };
  const loadingRows = orderedItems.length <= visibleLimit && read.refreshing;
  const qrClass = scope.kind === 'class' ? scope : null;
  const row: AccountRowContextV1 = {
    selectedId,
    selectable: qrClass !== null,
    open: (accountId, trigger) => {
      selectedTrigger.current = trigger;
      setSelectedId(accountId);
    },
  };
  const eligibleQr = useMemo(
    () =>
      new Set(
        orderedItems.filter(accountCredentialPreparableV1).map((account) => account.accountId),
      ),
    [orderedItems],
  );
  const disabledRows = useMemo(
    () =>
      visibleItems
        .filter((account) => !props.canWrite || !eligibleQr.has(account.accountId))
        .map((account) => account.accountId),
    [visibleItems, props.canWrite, eligibleQr],
  );
  const protectedFailure =
    read.state.state === 'error' &&
    ['unauthenticated', 'forbidden'].includes(read.state.error.state);
  useEffect(() => {
    if (protectedFailure) props.sealCache.clear();
  }, [protectedFailure, props.sealCache]);
  const onChanged = useCallback(() => {
    props.sealCache.clear();
    setRefreshVersion((value) => value + 1);
  }, [props.sealCache]);
  const onAuthorizationLost = useCallback(
    (error: PortalClientErrorV1) => {
      props.sealCache.clear();
      setAuthorizationError(error);
      setSelectedId(null);
    },
    [props.sealCache],
  );
  const sealError = sealErrorV1(seals);
  useEffect(() => {
    if (sealError && ['unauthenticated', 'forbidden'].includes(sealError.state))
      onAuthorizationLost(sealError);
  }, [sealError, onAuthorizationLost]);
  const reload = () => {
    if (!read.canReload) return;
    props.sealCache.clear();
    setAuthorizationError(null);
    read.clear();
    read.reload();
  };
  const listCount = listCountV1(current, orderedItems.length, props.order, seals.state);
  const liveFailed = liveReadFailedV1(read.refreshError, props.order, sealError);
  return (
    <>
      {props.qrMount &&
        createPortal(
          <AccountsQrSectionV1
            qrClass={qrClass}
            current={current}
            client={props.client}
            accounts={orderedItems}
            selected={selectedQr}
            label={props.bulkScopeLabel}
            canWrite={props.canWrite && !authorizationError && !protectedFailure}
            pendingBirth={Boolean(read.refreshing || read.refreshError)}
            onCommitted={onChanged}
            onAuthorizationLost={onAuthorizationLost}
          />,
          props.qrMount,
        )}
      {props.bulkMount &&
        !authorizationError &&
        !protectedFailure &&
        scope.kind === 'class' &&
        createPortal(
          <StudentBulkV1
            key={scope.classId}
            client={props.client}
            scope={scope}
            scopeLabel={props.bulkScopeLabel}
            canWrite={props.canWrite}
            selected={selectedQr}
            onAuthorizationLost={onAuthorizationLost}
          />,
          props.bulkMount,
        )}
      <Card className="pa-account-list-card">
        <Card.Content>
          <div className="pa-account-page-controls" tabIndex={-1} ref={listControl}>
            <p>
              <output className="contents">{listCount}</output>
            </p>
            <LiveReadNoticeV1 failed={liveFailed} />
          </div>

          {maintenance && current ? (
            <Suspense fallback={null}>
              <AvatarBackfillPanelV1
                key={props.classId ?? 'school'}
                subjects={photoSubjects}
                ready={!current.nextCursor}
              />
            </Suspense>
          ) : null}
          <AccountsReadNoticesV1
            readState={read.state}
            authorizationError={authorizationError}
            canReload={read.canReload}
            onReload={reload}
          />
          {current && visibleItems.length === 0 && !current.nextCursor && (
            <p>
              <output className="contents">Nenhuma conta encontrada neste filtro.</output>
            </p>
          )}
          {current && visibleItems.length > 0 && (
            // Rows are kept per account; a class adds the selection column, so its table is another.
            <Table key={qrClass ? 'class' : 'all'} className="pa-account-table">
              <Table.ScrollContainer
                className="pa-account-scroll"
                tabIndex={0}
                role="region"
                aria-label="Tabela de contas, role horizontalmente para todas as colunas"
              >
                <Table.Content
                  aria-label="Contas do Portal"
                  selectionMode={qrClass ? 'multiple' : 'none'}
                  selectedKeys={selectedQr}
                  disabledBehavior="selection"
                  disabledKeys={disabledRows}
                  onSelectionChange={(keys) => setSelectedQr(qrSelectionV1(keys, eligibleQr))}
                >
                  <Table.Header>
                    {qrClass ? (
                      <Table.Column id="selection" aria-label="Selecionar alunos para QR">
                        <Checkbox slot="selection" aria-label="Selecionar alunos disponíveis">
                          <Checkbox.Content>
                            <Checkbox.Control>
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                          </Checkbox.Content>
                        </Checkbox>
                      </Table.Column>
                    ) : null}
                    <Table.Column isRowHeader>Aluno e turma</Table.Column>
                    <Table.Column>Situação</Table.Column>
                    <Table.Column>Acesso</Table.Column>
                    <Table.Column>
                      <Tooltip>
                        <Tooltip.Trigger>Último acesso</Tooltip.Trigger>
                        <Tooltip.Content>
                          Último acesso bem-sucedido nos registros dos últimos 12 meses. Horário de
                          Brasília.
                        </Tooltip.Content>
                      </Tooltip>
                    </Table.Column>
                    <Table.Column>Sessões ativas</Table.Column>
                  </Table.Header>
                  <Table.Body items={visibleItems}>
                    {(account) => accountRowV1(account, row)}
                  </Table.Body>
                </Table.Content>
                {/* Observed again after each growth: a tall screen may still show the end. */}
                <ContinuousEndV1
                  key={visibleLimit}
                  more={moreRows}
                  busy={loadingRows}
                  failed={Boolean(read.refreshError)}
                  loadMore={loadRows}
                  retry={read.reload}
                />
              </Table.ScrollContainer>
            </Table>
          )}
          {current && !visibleItems.length && (
            <ContinuousEndV1
              more={moreRows}
              busy={loadingRows}
              failed={Boolean(read.refreshError)}
              loadMore={loadRows}
              retry={read.reload}
            />
          )}
        </Card.Content>
      </Card>
      {selectedId && !protectedFailure && !authorizationError && (
        <AccountDetailV1
          accountId={selectedId}
          parentScope={scope}
          known={current?.items.find((account) => account.accountId === selectedId)}
          reader={props.reader}
          client={props.client}
          canWrite={props.canWrite}
          onClose={() => {
            setSelectedId(null);
            focusBackV1(selectedTrigger.current, listControl.current);
          }}
          onChanged={onChanged}
          onAuthorizationLost={onAuthorizationLost}
          slots={props.slots}
          onQr={props.onQr}
          onReprint={props.onReprint}
          describeScope={props.describeScope}
        />
      )}
    </>
  );
});
