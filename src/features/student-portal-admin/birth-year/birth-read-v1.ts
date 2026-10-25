import type { AdminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type { AdminAccountReadV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import { scopeV1, type ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import type { PortalAdminReadClientV2 } from '../accounts/accounts-client-v2';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';

export type BirthScopeV1 = Exclude<ScopeV1, { kind: 'school' }>;
export type InitialBirthAccountV1 = { account: AdminAccountReadV2; scopeVersion: number };
export type BirthValueV1 = Extract<AdminResponseV1, { state: 'birth-years' }>['items'][number];
export interface BirthRecordV1 {
  account: AdminAccountReadV2;
  birth: BirthValueV1;
}
export interface BirthCursorsV1 {
  accounts: string;
  birth: string;
}
export interface BirthPageV1 {
  rows: BirthRecordV1[];
  scopeVersion: number;
  accountsScopeVersion?: number;
  next: BirthCursorsV1 | null;
}

/** The birth read saw exactly the reused account, at its version and in the same account scope. */
function snapshotStillCurrentV1(
  snapshot: AdminAccountReadV2,
  birth: AdminResponseV1,
  initialAccount: InitialBirthAccountV1 | undefined,
) {
  return (
    birth.state === 'birth-years' &&
    birth.accountsScopeVersion !== undefined &&
    birth.accountsScopeVersion === initialAccount?.scopeVersion &&
    birth.items.length === 1 &&
    !birth.nextCursor &&
    birth.items[0]!.accountId === snapshot.accountId &&
    birth.items[0]!.accountVersion === snapshot.version
  );
}

/** The next page exists only while both reads continue. */
function pairedCursorsV1(
  accounts: string | null | undefined,
  birth: string | null | undefined,
): BirthCursorsV1 | null {
  return accounts && birth ? { accounts, birth } : null;
}

/** One account with its birth record: same account version, a coherent year, the account in
 * scope, and an open link in the expected class. */
function pairedRowV1(
  account: BirthRecordV1['account'],
  value: BirthRecordV1['birth'] | undefined,
  scope: BirthScopeV1,
  classId: number | undefined,
): BirthRecordV1 {
  if (!value || account.version !== value.accountVersion) throw new PortalClientErrorV1('conflict');
  if ((value.year === null) !== (value.confirmation === null))
    throw new PortalClientErrorV1('invalid-response');
  if (scope.kind === 'account' && account.accountId !== scope.accountId)
    throw new PortalClientErrorV1('invalid-response');
  if (
    account.linkClosed ||
    !account.link ||
    account.classId === null ||
    (classId !== undefined && account.classId !== classId)
  )
    throw new PortalClientErrorV1('conflict');
  return { account, birth: value };
}

/** A repeated cursor pair would loop forever: refuse it. */
function markCursorSeenV1(seen: Set<string>, cursor: BirthCursorsV1) {
  const key = JSON.stringify(cursor);
  if (seen.has(key)) throw new PortalClientErrorV1('invalid-response');
  seen.add(key);
}

/** Adds a page's rows by account (a later copy replaces an earlier one) and counts the new ones. */
function mergeBirthRowsV1(rows: Map<string, BirthRecordV1>, page: readonly BirthRecordV1[]) {
  let added = 0;
  for (const row of page) {
    if (!rows.has(row.account.accountId)) added++;
    rows.set(row.account.accountId, row);
  }
  return added;
}

/** Two bounded reads, joined by identity and matching account CAS, never by row position.
 * Opaque cursors belong to different operations and must remain separate. */
export async function readBirthPageV1(
  client: PortalAdminClientV1,
  reader: PortalAdminReadClientV2,
  scope: BirthScopeV1,
  cursor: BirthCursorsV1 | undefined,
  signal: AbortSignal,
  expectedClassId?: number,
  initialAccount?: InitialBirthAccountV1,
): Promise<BirthPageV1> {
  const parsed = scopeV1.safeParse(scope);
  if (!parsed.success || parsed.data.kind === 'school')
    throw new PortalClientErrorV1('invalid-request');
  const readAccounts = () =>
    reader.query(
      {
        contractVersion: 2,
        operation: 'accounts-read',
        scope,
        page: { limit: 100, ...(cursor ? { cursor: cursor.accounts } : {}) },
      },
      signal,
    );
  const snapshot =
    scope.kind === 'account' && !cursor && initialAccount?.account.accountId === scope.accountId
      ? initialAccount.account
      : undefined;
  const [loadedAccounts, birth] = await Promise.all([
    snapshot ? Promise.resolve(null) : readAccounts(),
    client.query(
      {
        contractVersion: 1,
        operation: 'birth-years',
        ...(snapshot ? { includeReadContext: true as const } : {}),
        scope,
        page: { limit: 100, ...(cursor ? { cursor: cursor.birth } : {}) },
      },
      signal,
    ),
  ]);
  signal.throwIfAborted();
  // The independently authorized birth read confirms the account CAS before reuse.
  // A changed version falls back to a fresh account query, never an optimistic rebase.
  const accounts =
    loadedAccounts ??
    (snapshot && snapshotStillCurrentV1(snapshot, birth, initialAccount)
      ? {
          state: 'accounts-read' as const,
          items: [snapshot],
          nextCursor: null,
          scopeVersion: initialAccount!.scopeVersion,
        }
      : await readAccounts());
  signal.throwIfAborted();
  if (accounts.state !== 'accounts-read' || birth.state !== 'birth-years')
    throw new PortalClientErrorV1('invalid-response');
  if (accounts.items.length !== birth.items.length || !!accounts.nextCursor !== !!birth.nextCursor)
    throw new PortalClientErrorV1('conflict');
  const births = new Map(birth.items.map((item) => [item.accountId, item]));
  if (
    births.size !== birth.items.length ||
    new Set(accounts.items.map((a) => a.accountId)).size !== accounts.items.length
  )
    throw new PortalClientErrorV1('invalid-response');
  if (scope.kind === 'account' && (accounts.items.length > 1 || accounts.nextCursor))
    throw new PortalClientErrorV1('invalid-response');
  const classId = scope.kind === 'class' ? scope.classId : expectedClassId;
  const rows = accounts.items.map((account) =>
    pairedRowV1(account, births.get(account.accountId), scope, classId),
  );
  return {
    rows,
    scopeVersion: birth.scopeVersion,
    accountsScopeVersion: accounts.scopeVersion,
    next: pairedCursorsV1(accounts.nextCursor, birth.nextCursor),
  };
}

/** Automatic collection for the UI. The first interaction stays to one100-row page; later
 * continuation keeps the paired account/birth cursors and all existing CAS checks. */
export async function readBirthCollectionV1(
  client: PortalAdminClientV1,
  reader: PortalAdminReadClientV2,
  scope: BirthScopeV1,
  signal: AbortSignal,
  desired = 100,
  seed?: BirthPageV1,
  initialAccount?: InitialBirthAccountV1,
): Promise<BirthPageV1> {
  const rows = new Map((seed?.rows ?? []).map((row) => [row.account.accountId, row]));
  const seen = new Set<string>();
  let cursor = seed?.next ?? undefined;
  let result = seed;
  let added = 0;
  for (let i = 0; i < Math.max(20, Math.ceil(desired / 100) + 10); i++) {
    signal.throwIfAborted();
    if (cursor) markCursorSeenV1(seen, cursor);
    const page = await readBirthPageV1(
      client,
      reader,
      scope,
      cursor,
      signal,
      undefined,
      i === 0 ? initialAccount : undefined,
    );
    signal.throwIfAborted();
    if (
      result?.accountsScopeVersion !== undefined &&
      result.accountsScopeVersion !== page.accountsScopeVersion
    )
      throw new PortalClientErrorV1('conflict');
    added += mergeBirthRowsV1(rows, page.rows);
    result = { ...page, rows: [...rows.values()] };
    if (!page.next || added >= desired) return result;
    cursor = page.next;
  }
  if (!result) throw new PortalClientErrorV1('invalid-response');
  return result;
}
