import {
  type GradebookImportPersistenceRequestInspectionV4,
  type GradebookImportPersistenceRequestRejectionV4,
  type GradebookImportPersistenceRequestV4,
  type GradebookImportPersistenceResponseV4,
  type GradebookImportRecoverySheetObservationV4,
  type GradebookImportTermSheetObservationV4,
  GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V4,
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V4,
  GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V4,
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V4,
  GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V4,
  inspectGradebookImportPersistenceRequestV4,
  isGradebookImportPersistenceResponseV4,
} from './import-persistence-transport-v4';

import { SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2 } from '../source/source-contract-v2';

/**
 * V5 replaces browser-confirmed technical entity IDs with the canonical roster observed in the
 * workbook. The authorized server remains responsible for matching or creating every entity.
 */
export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V5 = 5 as const;
export const GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V5 = GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V4;
export const GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V5 = GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V4;
export const GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V5 = GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V4;
export const GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V5 =
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V4;
export const GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V5 =
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V4;

export interface GradebookImportSourceStudentV5 {
  readonly position: number;
  readonly label: string;
}

export interface GradebookImportTermStudentObservationV5 extends Omit<
  GradebookImportTermSheetObservationV4['students'][number],
  'confirmedStudent'
> {
  readonly sourceStudent: GradebookImportSourceStudentV5;
}

export interface GradebookImportRecoveryStudentObservationV5 extends Omit<
  GradebookImportRecoverySheetObservationV4['students'][number],
  'confirmedStudent'
> {
  readonly sourceStudent: GradebookImportSourceStudentV5;
}

export interface GradebookImportTermSheetObservationV5 extends Omit<
  GradebookImportTermSheetObservationV4,
  'teachingAssignmentId' | 'students'
> {
  readonly students: readonly GradebookImportTermStudentObservationV5[];
}

export interface GradebookImportRecoverySheetObservationV5 extends Omit<
  GradebookImportRecoverySheetObservationV4,
  'teachingAssignmentId' | 'students'
> {
  readonly students: readonly GradebookImportRecoveryStudentObservationV5[];
}

export type GradebookImportAcademicSheetObservationV5 =
  GradebookImportTermSheetObservationV5 | GradebookImportRecoverySheetObservationV5;

export interface GradebookImportPersistenceRequestV5 extends Omit<
  GradebookImportPersistenceRequestV4,
  'transportVersion' | 'recognizedSuggestions' | 'sheets'
> {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V5;
  readonly recognizedSuggestions: {
    readonly academicYear: number;
    readonly teacherName: string;
  };
  readonly sheets: readonly GradebookImportAcademicSheetObservationV5[];
}

export type GradebookImportPersistenceRequestRejectionV5 =
  GradebookImportPersistenceRequestRejectionV4;
export type GradebookImportPersistenceRequestInspectionV5 =
  GradebookImportPersistenceRequestInspectionV4;

export type GradebookImportPersistenceResponseV5 =
  GradebookImportPersistenceResponseV4 extends infer R
    ? R extends { readonly transportVersion: 4 }
      ? Omit<R, 'transportVersion'> & {
          readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V5;
        }
      : never
    : never;

export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_V5 = {
  version: GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V5,
  operation: GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V5,
  unit: 'one-recognized-source-file-per-request',
  bounds: GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V5,
  security: GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V5,
  academicCatalog: {
    technicalIdentityOwner: 'authorized-server',
    officialRoster: ['trimester-1', 'trimester-2', 'trimester-3'],
    recoveryRoster: 'subset-reference-only',
    overview: 'ignored',
  },
  trustBoundary: {
    browserInput: 'untrusted-structural-labels-and-source-observations',
    forbiddenClientFields: GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V5,
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validSourceStudent(value: unknown): value is GradebookImportSourceStudentV5 {
  return (
    isRecord(value) &&
    exactKeys(value, ['position', 'label']) &&
    Number.isSafeInteger(value.position) &&
    Number(value.position) > 0 &&
    typeof value.label === 'string' &&
    value.label.trim().length > 0 &&
    value.label.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V5.maxSuggestionLength
  );
}

/** Converts only for reuse of the frozen V4 structural validator. The IDs never leave memory. */
function asInspectionOnlyV4(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(value.sheets) || !isRecord(value.recognizedSuggestions)) return null;
  if (
    !Number.isSafeInteger(value.recognizedSuggestions.academicYear) ||
    Number(value.recognizedSuggestions.academicYear) < 2000 ||
    Number(value.recognizedSuggestions.academicYear) > 9999 ||
    typeof value.recognizedSuggestions.teacherName !== 'string' ||
    value.recognizedSuggestions.teacherName.trim().length === 0 ||
    value.recognizedSuggestions.teacherName.length >
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V5.maxSuggestionLength
  ) {
    return null;
  }

  const sheets: unknown[] = [];
  for (const [sheetIndex, candidate] of value.sheets.entries()) {
    if (!isRecord(candidate) || !Array.isArray(candidate.students)) return null;
    const assignmentId = `teaching-assignment:inspection:${sheetIndex}`;
    const students: Record<string, unknown>[] = [];
    for (const [studentIndex, student] of candidate.students.entries()) {
      if (!isRecord(student) || !validSourceStudent(student.sourceStudent)) return null;
      const key = `${sheetIndex}:${studentIndex}`;
      const { sourceStudent: _sourceStudent, ...rest } = student;
      students.push({
        ...rest,
        confirmedStudent: {
          studentId: `student:inspection:${key}`,
          enrollmentId: `enrollment:inspection:${key}`,
        },
      });
    }
    sheets.push({ ...candidate, teachingAssignmentId: assignmentId, students });
  }

  return {
    ...value,
    transportVersion: 4,
    recognizedSuggestions: {
      academicYear: value.recognizedSuggestions.academicYear as number,
      teacherName: value.recognizedSuggestions.teacherName,
    },
    sheets,
  };
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

const QUALITATIVE_SLOTS_V5 = new Set<string>(
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.map((definition) => definition.sourceSlot),
);

/**
 * V4 remains frozen. This copy is inspected only after the original request returned exactly
 * `blocked-definition`, proving that all structural, bounds, identity and trust checks already
 * passed. V5 can then replace only the historical qualitative policy for a second inspection.
 */
function asSourceContractV3InspectionOnlyV4(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...value,
    sheets: (value.sheets as readonly Record<string, unknown>[]).map((sheet) => {
      if (sheet.kind !== 'term') return sheet;
      return {
        ...sheet,
        assessmentDefinitions: (
          sheet.assessmentDefinitions as readonly Record<string, unknown>[]
        ).map((definition) =>
          QUALITATIVE_SLOTS_V5.has(String(definition.sourceSlot))
            ? {
                ...definition,
                maximumConfiguration: { state: 'numeric', rawValue: 1 },
                name: { state: 'text', rawValue: 'SourceContract V3 inspection' },
              }
            : definition,
        ),
      };
    }),
  };
}

export function inspectGradebookImportPersistenceRequestV5(
  value: unknown,
): GradebookImportPersistenceRequestInspectionV5 {
  const bytes = serializedByteLength(value);
  if (bytes === null) return 'invalid-request';
  if (bytes > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V5.maxBodyBytes) return 'payload-too-large';
  if (
    !isRecord(value) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V5
  ) {
    return 'invalid-request';
  }
  const compatible = asInspectionOnlyV4(value);
  if (compatible === null) return 'invalid-request';
  const historicalInspection = inspectGradebookImportPersistenceRequestV4(compatible);
  // Never normalize a structurally invalid request: the second pass is reachable only after V4
  // found no rejection other than its historical qualitative-definition policy.
  return historicalInspection === 'blocked-definition'
    ? inspectGradebookImportPersistenceRequestV4(asSourceContractV3InspectionOnlyV4(compatible))
    : historicalInspection;
}

export function isGradebookImportPersistenceRequestV5(
  value: unknown,
): value is GradebookImportPersistenceRequestV5 {
  return inspectGradebookImportPersistenceRequestV5(value) === 'ready';
}

export function isGradebookImportPersistenceResponseV5(
  value: unknown,
): value is GradebookImportPersistenceResponseV5 {
  return (
    isRecord(value) &&
    value.transportVersion === GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V5 &&
    isGradebookImportPersistenceResponseV4({ ...value, transportVersion: 4 })
  );
}

export function asGradebookImportPersistenceResponseV5(
  value: GradebookImportPersistenceResponseV4,
): GradebookImportPersistenceResponseV5 {
  return { ...value, transportVersion: GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V5 };
}
