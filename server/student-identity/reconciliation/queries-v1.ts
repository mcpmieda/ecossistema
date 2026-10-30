import { z } from 'zod';
import { normalizeStudentNameV1 } from '../../../shared/student-identity/reconciliation-normalization-v1';
import { seal, unseal } from '../../auth/sealed';
import {
  RECONCILIATION_PENDING_CAP_V1,
  reconciliationListItemV1,
  type ReconciliationContextV1,
  type ReconciliationRequestV1,
  type ReconciliationResponseV1,
} from '../../../shared/student-identity/reconciliation-v1';
import {
  boolV1,
  clockV1,
  digestV1,
  loadDomainV1,
  nullableTextV1,
  ReconciliationConflictV1,
  scalarTextV1,
  type TxV1,
} from './storage-v1';
const cursorSchema = z
  .object({
    actor: z.string(),
    query: z.string(),
    generation: z.string(),
    revision: z.number(),
    expires: z.number(),
    key: z.string(),
  })
  .strict();
export async function catalogV1(
  tx: TxV1,
  year: number,
  context: ReconciliationContextV1,
): Promise<ReconciliationResponseV1> {
  const classes = await tx.query(
    `SELECT id,codigo,etapa FROM gradebook.turma WHERE ano=$1 ORDER BY codigo,id`,
    [year],
  );
  const report = await tx.query(
    `SELECT id::text,label,shift,stage_label,gradebook_class_id,review_required FROM gradebook.student_report_class_v1 WHERE academic_year=$1
    UNION ALL SELECT DISTINCT 'pending:'||b.id::text||':'||md5(jsonb_build_array(p.class_label,p.shift,p.stage_label)::text),p.class_label,p.shift,p.stage_label,NULL::integer,false
    FROM gradebook.student_report_pending_row_v1 p JOIN gradebook.student_report_batch_v1 b ON b.id=p.batch_id
    WHERE b.academic_year=$1 AND b.state='awaiting_relation' AND b.expires_at>clock_timestamp() ORDER BY label,id`,
    [year],
  );
  return {
    contractVersion: 1,
    state: 'ready',
    operation: 'catalog',
    context,
    classes: classes.map((r) => ({
      id: Number(r.id),
      label: String(r.codigo),
      stage: Number(r.etapa),
    })),
    reportClasses: report.map((r) => ({
      id: String(r.id),
      label: String(r.label),
      shift: String(r.shift),
      stageLabel: String(r.stage_label),
      classId: r.gradebook_class_id === null ? null : Number(r.gradebook_class_id),
      reviewRequired: boolV1(r.review_required),
    })),
  };
}
/** Every row of the Conciliação: the students of the year and the report rows not linked yet. */
const RECONCILIATION_ROWS_SQL_V1 = `WITH people AS (
    SELECT 'p:'||a.student_uid::text AS key,jsonb_build_object('kind','person','studentUid',a.student_uid,'academicStudentId',a.id,'academicYear',a.ano,
      'name',CASE WHEN s.name_source='report' THEN COALESCE(o.name,a.nome) ELSE a.nome END,'relationName',a.nome,
      'classId',v.turma_id,'classLabel',t.codigo,'version',COALESCE(p.version,0),
      'reconciliation',CASE WHEN p.review_required OR r.review_required OR EXISTS(SELECT 1 FROM gradebook.student_source_link_v1 reviewed JOIN gradebook.student_source_record_v1 origin ON origin.id=reviewed.source_id WHERE reviewed.academic_year=a.ano AND reviewed.student_uid=a.student_uid AND (reviewed.review_required OR origin.pending_reason='profile_conflict')) THEN 'review-required' WHEN p.student_uid IS NULL AND EXISTS(SELECT 1 FROM gradebook.student_source_link_v1 l WHERE l.academic_year=a.ano AND l.student_uid=a.student_uid) THEN 'pending'
        WHEN p.student_uid IS NULL THEN 'without-report' WHEN r.last_batch_id IS DISTINCT FROM s.current_batch_id THEN 'missing-current-report' ELSE 'reconciled' END,
      'portal',CASE WHEN ac.account_id IS NOT NULL AND ac.closed_at IS NULL THEN 'with-portal' ELSE 'without-portal' END,'accountId',ac.account_id,
      'possibleSamePerson',false) AS item,
      v.turma_id AS class_id,CASE WHEN s.name_source='report' THEN COALESCE(o.name,a.nome) ELSE a.nome END AS name
    FROM gradebook.aluno a JOIN gradebook.student_reconciliation_scope_v1 s ON s.academic_year=a.ano
    LEFT JOIN LATERAL(SELECT turma_id,situacao FROM gradebook.vinculo WHERE aluno_id=a.id AND ano=a.ano ORDER BY (situacao IS DISTINCT FROM 6) DESC,turma_id DESC LIMIT 1) v ON true
    LEFT JOIN gradebook.turma t ON t.id=v.turma_id
    LEFT JOIN gradebook.student_report_profile_v1 p ON p.academic_year=a.ano AND p.student_uid=a.student_uid
    LEFT JOIN gradebook.student_source_observation_v1 o ON o.id=p.observation_id
    LEFT JOIN gradebook.student_source_record_v1 r ON r.id=o.source_id
    LEFT JOIN student_portal.reconciliation_accounts_v1($1::smallint) ac ON ac.student_uid=a.student_uid WHERE a.ano=$1
  ), external AS (
    SELECT 'e:'||r.id::text AS key,jsonb_build_object('kind','external','id',r.id,'sourceId',r.id,'batchId',r.last_batch_id,
      'name',o.name,'classLabel',c.label,'reason',COALESCE(r.pending_reason,'pending'),'expiresAt',NULL,'warning',false,'sourceRow',NULL) AS item,
      c.gradebook_class_id AS class_id,o.name FROM gradebook.student_source_record_v1 r JOIN gradebook.student_source_observation_v1 o ON o.id=r.current_observation_id
      JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id
      LEFT JOIN gradebook.student_source_link_v1 l ON l.academic_year=r.academic_year AND l.source_id=r.id
      WHERE r.academic_year=$1 AND (l.source_id IS NULL OR r.review_required OR l.review_required)
    UNION ALL SELECT 'w:'||b.id::text||':'||lpad(p.source_row::text,5,'0'),jsonb_build_object('kind','external','id',b.id::text||':'||p.source_row::text,
      'sourceId',NULL,'batchId',b.id,'name',p.name,'classLabel',p.class_label,'reason','awaiting_relation','expiresAt',b.expires_at,
      'warning',clock_timestamp()>=b.received_at+interval '27 days','sourceRow',p.source_row),NULL,p.name
    FROM gradebook.student_report_pending_row_v1 p JOIN gradebook.student_report_batch_v1 b ON b.id=p.batch_id
      WHERE b.academic_year=$1 AND b.state='awaiting_relation' AND b.expires_at>clock_timestamp()
  ) `;

/** How many rows the pending view lists (the rule of the screen), counted up to one past the cap. */
export async function pendingCountV1(tx: TxV1, academicYear: number): Promise<ReconciliationResponseV1> {
  const [row] = await tx.query(
    `${RECONCILIATION_ROWS_SQL_V1} SELECT count(*)::integer AS pending FROM (SELECT 1 FROM (SELECT item FROM people UNION ALL SELECT item FROM external) all_rows
    WHERE all_rows.item->>'kind'='external' OR all_rows.item->>'reconciliation'<>'reconciled' LIMIT $2) counted`,
    [academicYear, RECONCILIATION_PENDING_CAP_V1 + 1],
  );
  return { contractVersion: 1, state: 'ready', operation: 'pending-count', pending: Number(row?.pending ?? 0) };
}

export async function listV1(
  tx: TxV1,
  actor: string,
  request: Extract<ReconciliationRequestV1, { operation: 'list' }>,
  context: ReconciliationContextV1,
  secret: string,
): Promise<ReconciliationResponseV1> {
  const clock = await clockV1(tx),
    query = await digestV1({ ...request, cursor: null });
  const keySecret = `student-reconciliation-cursor-v1:${secret}`;
  let after = '';
  if (request.cursor) {
    const c = cursorSchema.safeParse(await unseal(request.cursor, keySecret));
    if (
      !c.success ||
      c.data.actor !== actor ||
      c.data.query !== query ||
      c.data.generation !== context.generation ||
      c.data.revision !== context.revision ||
      c.data.expires <= clock.now.getTime()
    )
      throw new ReconciliationConflictV1();
    after = c.data.key;
  }
  const rows = await tx.query(
    `${RECONCILIATION_ROWS_SQL_V1} SELECT key,item FROM (SELECT * FROM people UNION ALL SELECT * FROM external) all_rows
    WHERE key>$2 AND ($3::integer IS NULL OR class_id=$3) AND name ILIKE $4 ORDER BY key LIMIT $5`,
    [request.academicYear, after, request.classId, `%${request.search}%`, request.limit + 1],
  );
  const page = rows.slice(0, request.limit);
  const peers = await tx.query(
    `SELECT a.student_uid::text,a.nome,t.etapa,t.id AS class_id FROM gradebook.aluno a
    JOIN gradebook.vinculo v ON v.aluno_id=a.id AND v.ano=a.ano JOIN gradebook.turma t ON t.id=v.turma_id AND t.ano=v.ano
    WHERE a.ano=$1 AND v.situacao IS NULL`,
    [request.academicYear],
  );
  const sameName = new Map<string, (typeof peers)[number][]>();
  for (const peer of peers) {
    const key = JSON.stringify([peer.etapa, normalizeStudentNameV1(String(peer.nome))]);
    sameName.set(key, [...(sameName.get(key) ?? []), peer]);
  }
  const signaled = new Set<string>();
  for (const group of sameName.values())
    for (const peer of group)
      if (
        group.some(
          (other) => other.student_uid !== peer.student_uid && other.class_id !== peer.class_id,
        )
      )
        signaled.add(String(peer.student_uid));
  return {
    contractVersion: 1,
    state: 'ready',
    operation: 'list',
    context,
    items: page.map((r) => {
      const item = reconciliationListItemV1.parse(
        typeof r.item === 'string' ? JSON.parse(r.item) : r.item,
      );
      return item.kind === 'person'
        ? { ...item, possibleSamePerson: signaled.has(item.studentUid) }
        : item;
    }),
    nextCursor:
      rows.length > request.limit
        ? await seal(
            {
              actor,
              query,
              generation: context.generation,
              revision: context.revision,
              expires: clock.now.getTime() + 300000,
              key: String(page.at(-1)!.key),
            },
            keySecret,
          )
        : null,
  };
}
export async function detailV1(
  tx: TxV1,
  request: Extract<ReconciliationRequestV1, { operation: 'detail' }>,
  context: ReconciliationContextV1,
): Promise<ReconciliationResponseV1> {
  const rows = await tx.query(
    `SELECT r.id::text,r.review_required,o.id::text AS observation_id,o.name,o.birth_date::text,o.filiation1,o.inep,c.label,
    l.student_uid::text,COALESCE(l.version,0)::text AS version,l.decision_id::text,l.review_required AS link_review,c.gradebook_class_id
    FROM gradebook.student_source_record_v1 r JOIN gradebook.student_source_observation_v1 o ON o.id=r.current_observation_id
    JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id LEFT JOIN gradebook.student_source_link_v1 l ON l.source_id=r.id AND l.academic_year=r.academic_year
    WHERE r.academic_year=$1 AND (($2::uuid IS NOT NULL AND r.id=$2::uuid) OR ($3::uuid IS NOT NULL AND l.student_uid=$3::uuid)) ORDER BY r.id LIMIT 100`,
    [request.academicYear, request.sourceId ?? null, request.studentUid ?? null],
  );
  const domain = await loadDomainV1(tx, request.academicYear);
  const [profile] = await tx.query(
    `SELECT observation_id::text FROM gradebook.student_report_profile_v1 WHERE academic_year=$1 AND student_uid=$2::uuid`,
    [request.academicYear, request.studentUid ?? null],
  );
  const history = await tx.query(
    `SELECT id::text,action,recorded_at::text,reason,sequence::text FROM gradebook.student_reconciliation_decision_v1
    WHERE academic_year=$1 AND (($2::uuid IS NOT NULL AND source_id=$2::uuid) OR ($3::uuid IS NOT NULL AND student_uid=$3::uuid))
    ORDER BY sequence DESC,recorded_at DESC,id DESC LIMIT 100`,
    [request.academicYear, request.sourceId ?? null, request.studentUid ?? null],
  );
  return {
    contractVersion: 1,
    state: 'ready',
    operation: 'detail',
    context,
    selectedObservationId: nullableTextV1(profile?.observation_id),
    sources: rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      birthDate: String(r.birth_date),
      filiation1: nullableTextV1(r.filiation1),
      inep: nullableTextV1(r.inep),
      classLabel: String(r.label),
      studentUid: nullableTextV1(r.student_uid),
      version: Number(r.version),
      observationId: String(r.observation_id),
      decisionId: nullableTextV1(r.decision_id),
      reviewRequired: boolV1(r.review_required) || boolV1(r.link_review),
    })),
    candidates: domain.academic
      .filter(
        (r) =>
          rows.some((s) => s.gradebook_class_id === r.turma_id) ||
          r.student_uid === request.studentUid,
      )
      .slice(0, 100)
      .map((r) => ({
        studentUid: String(r.student_uid),
        name: String(r.nome),
        classLabel: scalarTextV1(r.codigo ?? ''),
      })),
    history: history.map((r) => ({
      id: String(r.id),
      action: String(r.action),
      at: new Date(String(r.recorded_at)).toISOString(),
      reason: String(r.reason),
      version: Number(r.sequence),
    })),
  };
}

/** The Coletor's last automatic report: what it applied and the differences it left here. */
export async function automaticReportV1(tx: TxV1, academicYear: number): Promise<ReconciliationResponseV1> {
  const [row] = await tx.query(
    `SELECT last_observed_at::text,last_changed_at::text,outcome,rows,notes_json FROM attendance.student_report_state_v2 WHERE academic_year=$1`,
    [academicYear],
  );
  // A jsonb column arrives parsed or as text, depending on the driver.
  const stored = typeof row?.notes_json === 'string' ? JSON.parse(row.notes_json) : row?.notes_json;
  const notes = row
    ? (stored as {
        counts: { rows: number; linked: number; pending: number } | null;
        differences: string[];
        invalid: { sourceRow: number; name: string; classLabel: string; field: string; reason: string }[];
      })
    : null;
  return {
    contractVersion: 1,
    state: 'ready',
    operation: 'automatic-report',
    report:
      row && notes
        ? {
            observedAt: new Date(String(row.last_observed_at)).toISOString(),
            changedAt: new Date(String(row.last_changed_at)).toISOString(),
            outcome: String(row.outcome) as 'applied' | 'preparing' | 'awaiting_relation' | 'review',
            rows: Number(row.rows),
            counts: notes.counts,
            differences: notes.differences,
            invalid: notes.invalid,
          }
        : null,
  };
}
