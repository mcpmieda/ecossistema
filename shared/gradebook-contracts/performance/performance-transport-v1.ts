import type {
  AcademicYearId,
  ClassGroupId,
  EnrollmentId,
  EnrollmentPositionV1,
  StudentId,
  StudentStatusEventId,
  StudentStatusV1,
} from '../entities';
import {
  CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
  PERFORMANCE_AUTHORITY_MODE_V1,
  PERFORMANCE_LENSES_V1,
  inspectClassPerformanceRequestV1,
  isClassPerformanceReadModelValidV1,
  type ClassPerformanceReadModelV1,
  type ClassPerformanceRequestV1,
  type PerformanceCellDetailRefV1,
  type PerformanceCellV1,
  type PerformanceStudentDetailRefV1,
} from './class-performance-read-model-v1';

/**
 * HTTP transport for Performance V1. This is a serialization boundary over the existing read model,
 * not a second academic contract. It deliberately omits source evidence and authorization claims.
 */
export const PERFORMANCE_TRANSPORT_VERSION_V1 = 1 as const;

const PERFORMANCE_TRANSPORT_OPERATIONS_V1 = [
  'matrix',
  'student-detail',
  'cell-detail',
] as const;
type PerformanceTransportOperationV1 =
  (typeof PERFORMANCE_TRANSPORT_OPERATIONS_V1)[number];

export interface PerformanceMatrixTransportRequestV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly operation: 'matrix';
  readonly request: ClassPerformanceRequestV1;
}

export interface PerformanceStudentDetailTransportRequestV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly operation: 'student-detail';
  readonly detailRef: PerformanceStudentDetailRefV1;
}

export interface PerformanceCellDetailTransportRequestV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly operation: 'cell-detail';
  readonly detailRef: PerformanceCellDetailRefV1;
}

export type PerformanceTransportRequestV1 =
  | PerformanceMatrixTransportRequestV1
  | PerformanceStudentDetailTransportRequestV1
  | PerformanceCellDetailTransportRequestV1;

interface PerformanceStudentDetailTransportV1 {
  readonly detailRef: PerformanceStudentDetailRefV1;
  readonly academicYearId: AcademicYearId;
  readonly classGroupId: ClassGroupId;
  readonly student: {
    readonly id: StudentId;
    readonly displayName: string;
  } | null;
  readonly enrollment: {
    readonly id: EnrollmentId;
    readonly studentId: StudentId;
    readonly classGroupId: ClassGroupId;
    readonly position: EnrollmentPositionV1;
    readonly sourcePosition?: number;
  };
  readonly statusHistory: readonly {
    readonly id: StudentStatusEventId;
    readonly status: StudentStatusV1;
    readonly occurredOn?: string;
  }[];
}

interface PerformanceCellDetailTransportV1 {
  readonly detailRef: PerformanceCellDetailRefV1;
  readonly studentId: StudentId;
  readonly authorityMode: typeof PERFORMANCE_AUTHORITY_MODE_V1;
  readonly cell: PerformanceCellV1;
}

interface PerformanceMatrixReadyTransportResponseV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly state: 'ready';
  readonly operation: 'matrix';
  readonly matrix: ClassPerformanceReadModelV1;
}

interface PerformanceStudentDetailReadyTransportResponseV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly state: 'ready';
  readonly operation: 'student-detail';
  readonly detail: PerformanceStudentDetailTransportV1;
}

interface PerformanceCellDetailReadyTransportResponseV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly state: 'ready';
  readonly operation: 'cell-detail';
  readonly detail: PerformanceCellDetailTransportV1;
}

interface PerformanceEmptyTransportResponseV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly state: 'empty';
  readonly operation: PerformanceTransportOperationV1;
}

interface PerformanceUnavailableTransportResponseV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly state: 'unavailable';
}

interface PerformanceNotAuthorizedTransportResponseV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly state: 'not-authorized';
}

export const PERFORMANCE_INVALID_REQUEST_REASONS_V1 = [
  'invalid-request',
  'invalid-row-cursor',
  'invalid-column-cursor',
  'invalid-detail-reference',
] as const;
export type PerformanceInvalidRequestReasonV1 =
  (typeof PERFORMANCE_INVALID_REQUEST_REASONS_V1)[number];

interface PerformanceInvalidRequestTransportResponseV1 {
  readonly transportVersion: typeof PERFORMANCE_TRANSPORT_VERSION_V1;
  readonly state: 'invalid-request';
  readonly reason: PerformanceInvalidRequestReasonV1;
}

type PerformanceTransportResponseV1 =
  | PerformanceMatrixReadyTransportResponseV1
  | PerformanceStudentDetailReadyTransportResponseV1
  | PerformanceCellDetailReadyTransportResponseV1
  | PerformanceEmptyTransportResponseV1
  | PerformanceUnavailableTransportResponseV1
  | PerformanceNotAuthorizedTransportResponseV1
  | PerformanceInvalidRequestTransportResponseV1;

const FORBIDDEN_TRANSPORT_KEYS = new Set([
  'officialRecords',
  'evidence',
  'rawSourceEvidence',
  'sourceEvidence',
  'sourceNames',
  'sourceIdentityMarks',
  'sourceText',
  'sourceReference',
  'importBatchId',
  'roles',
  'capabilities',
  'authorization',
  'actorId',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function containsPerformanceForbiddenTransportFieldV1(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPerformanceForbiddenTransportFieldV1);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_TRANSPORT_KEYS.has(key) || containsPerformanceForbiddenTransportFieldV1(nested)) {
      return true;
    }
  }
  return false;
}

export function isPerformanceTransportRequestV1(
  value: unknown,
): value is PerformanceTransportRequestV1 {
  if (
    !isRecord(value) ||
    containsPerformanceForbiddenTransportFieldV1(value) ||
    value.transportVersion !== PERFORMANCE_TRANSPORT_VERSION_V1 ||
    typeof value.operation !== 'string' ||
    !(PERFORMANCE_TRANSPORT_OPERATIONS_V1 as readonly string[]).includes(value.operation)
  ) {
    return false;
  }

  if (value.operation === 'matrix') {
    return (
      hasExactKeys(value, ['transportVersion', 'operation', 'request']) &&
      inspectClassPerformanceRequestV1(value.request as ClassPerformanceRequestV1) === 'ready'
    );
  }

  return (
    hasExactKeys(value, ['transportVersion', 'operation', 'detailRef']) &&
    nonEmptyString(value.detailRef)
  );
}

function isCoverage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    ['complete', 'partial', 'insufficient-data', 'not-applicable'].includes(String(value.state)) &&
    Number.isInteger(value.expectedItemCount) &&
    Number.isInteger(value.resolvedItemCount) &&
    Number.isInteger(value.missingItemCount) &&
    Number(value.expectedItemCount) >= 0 &&
    Number(value.resolvedItemCount) >= 0 &&
    Number(value.missingItemCount) >= 0 &&
    Number(value.resolvedItemCount) + Number(value.missingItemCount) === Number(value.expectedItemCount) &&
    Array.isArray(value.reasons) &&
    value.reasons.every(nonEmptyString)
  );
}

function isPerformanceCell(value: unknown): value is PerformanceCellV1 {
  if (!isRecord(value) || containsPerformanceForbiddenTransportFieldV1(value)) return false;
  if (
    !PERFORMANCE_LENSES_V1.includes(value.lens as PerformanceCellV1['lens']) ||
    !nonEmptyString(value.teachingAssignmentId) ||
    value.authorityMode !== PERFORMANCE_AUTHORITY_MODE_V1 ||
    !isCoverage(value.coverage) ||
    !nonEmptyString(value.detailRef) ||
    !Array.isArray(value.signals) ||
    !isRecord(value.projection)
  ) {
    return false;
  }
  return value.signals.every(
    (signal) =>
      isRecord(signal) &&
      nonEmptyString(signal.code) &&
      nonEmptyString(signal.explanation) &&
      ['official-result', 'coverage', 'comparison'].includes(String(signal.source)) &&
      (signal.detailRef === null || nonEmptyString(signal.detailRef)),
  );
}

function isStudentDetail(value: unknown): value is PerformanceStudentDetailTransportV1 {
  if (
    !isRecord(value) ||
    containsPerformanceForbiddenTransportFieldV1(value) ||
    !hasExactKeys(value, [
      'detailRef',
      'academicYearId',
      'classGroupId',
      'student',
      'enrollment',
      'statusHistory',
    ]) ||
    !nonEmptyString(value.detailRef) ||
    !nonEmptyString(value.academicYearId) ||
    !nonEmptyString(value.classGroupId) ||
    !isRecord(value.enrollment) ||
    !hasExactKeys(value.enrollment, ['id', 'studentId', 'classGroupId', 'position'], ['sourcePosition']) ||
    !nonEmptyString(value.enrollment.id) ||
    !nonEmptyString(value.enrollment.studentId) ||
    !nonEmptyString(value.enrollment.classGroupId) ||
    !['current', 'historical'].includes(String(value.enrollment.position)) ||
    (value.enrollment.sourcePosition !== undefined &&
      (!Number.isInteger(value.enrollment.sourcePosition) || Number(value.enrollment.sourcePosition) <= 0)) ||
    !Array.isArray(value.statusHistory)
  ) {
    return false;
  }

  if (
    value.student !== null &&
    (!isRecord(value.student) ||
      !hasExactKeys(value.student, ['id', 'displayName']) ||
      !nonEmptyString(value.student.id) ||
      !nonEmptyString(value.student.displayName))
  ) {
    return false;
  }

  return value.statusHistory.every(
    (event) =>
      isRecord(event) &&
      hasExactKeys(event, ['id', 'status'], ['occurredOn']) &&
      nonEmptyString(event.id) &&
      ['active', 'transferred', 'withdrawn', 'deceased', 'other'].includes(String(event.status)) &&
      (event.occurredOn === undefined || nonEmptyString(event.occurredOn)),
  );
}

function isCellDetail(value: unknown): value is PerformanceCellDetailTransportV1 {
  return (
    isRecord(value) &&
    !containsPerformanceForbiddenTransportFieldV1(value) &&
    hasExactKeys(value, ['detailRef', 'studentId', 'authorityMode', 'cell']) &&
    nonEmptyString(value.detailRef) &&
    nonEmptyString(value.studentId) &&
    value.authorityMode === PERFORMANCE_AUTHORITY_MODE_V1 &&
    isPerformanceCell(value.cell) &&
    value.cell.detailRef === value.detailRef
  );
}

export function isPerformanceTransportResponseV1(
  value: unknown,
): value is PerformanceTransportResponseV1 {
  if (
    !isRecord(value) ||
    containsPerformanceForbiddenTransportFieldV1(value) ||
    value.transportVersion !== PERFORMANCE_TRANSPORT_VERSION_V1 ||
    typeof value.state !== 'string'
  ) {
    return false;
  }

  if (value.state === 'not-authorized' || value.state === 'unavailable') {
    return hasExactKeys(value, ['transportVersion', 'state']);
  }

  if (value.state === 'invalid-request') {
    return (
      hasExactKeys(value, ['transportVersion', 'state', 'reason']) &&
      (PERFORMANCE_INVALID_REQUEST_REASONS_V1 as readonly unknown[]).includes(value.reason)
    );
  }

  if (value.state === 'empty') {
    return (
      hasExactKeys(value, ['transportVersion', 'state', 'operation']) &&
      (PERFORMANCE_TRANSPORT_OPERATIONS_V1 as readonly unknown[]).includes(value.operation)
    );
  }

  if (value.state !== 'ready' || typeof value.operation !== 'string') return false;
  if (value.operation === 'matrix') {
    return (
      hasExactKeys(value, ['transportVersion', 'state', 'operation', 'matrix']) &&
      isClassPerformanceReadModelValidV1(value.matrix as ClassPerformanceReadModelV1) &&
      (value.matrix as ClassPerformanceReadModelV1).contractVersion === CLASS_PERFORMANCE_CONTRACT_VERSION_V1
    );
  }
  if (value.operation === 'student-detail') {
    return (
      hasExactKeys(value, ['transportVersion', 'state', 'operation', 'detail']) &&
      isStudentDetail(value.detail)
    );
  }
  if (value.operation === 'cell-detail') {
    return (
      hasExactKeys(value, ['transportVersion', 'state', 'operation', 'detail']) &&
      isCellDetail(value.detail)
    );
  }
  return false;
}
