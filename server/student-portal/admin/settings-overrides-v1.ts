import {
  adminReadResponseV2,
  type AdminReadQueryV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';
import type { AdminCursorV1 } from './cursor-v1';
import { adminInstantV1 } from './common-v1';
import { ACCOUNT_JOIN_V1 } from './queries-v1';

/** Additive, read-only listing. Inherited snapshots are not personalized settings. Shift rules
 * (owner decision 28/09/2026) are listed with the school, never under one class or account.
 * Authorization and repeatable-read transaction belong to the existing admin dispatcher. */
export async function readSettingsOverridesV1(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  actor: string,
  requestId: string,
  now: Date,
  cursor: AdminCursorV1,
) {
  const after = await cursor.read(query, actor, now);
  if (after?.at) throw new Error('student-portal-cursor-invalid-request');
  const args: unknown[] = [query.scope.academicYear];
  const bind = (v: unknown) => {
    args.push(v);
    return '$' + args.length;
  };
  const where = ['TRUE'];
  if (query.scope.kind === 'class') {
    const id = bind(query.scope.classId);
    where.push(
      `((g.scope_kind='class' AND g.class_id=${id}) OR (g.scope_kind='account' AND a.class_id=${id}))`,
    );
  }
  if (query.scope.kind === 'account')
    where.push(`g.scope_kind='account' AND g.account_id=${bind(query.scope.accountId)}::uuid`);
  if (after) where.push(`g.scope_key COLLATE "C" > ${bind(after.id)} COLLATE "C"`);
  const limit = bind(query.page.limit + 1);
  const rows = await tx.unsafe(
    `WITH personalized AS (
    SELECT st.scope_key,st.scope_kind,st.class_id,st.account_id,
      jsonb_object_agg(st.field_key,st.value_json) AS value,max(st.updated_at) AS updated_at
    FROM student_portal.setting st
    WHERE st.academic_year=$1 AND st.scope_kind IN ('class','shift','account')
      AND st.source_scope_json = CASE WHEN st.scope_kind='class'
        THEN jsonb_build_object('kind','class','academicYear',st.academic_year,'classId',st.class_id)
        WHEN st.scope_kind='shift'
        THEN jsonb_build_object('kind','shift','academicYear',st.academic_year,'shift',split_part(st.scope_key,':',3))
        ELSE jsonb_build_object('kind','account','academicYear',st.academic_year,'accountId',st.account_id::text) END
    GROUP BY st.scope_key,st.scope_kind,st.class_id,st.account_id
  ), accounts AS (
    SELECT a.id,s.name,b.class_id,b.class_name ${ACCOUNT_JOIN_V1} WHERE a.academic_year=$1
  ), classes AS (
    SELECT class_id,min(class_name) AS name FROM student_portal.academic_binding_v1
    WHERE academic_year=$1 AND status IS DISTINCT FROM 6 GROUP BY class_id
  ) SELECT g.*,CASE WHEN g.scope_kind='class' THEN COALESCE(c.name,'Turma '||g.class_id::text)
    WHEN g.scope_kind='shift' THEN 'Turno '||initcap(lower(split_part(g.scope_key,':',3)))
    ELSE COALESCE(a.name,'Aluno indisponível') END AS label,
    COALESCE(CASE WHEN g.scope_kind='class' THEN c.name ELSE a.class_name END,'') AS class_label
  FROM personalized g LEFT JOIN accounts a ON a.id=g.account_id
  LEFT JOIN classes c ON c.class_id=g.class_id
  WHERE ${where.join(' AND ')} ORDER BY g.scope_key COLLATE "C" LIMIT ${limit}`,
    args,
  );
  const selected = rows.slice(0, query.page.limit);
  // The override's own scope: a class, a shift (from its key) or a student account.
  const scopeOf = (row: (typeof selected)[number]) => {
    const academicYear = query.scope.academicYear;
    if (row.scope_kind === 'class') return { kind: 'class', academicYear, classId: row.class_id };
    if (row.scope_kind === 'shift')
      return { kind: 'shift', academicYear, shift: String(row.scope_key).split(':')[2] };
    return { kind: 'account', academicYear, accountId: row.account_id };
  };
  return adminReadResponseV2.parse({
    contractVersion: 2,
    state: 'settings-overrides',
    requestId,
    observedAt: now.toISOString(),
    scope: query.scope,
    items: selected.map((row) => ({
      id: row.scope_key,
      scope: scopeOf(row),
      label: row.label,
      classLabel: row.class_label,
      value: row.value,
      updatedAt: adminInstantV1(row.updated_at),
    })),
    nextCursor:
      rows.length > query.page.limit
        ? await cursor.next(query, actor, now, String(selected.at(-1)!.scope_key))
        : null,
  });
}
