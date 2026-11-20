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
 * The student, when the Relação no longer has it and nothing keeps it; null when something does, when it does not exist, or when a
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
  // No student, or a previous year's council decision (a real student).
  if (student?.conselho_anterior !== null) return null;
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
    // Still in the Relação: the line has to be deleted there first (gradebook-simplified 0021).
    'EXISTS(SELECT 1 FROM gradebook.vinculo WHERE aluno_id=$1 AND NOT fora_da_relacao)',
    ...BY_STUDENT_ID_V1.filter((relation) => present.has(relation)).map(
      (relation) => `EXISTS(SELECT 1 FROM ${relation} WHERE aluno_id=$1)`,
    ),
    ...BY_STUDENT_UID_V1.filter(([relation]) => present.has(relation)).map(
      ([relation, column]) => `EXISTS(SELECT 1 FROM ${relation} WHERE ${column}=$2::uuid)`,
    ),
  ];
  const [kept] = await tx.query(`SELECT ${checks.join(' OR ')} AS kept`, [
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

/** The two steps of a removal (the Portal account points at the student until it is closed). */
export type RemovalStepV1 = 'class' | 'student';

async function openAccountV1(tx: TxV1, year: number, studentUid: string) {
  const [account] = await tx.query(
    `SELECT account_id::text,account_version::text FROM student_portal.reconciliation_accounts_v1($1::smallint)
     WHERE student_uid=$2::uuid AND closed_at IS NULL`,
    [year, studentUid],
  );
  return account
    ? { id: String(account.account_id).toLowerCase(), version: Number(account.account_version) }
    : null;
}

/**
 * "Excluir aluno lançado por engano", in two steps around the Portal: the Portal account points at
 * the student, and the Portal closes only an account whose student has no class.
 *
 * - `class`: checks that nothing keeps the student and that its account is still the one the caller
 *   found never used (`accountVersion`; null: no open account), removes its places in classes and
 *   records who, when and what in the Conciliação's decisions (without a reference to the student).
 * - `student`: after that step (same request) and with no open account left, removes the student.
 */
export async function removeStudentV1(
  tx: TxV1,
  actor: string,
  request: RemoveRequestV1,
  context: ReconciliationContextV1,
  accountVersion: number | null,
  step: RemovalStepV1,
): Promise<ReconciliationResponseV1> {
  const digest = await digestV1(request);
  const [receipt] = await tx.query(
    `SELECT id::text,request_digest FROM gradebook.student_reconciliation_decision_v1
     WHERE academic_year=$1 AND generation=$2::uuid AND actor_id=$3::uuid AND idempotency_key=$4::uuid`,
    [request.academicYear, request.generation, actor, request.idempotencyKey],
  );
  if (receipt && receipt.request_digest !== digest) throw new ReconciliationConflictV1();
  if (step === 'student') {
    if (!receipt) throw new ReconciliationConflictV1();
    return removeStudentRecordV1(tx, request, String(receipt.id));
  }
  if (receipt)
    return { contractVersion: 1, state: 'committed', context, operationId: String(receipt.id) };
  assertContextV1(context, request);
  await tx.query(
    `SELECT id FROM gradebook.aluno WHERE ano=$1 AND student_uid=$2::uuid FOR UPDATE`,
    [request.academicYear, request.studentUid],
  );
  const student = await removableStudentV1(tx, request.academicYear, request.studentUid);
  if (!student) throw new ReconciliationConflictV1('conflict', KEPT_REASON_V1);
  const account = await openAccountV1(tx, request.academicYear, request.studentUid);
  if (
    (account?.id ?? null) !== (request.accountId?.toLowerCase() ?? null) ||
    (account && account.version !== accountVersion)
  )
    throw new ReconciliationConflictV1();
  await tx.executeNative(`DELETE FROM gradebook.vinculo WHERE aluno_id=$1`, [student.id]);
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
        accountId: account?.id ?? null,
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

/** The second step: the student itself, once it has no class and no open Portal account. */
async function removeStudentRecordV1(
  tx: TxV1,
  request: RemoveRequestV1,
  operationId: string,
): Promise<ReconciliationResponseV1> {
  const [locked] = await tx.query(
    `SELECT id FROM gradebook.aluno WHERE ano=$1 AND student_uid=$2::uuid FOR UPDATE`,
    [request.academicYear, request.studentUid],
  );
  const done = async (): Promise<ReconciliationResponseV1> => ({
    contractVersion: 1,
    state: 'committed',
    context: await contextV1(tx, request.academicYear),
    operationId,
  });
  // Already removed (a repeated request).
  if (!locked) return done();
  const [classes] = await tx.query(
    `SELECT count(*)::integer AS n FROM gradebook.vinculo WHERE aluno_id=$1`,
    [Number(locked.id)],
  );
  if (
    Number(classes?.n) > 0 ||
    !(await removableStudentV1(tx, request.academicYear, request.studentUid)) ||
    (await openAccountV1(tx, request.academicYear, request.studentUid))
  )
    throw new ReconciliationConflictV1();
  await tx.executeNative(`DELETE FROM gradebook.aluno WHERE id=$1`, [Number(locked.id)]);
  await advanceV1(tx, request.academicYear, true);
  return done();
}
