import type {
  ReconciliationContextV1,
  ReconciliationMutationV1,
  ReconciliationResponseV1,
} from '../../../shared/student-identity/reconciliation-v1';
import { preparedResponseV1 } from './prepare-v1';
import {
  academicRevisionV1,
  advanceV1,
  assertContextV1,
  boolV1,
  contextV1,
  digestV1,
  ReconciliationConflictV1,
  scalarTextV1,
  type DbRowV1,
  type TxV1,
} from './storage-v1';

type DecisionRequest = Extract<
  ReconciliationMutationV1,
  { operation: 'resolve' | 'class-link' | 'name-source' | 'select-observation' }
>;
type ResolveRequestV1 = Extract<DecisionRequest, { operation: 'resolve' }>;
type PersonRequestV1 = Extract<DecisionRequest, { operation: 'resolve' | 'select-observation' }>;
interface DecisionScopeV1<R extends DecisionRequest = DecisionRequest> {
  readonly tx: TxV1;
  readonly actor: string;
  readonly request: R;
  readonly context: ReconciliationContextV1;
  readonly digest: string;
}
/** What the durable decision row records once the operation has changed the current state. */
interface DecisionRecordV1 {
  readonly action: string;
  readonly reason: string;
  readonly source?: string;
  readonly uid?: string;
  readonly reportClass?: string;
  readonly observation?: string;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
}
/** A decision either is recorded now or becomes a prepared batch that the operator still applies. */
type DecisionStepV1 = DecisionRecordV1 | ReconciliationResponseV1;
interface DecisionTargetV1 {
  readonly source: string;
  readonly observation: string;
}

function isPreparedV1(step: DecisionStepV1): step is ReconciliationResponseV1 {
  return 'contractVersion' in step;
}

async function decisionReceiptV1(scope: DecisionScopeV1): Promise<ReconciliationResponseV1 | null> {
  const { tx, actor, request, context, digest } = scope;
  const key = [request.academicYear, request.generation, actor, request.idempotencyKey];
  const [receipt] = await tx.query(
    `SELECT id::text,request_digest FROM gradebook.student_reconciliation_decision_v1
    WHERE academic_year=$1 AND generation=$2::uuid AND actor_id=$3::uuid AND idempotency_key=$4::uuid`,
    key,
  );
  if (receipt) {
    if (receipt.request_digest !== digest) throw new ReconciliationConflictV1();
    return {
      contractVersion: 1,
      state: 'committed',
      context,
      operationId: scalarTextV1(receipt.id),
    };
  }
  const [batch] = await tx.query(
    `SELECT id::text,request_digest FROM gradebook.student_report_batch_v1
    WHERE academic_year=$1 AND generation=$2::uuid AND actor_id=$3::uuid AND idempotency_key=$4::uuid`,
    key,
  );
  if (!batch) return null;
  if (batch.request_digest !== digest) throw new ReconciliationConflictV1();
  return preparedResponseV1(tx, scalarTextV1(batch.id), context);
}

async function nameSourceDecisionV1(
  scope: DecisionScopeV1<Extract<DecisionRequest, { operation: 'name-source' }>>,
): Promise<DecisionRecordV1> {
  const { tx, request, context } = scope;
  await tx.executeNative(
    `UPDATE gradebook.student_reconciliation_scope_v1 SET name_source=$2 WHERE academic_year=$1`,
    [request.academicYear, request.nameSource],
  );
  return {
    action: request.operation,
    reason: request.operation,
    before: { nameSource: context.nameSource },
    after: { nameSource: request.nameSource },
  };
}

async function classLinkDecisionV1(
  scope: DecisionScopeV1<Extract<DecisionRequest, { operation: 'class-link' }>>,
): Promise<DecisionRecordV1> {
  const { tx, request } = scope;
  const [c] = await tx.query(
    `SELECT gradebook_class_id,version::text,stage FROM gradebook.student_report_class_v1 WHERE academic_year=$1 AND id=$2::uuid FOR UPDATE`,
    [request.academicYear, request.reportClassId],
  );
  if (!c) throw new ReconciliationConflictV1();
  if (request.gradebookClassId !== null) {
    const classes = await tx.query(
      `SELECT 1 FROM gradebook.turma WHERE ano=$1 AND id=$2 AND etapa=$3`,
      [request.academicYear, request.gradebookClassId, Number(c.stage)],
    );
    if (!classes.length) throw new ReconciliationConflictV1('invalid-request');
  }
  const reportClass = request.reportClassId;
  await tx.executeNative(
    `UPDATE gradebook.student_report_class_v1 SET gradebook_class_id=$3,version=version+1,review_required=true WHERE academic_year=$1 AND id=$2::uuid`,
    [request.academicYear, reportClass, request.gradebookClassId],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_source_link_v1 l SET review_required=true,version=l.version+1 FROM gradebook.student_source_record_v1 r,gradebook.student_source_observation_v1 o
      WHERE l.source_id=r.id AND o.id=r.current_observation_id AND o.report_class_id=$1::uuid`,
    [reportClass],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_source_record_v1 r SET review_required=true,pending_reason='class_changed' FROM gradebook.student_source_observation_v1 o
      WHERE o.id=r.current_observation_id AND o.report_class_id=$1::uuid`,
    [reportClass],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_report_profile_v1 p SET review_required=true,version=p.version+1 FROM gradebook.student_source_observation_v1 o
      WHERE o.id=p.observation_id AND o.report_class_id=$1::uuid`,
    [reportClass],
  );
  return {
    action: request.operation,
    reason: request.operation,
    reportClass,
    before: { classId: c.gradebook_class_id, version: Number(c.version) },
    after: { classId: request.gradebookClassId },
  };
}

async function assertAcademicStudentV1(tx: TxV1, year: number, uid: string): Promise<void> {
  const students = await tx.query(
    `SELECT 1 FROM gradebook.aluno WHERE ano=$1 AND student_uid=$2::uuid`,
    [year, uid],
  );
  if (!students.length) throw new ReconciliationConflictV1('invalid-request');
}

async function selectObservationDecisionV1(
  scope: DecisionScopeV1<Extract<DecisionRequest, { operation: 'select-observation' }>>,
): Promise<ReconciliationResponseV1> {
  const { tx, request } = scope;
  await assertAcademicStudentV1(tx, request.academicYear, request.studentUid);
  const [o] = await tx.query(
    `SELECT o.source_id::text FROM gradebook.student_source_observation_v1 o JOIN gradebook.student_source_link_v1 l ON l.source_id=o.source_id AND l.academic_year=o.academic_year
        WHERE o.id=$1::uuid AND o.academic_year=$2 AND l.student_uid=$3::uuid AND NOT l.review_required`,
    [request.observationId, request.academicYear, request.studentUid],
  );
  if (!o) throw new ReconciliationConflictV1();
  return prepareDecisionV1(scope, {
    source: scalarTextV1(o.source_id),
    observation: request.observationId,
    action: 'select-observation',
  });
}

async function associateDecisionV1(
  scope: DecisionScopeV1<ResolveRequestV1>,
  link: DbRowV1,
  target: DecisionTargetV1,
): Promise<ReconciliationResponseV1> {
  const { tx, request } = scope;
  const uid = request.studentUid;
  if (link.student_uid !== null && link.student_uid !== uid) throw new ReconciliationConflictV1();
  const [last] = await tx.query(
    `SELECT action FROM gradebook.student_reconciliation_decision_v1 WHERE academic_year=$1 AND source_id=$2::uuid AND student_uid=$3::uuid
        AND action IN('reject','separate','release') ORDER BY sequence DESC,recorded_at DESC,id DESC LIMIT 1`,
    [request.academicYear, target.source, uid],
  );
  if (last && last.action !== 'release') throw new ReconciliationConflictV1();
  return prepareDecisionV1(scope, { ...target, action: 'associate' });
}

async function separateDecisionV1(
  scope: DecisionScopeV1<ResolveRequestV1>,
  link: DbRowV1,
  target: DecisionTargetV1,
  record: DecisionRecordV1,
): Promise<DecisionStepV1> {
  const { tx, request } = scope;
  const uid = request.studentUid;
  if (
    link.student_uid !== uid ||
    !request.revertsDecisionId ||
    request.revertsDecisionId !== link.decision_id
  )
    throw new ReconciliationConflictV1();
  const [profile] = await tx.query(
    `SELECT p.source_id::text,p.observation_id::text,p.version::text,ac.account_id::text
        FROM gradebook.student_report_profile_v1 p LEFT JOIN student_portal.reconciliation_accounts_v1($1::smallint) ac ON ac.student_uid=p.student_uid
        WHERE p.academic_year=$1 AND p.student_uid=$2::uuid`,
    [request.academicYear, uid],
  );
  if (profile?.source_id === target.source) {
    // A later correction or credential dependency cannot be undone as an incidental side effect.
    if (Number(profile.version) > 1) throw new ReconciliationConflictV1();
    if (profile.account_id !== null)
      return prepareDecisionV1(scope, { ...target, action: 'separate' });
    await tx.executeNative(
      `DELETE FROM gradebook.student_report_profile_v1 WHERE academic_year=$1 AND student_uid=$2::uuid`,
      [request.academicYear, uid],
    );
  }
  await tx.executeNative(
    `DELETE FROM gradebook.student_source_link_v1 WHERE academic_year=$1 AND source_id=$2::uuid`,
    [request.academicYear, target.source],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_source_record_v1 SET review_required=true,pending_reason='separated',version=version+1 WHERE id=$1::uuid`,
    [target.source],
  );
  return {
    ...record,
    before: {
      linkVersion: Number(link.link_version),
      studentUid: uid,
      observationId: target.observation,
    },
  };
}

async function confirmDecisionV1(
  scope: DecisionScopeV1<ResolveRequestV1>,
  link: DbRowV1,
  target: DecisionTargetV1,
): Promise<void> {
  const { tx, request } = scope;
  if (link.student_uid !== request.studentUid) throw new ReconciliationConflictV1();
  await tx.executeNative(
    `UPDATE gradebook.student_source_link_v1 SET review_required=false,version=version+1 WHERE academic_year=$1 AND source_id=$2::uuid`,
    [request.academicYear, target.source],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_source_record_v1 SET review_required=false,pending_reason=CASE WHEN pending_reason='profile_conflict' THEN pending_reason END,version=version+1 WHERE id=$1::uuid`,
    [target.source],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_report_profile_v1 p SET review_required=false,version=version+1 WHERE academic_year=$1 AND source_id=$2::uuid
        AND NOT EXISTS(SELECT 1 FROM gradebook.student_source_link_v1 l JOIN gradebook.student_source_record_v1 r ON r.id=l.source_id
          WHERE l.academic_year=p.academic_year AND l.student_uid=p.student_uid AND r.pending_reason='profile_conflict')`,
    [request.academicYear, target.source],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_report_class_v1 c SET review_required=false
        WHERE c.academic_year=$1 AND c.id=(SELECT report_class_id FROM gradebook.student_source_observation_v1 WHERE id=$2::uuid)
        AND NOT EXISTS(SELECT 1 FROM gradebook.student_source_link_v1 l JOIN gradebook.student_source_record_v1 r ON r.id=l.source_id
          JOIN gradebook.student_source_observation_v1 o ON o.id=r.current_observation_id WHERE o.report_class_id=c.id AND l.review_required)`,
    [request.academicYear, target.observation],
  );
}

async function resolveDecisionV1(
  scope: DecisionScopeV1<ResolveRequestV1>,
): Promise<DecisionStepV1> {
  const { tx, request } = scope;
  const uid = request.studentUid;
  const source = request.sourceId;
  await assertAcademicStudentV1(tx, request.academicYear, uid);
  const [link] = await tx.query(
    `SELECT r.current_observation_id::text,l.student_uid::text,COALESCE(l.version,0)::text AS link_version,l.decision_id::text
      FROM gradebook.student_source_record_v1 r LEFT JOIN gradebook.student_source_link_v1 l ON l.source_id=r.id AND l.academic_year=r.academic_year
      WHERE r.academic_year=$1 AND r.id=$2::uuid FOR UPDATE OF r`,
    [request.academicYear, source],
  );
  if (!link || Number(link.link_version) !== request.expectedLinkVersion)
    throw new ReconciliationConflictV1();
  const target = { source, observation: scalarTextV1(link.current_observation_id) };
  const record: DecisionRecordV1 = { action: request.action, reason: 'operator', uid, ...target };
  if (request.action === 'associate') return associateDecisionV1(scope, link, target);
  if (request.action === 'separate') return separateDecisionV1(scope, link, target, record);
  if (request.action === 'reject' && link.student_uid === uid) throw new ReconciliationConflictV1();
  if (request.action === 'confirm') await confirmDecisionV1(scope, link, target);
  return record;
}

function decisionStepV1(scope: DecisionScopeV1): Promise<DecisionStepV1> {
  const { request } = scope;
  switch (request.operation) {
    case 'name-source':
      return nameSourceDecisionV1({ ...scope, request });
    case 'class-link':
      return classLinkDecisionV1({ ...scope, request });
    case 'select-observation':
      return selectObservationDecisionV1({ ...scope, request });
    default:
      return resolveDecisionV1({ ...scope, request });
  }
}

export async function decideV1(
  tx: TxV1,
  actor: string,
  request: DecisionRequest,
  context: ReconciliationContextV1,
): Promise<ReconciliationResponseV1> {
  const digest = await digestV1(request);
  const scope: DecisionScopeV1 = { tx, actor, request, context, digest };
  const receipt = await decisionReceiptV1(scope);
  if (receipt) return receipt;
  assertContextV1(context, request);
  const step = await decisionStepV1(scope);
  if (isPreparedV1(step)) return step;
  const id = crypto.randomUUID();
  await tx.executeNative(
    `INSERT INTO gradebook.student_reconciliation_decision_v1
    (id,academic_year,generation,sequence,actor_id,action,source_id,student_uid,report_class_id,observation_id,reason,before_state,after_state,reverts_decision_id,idempotency_key,request_digest)
    VALUES($1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$11,$12::text::jsonb,$13::text::jsonb,$14::uuid,$15::uuid,$16)`,
    [
      id,
      request.academicYear,
      context.generation,
      context.revision + 1,
      actor,
      step.action,
      step.source ?? null,
      step.uid ?? null,
      step.reportClass ?? null,
      step.observation ?? null,
      step.reason,
      JSON.stringify(step.before ?? {}),
      JSON.stringify(step.after ?? {}),
      request.operation === 'resolve' ? request.revertsDecisionId : null,
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

async function prepareDecisionV1(
  scope: DecisionScopeV1<PersonRequestV1>,
  target: DecisionTargetV1 & { readonly action: string },
): Promise<ReconciliationResponseV1> {
  const { tx, actor, request, context, digest } = scope;
  const { source, observation, action } = target;
  const id = crypto.randomUUID();
  await advanceV1(tx, request.academicYear);
  await tx.executeNative(
    `INSERT INTO gradebook.student_report_batch_v1(id,academic_year,generation,actor_id,source_evidence,normalization_version,digest,request_digest,idempotency_key,
    base_revision,base_academic_revision,state,expires_at,class_links,purpose,resolution)
    VALUES($1::uuid,$2,$3::uuid,$4::uuid,'unknown',1,$5,$5,$6::uuid,$7,$8,'preparing',clock_timestamp()+interval '24 hours','[]','decision',$9::text::jsonb)`,
    [
      id,
      request.academicYear,
      context.generation,
      actor,
      digest,
      request.idempotencyKey,
      context.revision + 1,
      await academicRevisionV1(tx, request.academicYear),
      JSON.stringify({
        action,
        sourceId: source,
        studentUid: request.studentUid,
        observationId: observation,
        revertsDecisionId: request.operation === 'resolve' ? request.revertsDecisionId : null,
      }),
    ],
  );
  await tx.executeNative(
    `INSERT INTO gradebook.student_report_pending_row_v1(batch_id,academic_year,source_row,name,name_key,birth_date,filiation1,filiation1_key,inep,inep_key,enrollment_hash,
    class_label,class_key,stage_label,stage,shift,shift_key,status,status_key,enrolled_at,transferred_at,gradebook_class_id,target_uid,target_source_id,target_observation_id,target_rule,selected_profile)
    SELECT $1::uuid,o.academic_year,2,o.name,o.name_key,o.birth_date,o.filiation1,o.filiation1_key,o.inep,o.inep_key,o.enrollment_hash,
      c.label,c.class_key,c.stage_label,c.stage,o.shift,o.shift_key,o.status,o.status_key,o.enrolled_at,o.transferred_at,c.gradebook_class_id,$2::uuid,o.source_id,o.id,'operator',$4::integer::boolean
    FROM gradebook.student_source_observation_v1 o JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id WHERE o.id=$3::uuid`,
    [id, request.studentUid, observation, action !== 'separate' ? 1 : 0],
  );
  return preparedResponseV1(tx, id, await contextV1(tx, request.academicYear));
}
export async function applyDecisionV1(
  tx: TxV1,
  actor: string,
  batch: DbRowV1,
  context: ReconciliationContextV1,
) {
  const resolution = (
    typeof batch.resolution === 'string' ? JSON.parse(batch.resolution) : batch.resolution
  ) as {
    action: string;
    sourceId: string;
    studentUid: string;
    observationId: string;
    revertsDecisionId: string | null;
  };
  const [existing] = await tx.query(
    `SELECT student_uid::text,version::text,decision_id::text FROM gradebook.student_source_link_v1 WHERE academic_year=$1 AND source_id=$2::uuid`,
    [Number(batch.academic_year), resolution.sourceId],
  );
  if (existing && existing.student_uid !== resolution.studentUid)
    throw new ReconciliationConflictV1();
  if (resolution.action === 'separate') {
    const linkedBy = existing?.decision_id ?? null;
    if (linkedBy === null || linkedBy !== resolution.revertsDecisionId)
      throw new ReconciliationConflictV1();
    const [profile] = await tx.query(
      `SELECT source_id::text,observation_id::text,version::text FROM gradebook.student_report_profile_v1 WHERE academic_year=$1 AND student_uid=$2::uuid`,
      [Number(batch.academic_year), resolution.studentUid],
    );
    if (
      profile?.source_id !== resolution.sourceId ||
      profile?.observation_id !== resolution.observationId ||
      Number(profile?.version) !== 1
    )
      throw new ReconciliationConflictV1();
  }
  const id = crypto.randomUUID();
  await tx.executeNative(
    `INSERT INTO gradebook.student_reconciliation_decision_v1(id,academic_year,generation,sequence,actor_id,action,source_id,student_uid,observation_id,reason,before_state,after_state,reverts_decision_id)
    VALUES($1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7::uuid,$8::uuid,$9::uuid,'operator',$10::text::jsonb,$11::text::jsonb,$12::uuid)`,
    [
      id,
      Number(batch.academic_year),
      context.generation,
      context.revision + 1,
      actor,
      resolution.action,
      resolution.sourceId,
      resolution.studentUid,
      resolution.observationId,
      JSON.stringify(existing ?? {}),
      JSON.stringify({
        observationId: resolution.observationId,
        linkVersion: Number(existing?.version ?? 0) + 1,
      }),
      resolution.revertsDecisionId,
    ],
  );
  if (resolution.action === 'separate') {
    await tx.executeNative(
      `DELETE FROM gradebook.student_report_profile_v1 WHERE academic_year=$1 AND student_uid=$2::uuid`,
      [Number(batch.academic_year), resolution.studentUid],
    );
    await tx.executeNative(
      `DELETE FROM gradebook.student_source_link_v1 WHERE academic_year=$1 AND source_id=$2::uuid`,
      [Number(batch.academic_year), resolution.sourceId],
    );
    await tx.executeNative(
      `UPDATE gradebook.student_source_record_v1 SET review_required=true,pending_reason='separated',version=version+1 WHERE id=$1::uuid`,
      [resolution.sourceId],
    );
    return;
  }
  await tx.executeNative(
    `INSERT INTO gradebook.student_source_link_v1(academic_year,source_id,student_uid,version,decision_id)
    VALUES($1,$2::uuid,$3::uuid,1,$4::uuid) ON CONFLICT(academic_year,source_id) DO UPDATE SET version=student_source_link_v1.version+1,decision_id=EXCLUDED.decision_id,review_required=false`,
    [Number(batch.academic_year), resolution.sourceId, resolution.studentUid, id],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_source_record_v1 SET review_required=false,pending_reason=NULL,version=version+1 WHERE id=$1::uuid`,
    [resolution.sourceId],
  );
  // The profile and credential are activated by the caller after this identity decision.
  await tx.executeNative(
    `UPDATE gradebook.student_source_record_v1 r SET pending_reason=NULL,version=r.version+1
    FROM gradebook.student_source_link_v1 l WHERE l.source_id=r.id AND l.academic_year=$1 AND l.student_uid=$2::uuid
      AND r.pending_reason='profile_conflict' AND NOT r.review_required AND NOT l.review_required`,
    [Number(batch.academic_year), resolution.studentUid],
  );
  if (
    !boolV1(
      (
        await tx.query(
          `SELECT EXISTS(SELECT 1 FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1::uuid AND selected_profile) AS valid`,
          [scalarTextV1(batch.id)],
        )
      )[0]?.valid,
    )
  )
    throw new ReconciliationConflictV1();
}
