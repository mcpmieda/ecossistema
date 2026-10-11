import type {
  AdminAccountReadV2,
  AdminReadQueryV2,
} from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { AdminCommandV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type { ReconciliationResponseV1 } from '../../../../shared/student-identity/reconciliation-v1';
import { SYNTHETIC_QR_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import {
  createPortalAdminReadClientV2,
  type AccountsReadPageV2,
} from '../../../../src/features/student-portal-admin/accounts/accounts-client-v2';
export const ACCOUNT_SCHOOL_V1 = { kind: 'school', academicYear: 2026 } as const;
export const ACCOUNT_CLASS_V1 = { kind: 'class', academicYear: 2026, classId: 753001 } as const;
export const accountIdV1 = (n: number) => '75300000-0000-4000-8000-' + String(n).padStart(12, '0');
export const ACCOUNT_META_V1 = { contractVersion: 1 as const, requestId: accountIdV1(9000) };
export function emptyReconciliationReadV1(operation: unknown): ReconciliationResponseV1 {
  const base = {
    contractVersion: 1 as const,
    state: 'ready' as const,
    context: {
      generation: accountIdV1(9001),
      revision: 1,
      nameSource: 'report' as const,
      relationAvailable: true,
    },
  };
  if (operation === 'catalog')
    return { ...base, operation, classes: [], reportClasses: [] };
  if (operation === 'list') return { ...base, operation, items: [], nextCursor: null };
  throw new Error('Unexpected synthetic reconciliation operation');
}
export const accountJsonV1 = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
export function accountFixtureV1(n = 1): AdminAccountReadV2 {
  return {
    accountId: accountIdV1(n),
    link: { academicYear: 2026, studentId: 753000 + n },
    linkClosed: false,
    name: 'SYNTHETIC ACCOUNT ' + String(n).padStart(3, '0'),
    classLabel: 'SYNTHETIC CLASS A',
    classId: 753001,
    state: 'active',
    eligibility: 'eligible',
    blocked: false,
    version: 9,
    access: {
      state: 'resolved',
      enabled: false,
      source: ACCOUNT_SCHOOL_V1,
      settingsVersion: 2,
      accessPermitted: false,
    },
    lastAuthenticationAt: null,
    validSessionCount: 0,
    firstAccess: { state: 'not-required', qrIssued: true, recoveryReady: true },
  };
}
export function accountPageV1(
  items: AdminAccountReadV2[],
  nextCursor: string | null = null,
): AccountsReadPageV2 {
  return {
    contractVersion: 2,
    requestId: ACCOUNT_META_V1.requestId,
    state: 'accounts-read',
    observedAt: '2026-09-13T15:00:00Z',
    scopeVersion: 4,
    items,
    nextCursor,
    lastAuthenticationWindowMonths: 12,
  };
}
export function accountsMockV1(
  options: {
    count?: number;
    query?: (input: AdminReadQueryV2, signal?: AbortSignal | null) => Promise<Response> | undefined;
    write?: (input: AdminCommandV1, signal?: AbortSignal | null) => Promise<Response>;
  } = {},
) {
  const accounts = Array.from({ length: options.count ?? 3 }, (_, i) => accountFixtureV1(i + 1));
  const queries: AdminReadQueryV2[] = [],
    writes: AdminCommandV1[] = [],
    bodies: string[] = [];
  const reader = createPortalAdminReadClientV2({
    fetch: async (_path, init) => {
      const input: AdminReadQueryV2 = JSON.parse(String(init.body));
      queries.push(input);
      const special = options.query?.(input, init.signal);
      if (special) return special;
      if (input.operation === 'seals-read')
        return accountJsonV1({
          contractVersion: 2,
          requestId: ACCOUNT_META_V1.requestId,
          observedAt: '2026-10-01T15:00:00Z',
          state: 'seals-read',
          items: accounts
            .filter((item) =>
              input.scope.kind === 'account'
                ? item.accountId === input.scope.accountId
                : input.scope.kind === 'class' ? item.classId === input.scope.classId
                  : input.accountIds?.includes(item.accountId),
            )
            .map((item, index) => ({ accountId: item.accountId, seals: index % 3 })),
        });
      let filtered = accounts.filter(
        (item) =>
          (input.scope.kind !== 'account' || item.accountId === input.scope.accountId) &&
          (input.scope.kind !== 'class' || item.classId === input.scope.classId) &&
          (input.accountState === undefined || item.state === input.accountState) &&
          (input.blocked === undefined || item.blocked === input.blocked) &&
          (!input.nameSearch || item.name.toLowerCase().includes(input.nameSearch.toLowerCase())),
      );
      const offset = input.page.cursor ? Number(input.page.cursor.split('_')[0]) : 0;
      filtered = filtered.slice(offset);
      return accountJsonV1(
        accountPageV1(
          filtered.slice(0, input.page.limit),
          filtered.length > input.page.limit
            ? `${offset + input.page.limit}_${'c'.repeat(80)}`
            : null,
        ),
      );
    },
  });
  const client = createPortalAdminClientV1({
    fetch: async (_path, init) => {
      const input: AdminCommandV1 = JSON.parse(String(init.body));
      writes.push(input);
      bodies.push(String(init.body));
      if (options.write) return options.write(input, init.signal);
      if (!('accountId' in input)) throw new Error('Unexpected synthetic command');
      const item = accounts.find((item) => item.accountId === input.accountId)!;
      if (item.version !== input.expectedVersion)
        return accountJsonV1({ ...ACCOUNT_META_V1, state: 'conflict' }, 409);
      item.version++;
      if (input.operation === 'block') item.blocked = input.blocked;
      if (input.operation === 'password-reset') item.state = 'reset-required';
      if (input.operation === 'account-reset') item.state = 'pending-activation';
      return accountJsonV1(
        input.operation === 'qr-regenerate'
          ? {
              ...ACCOUNT_META_V1,
              state: 'qr',
              version: item.version,
              cards: [{ accountId: item.accountId, mode: 'qr-only', qr: SYNTHETIC_QR_V1 }],
            }
          : {
              ...ACCOUNT_META_V1,
              state: 'committed',
              version: item.version,
              operationId: accountIdV1(9001),
            },
      );
    },
  });
  const catalog = async () => ({
    items: [
      { id: 753001, label: 'SYNTHETIC CLASS A' },
      { id: 753002, label: 'SYNTHETIC EMPTY CLASS' },
    ],
    nextOffset: null,
  });
  return {
    accounts,
    queries,
    writes,
    bodies,
    props: {
      reader,
      client,
      catalog,
      scope: ACCOUNT_SCHOOL_V1,
      canWrite: true,
      identityKey: 'synthetic-admin',
    },
  };
}
