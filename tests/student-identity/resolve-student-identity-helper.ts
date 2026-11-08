import {
  studentIdentityRequestV1,
  studentIdentityResolutionV1,
  type StudentIdentityResolutionV1,
} from '../../shared/student-identity/student-identity-v1';

type StudentIdentityQueryV1 = (
  query: string,
  parameters: readonly (string | number)[],
) => Promise<readonly Record<string, unknown>[]>;

/**
 * Internal reader. The caller must authorize the operation, year and student scope first.
 * A UID establishes identity, never permission. Use the caller's existing transaction/role.
 * Missing references are omitted; database/schema failures are not converted to missing data.
 */
export async function resolveStudentIdentitiesV1(
  query: StudentIdentityQueryV1,
  input: unknown,
): Promise<StudentIdentityResolutionV1[]> {
  const request = studentIdentityRequestV1.parse(input);
  const references = request.source === 'gradebook'
    ? [...new Set(request.studentIds)]
    : [...new Set(request.accountIds)];
  // Text parameter avoids automatic JSON serialization of already serialized strings.
  const rows = await query(
    request.source === 'gradebook'
      ? `SELECT id AS gradebook_student_id, ano AS academic_year, student_uid::text
         FROM gradebook.aluno
         WHERE ano=$1 AND id IN (
           SELECT value::integer FROM jsonb_array_elements_text($2::text::jsonb)
         ) ORDER BY id`
      : `SELECT id::text AS account_id, academic_year, gradebook_student_id, student_uid::text
         FROM student_portal.account
         WHERE academic_year=$1 AND id IN (
           SELECT value::uuid FROM jsonb_array_elements_text($2::text::jsonb)
         ) ORDER BY id`,
    [request.academicYear, JSON.stringify(references)],
  );
  const requested = new Set(references.map(String));
  const seen = new Set<string>();
  const identities = new Set<string>();
  return rows.map((row) => {
    const result = studentIdentityResolutionV1.parse({
      source: request.source,
      studentUid: row.student_uid,
      academicYear: row.academic_year,
      gradebookStudentId: row.gradebook_student_id,
      ...(request.source === 'portal' ? { accountId: row.account_id } : {}),
    });
    const reference = result.source === 'portal'
      ? result.accountId
      : String(result.gradebookStudentId);
    if (result.academicYear !== request.academicYear || !requested.has(reference)
      || seen.has(reference) || identities.has(result.studentUid)) {
      throw new Error('student-identity-inconsistent-result');
    }
    seen.add(reference);
    identities.add(result.studentUid);
    return result;
  });
}
