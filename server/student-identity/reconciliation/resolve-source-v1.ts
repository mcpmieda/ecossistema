import {
  normalizeStudentNameV1,
  normalizeInepV1,
  parseCivilDateV1,
} from '../../../shared/student-identity/reconciliation-normalization-v1';
import type {
  ReconciliationSourceEvidenceV1,
  ReconciliationSourceResolutionV1,
} from '../../../shared/student-identity/reconciliation-v1';
import { boolV1, type TxV1 } from './storage-v1';

/** Internal identity evidence only. Attendance collection and occurrence storage belong to delivery two. */
export async function resolveReconciledSourceV1(
  tx: TxV1,
  input: ReconciliationSourceEvidenceV1,
): Promise<ReconciliationSourceResolutionV1> {
  if (
    input.academicYear !== 2026 ||
    !input.name.trim() ||
    !input.classLabel.trim() ||
    !input.sourceSnapshotRef.trim() ||
    !input.sourceRecordRef.trim()
  )
    return { state: 'not_found', decisionVersion: 0 };
  const inep = normalizeInepV1(input.inep ?? null);
  const birth = parseCivilDateV1(input.birthDate ?? null, false, '9999-12-31', false);
  if (!inep.ok || !birth.ok) return { state: 'not_found', decisionVersion: 0 };
  const [scope] = await tx.query(
    `SELECT revision::text FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=$1`,
    [input.academicYear],
  );
  const decisionVersion = Number(scope?.revision ?? 0);
  const rows = await tx.query(
    `SELECT o.id::text,o.source_id::text,l.student_uid::text,r.review_required AS source_review,l.review_required AS link_review
    FROM gradebook.student_source_observation_v1 o JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id AND c.academic_year=o.academic_year
    JOIN gradebook.student_source_record_v1 r ON r.id=o.source_id AND r.academic_year=o.academic_year
    LEFT JOIN gradebook.student_source_link_v1 l ON l.source_id=o.source_id AND l.academic_year=o.academic_year
    WHERE o.academic_year=$1 AND o.name_key=$2 AND c.class_key=$3
      AND ($4::text IS NULL OR o.inep_key=$4) AND ($5::date IS NULL OR o.birth_date=$5::date)
      AND ($6::text IS NULL OR o.filiation1_key=$6) ORDER BY o.id`,
    [
      input.academicYear,
      normalizeStudentNameV1(input.name),
      normalizeStudentNameV1(input.classLabel),
      inep.key,
      birth.value,
      input.filiation1?.trim() ? normalizeStudentNameV1(input.filiation1) : null,
    ],
  );
  if (!rows.length) return { state: 'not_found', decisionVersion };
  const uids = new Set(rows.map((r) => r.student_uid));
  if (
    uids.size !== 1 ||
    uids.has(null) ||
    rows.some((r) => boolV1(r.source_review) || boolV1(r.link_review))
  )
    return { state: 'ambiguous', decisionVersion };
  return {
    state: 'resolved',
    studentUid: String(rows[0]!.student_uid),
    sourceIds: [...new Set(rows.map((r) => String(r.source_id)))],
    observationIds: rows.map((r) => String(r.id)),
    decisionVersion,
  };
}
