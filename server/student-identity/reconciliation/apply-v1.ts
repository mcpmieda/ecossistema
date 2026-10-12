import type {
  ReconciliationContextV1,
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../../shared/student-identity/reconciliation-v1';
import {
  academicRevisionV1,
  advanceV1,
  assertContextV1,
  boolV1,
  contextV1,
  digestV1,
  ReconciliationConflictV1,
  type TxV1,
} from './storage-v1';
import { applyDecisionV1 } from './decisions-v1';

/** Classes, origins, observations, associations and links of a prepared report, in dependency order. */
async function activateReportRowsV1(
  tx: TxV1,
  actorId: string,
  batchId: string,
  context: ReconciliationContextV1,
): Promise<void> {
  // Mapping changes on existing classes must have gone through the explicit class-link command.
  const conflicts = await tx.query(
    `SELECT 1 FROM gradebook.student_report_pending_row_v1 p JOIN gradebook.student_report_class_v1 c
    ON c.academic_year=p.academic_year AND c.class_key=p.class_key AND c.shift_key=p.shift_key AND c.stage=p.stage
    WHERE p.batch_id=$1::uuid AND c.gradebook_class_id IS NOT NULL AND c.gradebook_class_id IS DISTINCT FROM p.gradebook_class_id LIMIT 1`,
    [batchId],
  );
  if (conflicts.length) throw new ReconciliationConflictV1();
  await tx.executeNative(
    `INSERT INTO gradebook.student_report_class_v1(id,academic_year,label,class_key,shift,shift_key,stage_label,stage,gradebook_class_id)
    SELECT gen_random_uuid(),academic_year,min(class_label),class_key,min(shift),shift_key,min(stage_label),stage,min(gradebook_class_id)
    FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1::uuid GROUP BY academic_year,class_key,shift_key,stage
    ON CONFLICT(academic_year,class_key,shift_key,stage) DO UPDATE SET gradebook_class_id=EXCLUDED.gradebook_class_id`,
    [batchId],
  );
  await tx.executeNative(
    `INSERT INTO gradebook.student_source_record_v1(id,academic_year,last_batch_id,review_required,pending_reason)
    SELECT target_source_id,academic_year,batch_id,target_uid IS NULL,pending_reason
    FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1::uuid
    ON CONFLICT(id) DO UPDATE SET last_batch_id=EXCLUDED.last_batch_id,review_required=EXCLUDED.review_required,
      pending_reason=EXCLUDED.pending_reason,version=student_source_record_v1.version+1`,
    [batchId],
  );
  await tx.executeNative(
    `INSERT INTO gradebook.student_source_observation_v1
    (id,academic_year,source_id,version,batch_id,report_class_id,name,name_key,birth_date,filiation1,filiation1_key,inep,inep_key,enrollment_hash,shift,shift_key,status,status_key,enrolled_at,transferred_at)
    SELECT p.target_observation_id,p.academic_year,p.target_source_id,COALESCE((SELECT max(o.version) FROM gradebook.student_source_observation_v1 o WHERE o.source_id=p.target_source_id),0)+1,
      p.batch_id,c.id,p.name,p.name_key,p.birth_date,p.filiation1,p.filiation1_key,p.inep,p.inep_key,p.enrollment_hash,p.shift,p.shift_key,p.status,p.status_key,p.enrolled_at,p.transferred_at
    FROM gradebook.student_report_pending_row_v1 p JOIN gradebook.student_report_class_v1 c
      ON c.academic_year=p.academic_year AND c.class_key=p.class_key AND c.shift_key=p.shift_key AND c.stage=p.stage
    WHERE p.batch_id=$1::uuid AND NOT EXISTS(SELECT 1 FROM gradebook.student_source_observation_v1 o WHERE o.id=p.target_observation_id)`,
    [batchId],
  );
  await tx.executeNative(
    `UPDATE gradebook.student_source_record_v1 r SET current_observation_id=p.target_observation_id
    FROM gradebook.student_report_pending_row_v1 p WHERE p.batch_id=$1::uuid AND p.target_source_id=r.id`,
    [batchId],
  );
  await tx.executeNative(
    `INSERT INTO gradebook.student_reconciliation_decision_v1
    (id,academic_year,generation,sequence,actor_id,action,source_id,student_uid,observation_id,reason,after_state)
    SELECT gen_random_uuid(),p.academic_year,$2::uuid,$3,$4::uuid,'associate',p.target_source_id,p.target_uid,p.target_observation_id,p.target_rule,
      jsonb_build_object('observationId',p.target_observation_id,'linkVersion',1)
    FROM gradebook.student_report_pending_row_v1 p WHERE p.batch_id=$1::uuid AND p.target_uid IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM gradebook.student_source_link_v1 l WHERE l.academic_year=p.academic_year AND l.source_id=p.target_source_id)`,
    [batchId, context.generation, context.revision + 1, actorId],
  );
  await tx.executeNative(
    `INSERT INTO gradebook.student_source_link_v1(academic_year,source_id,student_uid,version,decision_id)
    SELECT p.academic_year,p.target_source_id,p.target_uid,1,d.id
    FROM gradebook.student_report_pending_row_v1 p JOIN gradebook.student_reconciliation_decision_v1 d
    ON d.academic_year=p.academic_year AND d.source_id=p.target_source_id AND d.student_uid=p.target_uid AND d.sequence=$2 AND d.action='associate'
    WHERE p.batch_id=$1::uuid AND p.target_uid IS NOT NULL ON CONFLICT(academic_year,source_id) DO NOTHING`,
    [batchId, context.revision + 1],
  );
  const wrong = await tx.query(
    `SELECT 1 FROM gradebook.student_report_pending_row_v1 p JOIN gradebook.student_source_link_v1 l
    ON l.academic_year=p.academic_year AND l.source_id=p.target_source_id WHERE p.batch_id=$1::uuid AND p.target_uid IS NOT NULL
      AND (l.student_uid<>p.target_uid OR l.review_required) LIMIT 1`,
    [batchId],
  );
  if (wrong.length) throw new ReconciliationConflictV1();
}

export async function applyReportV1(
  tx: TxV1,
  actorId: string,
  request: Extract<ReconciliationRequestV1, { operation: 'apply' }>,
  context: ReconciliationContextV1,
): Promise<ReconciliationResponseV1> {
  const [batch] = await tx.query(
    `SELECT *,expires_at>clock_timestamp() AS usable FROM gradebook.student_report_batch_v1
    WHERE id=$1::uuid AND academic_year=$2 AND actor_id=$3::uuid FOR UPDATE`,
    [request.batchId, request.academicYear, actorId],
  );
  if (!batch || batch.generation !== request.generation) throw new ReconciliationConflictV1();
  const digest = await digestV1(request);
  if (batch.apply_key === request.idempotencyKey) {
    if (batch.apply_digest !== digest || !['applied', 'superseded'].includes(String(batch.state)))
      throw new ReconciliationConflictV1();
    return { contractVersion: 1, state: 'committed', context, operationId: request.batchId };
  }
  assertContextV1(context, request);
  if (!boolV1(batch.usable)) throw new ReconciliationConflictV1('expired');
  if (
    !['preparing', 'review_required'].includes(String(batch.state)) ||
    Number(batch.base_revision) !== context.revision ||
    batch.base_academic_revision !== (await academicRevisionV1(tx, request.academicYear))
  )
    throw new ReconciliationConflictV1();
  if (batch.state === 'review_required' && !request.confirmDifferences)
    throw new ReconciliationConflictV1();
  await tx.executeNative(
    `UPDATE gradebook.student_report_batch_v1 SET state='preparing' WHERE id=$1::uuid`,
    [request.batchId],
  );
  if (batch.purpose === 'decision') await applyDecisionV1(tx, actorId, batch, context);
  else await activateReportRowsV1(tx, actorId, request.batchId, context);
  await tx.executeNative(
    `UPDATE gradebook.student_report_profile_v1 p SET review_required=true,version=p.version+1
    WHERE p.academic_year=$2 AND EXISTS(SELECT 1 FROM gradebook.student_report_pending_row_v1 r
      WHERE r.batch_id=$1::uuid AND r.target_uid=p.student_uid AND r.pending_reason='profile_conflict')`,
    [request.batchId, request.academicYear],
  );
  await tx.executeNative(
    `INSERT INTO gradebook.student_report_profile_v1(academic_year,student_uid,source_id,observation_id,version)
    SELECT academic_year,target_uid,target_source_id,target_observation_id,1 FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1::uuid AND selected_profile
    ON CONFLICT(academic_year,student_uid) DO UPDATE SET source_id=EXCLUDED.source_id,observation_id=EXCLUDED.observation_id,
      version=student_report_profile_v1.version+1,review_required=false
    WHERE student_report_profile_v1.observation_id IS DISTINCT FROM EXCLUDED.observation_id OR student_report_profile_v1.review_required`,
    [request.batchId],
  );
  // Sole credential activation. This function runs on this exact physical transaction.
  await tx.query(`SELECT student_portal.apply_reconciliation_credentials_v1($1::uuid,$2::uuid)`, [
    request.batchId,
    actorId,
  ]);
  if (batch.purpose === 'report')
    await tx.executeNative(
      `UPDATE gradebook.student_report_batch_v1 SET state='superseded' WHERE academic_year=$1 AND state='applied' AND purpose='report'`,
      [request.academicYear],
    );
  await tx.executeNative(
    `UPDATE gradebook.student_report_batch_v1 SET state='applied',apply_key=$2::uuid,apply_digest=$3,applied_revision=$4 WHERE id=$1::uuid`,
    [request.batchId, request.idempotencyKey, digest, context.revision + 1],
  );
  if (batch.purpose === 'report')
    await tx.executeNative(
      `UPDATE gradebook.student_reconciliation_scope_v1 SET current_batch_id=$2::uuid WHERE academic_year=$1`,
      [request.academicYear, request.batchId],
    );
  await tx.executeNative(
    `DELETE FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1::uuid`,
    [request.batchId],
  );
  await advanceV1(tx, request.academicYear, true);
  return {
    contractVersion: 1,
    state: 'committed',
    context: await contextV1(tx, request.academicYear),
    operationId: request.batchId,
  };
}
