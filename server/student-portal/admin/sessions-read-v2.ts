import { z } from 'zod';
import {
  adminReadResponseV2,
  type AdminReadQueryV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';
import { accountsScopeVersionV1, adminInstantV1 } from './common-v1';
import { ACCOUNT_JOIN_V1, ENROLLED_ACCOUNT_SQL_V1 } from './queries-v1';
import { ADMIN_ACCOUNT_FIELDS_V2, accountReadContextV2 } from './account-read-context-v2';
import { createPolicyResolutionMemoV1 } from '../policies/policy-service-v1';
import type { AdminCursorV1 } from './cursor-v1';
import { accessEndV1 } from '../policies/calendar-v1';

type SessionContextV2 = Awaited<ReturnType<typeof accountReadContextV2>>;
// Built once: a schema created for each session costs more than the validation it performs.
const sessionIdV2 = z.uuid();
const sessionPersistentV2 = z.boolean();
type SessionItemV2 = Extract<
  ReturnType<typeof adminReadResponseV2.parse>,
  { state: 'sessions-read' }
>['items'][number];
type SessionViewV2 = AdminReadQueryV2['sessionView'];

function sessionScopeSqlV2(scope: AdminReadQueryV2['scope']) {
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return '$' + values.length;
  };
  const where = ['a.academic_year=2026', ENROLLED_ACCOUNT_SQL_V1];
  if (scope.kind === 'account') where.push('a.id=' + bind(scope.accountId) + '::uuid');
  if (scope.kind === 'class')
    where.push(`EXISTS (SELECT 1 FROM student_portal.academic_binding_v1 bb
    WHERE bb.student_id=a.gradebook_student_id AND bb.academic_year=a.academic_year
      AND bb.class_id=${bind(scope.classId)} AND bb.status IS DISTINCT FROM 6)`);
  return { predicate: where.join(' AND '), values };
}

async function sessionVersionV2(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  accountVersion: unknown,
) {
  return query.scope.kind === 'account' ? Number(accountVersion) : accountsScopeVersionV1(tx);
}

async function readSessionWindowV2(
  tx: StudentPortalPostgresQueryV1,
  predicate: string,
  values: readonly unknown[],
  position: string | null,
  limit: number,
  view: SessionViewV2,
  now: Date,
) {
  const params = [
    ...values,
    position,
    limit + 1,
    ...(view === 'active' ? [now.toISOString()] : []),
  ];
  return tx.unsafe(
    `SELECT ss.id,ss.account_id,ss.security_version::text,
      ss.created_at,ss.expires_at,ss.revoked_at,ss.persistent
     FROM student_portal.account a JOIN student_portal.session ss ON ss.account_id=a.id
     WHERE ${predicate} AND ($${values.length + 1}::uuid IS NULL OR ss.id>$${values.length + 1}::uuid)
     ${view === 'active' ? `AND ss.revoked_at IS NULL AND ss.expires_at > $${values.length + 3}::timestamptz` : ''}
     ORDER BY ss.id LIMIT $${values.length + 2}`,
    params,
  );
}

async function loadSessionContextsV2(
  tx: StudentPortalPostgresQueryV1,
  rows: readonly Record<string, unknown>[],
  contexts: Map<string, SessionContextV2>,
  now: Date,
) {
  const ids = [...new Set(rows.map((row) => sessionIdV2.parse(row.account_id)))].filter(
    (id) => !contexts.has(id),
  );
  if (!ids.length) return;
  const accounts = await tx.unsafe(
    `SELECT ${ADMIN_ACCOUNT_FIELDS_V2} ${ACCOUNT_JOIN_V1}
     WHERE a.academic_year=2026 AND a.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::text::jsonb)) ORDER BY a.id`,
    [JSON.stringify(ids)],
  );
  const policies = createPolicyResolutionMemoV1();
  for (const account of accounts) {
    const context = await accountReadContextV2(account, now, policies);
    contexts.set(context.item.accountId, context);
  }
}

function sessionMatchesViewV2(view: SessionViewV2, item: SessionItemV2) {
  if (!view) return true;
  return view === 'active' ? item.validity === 'valid' : item.validity !== 'valid';
}

function appendSessionRowsV2(
  rows: readonly Record<string, unknown>[],
  contexts: Map<string, SessionContextV2>,
  now: Date,
  view: SessionViewV2,
  items: SessionItemV2[],
  pageLimit: number,
) {
  let position: string | null = null;
  let scanned = 0;
  for (const row of rows) {
    const mapped = mapSession(row, contexts, now);
    position = sessionIdV2.parse(row.id);
    scanned += 1;
    if (!sessionMatchesViewV2(view, mapped)) continue;
    items.push(mapped);
    if (items.length > pageLimit) break;
  }
  return { position, scanned };
}

function effectiveSessionExpiryV2(
  expiresAt: string,
  created: number,
  persistent: boolean,
  context: SessionContextV2,
  now: Date,
) {
  const { policy } = context;
  if (!policy) return null;
  const end = accessEndV1(policy.enforcedValue, now);
  if (end === Number.NEGATIVE_INFINITY) return null;
  const durationSeconds = persistent
    ? policy.enforcedValue.risk.persistentSeconds
    : policy.enforcedValue.risk.shortSeconds;
  return new Date(
    Math.min(Date.parse(expiresAt), end, created + durationSeconds * 1000),
  ).toISOString();
}

function sessionValidityV2(
  row: Record<string, unknown>,
  context: SessionContextV2,
  created: number,
  expiresAt: string,
  effectiveExpiresAt: string | null,
  revokedAt: string | null,
  now: Date,
): SessionItemV2['validity'] {
  if (revokedAt) return 'revoked';
  if (Date.parse(effectiveExpiresAt ?? expiresAt) <= now.getTime()) return 'expired';
  const current =
    context.item.access.accessPermitted &&
    context.item.state === 'active' &&
    Number(row.security_version) === context.securityVersion &&
    created <= now.getTime();
  return current ? 'valid' : 'unavailable';
}

/** One repeatable-read snapshot. <=100 returned sessions. Filtered feeds scan <=500 rows;
 * <=100 policy contexts per SQL batch, no per-session queries.
 * The membership predicate mirrors SessionServiceV1.revocationScope, including ambiguity.
 * No tokens, hashes, credentials, audit IP or birth data cross this boundary.
 */
export async function readSessionsV2(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  actor: string,
  requestId: string,
  now: Date,
  cursor: AdminCursorV1,
) {
  const after = await cursor.read(query, actor, now);
  if (after?.at) throw new Error('student-portal-cursor-invalid-request');
  const { predicate, values } = sessionScopeSqlV2(query.scope);
  const totals = await tx.unsafe(
    `SELECT count(ss.id) FILTER (WHERE ss.revoked_at IS NULL)::integer AS revocable_count,
    COALESCE(max(a.version),0)::text AS account_version
    FROM student_portal.account a LEFT JOIN student_portal.session ss ON ss.account_id=a.id
    WHERE ${predicate}`,
    values,
  );
  const version = await sessionVersionV2(tx, query, totals[0]!.account_version);
  const contexts = new Map<string, SessionContextV2>();
  const items: SessionItemV2[] = [];
  let position = after?.id ?? null;
  let nextId: string | null = null;
  let scanned = 0;
  // Filtered feeds scan bounded windows, not every session in the school. The cursor is
  // bound to the view and advances over inspected rows, even when none match this window.
  const budget = query.sessionView ? 500 : query.page.limit;
  while (scanned < budget && items.length <= query.page.limit) {
    const limit = Math.min(query.sessionView ? 100 : query.page.limit, budget - scanned);
    const candidates = await readSessionWindowV2(
      tx,
      predicate,
      values,
      position,
      limit,
      query.sessionView,
      now,
    );
    const selected = candidates.slice(0, limit);
    await loadSessionContextsV2(tx, selected, contexts, now);
    const appended = appendSessionRowsV2(
      selected,
      contexts,
      now,
      query.sessionView,
      items,
      query.page.limit,
    );
    position = appended.position ?? position;
    scanned += appended.scanned;
    if (items.length > query.page.limit) {
      nextId = items[query.page.limit - 1]!.sessionId;
      break;
    }
    if (candidates.length <= limit) {
      nextId = null;
      break;
    }
    nextId = position;
    if (!selected.length) break;
  }
  return adminReadResponseV2.parse({
    contractVersion: 2,
    requestId,
    state: 'sessions-read',
    scope: query.scope,
    observedAt: now.toISOString(),
    version,
    revocableCount: totals[0]!.revocable_count,
    ...(query.sessionView ? { sessionView: query.sessionView } : {}),
    items: items.slice(0, query.page.limit),
    nextCursor: nextId ? await cursor.next(query, actor, now, nextId) : null,
  });
}

function mapSession(
  row: Record<string, unknown>,
  contexts: Map<string, SessionContextV2>,
  now: Date,
): SessionItemV2 {
  const accountId = sessionIdV2.parse(row.account_id);
  const context = contexts.get(accountId);
  if (!context) throw new Error('student-portal-admin-scope-unavailable');
  const expiresAt = adminInstantV1(row.expires_at);
  const createdAt = adminInstantV1(row.created_at);
  const created = Date.parse(createdAt);
  const persistent = sessionPersistentV2.parse(row.persistent);
  const effectiveExpiresAt = effectiveSessionExpiryV2(expiresAt, created, persistent, context, now);
  const revokedAt = row.revoked_at === null ? null : adminInstantV1(row.revoked_at);
  return {
    sessionId: sessionIdV2.parse(row.id),
    accountId,
    name: context.item.name,
    classLabel: context.item.classLabel,
    classId: context.item.classId,
    accountVersion: context.item.version,
    createdAt,
    expiresAt,
    effectiveExpiresAt,
    revokedAt,
    persistent,
    validity: sessionValidityV2(
      row,
      context,
      created,
      expiresAt,
      effectiveExpiresAt,
      revokedAt,
      now,
    ),
  };
}
