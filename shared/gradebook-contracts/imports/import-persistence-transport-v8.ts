import {
  inspectGradebookImportPersistenceRequestV6,
  isGradebookImportPersistenceResponseV6,
  type GradebookImportPersistenceRequestV6,
  type GradebookImportPersistenceResponseV6,
  type GradebookImportCourseV6,
  type GradebookImportTermV6,
  type GradebookImportRecoveryV6,
} from './import-persistence-transport-v6';
import {
  SOURCE_VALUES_POLICY_V5,
  SNAPSHOT_UNAVAILABLE_INTERNAL_V5,
} from '../source/source-values-contract-v5';

export const GRADEBOOK_IMPORT_VALUES_VERSION_V8 = 8 as const;
export const GRADEBOOK_IMPORT_VALUES_BODY_BYTES_V8 = 2_000_000;
export type GradebookSnapshotCellV8 = number | string | boolean | readonly ['u'];
export type GradebookSnapshotCellsV8 = Readonly<Record<string, GradebookSnapshotCellV8>>;
export interface GradebookSnapshotTermV8 extends Omit<GradebookImportTermV6, 'rows'> {
  readonly rows: readonly (readonly [number, GradebookSnapshotCellsV8])[];
}
export interface GradebookSnapshotRecoveryV8 extends Omit<GradebookImportRecoveryV6, 'rows'> {
  readonly rows: readonly (readonly [number, number, GradebookSnapshotCellsV8])[];
}
export interface GradebookSnapshotCourseV8 extends Omit<
  GradebookImportCourseV6,
  'terms' | 'recovery'
> {
  readonly terms: readonly [
    GradebookSnapshotTermV8,
    GradebookSnapshotTermV8,
    GradebookSnapshotTermV8,
  ];
  readonly recovery: GradebookSnapshotRecoveryV8 | null;
}
export interface GradebookImportPersistenceRequestV8 extends Omit<
  GradebookImportPersistenceRequestV6,
  'transportVersion' | 'courses'
> {
  readonly transportVersion: 8;
  readonly valuePolicy: typeof SOURCE_VALUES_POLICY_V5;
  readonly courses: readonly GradebookSnapshotCourseV8[];
}
export type GradebookImportPersistenceResponseV8 =
  GradebookImportPersistenceResponseV6 extends infer R
    ? R extends { transportVersion: 6 }
      ? Omit<R, 'transportVersion'> & { readonly transportVersion: 8 }
      : never
    : never;

/** Shape adapter only. The server separately enables prospective value semantics. */
export function snapshotRequestAsV6(
  request: GradebookImportPersistenceRequestV8,
): GradebookImportPersistenceRequestV6 {
  const { valuePolicy: _policy, ...base } = request;
  void _policy;
  const cells = (input: GradebookSnapshotCellsV8) =>
    Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        Array.isArray(value) ? SNAPSHOT_UNAVAILABLE_INTERNAL_V5 : value,
      ]),
    );
  return {
    ...base,
    transportVersion: 6,
    courses: request.courses.map((course) => ({
      ...course,
      terms: course.terms.map((term) => ({
        ...term,
        rows: term.rows.map(([position, values]) => [position, cells(values)] as const),
      })) as unknown as GradebookImportCourseV6['terms'],
      recovery: course.recovery
        ? {
            ...course.recovery,
            rows: course.recovery.rows.map(
              ([position, row, values]) => [position, row, cells(values)] as const,
            ),
          }
        : null,
    })),
  };
}

/** Source cells: finite numbers, booleans, text without NUL, or the unavailable marker ['u']. */
function inspectCellsV8(values: GradebookSnapshotCellsV8) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  return Object.values(values).every((cell) => {
    if (Array.isArray(cell)) {
      return cell.length === 1 && cell[0] === 'u';
    }
    if (typeof cell === 'number') {
      return Number.isFinite(cell);
    }
    return typeof cell === 'boolean' || (typeof cell === 'string' && !cell.includes('\u0000'));
  });
}

function courseCellsValidV8(course: GradebookImportPersistenceRequestV8['courses'][number]) {
  for (const term of course.terms)
    for (const row of term.rows) if (!inspectCellsV8(row[1])) return false;
  if (course.recovery)
    for (const row of course.recovery.rows) if (!inspectCellsV8(row[2])) return false;
  return true;
}

export function inspectGradebookImportPersistenceRequestV8(
  value: unknown,
): ReturnType<typeof inspectGradebookImportPersistenceRequestV6> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid-request';
    const request = value as GradebookImportPersistenceRequestV8;
    if (
      request.transportVersion !== 8 ||
      request.valuePolicy !== SOURCE_VALUES_POLICY_V5 ||
      !Array.isArray(request.courses)
    )
      return 'invalid-request';
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      GRADEBOOK_IMPORT_VALUES_BODY_BYTES_V8
    )
      return 'payload-too-large';
    if (!request.courses.every(courseCellsValidV8)) return 'invalid-academic-shape';
    return inspectGradebookImportPersistenceRequestV6(snapshotRequestAsV6(request));
  } catch {
    return 'invalid-request';
  }
}
export function isGradebookImportPersistenceRequestV8(
  value: unknown,
): value is GradebookImportPersistenceRequestV8 {
  return inspectGradebookImportPersistenceRequestV8(value) === 'ready';
}
export function isGradebookImportPersistenceResponseV8(
  value: unknown,
): value is GradebookImportPersistenceResponseV8 {
  return (
    !!value &&
    typeof value === 'object' &&
    'transportVersion' in value &&
    value.transportVersion === 8 &&
    isGradebookImportPersistenceResponseV6({ ...value, transportVersion: 6 })
  );
}
