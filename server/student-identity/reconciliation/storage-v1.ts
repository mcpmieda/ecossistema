import type { GradebookPostgresTransactionV1 } from '../../gradebook/persistence/postgres/postgres-database-v1';
import { lockResetWriterV1 } from '../../student-portal/integration/year-reset/writer-v1';
import { normalizeStudentNameV1 } from '../../../shared/student-identity/reconciliation-normalization-v1';
import type {
  ReconciliationContextV1,
  ReconciliationMutationV1,
} from '../../../shared/student-identity/reconciliation-v1';
import type {
  NormalizedReportRowV1,
  ReconciliationReportRowV1,
  ReconciliationSourceV1,
  ReconciliationStudentV1,
} from './domain-v1';

export type TxV1 = GradebookPostgresTransactionV1;
export type DbRowV1 = Record<string, unknown>;
export class ReconciliationConflictV1 extends Error {
  constructor(public readonly state: 'conflict' | 'expired' | 'invalid-request' = 'conflict') {
    super('reconciliation-conflict');
  }
}
export function stableV1(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableV1).join(',')}]`;
  if (input !== null && typeof input === 'object')
    return `{${Object.entries(input)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableV1(v)}`)
      .join(',')}}`;
  return JSON.stringify(input);
}
export async function digestV1(input: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableV1(input))),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function nullableTextV1(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
export function boolV1(v: unknown): boolean {
  return v === true || v === 1;
}
export async function clockV1(tx: TxV1) {
  const [r] = await tx.query(
    `SELECT clock_timestamp()::text AS now, (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today`,
    [],
  );
  if (!r) throw new Error('reconciliation-clock-unavailable');
  return { now: new Date(String(r.now)), today: String(r.today) };
}
export async function contextV1(
  tx: TxV1,
  year: number,
  lock = false,
): Promise<ReconciliationContextV1> {
  if (lock) {
    await lockResetWriterV1(tx, year);
    await tx.executeNative(
      `INSERT INTO gradebook.student_reconciliation_scope_v1(academic_year) VALUES($1) ON CONFLICT DO NOTHING`,
      [year],
    );
    const revision = await academicRevisionV1(tx, year);
    // A Relação/account/reset write also invalidates list cursors and decisions prepared from an old screen.
    await tx.executeNative(
      `UPDATE gradebook.student_reconciliation_scope_v1 SET
      revision=revision+CASE WHEN academic_revision IS NOT NULL AND academic_revision<>$2 THEN 1 ELSE 0 END,
      academic_revision=$2 WHERE academic_year=$1 AND academic_revision IS DISTINCT FROM $2`,
      [year, revision],
    );
  }
  const [r] = await tx.query(
    `SELECT generation::text,revision::text,name_source,
    EXISTS(SELECT 1 FROM gradebook.ano_letivo WHERE ano=$1) AS relation_available
    FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [year],
  );
  if (!r) throw new ReconciliationConflictV1();
  return {
    generation: String(r.generation),
    revision: Number(r.revision),
    nameSource: r.name_source as 'relation' | 'report',
    relationAvailable: boolV1(r.relation_available),
  };
}
export function assertContextV1(
  context: ReconciliationContextV1,
  request: Pick<ReconciliationMutationV1, 'generation' | 'expectedRevision'>,
) {
  if (context.generation !== request.generation || context.revision !== request.expectedRevision)
    throw new ReconciliationConflictV1();
}
export async function academicRevisionV1(tx: TxV1, year: number): Promise<string> {
  const [r] = await tx.query(
    `SELECT student_portal.reconciliation_revision_v1($1::smallint) AS revision`,
    [year],
  );
  return r ? String(r.revision) : 'absent';
}
export async function advanceV1(tx: TxV1, year: number, publish = false): Promise<void> {
  await tx.executeNative(
    `UPDATE gradebook.student_reconciliation_scope_v1 SET revision=revision+1 WHERE academic_year=$1`,
    [year],
  );
  // The existing deferred trigger captures the account projection and queues invalidation at commit.
  // Preparing a batch only invalidates reset previews; it cannot publish proposed personal data.
  await tx.query(
    `SELECT student_portal.record_gradebook_change_v1($1::uuid,$2::smallint,$3,$4::integer::boolean,
      CASE WHEN $4::integer=1 THEN ARRAY(SELECT id FROM gradebook.aluno WHERE ano=$2) ELSE ARRAY[]::integer[] END,statement_timestamp())`,
    [crypto.randomUUID(), year, publish ? 'relation' : 'audit-treatment', publish ? 1 : 0],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_reconciliation_scope_v1 SET academic_revision=$2 WHERE academic_year=$1`,
    [year, await academicRevisionV1(tx, year)],
  );
}
export function normalizedDbRowV1(r: DbRowV1): NormalizedReportRowV1 {
  return {
    sourceRow: Number(r.source_row ?? 2),
    name: String(r.name),
    nameKey: String(r.name_key),
    birthDate: String(r.birth_date).slice(0, 10),
    filiation1: nullableTextV1(r.filiation1),
    filiation1Key: nullableTextV1(r.filiation1_key),
    inep: nullableTextV1(r.inep),
    inepKey: nullableTextV1(r.inep_key),
    enrollmentHash: String(r.enrollment_hash),
    classLabel: String(r.class_label),
    classKey: String(r.class_key),
    shift: String(r.shift),
    shiftKey: String(r.shift_key),
    stage: Number(r.stage),
    status: String(r.status),
    statusKey: String(r.status_key),
    enrolledAt: nullableTextV1(r.enrolled_at)?.slice(0, 10) ?? null,
    transferredAt: nullableTextV1(r.transferred_at)?.slice(0, 10) ?? null,
  };
}
export async function loadDomainV1(tx: TxV1, year: number) {
  const academic = await tx.query(
    `SELECT a.student_uid::text,a.id,a.nome,v.turma_id,t.codigo,t.etapa,v.situacao,account.legacy_birth_year
    FROM gradebook.aluno a LEFT JOIN gradebook.vinculo v ON v.aluno_id=a.id AND v.ano=a.ano AND v.situacao IS DISTINCT FROM 6
    LEFT JOIN gradebook.turma t ON t.id=v.turma_id
    LEFT JOIN student_portal.reconciliation_accounts_v1($1::smallint) account
      ON account.student_uid=a.student_uid
    WHERE a.ano=$1 ORDER BY a.id,v.turma_id`,
    [year],
  );
  const students: ReconciliationStudentV1[] = academic
    .filter((r) => r.turma_id !== null)
    .map((r) => ({
      studentUid: String(r.student_uid),
      classId: Number(r.turma_id),
      nameKey: normalizeStudentNameV1(String(r.nome)),
      legacyBirthYear:
        r.legacy_birth_year === null || r.legacy_birth_year === undefined
          ? null
          : Number(r.legacy_birth_year),
    }));
  const observations = await tx.query(
    `SELECT o.*,o.birth_date::text,o.enrolled_at::text,o.transferred_at::text,
    c.label AS class_label,c.class_key,c.stage,c.gradebook_class_id,r.current_observation_id::text,r.review_required AS source_review,
    l.student_uid::text,l.review_required AS link_review,(p.observation_id=o.id AND NOT p.review_required) AS profile_selected FROM gradebook.student_source_observation_v1 o
    JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id
    JOIN gradebook.student_source_record_v1 r ON r.id=o.source_id
    LEFT JOIN gradebook.student_source_link_v1 l ON l.source_id=o.source_id AND l.academic_year=o.academic_year
    LEFT JOIN gradebook.student_report_profile_v1 p ON p.academic_year=o.academic_year AND p.student_uid=l.student_uid
    WHERE o.academic_year=$1 ORDER BY o.source_id,o.version`,
    [year],
  );
  const grouped = new Map<string, DbRowV1[]>();
  for (const r of observations) {
    const id = String(r.source_id);
    grouped.set(id, [...(grouped.get(id) ?? []), r]);
  }
  const sources: ReconciliationSourceV1[] = [...grouped].map(([sourceId, rows]) => {
    const current = rows.find((r) => r.id === r.current_observation_id);
    if (!current) throw new Error('reconciliation-source-invalid');
    return {
      sourceId,
      current: normalizedDbRowV1(current),
      studentUid: nullableTextV1(current.student_uid),
      profileSelected: boolV1(current.profile_selected),
      reviewRequired: boolV1(current.source_review) || boolV1(current.link_review),
      history: rows.filter((r) => r !== current).map(normalizedDbRowV1),
    };
  });
  const rejected = await tx.query(
    `SELECT source_id::text,student_uid::text FROM (
    SELECT DISTINCT ON(source_id,student_uid) source_id,student_uid,action
    FROM gradebook.student_reconciliation_decision_v1 WHERE academic_year=$1 AND source_id IS NOT NULL AND student_uid IS NOT NULL
      AND action IN ('reject','separate','release') ORDER BY source_id,student_uid,sequence DESC,recorded_at DESC,id DESC
    ) d WHERE action IN ('reject','separate')`,
    [year],
  );
  return {
    academic,
    observations,
    students,
    sources,
    rejectedPairs: rejected.map((r) => ({
      sourceId: String(r.source_id),
      studentUid: String(r.student_uid),
    })),
  };
}
export type PreparedRowV1 = ReconciliationReportRowV1 & {
  stageLabel: string;
  targetSourceId: string;
  targetObservationId: string;
  targetUid: string | null;
  targetRule: string | null;
  pendingReason: string | null;
  selectedProfile: boolean;
};
export async function savePendingV1(
  tx: TxV1,
  batchId: string,
  year: number,
  rows: readonly PreparedRowV1[],
) {
  // One set-based write; all columns are a closed allowlist, never a raw report blob.
  await tx.executeNative(
    `INSERT INTO gradebook.student_report_pending_row_v1
    (batch_id,academic_year,source_row,name,name_key,birth_date,filiation1,filiation1_key,inep,inep_key,enrollment_hash,
     class_label,class_key,stage_label,stage,shift,shift_key,status,status_key,enrolled_at,transferred_at,gradebook_class_id,
     target_uid,target_source_id,target_observation_id,target_rule,pending_reason,selected_profile)
    SELECT $1::uuid,$2::smallint,x."sourceRow",x.name,x."nameKey",x."birthDate"::date,x.filiation1,x."filiation1Key",x.inep,x."inepKey",x."enrollmentHash",
     x."classLabel",x."classKey",x."stageLabel",x.stage,x.shift,x."shiftKey",x.status,x."statusKey",x."enrolledAt"::date,x."transferredAt"::date,x."classId",
     x."targetUid"::uuid,x."targetSourceId"::uuid,x."targetObservationId"::uuid,x."targetRule",x."pendingReason",x."selectedProfile"
    FROM jsonb_to_recordset($3::text::jsonb) AS x("sourceRow" integer,name text,"nameKey" text,"birthDate" text,filiation1 text,"filiation1Key" text,inep text,"inepKey" text,
     "enrollmentHash" text,"classLabel" text,"classKey" text,"stageLabel" text,stage smallint,shift text,"shiftKey" text,status text,"statusKey" text,
     "enrolledAt" text,"transferredAt" text,"classId" integer,"targetUid" text,"targetSourceId" text,"targetObservationId" text,"targetRule" text,"pendingReason" text,"selectedProfile" boolean)`,
    [batchId, year, JSON.stringify(rows)],
  );
}
