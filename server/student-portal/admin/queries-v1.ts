import { portalMaintenanceHealthV1 } from '../observability/maintenance-health-v1';
import { z } from 'zod';
import { auditDetailV1, auditEventV1, type AdminQueryV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { versionV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';
import { accountsScopeVersionV1, adminInstantV1 } from './common-v1';
import type { AdminCursorV1 } from './cursor-v1';
import { scalarTextV1 } from '../../../shared/scalar-text-v1';

export const ACCOUNT_JOIN_V1 = `FROM student_portal.account a
  LEFT JOIN student_portal.academic_student_v1 s ON s.student_id=a.gradebook_student_id AND s.academic_year=a.academic_year
  LEFT JOIN LATERAL (SELECT min(class_id) AS class_id,min(class_name) AS class_name,count(*)::integer AS matches
    FROM student_portal.academic_binding_v1 WHERE student_id=a.gradebook_student_id AND academic_year=a.academic_year
      AND status IS DISTINCT FROM 6) b ON b.matches=1`;
/** The admin lists and operations show only em curso, especial and estava no (owner decision,
 * 26/09/2026): assistido (2), desistente (3), transferido (4) and falecido (5) are hidden. "Foi
 * para" (6) is already history outside the class binding. Needs the `a` account alias.
 */
export const ENROLLED_ACCOUNT_SQL_V1 = `NOT EXISTS(SELECT 1 FROM student_portal.academic_binding_v1 exit_b
  WHERE exit_b.student_id=a.gradebook_student_id AND exit_b.academic_year=a.academic_year
    AND exit_b.status IN (2,3,4,5))`;
export const studentNameOrderSqlV1 = (value: string) =>
  `translate(lower(${value}),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc') COLLATE "C"`;
function accountFilter(query: AdminQueryV1, parameters: unknown[]): string {
  const bind = (value: unknown) => { parameters.push(value); return `$${parameters.length}`; };
  const predicates = ['a.academic_year=2026', ENROLLED_ACCOUNT_SQL_V1];
  if (query.scope.kind === 'account') predicates.push(`a.id=${bind(query.scope.accountId)}::uuid`);
  if (query.scope.kind === 'class') predicates.push(`b.class_id=${bind(query.scope.classId)}`);
  if (query.accountState !== undefined) predicates.push(`a.auth_state=${bind(query.accountState)}`);
  if (query.blocked !== undefined) predicates.push(`a.blocked=${bind(query.blocked)}`);
  if (query.nameSearch !== undefined) predicates.push(`position(lower(${bind(query.nameSearch)}) in lower(COALESCE(s.name,'')))>0`);
  return predicates.join(' AND ');
}

function accountListCursorClause(query: AdminQueryV1, after: { id: string; name?: string } | null,
  parameters: unknown[], key: string, nameOrder: string) {
  if (query.operation === 'birth-years') {
    if (!after) return 'TRUE';
    if (after.name === undefined) throw new Error('student-portal-cursor-invalid-request');
    parameters.push(after.name, after.id);
    const nameParameter = '$' + (parameters.length - 1) + '::text';
    const idParameter = '$' + parameters.length + '::uuid';
    return `(${nameOrder},a.id)>(${studentNameOrderSqlV1(nameParameter)},${idParameter})`;
  }
  parameters.push(after?.id ?? null);
  const idParameter = '$' + parameters.length + '::uuid';
  return `(${idParameter} IS NULL OR ${key}>${idParameter})`;
}

function accountListShape(query: AdminQueryV1) {
  if (query.operation === 'sessions') return {
    fields: 'ss.id,ss.account_id,ss.expires_at,ss.revoked_at',
    join: 'JOIN student_portal.session ss ON ss.account_id=a.id',
  };
  if (query.operation === 'birth-years') return {
    fields: "a.id,a.version::text AS account_version,d.birth_year,d.confirmation,COALESCE(d.version,0)::text AS birth_version,COALESCE(s.name,'') AS name",
    join: 'LEFT JOIN student_portal.account_birth_v1 d ON d.account_id=a.id',
  };
  return {
    fields: `a.id,a.gradebook_student_id,a.auth_state,a.eligibility,a.blocked,a.version::text,
      COALESCE(s.name,'') AS name,COALESCE(b.class_name,'') AS class_name`,
    join: '',
  };
}

async function accountListResultV1(tx: StudentPortalPostgresQueryV1, query: AdminQueryV1,
  selected: Record<string, unknown>[], nextCursor: string | null) {
  if (query.operation === 'sessions') return { items: selected.map((row) => ({ sessionId: row.id, accountId: row.account_id,
    expiresAt: adminInstantV1(row.expires_at), revokedAt: row.revoked_at === null ? null : adminInstantV1(row.revoked_at) })), nextCursor };
  if (query.operation === 'birth-years') {
    const revision = await tx.unsafe('SELECT (academic_counter+portal_link_counter)::text AS version FROM student_portal.academic_revision WHERE academic_year=2026');
    if (revision.length !== 1) throw new Error('student-portal-admin-unavailable');
    return { scopeVersion: versionV1.parse(Number(revision[0]!.version)),
      ...(query.includeReadContext && query.scope.kind === 'account' ? { accountsScopeVersion: await accountsScopeVersionV1(tx) } : {}),
      items: selected.map((row) => ({ accountId: row.id,
      accountVersion: Number(row.account_version), year: row.birth_year === null ? null : scalarTextV1(row.birth_year),
      confirmation: row.confirmation, version: Number(row.birth_version) })), nextCursor };
  }
  return { scopeVersion: await accountsScopeVersionV1(tx), items: selected.map((row) => ({ accountId: row.id,
    link: row.gradebook_student_id === null ? null : { academicYear: 2026, studentId: row.gradebook_student_id },
    name: row.name, classLabel: row.class_name, state: row.auth_state, eligibility: row.eligibility, blocked: row.blocked,
    version: Number(row.version) })), nextCursor };
}

export async function readAccountListV1(tx: StudentPortalPostgresQueryV1, query: AdminQueryV1,
  actor: string, now: Date, cursor: AdminCursorV1) {
  const after = await cursor.read(query, actor, now);
  if (after?.at) throw new Error('student-portal-cursor-invalid-request');
  const alphabetical = query.operation === 'birth-years';
  const parameters: unknown[] = [];
  const filter = accountFilter(query, parameters);
  const key = query.operation === 'sessions' ? 'ss.id' : 'a.id';
  const nameOrder = studentNameOrderSqlV1("COALESCE(s.name,'')");
  const cursorClause = accountListCursorClause(query, after, parameters, key, nameOrder);
  parameters.push(query.page.limit + 1);
  const shape = accountListShape(query);
  const closedFilter = alphabetical ? 'AND a.closed_at IS NULL' : '';
  const orderBy = alphabetical ? nameOrder + ',a.id' : key;
  const rows = await tx.unsafe(`SELECT ${shape.fields} ${ACCOUNT_JOIN_V1} ${shape.join} WHERE ${filter}
    ${closedFilter}
    AND ${cursorClause}
    ORDER BY ${orderBy} LIMIT $${parameters.length}`, parameters);
  const selected = rows.slice(0, query.page.limit);
  let nextCursor: string | null = null;
  if (rows.length > query.page.limit) {
    const last = selected.at(-1)!;
    const name = alphabetical ? String(last.name) : undefined;
    nextCursor = await cursor.next(query, actor, now, z.uuid().parse(last.id), undefined, name);
  }
  return accountListResultV1(tx, query, selected, nextCursor);
}

/** A stored detail that no longer fits the contract is left out rather than failing the list. */
function auditDetailOfV1(value: unknown) {
  const parsed = auditDetailV1.safeParse(value);
  return parsed.success && Object.keys(parsed.data).length ? { detail: parsed.data } : {};
}

/** The audit filters in bind order: the 2026 year and 12 months, the scope (a class through the
 * event's own class or its account), the chosen filters, and the page cursor. */
function auditPredicatesV1(
  query: AdminQueryV1,
  after: Awaited<ReturnType<AdminCursorV1['read']>>,
  bind: (value: unknown) => string,
) {
  const predicates: string[] = ["e.scope_json->>'academicYear'='2026'", "e.occurred_at>statement_timestamp()-interval '12 months'"];
  if (query.scope.kind === 'account') predicates.push(`e.account_id=${bind(query.scope.accountId)}::uuid`);
  if (query.scope.kind === 'class') {
    const classParam = bind(query.scope.classId);
    // With entities the event carries the student's class; otherwise it is found through the account.
    const inClass = query.includeEntities
      ? `e.subject_class_id=${classParam}::integer`
      : `EXISTS(SELECT 1 ${ACCOUNT_JOIN_V1} WHERE a.id=e.account_id AND b.class_id=${classParam}::integer)`;
    predicates.push(`((e.scope_json->>'kind'='class' AND e.scope_json->>'classId'=${classParam}::text)
      OR ${inClass})`);
  }
  if (query.from) predicates.push(`e.occurred_at>=${bind(query.from)}::text::timestamptz`);
  if (query.until) predicates.push(`e.occurred_at<=${bind(query.until)}::text::timestamptz`);
  if (query.event) predicates.push(`e.kind=${bind(query.event)}`);
  if (query.result) predicates.push(`e.result=${bind(query.result)}`);
  if (query.eventId) predicates.push(`e.event_id=${bind(query.eventId)}::uuid`);
  // Keep microseconds as text through postgres.js; its timestamp serializer otherwise truncates to JS milliseconds.
  if (after) predicates.push(`(e.occurred_at,e.event_id)<(${bind(after.at)}::text::timestamptz,${bind(after.id)}::uuid)`);
  return predicates;
}

export async function readAuditV1(tx: StudentPortalPostgresQueryV1, query: AdminQueryV1,
  actor: string, now: Date, cursor: AdminCursorV1) {
  const after = await cursor.read(query, actor, now);
  if (after && !after.at) throw new Error('student-portal-cursor-invalid-request');
  const parameters: unknown[] = [];
  const bind = (value: unknown) => { parameters.push(value); return `$${parameters.length}`; };
  const predicates = auditPredicatesV1(query, after, bind);
  // The IP is shown only in the detail, and only while it is still kept (90 days at most).
  const ipColumns = query.operation === 'audit-detail' ? `,
    CASE WHEN e.ip_expires_at>statement_timestamp() AND e.occurred_at>statement_timestamp()-interval '90 days' THEN host(e.raw_ip) ELSE NULL END AS ip,
    CASE WHEN e.ip_expires_at>statement_timestamp() AND e.occurred_at>statement_timestamp()-interval '90 days'
      THEN LEAST(e.ip_expires_at,e.occurred_at+interval '90 days') ELSE NULL END AS ip_expires_at` : '';
  const rows = await tx.unsafe(`SELECT e.event_id,e.occurred_at,to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,e.actor_id,e.account_id,e.scope_json,e.kind,e.result,
    e.request_id,e.version::text,e.masked_ip,to_jsonb(e)->'detail_json' AS detail_json ${query.includeEntities ? ',e.actor_name,e.subject_name,e.subject_class_id,e.subject_class_label' : ''} ${ipColumns}
    FROM student_portal.audit_event e WHERE ${predicates.join(' AND ')} ORDER BY e.occurred_at DESC,e.event_id DESC
    LIMIT ${bind(query.operation === 'audit-detail' ? 1 : query.page.limit + 1)}`, parameters);
  const event = (row: Record<string, unknown>) => auditEventV1.parse({ eventId: row.event_id, at: adminInstantV1(row.occurred_at),
    actorId: row.actor_id, accountId: row.account_id, scope: row.scope_json, kind: row.kind, result: row.result,
    requestId: row.request_id, version: Number(row.version), maskedIp: row.masked_ip, ...(auditDetailOfV1(row.detail_json)), ...(query.includeEntities ? { entities: { actorName: row.actor_name, subjectName: row.subject_name, classId: row.subject_class_id, classLabel: row.subject_class_label } } : {}) });
  if (query.operation === 'audit-detail') {
    if (rows.length !== 1) throw new Error('student-portal-audit-forbidden');
    return { ...(query.includeReadContext ? { observedAt: now.toISOString() } : {}), event: event(rows[0]!), ip: rows[0]!.ip,
      ipExpiresAt: rows[0]!.ip_expires_at === null ? null : adminInstantV1(rows[0]!.ip_expires_at) };
  }
  const selected = rows.slice(0, query.page.limit);
  const last = selected.at(-1);
  return { items: selected.map(event), nextCursor: rows.length > query.page.limit
    ? await cursor.next(query, actor, now, z.uuid().parse(last!.event_id), z.string().parse(last!.cursor_at)) : null };
}

export async function readAdminHealthV1(tx: StudentPortalPostgresQueryV1, query: AdminQueryV1) {
  const parameters: unknown[] = [];
  const filter = accountFilter(query, parameters);
  // Both reads are independent: they share the connection without waiting for each other.
  const [rows, maintenance] = await Promise.all([
    tx.unsafe(`SELECT
    COALESCE(bool_or(j.state='failed' AND j.attempts>=5),false) AS intervention,
    COALESCE(bool_or(j.state IN ('queued','running') AND j.next_attempt_at<statement_timestamp()-interval '5 minutes'
      AND (j.lease_until IS NULL OR j.lease_until<statement_timestamp())),false) AS attention
    ${ACCOUNT_JOIN_V1} JOIN student_portal.publication_job j ON j.account_id=a.id WHERE ${filter}`, parameters),
    portalMaintenanceHealthV1(tx),
  ]);
  let status: 'intervention' | 'attention' | 'normal' = 'normal';
  if (rows[0]?.intervention || maintenance.status === 'intervention') status = 'intervention';
  else if (rows[0]?.attention || maintenance.status === 'attention') status = 'attention';
  return { status };
}
