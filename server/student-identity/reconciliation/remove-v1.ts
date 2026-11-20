import type {
  ReconciliationContextV1,
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../../shared/student-identity/reconciliation-v1';
import {
  advanceV1,
  assertContextV1,
  boolV1,
  contextV1,
  digestV1,
  nullableTextV1,
  ReconciliationConflictV1,
  type TxV1,
} from './storage-v1';

type RemoveRequestV1 = Extract<ReconciliationRequestV1, { operation: 'remove-student' }>;

/**
 * "Excluir aluno lançado por engano" (owner request 20/11/2026): a student is removed only when
 * nothing in the system keeps it. A row in any of these relations means a real student.
 */
const BY_STUDENT_ID_V1 = [
  'gradebook.nota',
  'gradebook.nota_historico',
  'gradebook.fechamento',
  'gradebook.fechamento_historico',
  'gradebook.boletim_snapshot',
  'gradebook.conselho_decisao',
  'gradebook.conselho_decisao_historico',
  'gradebook.conselho_anterior_historico',
  'gradebook.conselho_votacao',
  'gradebook.conselho_votacao_historico',
  'gradebook.conselho_decisao_comando',
  'gradebook.conselho_fechamento_item',
  'gradebook.conselho_idempotencia',
] as const;
const BY_STUDENT_UID_V1: readonly (readonly [string, string])[] = [
  ['gradebook.student_source_link_v1', 'student_uid'],
  ['gradebook.student_report_profile_v1', 'student_uid'],
  ['gradebook.student_reconciliation_decision_v1', 'student_uid'],
  ['gradebook.student_report_pending_row_v1', 'target_uid'],
  ['attendance.occurrence_v2', 'student_uid'],
  ['attendance.incident_v2', 'student_uid'],
  ['attendance.source_row_v2', 'student_uid'],
  ['attendance.pruned_origin_v2', 'student_uid'],
  ['student_photos.photo_family_v1', 'student_uid'],
  ['student_photos.asset_delivery_v1', 'student_uid'],
  ['student_photos.write_operation_v1', 'student_uid'],
  ['student_photos.write_audit_v1', 'student_uid'],
  ['student_photos.recovery_audit_v1', 'student_uid'],
];

export type RemovableStudentV1 = {
  readonly id: number;
  readonly name: string;
  readonly classLabel: string | null;
  readonly number: number | null;
};

/**
 * The student, when nothing keeps it; null when something does, when it does not exist, or when a
 * relation cannot be read (what cannot be checked is never removed). A relation missing from the
 * database (a schema not installed) holds nothing.
 */
export async function removableStudentV1(
  tx: TxV1,
  year: number,
  studentUid: string,
): Promise<RemovableStudentV1 | null> {
  const [student] = await tx.query(
    `SELECT a.id,a.nome,a.conselho_anterior,t.codigo,v.numero FROM gradebook.aluno a
     LEFT JOIN LATERAL (SELECT turma_id,numero FROM gradebook.vinculo WHERE aluno_id=a.id ORDER BY ano DESC LIMIT 1) v ON true
     LEFT JOIN gradebook.turma t ON t.id=v.turma_id
     WHERE a.ano=$1 AND a.student_uid=$2::uuid`,
    [year, studentUid],
  );
  if (!student || student.conselho_anterior !== null) return null;
  const relations = [...BY_STUDENT_ID_V1, ...BY_STUDENT_UID_V1.map(([relation]) => relation)];
  const found = await tx.query(
    `SELECT r AS relation,to_regclass(r) IS NOT NULL AS present,
       to_regclass(r) IS NULL OR has_table_privilege(r,'SELECT') AS readable
     FROM jsonb_array_elements_text($1::text::jsonb) r`,
    [JSON.stringify(relations)],
  );
  if (found.some((row) => !boolV1(row.readable))) return null;
  const present = new Set(found.filter((row) => boolV1(row.present)).map((row) => row.relation));
  // Relation and column names come from the fixed lists above, never from a request.
  const checks = [
    ...BY_STUDENT_ID_V1.filter((relation) => present.has(relation)).map(
      (relation) => `EXISTS(SELECT 1 FROM ${relation} WHERE aluno_id=$1)`,
    ),
    ...BY_STUDENT_UID_V1.filter(([relation]) => present.has(relation)).map(
      ([relation, column]) => `EXISTS(SELECT 1 FROM ${relation} WHERE ${column}=$2::uuid)`,
    ),
  ];
  const [kept] = await tx.query(`SELECT ${checks.join(' OR ') || 'false'} AS kept`, [
    Number(student.id),
    studentUid,
  ]);
  if (boolV1(kept?.kept)) return null;
  return {
    id: Number(student.id),
    name: String(student.nome),
    classLabel: nullableTextV1(student.codigo),
    number: student.numero === null || student.numero === undefined ? null : Number(student.numero),
  };
}

const KEPT_REASON_V1 = 'O aluno tem dados no sistema e não pode ser excluído.';

/**
 * Removes the student and its places in classes, and records who, when and what in the
 * Conciliação's decisions (without a reference to the removed student). `accountVersion` is the
 * version of the Portal account the caller found never used (null: no open account): the account
 * must still be that one, unchanged.
 */
export async function removeStudentV1(
  tx: TxV1,
  actor: string,
  request: RemoveRequestV1,
  context: ReconciliationContextV1,
  accountVersion: number | null,
): Promise<ReconciliationResponseV1> {
  const digest = await digestV1(request);
  const [receipt] = await tx.query(
    `SELECT id::text,request_digest FROM gradebook.student_reconciliation_decision_v1
     WHERE academic_year=$1 AND generation=$2::uuid AND actor_id=$3::uuid AND idempotency_key=$4::uuid`,
    [request.academicYear, request.generation, actor, request.idempotencyKey],
  );
  if (receipt) {
    if (receipt.request_digest !== digest) throw new ReconciliationConflictV1();
    return { contractVersion: 1, state: 'committed', context, operationId: String(receipt.id) };
  }
  assertContextV1(context, request);
  await tx.query(
    `SELECT id FROM gradebook.aluno WHERE ano=$1 AND student_uid=$2::uuid FOR UPDATE`,
    [request.academicYear, request.studentUid],
  );
  const student = await removableStudentV1(tx, request.academicYear, request.studentUid);
  if (!student) throw new ReconciliationConflictV1('conflict', KEPT_REASON_V1);
  const [account] = await tx.query(
    `SELECT account_id::text,account_version::text FROM student_portal.reconciliation_accounts_v1($1::smallint)
     WHERE student_uid=$2::uuid AND closed_at IS NULL`,
    [request.academicYear, request.studentUid],
  );
  const accountNow = account ? String(account.account_id).toLowerCase() : null;
  if (
    accountNow !== (request.accountId?.toLowerCase() ?? null) ||
    (account && Number(account.account_version) !== accountVersion)
  )
    throw new ReconciliationConflictV1();
  await tx.executeNative(`DELETE FROM gradebook.vinculo WHERE aluno_id=$1`, [student.id]);
  await tx.executeNative(`DELETE FROM gradebook.aluno WHERE id=$1`, [student.id]);
  const id = crypto.randomUUID();
  await tx.executeNative(
    `INSERT INTO gradebook.student_reconciliation_decision_v1
    (id,academic_year,generation,sequence,actor_id,action,reason,before_state,after_state,idempotency_key,request_digest)
    VALUES($1::uuid,$2,$3::uuid,$4,$5::uuid,'remove-student',$6,$7::text::jsonb,'{}'::jsonb,$8::uuid,$9)`,
    [
      id,
      request.academicYear,
      context.generation,
      context.revision + 1,
      actor,
      'Aluno lançado por engano',
      JSON.stringify({
        studentUid: request.studentUid,
        academicStudentId: student.id,
        name: student.name,
        classLabel: student.classLabel,
        number: student.number,
        accountId: accountNow,
      }),
      request.idempotencyKey,
      digest,
    ],
  );
  await advanceV1(tx, request.academicYear, true);
  return {
    contractVersion: 1,
    state: 'committed',
    context: await contextV1(tx, request.academicYear),
    operationId: id,
  };
}
