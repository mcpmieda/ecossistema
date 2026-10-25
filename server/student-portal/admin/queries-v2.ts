import { readCustomizationsV1 } from './customizations-read-v1';
import { readClosingPreviewV2 } from './closing-preview-v2';
import { readSettingsOverridesV1 } from './settings-overrides-v1';
import { readShiftsV1 } from './shifts-read-v1';
import { readSealsV1 } from './seals-read-v1';
import type { SealCacheWriteV1 } from './seal-cache-v1';
import { z } from 'zod';
import { ADMIN_ACCOUNT_FIELDS_V2, accountReadContextV2 } from './account-read-context-v2';
import { readSessionsV2 } from './sessions-read-v2';
import {
  ADMIN_OVERVIEW_ACCOUNT_LIMIT_V2,
  adminAccountReadV2,
  adminReadResponseV2,
  type AdminReadQueryV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';
import { accountsScopeVersionV1 } from './common-v1';
import { accessEndV1 } from '../policies/calendar-v1';
import { createPolicyResolutionMemoV1 } from '../policies/policy-service-v1';
import {
  ACCOUNT_JOIN_V1,
  ENROLLED_ACCOUNT_SQL_V1,
  readAdminHealthV1,
  studentNameOrderSqlV1,
} from './queries-v1';
import type { AdminCursorV1 } from './cursor-v1';

const sessionAccountV2 = z.uuid();
const sessionCountV2 = z.number().int().nonnegative().safe();

/** Fixed query count: one bounded account/policy batch, one session aggregate, sent together with
 * the scope version and, for the overview, the health reads.
 * The caller owns a read-only repeatable-read transaction; no lock or per-account query.
 */
export async function readAdminV2(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  actor: string,
  requestId: string,
  now: Date,
  cursor: AdminCursorV1,
  pendingSealWrites?: SealCacheWriteV1[],
) {
  if (query.operation === 'closing-preview') return readClosingPreviewV2(tx, query, requestId, now);
  if (query.operation === 'customizations-read')
    return readCustomizationsV1(tx, query, actor, requestId, now, cursor);
  if (query.operation === 'settings-overrides')
    return readSettingsOverridesV1(tx, query, actor, requestId, now, cursor);
  if (query.operation === 'shifts-read') return readShiftsV1(tx, query, requestId, now);
  if (query.operation === 'seals-read') return readSealsV1(tx, query, requestId, now, pendingSealWrites);
  if (query.operation === 'sessions-read')
    return readSessionsV2(tx, query, actor, requestId, now, cursor);
  return readAccountsV2(tx, query, { actor, requestId, now, cursor });
}

/** The account list or the overview: one bounded account batch, sessions counted together. */
async function readAccountsV2(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  { actor, requestId, now, cursor }: { actor: string; requestId: string; now: Date; cursor: AdminCursorV1 },
) {
  const after = await cursor.read(query, actor, now);
  if (after?.at) throw new Error('student-portal-cursor-invalid-request');
  const alphabetical = query.operation === 'accounts-read';
  if (alphabetical && after && after.name === undefined)
    throw new Error('student-portal-cursor-invalid-request');
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const nameOrder = studentNameOrderSqlV1("COALESCE(s.name,'')");
  const where = accountWhereV2(query, bind);
  if (after) where.push(afterWhereV2(after, alphabetical, nameOrder, bind));
  const clock = bind(now.toISOString());
  const limit = query.operation === 'overview' ? ADMIN_OVERVIEW_ACCOUNT_LIMIT_V2 : query.page.limit;
  const orderBy = alphabetical ? nameOrder + ',a.id' : 'a.id';
  // Reads that do not depend on the account rows go out on the same connection without waiting
  // for them: each one would otherwise cost its own round trips to the database.
  const pending = Promise.all([
    tx.unsafe(
    `SELECT ${ADMIN_ACCOUNT_FIELDS_V2},
    (SELECT max(e.occurred_at) FROM student_portal.audit_event e WHERE e.account_id=a.id
      AND e.kind IN ('login','activated') AND e.result='success'
      AND e.occurred_at>${clock}::timestamptz-interval '12 months'
      AND e.occurred_at<=${clock}::timestamptz) AS last_authentication
    ${ACCOUNT_JOIN_V1} WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ${bind(limit + 1)}`,
    values,
    ),
    accountsScopeVersionV1(tx),
    query.operation === 'overview'
      ? readAdminHealthV1(tx, { ...query, contractVersion: 1, operation: 'health' })
      : Promise.resolve(null),
  ] as const);
  const [rows, scopeVersion, health] = await pending;
  if (query.operation === 'overview' && rows.length > limit)
    throw new Error('student-portal-admin-scope-unavailable');
  const selected = rows.slice(0, limit);
  const { items, sessionPolicies } = await accountItemsV2(selected, now);
  if (sessionPolicies.length > 0) await countValidSessionsV2(tx, items, sessionPolicies, now);
  const base = {
    contractVersion: 2,
    requestId,
    observedAt: now.toISOString(),
    scopeVersion,
  };
  if (query.operation === 'accounts-read')
    return adminReadResponseV2.parse({
      ...base,
      state: 'accounts-read',
      items,
      nextCursor:
        rows.length > limit ? await cursor.next(query, actor, now, items.at(-1)!.accountId, undefined,
          String(selected.at(-1)!.name)) : null,
      lastAuthenticationWindowMonths: 12,
    });
  return overviewResponseV2(base, items, health!.status);
}

type SessionPolicyV2 = { id: string; security: number; end: string; persistent: number; short: number };
type AdminAccountItemV2 = z.infer<typeof adminAccountReadV2>;

/** The filters of the read; a single record opens even after the student left (audit links,
 * 29/09/2026), while lists and totals keep showing only enrolled students. */
function accountWhereV2(
  query: AdminReadQueryV2,
  bind: (value: unknown) => string,
) {
  const where = ['a.academic_year=2026'];
  if (query.scope.kind !== 'account' || query.operation !== 'accounts-read') where.push(ENROLLED_ACCOUNT_SQL_V1);
  if (query.scope.kind === 'account') where.push(`a.id=${bind(query.scope.accountId)}::uuid`);
  if (query.scope.kind === 'class') where.push(`b.class_id=${bind(query.scope.classId)}`);
  if (query.accountState !== undefined) where.push(`a.auth_state=${bind(query.accountState)}`);
  if (query.blocked !== undefined) where.push(`a.blocked=${bind(query.blocked)}`);
  if (query.nameSearch !== undefined)
    where.push(`position(lower(${bind(query.nameSearch)}) in lower(COALESCE(s.name,'')))>0`);
  return where;
}

/** The page's start: after a name and id (alphabetical list) or after an id. */
function afterWhereV2(
  after: { id: string; name?: string },
  alphabetical: boolean,
  nameOrder: string,
  bind: (value: unknown) => string,
) {
  if (!alphabetical) return `a.id>${bind(after.id)}::uuid`;
  const afterName = studentNameOrderSqlV1(bind(after.name) + '::text');
  const afterId = bind(after.id) + '::uuid';
  return `(${nameOrder},a.id)>(${afterName},${afterId})`;
}

/** Each account as the ADM reads it, and the session rules of those that may be signed in now. */
async function accountItemsV2(selected: readonly Readonly<Record<string, unknown>>[], now: Date) {
  const sessionPolicies: SessionPolicyV2[] = [];
  const items: AdminAccountItemV2[] = [];
  // Classmates share the same stored rules: resolve them once for this read.
  const policies = createPolicyResolutionMemoV1();
  for (const row of selected) {
    const { item, policy, securityVersion } = await accountReadContextV2(row, now, policies);
    items.push(item);
    if (item.access.accessPermitted && item.state === 'active' && policy) {
      const end = accessEndV1(policy.enforcedValue, now);
      sessionPolicies.push({
        id: item.accountId,
        security: securityVersion,
        // No scheduled close: timestamptz 'infinity' keeps LEAST() on the other limits.
        end: Number.isFinite(end) ? new Date(end).toISOString() : 'infinity',
        persistent: policy.enforcedValue.risk.persistentSeconds,
        short: policy.enforcedValue.risk.shortSeconds,
      });
    }
  }
  return { items, sessionPolicies };
}

/** The still valid sessions of each account, in one aggregate. */
async function countValidSessionsV2(
  tx: StudentPortalPostgresQueryV1,
  items: AdminAccountItemV2[],
  sessionPolicies: readonly SessionPolicyV2[],
  now: Date,
) {
  const sessions = await tx.unsafe(
    `SELECT s.account_id,count(*)::integer AS count
    FROM jsonb_to_recordset($1::text::jsonb) AS p(id uuid,security bigint,"end" timestamptz,persistent integer,short integer)
    JOIN student_portal.session s ON s.account_id=p.id
    WHERE s.revoked_at IS NULL AND s.security_version=p.security AND s.created_at<=$2::timestamptz
      AND LEAST(s.expires_at,p."end",s.created_at+make_interval(secs=>CASE WHEN s.persistent THEN p.persistent ELSE p.short END))>$2::timestamptz
    GROUP BY s.account_id`,
    [JSON.stringify(sessionPolicies), now.toISOString()],
  );
  const counts = new Map(
    sessions.map((row) => [sessionAccountV2.parse(row.account_id), sessionCountV2.parse(row.count)]),
  );
  for (const item of items) item.validSessionCount = counts.get(item.accountId) ?? 0;
}

function overviewResponseV2(
  base: { contractVersion: number; requestId: string; observedAt: string; scopeVersion: unknown },
  items: readonly AdminAccountItemV2[],
  health: unknown,
) {
  const count = (predicate: (item: (typeof items)[number]) => boolean) =>
    items.filter(predicate).length;
  return adminReadResponseV2.parse({
    ...base,
    state: 'overview',
    counts: {
      accounts: items.length,
      active: count((item) => item.state === 'active'),
      pendingActivation: count((item) => item.state === 'pending-activation'),
      resetRequired: count((item) => item.state === 'reset-required'),
      blocked: count((item) => item.blocked),
      unresolved: count((item) => item.eligibility === 'unresolved'),
      unlinked: count((item) => item.eligibility === 'unlinked'),
      accessEnabled: count((item) => item.access.enabled === true),
      accessPermitted: count((item) => item.access.accessPermitted),
      validSessions: items.reduce((total, item) => total + item.validSessionCount, 0),
    },
    health,
  });
}
