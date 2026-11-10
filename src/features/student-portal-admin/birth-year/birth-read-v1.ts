import type { AdminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type { AdminAccountReadV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import { scopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import type { PortalAdminReadClientV2 } from '../accounts/accounts-client-v2';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';

export type BirthValueV1 = Extract<AdminResponseV1, { state: 'birth-years' }>['items'][number];
type BirthResponseV1 = Extract<AdminResponseV1, { state: 'birth-years' }>;

/** The birth read saw exactly the record's account, at its version and in the same account scope. */
function snapshotStillCurrentV1(account: AdminAccountReadV2, birth: BirthResponseV1, scopeVersion: number) {
  return (
    birth.accountsScopeVersion !== undefined &&
    birth.accountsScopeVersion === scopeVersion &&
    birth.items.length === 1 &&
    !birth.nextCursor &&
    birth.items[0]!.accountId === account.accountId &&
    birth.items[0]!.accountVersion === account.version
  );
}

/**
 * One student's birth year for the record (10/11/2026: the record reads one account only).
 * The independently authorized birth read confirms the account CAS before the record's account is
 * reused; a changed version falls back to a fresh account query, never an optimistic rebase.
 * Null when the account is no longer in its own scope.
 */
export async function readAccountBirthV1(
  client: PortalAdminClientV1,
  reader: PortalAdminReadClientV2,
  account: AdminAccountReadV2,
  scopeVersion: number,
  signal: AbortSignal,
): Promise<BirthValueV1 | null> {
  const parsed = scopeV1.safeParse({
    kind: 'account',
    academicYear: 2026,
    accountId: account.accountId,
  });
  if (!parsed.success || parsed.data.kind !== 'account')
    throw new PortalClientErrorV1('invalid-request');
  const scope = parsed.data;
  const birth = await client.query(
    {
      contractVersion: 1,
      operation: 'birth-years',
      includeReadContext: true,
      scope,
      page: { limit: 100 },
    },
    signal,
  );
  signal.throwIfAborted();
  if (birth.state !== 'birth-years') throw new PortalClientErrorV1('invalid-response');
  let current: AdminAccountReadV2 | undefined = account;
  if (!snapshotStillCurrentV1(account, birth, scopeVersion)) {
    const accounts = await reader.query(
      { contractVersion: 2, operation: 'accounts-read', scope, page: { limit: 100 } },
      signal,
    );
    signal.throwIfAborted();
    if (accounts.state !== 'accounts-read' || accounts.items.length > 1 || accounts.nextCursor)
      throw new PortalClientErrorV1('invalid-response');
    current = accounts.items[0];
  }
  if (birth.nextCursor || birth.items.length > 1) throw new PortalClientErrorV1('invalid-response');
  const value = birth.items[0];
  if (!current && !value) return null;
  if (!current || !value || current.version !== value.accountVersion)
    throw new PortalClientErrorV1('conflict');
  if (value.accountId !== account.accountId || current.accountId !== account.accountId)
    throw new PortalClientErrorV1('invalid-response');
  if ((value.year === null) !== (value.confirmation === null))
    throw new PortalClientErrorV1('invalid-response');
  // Without an open link in a class the year does not apply to this record.
  if (current.linkClosed || !current.link || current.classId === null)
    throw new PortalClientErrorV1('conflict');
  return value;
}
