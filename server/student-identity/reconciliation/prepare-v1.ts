import type {
  ReconciliationContextV1,
  ReconciliationPrepareV1,
  ReconciliationResponseV1,
  ReconciliationValidationErrorV1,
} from '../../../shared/student-identity/reconciliation-v1';
import {
  classifyReportClassV1,
  normalizeStudentNameV1,
  normalizeInepV1,
  parseCivilDateV1,
  reportClassReferenceV1,
} from '../../../shared/student-identity/reconciliation-normalization-v1';
import { planStudentReconciliationV1, reportContentV1, reportRowContentV1 } from './domain-v1';
import {
  academicRevisionV1,
  advanceV1,
  assertContextV1,
  clockV1,
  contextV1,
  digestV1,
  loadDomainV1,
  ReconciliationConflictV1,
  savePendingV1,
  type PreparedRowV1,
  type TxV1,
} from './storage-v1';

export const classReferenceV1 = reportClassReferenceV1;
export async function prepareReportV1(
  tx: TxV1,
  actorId: string,
  request: ReconciliationPrepareV1,
  context: ReconciliationContextV1,
): Promise<ReconciliationResponseV1> {
  const requestDigest = await digestV1({
    ...request,
    rows: [...request.rows].sort((a, b) => a.sourceRow - b.sourceRow),
    classLinks: [...request.classLinks].sort((a, b) =>
      classReferenceV1(a.classLabel, a.shift, a.stageLabel).localeCompare(
        classReferenceV1(b.classLabel, b.shift, b.stageLabel),
      ),
    ),
  });
  const [receipt] = await tx.query(
    `SELECT * FROM gradebook.student_report_batch_v1
    WHERE academic_year=$1 AND generation=$2::uuid AND actor_id=$3::uuid AND idempotency_key=$4::uuid`,
    [request.academicYear, request.generation, actorId, request.idempotencyKey],
  );
  if (receipt) {
    if (receipt.request_digest !== requestDigest) throw new ReconciliationConflictV1();
    return preparedResponseV1(tx, String(receipt.id), context);
  }
  assertContextV1(context, request);
  if (
    (request.sourceYear !== null && request.sourceYear !== request.academicYear) ||
    (request.sourceYear === null && !request.confirmYear)
  )
    throw new ReconciliationConflictV1('invalid-request');
  if (new Set(request.rows.map((r) => r.sourceRow)).size !== request.rows.length)
    throw new ReconciliationConflictV1('invalid-request');
  const clock = await clockV1(tx);
  if (request.sourceGeneratedAt && new Date(request.sourceGeneratedAt) > clock.now)
    throw new ReconciliationConflictV1('invalid-request');
  const classes = await tx.query(`SELECT id,etapa FROM gradebook.turma WHERE ano=$1`, [
    request.academicYear,
  ]);
  const mapping = new Map(
    request.classLinks.map((m) => [classReferenceV1(m.classLabel, m.shift, m.stageLabel), m]),
  );
  if (mapping.size !== request.classLinks.length)
    throw new ReconciliationConflictV1('invalid-request');
  for (const m of mapping.values())
    if (m.gradebookClassId !== null && !classes.some((c) => c.id === m.gradebookClassId))
      throw new ReconciliationConflictV1('invalid-request');
  const rows: PreparedRowV1[] = [];
  const errors: ReconciliationValidationErrorV1[] = [];
  for (const row of request.rows) {
    const classification = classifyReportClassV1(row.classLabel, row.stageLabel, row.shift);
    const link = mapping.get(classReferenceV1(row.classLabel, row.shift, row.stageLabel));
    if (classification.kind === 'excluded') continue;
    if (classification.kind === 'regular' && classification.academicYear !== request.academicYear)
      throw new ReconciliationConflictV1('invalid-request');
    if (context.relationAvailable && link?.gradebookClassId === null) continue;
    if (classification.kind === 'unknown') {
      // Unknown modality has no inferred eligibility. Only an explicit operator classification can admit it.
      if (!link?.confirmRegular || !link.gradebookClassId) {
        errors.push({ ...errorIdentityV1(row), field: 'class', reason: 'Confira a turma.' });
        continue;
      }
    }
    if (context.relationAvailable && !link?.gradebookClassId) continue;
    const error = (field: ReconciliationValidationErrorV1['field'], reason: string) =>
      errors.push({ ...errorIdentityV1(row), field, reason });
    const birth = parseCivilDateV1(row.birthDate, request.date1904, clock.today, true);
    const enrolled = parseCivilDateV1(row.enrolledAt, request.date1904, clock.today, false);
    const transferred = parseCivilDateV1(row.transferredAt, request.date1904, clock.today, false);
    const inep = normalizeInepV1(row.inep);
    if (!birth.ok)
      error(
        'birthDate',
        birth.reason === 'missing'
          ? 'nascimento ausente.'
          : birth.reason === 'future'
            ? 'nascimento no futuro.'
            : 'nascimento inválido.',
      );
    if (!enrolled.ok) error('enrolledAt', 'data de matrícula inválida.');
    if (!transferred.ok) error('transferredAt', 'data de transferência inválida.');
    if (!inep.ok) error('inep', 'INEP inválido.');
    if (!row.name.trim() || !row.enrollmentHash.trim())
      throw new ReconciliationConflictV1('invalid-request');
    if (!birth.ok || birth.value === null || !enrolled.ok || !transferred.ok || !inep.ok) continue;
    const stage =
      classification.kind === 'regular'
        ? classification.stage
        : Number(classes.find((c) => c.id === link?.gradebookClassId)?.etapa);
    if (
      link?.gradebookClassId !== null &&
      link?.gradebookClassId !== undefined &&
      classes.find((c) => c.id === link.gradebookClassId)?.etapa !== stage
    )
      throw new ReconciliationConflictV1('invalid-request');
    rows.push({
      sourceRow: row.sourceRow,
      name: row.name.trim(),
      nameKey: normalizeStudentNameV1(row.name),
      birthDate: birth.value,
      filiation1: row.filiation1?.trim() || null,
      filiation1Key: row.filiation1?.trim() ? normalizeStudentNameV1(row.filiation1) : null,
      inep: inep.value,
      inepKey: inep.key,
      enrollmentHash: row.enrollmentHash.trim(),
      classLabel: row.classLabel.trim(),
      classKey: normalizeStudentNameV1(row.classLabel),
      shift: row.shift.trim(),
      shiftKey: normalizeStudentNameV1(row.shift),
      stage,
      stageLabel: row.stageLabel.trim(),
      status: row.status.trim(),
      statusKey: normalizeStudentNameV1(row.status),
      enrolledAt: enrolled.value,
      transferredAt: transferred.value,
      classId: context.relationAvailable ? (link?.gradebookClassId ?? null) : null,
      targetSourceId: crypto.randomUUID(),
      targetObservationId: crypto.randomUUID(),
      targetUid: null,
      targetRule: null,
      pendingReason: 'awaiting_relation',
      selectedProfile: false,
    });
  }
  if (errors.length) return { contractVersion: 1, state: 'validation-failed', errors };
  if (!rows.length) throw new ReconciliationConflictV1('invalid-request');
  // No batch, row, link or credential has been written before complete C3 validation.
  const domain = await loadDomainV1(tx, request.academicYear);
  const plan = planStudentReconciliationV1({ rows, ...domain });
  const selectedRows = new Set(
    plan.profiles.flatMap((p) => (p.selectedSourceRow === null ? [] : [p.selectedSourceRow])),
  );
  const profileConflicts = new Set(
    plan.profiles.filter((p) => p.reason === 'profile_conflict').map((p) => p.studentUid),
  );
  // An unchanged report preserves an observation already chosen by the operator.
  // A changed or additional origin must be reviewed again as a complete profile.
  for (const profile of plan.profiles.filter((p) => p.reason === 'profile_conflict')) {
    const group = plan.rows.filter((p) => p.studentUid === profile.studentUid);
    const unchanged = group.every((p) => {
      const source = domain.sources.find((s) => s.sourceId === p.sourceId);
      const row = rows.find((r) => r.sourceRow === p.sourceRow)!;
      return (
        source &&
        !source.reviewRequired &&
        reportRowContentV1(source.current) === reportRowContentV1(row)
      );
    });
    const selected = group.find((p) =>
      domain.sources.some((s) => s.sourceId === p.sourceId && s.profileSelected),
    );
    if (unchanged && selected) {
      selectedRows.add(selected.sourceRow);
      profileConflicts.delete(profile.studentUid);
    }
  }
  for (const row of rows) {
    const planned = plan.rows.find((p) => p.sourceRow === row.sourceRow)!;
    if (planned.sourceId) {
      row.targetSourceId = planned.sourceId;
      const old = domain.observations.find(
        (o) => o.source_id === planned.sourceId && o.id === o.current_observation_id,
      );
      const source = domain.sources.find((s) => s.sourceId === planned.sourceId)!;
      if (old && reportRowContentV1(source.current) === reportRowContentV1(row))
        row.targetObservationId = String(old.id);
    }
    row.targetUid = planned.studentUid;
    row.targetRule = planned.rule;
    row.pendingReason = context.relationAvailable
      ? (planned.reason ??
        (planned.studentUid && profileConflicts.has(planned.studentUid)
          ? 'profile_conflict'
          : null))
      : 'awaiting_relation';
    row.selectedProfile = selectedRows.has(row.sourceRow);
  }
  const differences: string[] = [];
  const [current] = await tx.query(
    `SELECT b.* FROM gradebook.student_report_batch_v1 b JOIN gradebook.student_reconciliation_scope_v1 s ON s.current_batch_id=b.id WHERE s.academic_year=$1`,
    [request.academicYear],
  );
  const contentDigest = await digestV1(reportContentV1(rows));
  if (current && current.digest !== contentDigest) {
    const missing = domain.sources.filter(
      (s) => !rows.some((r) => r.targetSourceId === s.sourceId),
    ).length;
    if (missing) differences.push(`${missing} origem(ns) não encontrada(s) no relatório.`);
    const oldClasses = new Set(domain.sources.map((s) => s.current.classKey));
    const missingClasses = [...oldClasses].filter(
      (k) => !rows.some((r) => r.classKey === k),
    ).length;
    if (missingClasses) differences.push(`${missingClasses} turma(s) ausente(s) ou alterada(s).`);
    if (!request.sourceGeneratedAt || !current.source_generated_at)
      differences.push('Data do relatório não confirmada. Confira as alterações.');
    else if (new Date(request.sourceGeneratedAt) < new Date(String(current.source_generated_at)))
      differences.push('Relatório anterior ao vigente. Confira as alterações.');
  }
  const id = crypto.randomUUID();
  const state = !context.relationAvailable
    ? 'awaiting_relation'
    : differences.length
      ? 'review_required'
      : 'preparing';
  const expiresAt = new Date(
    clock.now.getTime() + (context.relationAvailable ? 1 : 30) * 86400_000,
  ).toISOString();
  await advanceV1(tx, request.academicYear);
  await tx.executeNative(
    `INSERT INTO gradebook.student_report_batch_v1
    (id,academic_year,generation,actor_id,source_generated_at,source_evidence,normalization_version,digest,request_digest,idempotency_key,
     base_revision,base_academic_revision,state,expires_at,differences,class_links)
    VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::timestamptz,$6,1,$7,$8,$9::uuid,$10,$11,$12,$13::timestamptz,$14::text[],$15::text::jsonb)`,
    [
      id,
      request.academicYear,
      context.generation,
      actorId,
      request.sourceGeneratedAt,
      request.sourceGeneratedAt ? 'declared' : 'unknown',
      contentDigest,
      requestDigest,
      request.idempotencyKey,
      context.revision + 1,
      await academicRevisionV1(tx, request.academicYear),
      state,
      expiresAt,
      `{${differences.map((d) => `"${d.replaceAll('"', '\\"')}"`).join(',')}}`,
      JSON.stringify(request.classLinks),
    ],
  );
  await savePendingV1(tx, id, request.academicYear, rows);
  return preparedResponseV1(tx, id, await contextV1(tx, request.academicYear));
}
function errorIdentityV1(row: { sourceRow: number; name: string; classLabel: string }) {
  return { sourceRow: row.sourceRow, name: row.name, classLabel: row.classLabel };
}
export async function preparedResponseV1(
  tx: TxV1,
  batchId: string,
  context: ReconciliationContextV1,
): Promise<ReconciliationResponseV1> {
  const [r] = await tx.query(
    `SELECT b.*, (SELECT count(*)::integer FROM gradebook.student_report_pending_row_v1 WHERE batch_id=b.id) AS rows,
    (SELECT count(*)::integer FROM gradebook.student_report_pending_row_v1 WHERE batch_id=b.id AND target_uid IS NOT NULL) AS linked,
    expires_at>clock_timestamp() AS usable FROM gradebook.student_report_batch_v1 b WHERE id=$1::uuid`,
    [batchId],
  );
  if (!r) throw new ReconciliationConflictV1('expired');
  if (r.generation !== context.generation) throw new ReconciliationConflictV1();
  if (r.applied_revision !== null)
    return { contractVersion: 1, state: 'committed', context, operationId: batchId };
  if (!r.usable || r.state === 'expired') throw new ReconciliationConflictV1('expired');
  if (!['awaiting_relation', 'review_required', 'preparing'].includes(String(r.state)))
    throw new ReconciliationConflictV1();
  if (r.state !== 'awaiting_relation' && Number(r.base_revision) !== context.revision)
    throw new ReconciliationConflictV1();
  return {
    contractVersion: 1,
    state: 'ready',
    operation: 'prepare',
    context,
    batchId,
    batchState: r.state as 'preparing' | 'review_required' | 'awaiting_relation',
    expiresAt: new Date(String(r.expires_at)).toISOString(),
    differences: r.differences as string[],
    counts: {
      rows: Number(r.rows),
      linked: Number(r.linked),
      pending: Number(r.rows) - Number(r.linked),
    },
    credentialsReady: false,
  };
}
