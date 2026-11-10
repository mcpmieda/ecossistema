import type {
  AdminCommandV1,
  AdminQueryV1,
  AdminResponseV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import type {
  AdminAccountReadV2,
  AdminReadQueryV2,
} from '../../../../shared/student-portal-contracts/admin-read-v2';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import { createPortalAdminReadClientV2 } from '../../../../src/features/student-portal-admin/accounts/accounts-client-v2';
import type { BirthValueV1 } from '../../../../src/features/student-portal-admin/birth-year/birth-read-v1';

const BIRTH_CLASS_V1 = { kind: 'class', academicYear: 2026, classId: 754001 } as const;
const birthIdV1 = (n: number) => '75400000-0000-4000-8000-' + String(n).padStart(12, '0');
export const BIRTH_META_V1 = { contractVersion: 1 as const, requestId: birthIdV1(9000) };
export const birthJsonV1 = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
export type BirthQueryV1 = AdminQueryV1 | AdminReadQueryV2;
export function birthMockV1(
  options: {
    count?: number;
    query?: (query: BirthQueryV1, signal?: AbortSignal | null) => Promise<Response> | undefined;
    write?: (command: AdminCommandV1, signal?: AbortSignal | null) => Promise<Response> | undefined;
  } = {},
) {
  const accounts: AdminAccountReadV2[] = Array.from({ length: options.count ?? 3 }, (_, index) => ({
    accountId: birthIdV1(index + 1),
    link: { academicYear: 2026, studentId: 754000 + index + 1 },
    linkClosed: false,
    name: 'SYNTHETIC BIRTH ' + String(index + 1).padStart(3, '0'),
    classLabel: 'SYNTHETIC BIRTH CLASS',
    classId: 754001,
    state: 'active',
    eligibility: 'eligible',
    blocked: false,
    version: 19 + index,
    access: {
      state: 'resolved',
      enabled: false,
      source: { kind: 'school', academicYear: 2026 },
      settingsVersion: 1,
      accessPermitted: false,
    },
    lastAuthenticationAt: null,
    validSessionCount: 0,
    firstAccess: { state: 'not-required', qrIssued: true, recoveryReady: true },
  }));
  const births = new Map<string, BirthValueV1>(
    accounts.map((account, index) => [
      account.accountId,
      {
        accountId: account.accountId,
        accountVersion: account.version,
        year: index === 0 ? '2000' : null,
        confirmation: index === 0 ? 'unconfirmed-test' : null,
        version: index === 0 ? 7 : 0,
      },
    ]),
  );
  const queries: BirthQueryV1[] = [],
    writes: AdminCommandV1[] = [],
    bodies: string[] = [];
  const receipts = new Map<string, { body: string; result: AdminResponseV1 }>();
  const scopeVersion = 47;
  function apply(item: Extract<AdminCommandV1, { operation: 'birth-write' }>['item']) {
    const account = accounts.find((a) => a.accountId === item.accountId),
      before = births.get(item.accountId);
    if (!account || account.classId !== BIRTH_CLASS_V1.classId || !before)
      return { accountId: item.accountId, state: 'forbidden' as const, version: 0 };
    if (before.version !== item.expectedVersion)
      return { accountId: item.accountId, state: 'conflict' as const, version: before.version };
    const year = item.action === 'set' ? item.year : null,
      confirmation = item.action === 'set' ? item.confirmation : null;
    if (before.year !== year || before.confirmation !== confirmation) {
      account.version++;
      births.set(item.accountId, {
        ...before,
        year,
        confirmation,
        version: before.version + 1,
        accountVersion: account.version,
      });
    }
    return {
      accountId: item.accountId,
      state: 'committed' as const,
      version: births.get(item.accountId)!.version,
    };
  }
  function defaultWrite(command: AdminCommandV1): Response {
    const body = JSON.stringify(command),
      previous = receipts.get(command.idempotencyKey);
    if (previous && previous.body !== body)
      return birthJsonV1({ ...BIRTH_META_V1, state: 'conflict' }, 409);
    if (command.operation === 'birth-write') {
      if (previous) return birthJsonV1(previous.result);
      const account = accounts.find((a) => a.accountId === command.item.accountId);
      if (!account || account.version !== command.expectedVersion)
        return birthJsonV1({ ...BIRTH_META_V1, state: 'conflict' }, 409);
      const outcome = apply(command.item);
      if (outcome.state !== 'committed')
        return birthJsonV1(
          { ...BIRTH_META_V1, state: outcome.state },
          outcome.state === 'conflict' ? 409 : 403,
        );
      const result = {
        ...BIRTH_META_V1,
        state: 'committed' as const,
        operationId: command.idempotencyKey,
        version: account.version,
      };
      receipts.set(command.idempotencyKey, { body, result });
      return birthJsonV1(result);
    }
    if (command.operation === 'birth-batch') {
      if (!previous && command.expectedVersion !== scopeVersion)
        return birthJsonV1({ ...BIRTH_META_V1, state: 'conflict' }, 409);
      const completed = new Map(
        previous?.result.state === 'batch'
          ? previous.result.items.map((x) => [x.accountId, x])
          : [],
      );
      let newItems = 0,
        kdf = 0;
      const items = command.items.map((item) => {
        const prior = completed.get(item.accountId);
        if (prior && prior.state !== 'unavailable') return prior;
        if (kdf >= 1 || newItems >= 2)
          return {
            accountId: item.accountId,
            state: 'unavailable' as const,
            version: item.expectedVersion,
          };
        newItems++;
        if (item.action === 'set') kdf++;
        return apply(item);
      });
      const result = {
        ...BIRTH_META_V1,
        state: 'batch' as const,
        operationId: command.idempotencyKey,
        items,
      };
      receipts.set(command.idempotencyKey, { body, result });
      return birthJsonV1(result);
    }
    return birthJsonV1({ ...BIRTH_META_V1, state: 'invalid-request' }, 400);
  }
  function defaultQuery(query: BirthQueryV1): Response {
    const scope = query.scope;
    if (scope.kind === 'shift')
      return birthJsonV1({ ...BIRTH_META_V1, state: 'invalid-request' }, 400);
    let selected = accounts.filter(
      (account) =>
        scope.kind === 'school' ||
        (scope.kind === 'account'
          ? account.accountId === scope.accountId
          : account.classId === scope.classId),
    );
    if (query.operation === 'birth-years') selected = selected.filter((a) => !a.linkClosed);
    const prefix = query.operation === 'birth-years' ? 'b' : 'a';
    if (query.page.cursor && !query.page.cursor.startsWith(prefix.repeat(32)))
      return birthJsonV1({ ...BIRTH_META_V1, state: 'invalid-request' }, 400);
    const offset = query.page.cursor ? Number(query.page.cursor.slice(32)) : 0;
    const rows = selected.slice(offset, offset + query.page.limit);
    const nextCursor =
      selected.length > offset + query.page.limit
        ? prefix.repeat(32) + String(offset + query.page.limit)
        : null;
    if (query.operation === 'birth-years')
      return birthJsonV1({
        ...BIRTH_META_V1,
        state: 'birth-years',
        scopeVersion,
        accountsScopeVersion: 99,
        nextCursor,
        items: rows.map((a) => ({ ...births.get(a.accountId)!, accountVersion: a.version })),
      });
    return birthJsonV1({
      ...BIRTH_META_V1,
      contractVersion: 2,
      state: 'accounts-read',
      observedAt: '2026-09-13T19:00:00Z',
      scopeVersion: 99,
      lastAuthenticationWindowMonths: 12,
      items: rows,
      nextCursor,
    });
  }
  const fetcher = async (_path: string, init: RequestInit) => {
    const body = String(init.body),
      data = JSON.parse(body);
    if (_path.endsWith('/command')) {
      const command = data as AdminCommandV1;
      writes.push(command);
      bodies.push(body);
      return options.write?.(command, init.signal) ?? defaultWrite(command);
    }
    const query = data as BirthQueryV1;
    queries.push(query);
    return options.query?.(query, init.signal) ?? defaultQuery(query);
  };
  const client = createPortalAdminClientV1({ fetch: fetcher }),
    reader = createPortalAdminReadClientV2({ fetch: fetcher });
  return {
    accounts,
    births,
    queries,
    writes,
    bodies,
    client,
    reader,
    defaultWrite,
    defaultQuery,
    scopeVersion,
    props: {
      client,
      reader,
      scope: BIRTH_CLASS_V1,
      identityKey: 'synthetic-operator-754',
      canWrite: true,
      scopeLabel: 'SYNTHETIC BIRTH CLASS',
    },
  };
}
