import type { GradebookPostgresWritePortV1 } from '../../../gradebook/persistence/postgres/postgres-database-v1';
import { postgresJsonTextV1 } from '../../../gradebook/persistence/postgres/postgres-values-v1';
import { lockYearResetV1 } from './proof-v1';

type AcademicChangeV1 = { changed: boolean; studentIds?: readonly number[] };
const NO_ACADEMIC_CHANGE_V1: AcademicChangeV1 = Object.freeze({ changed: false });

export async function lockResetWriterV1(
  transaction: GradebookPostgresWritePortV1,
  year: number,
): Promise<void> {
  await lockYearResetV1(transaction, year, 'preview');
  await transaction.query('SELECT student_portal.ensure_year_coordination_v1($1::smallint)', [
    year,
  ]);
}

export async function recordResetWriteV1(
  transaction: GradebookPostgresWritePortV1,
  year: number,
  cause:
    | 'diagnostics'
    | 'audit-treatment'
    | 'bulletin-snapshot'
    | 'relation'
    | 'marks'
    | 'council'
    | 'academic-policy',
  academic: AcademicChangeV1 = NO_ACADEMIC_CHANGE_V1,
): Promise<void> {
  const studentIds = [...new Set(academic.studentIds ?? [])].sort((a, b) => a - b);
  if (studentIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new Error('student-portal-revision-student-invalid');
  if (academic.changed && !['relation', 'marks', 'council', 'academic-policy'].includes(cause))
    throw new Error('student-portal-revision-cause-invalid');
  // Bind the numeric flag as integer before PostgreSQL's explicit boolean conversion.
  const result = (
    await transaction.executeNative<{ reset_version: unknown }>(
      `SELECT reset_version FROM student_portal.record_gradebook_change_v1(
      $1::uuid,$2::smallint,$3::text,$4::integer::boolean,
      ARRAY(SELECT value::integer FROM jsonb_array_elements_text($5::jsonb)),statement_timestamp())`,
      [
        crypto.randomUUID(),
        year,
        cause,
        academic.changed ? 1 : 0,
        postgresJsonTextV1(JSON.stringify(studentIds)),
      ],
    )
  ).rows[0];
  if (!result || typeof result.reset_version !== 'string') {
    throw new Error('year-reset-writer-revision-unavailable');
  }
  if (year === 2026 && cause === 'relation' && academic.changed) {
    const synchronized = (
      await transaction.query(
        'SELECT * FROM student_portal.synchronize_gradebook_profiles_v1()',
        [],
      )
    )[0];
    if (!synchronized) throw new Error('student-portal-lifecycle-unavailable');
  }
}

export async function recordImportResetWriteV1(
  transaction: GradebookPostgresWritePortV1,
  year: number,
  cause: 'relation' | 'marks',
  academic: AcademicChangeV1 = NO_ACADEMIC_CHANGE_V1,
): Promise<void> {
  const buffered = transaction as GradebookPostgresWritePortV1 & {
    afterImportFlush?: (
      operation: (database: GradebookPostgresWritePortV1) => Promise<void>,
    ) => void;
  };
  if (typeof buffered.afterImportFlush === 'function') {
    buffered.afterImportFlush((database) => recordResetWriteV1(database, year, cause, academic));
  } else {
    await recordResetWriteV1(transaction, year, cause, academic);
  }
}
