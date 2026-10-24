import {
  type GradebookImportPersistenceIssueV2,
  type GradebookImportPersistenceRequestInspectionV2,
  type GradebookImportPersistenceRequestRejectionV2,
  type GradebookImportPersistenceRequestV2,
  type GradebookImportPersistenceSummaryV2,
  GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V2,
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V2,
  GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V2,
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V2,
  GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V2,
  containsGradebookImportPersistenceForbiddenClientFieldV2,
  inspectGradebookImportPersistenceRequestV2,
  isGradebookImportPersistenceResponseV2,
} from './import-persistence-transport-v2';

import type {
  GradebookImportRecoverySheetObservationV1,
  GradebookImportRecoveryStudentObservationV1,
  GradebookImportRecoveryValuesV1,
  GradebookImportTermSheetObservationV1,
} from './import-persistence-transport-v1';
import type { ApplicabilityV1 } from '../results/results-contract-v1';

/**
 * V3 preserves the observed AC/AD/AE cell instead of collapsing it to a boolean.
 * V1 and V2 remain frozen and interpretable as historical transports.
 */
export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V3 = 3 as const;
export const GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V3 = GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V2;
export const GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V3 = GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V2;
export const GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V3 = GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V2;
export const GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V3 =
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V2;
export const GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V3 =
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V2;

export type GradebookImportRecoveryApplicabilityObservationV3 =
  | { readonly classification: 'numeric'; readonly rawValue: number }
  | { readonly classification: 'empty'; readonly rawValue: null | '' }
  | { readonly classification: 'missing-field' }
  | { readonly classification: 'unrecognized'; readonly rawValue: string | boolean }
  | {
      readonly classification: 'formula';
      readonly rawValue: string | number | boolean | null;
      readonly formula: string;
      readonly cachedValue: number | null;
    };

export interface GradebookImportRecoveryValuesV3 extends Omit<
  GradebookImportRecoveryValuesV1,
  'eligibleTrimester1' | 'eligibleTrimester2' | 'eligibleTrimester3'
> {
  readonly applicabilityTrimester1: GradebookImportRecoveryApplicabilityObservationV3;
  readonly applicabilityTrimester2: GradebookImportRecoveryApplicabilityObservationV3;
  readonly applicabilityTrimester3: GradebookImportRecoveryApplicabilityObservationV3;
}

export interface GradebookImportRecoveryStudentObservationV3 extends Omit<
  GradebookImportRecoveryStudentObservationV1,
  'recovery'
> {
  readonly recovery: GradebookImportRecoveryValuesV3;
}

export interface GradebookImportRecoverySheetObservationV3 extends Omit<
  GradebookImportRecoverySheetObservationV1,
  'students'
> {
  readonly students: readonly GradebookImportRecoveryStudentObservationV3[];
}

export type GradebookImportAcademicSheetObservationV3 =
  GradebookImportTermSheetObservationV1 | GradebookImportRecoverySheetObservationV3;

export interface GradebookImportPersistenceRequestV3 extends Omit<
  GradebookImportPersistenceRequestV2,
  'transportVersion' | 'sheets'
> {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V3;
  readonly sheets: readonly GradebookImportAcademicSheetObservationV3[];
}

export type GradebookImportPersistenceRequestRejectionV3 =
  GradebookImportPersistenceRequestRejectionV2;
export type GradebookImportPersistenceRequestInspectionV3 =
  GradebookImportPersistenceRequestInspectionV2;

interface GradebookImportPersistenceResponseBaseV3 {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V3;
}

export type GradebookImportPersistenceResponseV3 =
  | (GradebookImportPersistenceResponseBaseV3 & {
      readonly state: 'applied' | 'no-changes';
      readonly summary: GradebookImportPersistenceSummaryV2;
    })
  | (GradebookImportPersistenceResponseBaseV3 & {
      readonly state: 'review-required' | 'blocked';
      readonly summary: GradebookImportPersistenceSummaryV2;
      readonly issues: readonly [
        GradebookImportPersistenceIssueV2,
        ...GradebookImportPersistenceIssueV2[],
      ];
    })
  | (GradebookImportPersistenceResponseBaseV3 & { readonly state: 'conflict' })
  | (GradebookImportPersistenceResponseBaseV3 & {
      readonly state: 'invalid-request';
      readonly reason: GradebookImportPersistenceRequestRejectionV3;
    })
  | (GradebookImportPersistenceResponseBaseV3 & {
      readonly state: 'not-authorized' | 'unavailable';
    });

export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_V3 = {
  version: GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V3,
  operation: GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V3,
  unit: 'one-recognized-source-file-per-request',
  bounds: GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V3,
  security: GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V3,
  recoveryApplicability: {
    sourceCells: ['AC', 'AD', 'AE'],
    preservedStates: ['numeric', 'empty', 'missing-field', 'unrecognized', 'formula'],
    numericOne: 'applicable',
    numericZero: 'not-applicable',
    everythingElse: 'insufficient-data',
  },
  trustBoundary: {
    browserInput: 'untrusted-recognized-academic-observations',
    recoveryApplicability: 'observation-not-authority',
    forbiddenClientFields: GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V3,
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.length === required.length;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isGradebookImportRecoveryApplicabilityObservationV3(
  value: unknown,
): value is GradebookImportRecoveryApplicabilityObservationV3 {
  if (!isRecord(value) || typeof value.classification !== 'string') return false;
  if (value.classification === 'missing-field') return hasExactKeys(value, ['classification']);
  if (value.classification === 'empty') {
    return (
      hasExactKeys(value, ['classification', 'rawValue']) &&
      (value.rawValue === null || value.rawValue === '')
    );
  }
  if (value.classification === 'numeric') {
    return hasExactKeys(value, ['classification', 'rawValue']) && isFiniteNumber(value.rawValue);
  }
  if (value.classification === 'unrecognized') {
    return (
      hasExactKeys(value, ['classification', 'rawValue']) &&
      ((typeof value.rawValue === 'string' &&
        value.rawValue.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V3.maxSuggestionLength) ||
        typeof value.rawValue === 'boolean')
    );
  }
  return (
    value.classification === 'formula' &&
    hasExactKeys(value, ['classification', 'rawValue', 'formula', 'cachedValue']) &&
    (value.rawValue === null ||
      typeof value.rawValue === 'string' ||
      typeof value.rawValue === 'boolean' ||
      isFiniteNumber(value.rawValue)) &&
    typeof value.formula === 'string' &&
    value.formula.length > 0 &&
    value.formula.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V3.maxFormulaLength &&
    (value.cachedValue === null || isFiniteNumber(value.cachedValue))
  );
}

/** Historical 1/0 meaning is explicit; every other observation fails closed. */
export function resolveGradebookImportRecoveryApplicabilityV3(
  observation: GradebookImportRecoveryApplicabilityObservationV3,
): ApplicabilityV1 {
  if (observation.classification === 'numeric' && observation.rawValue === 1) {
    return { state: 'applicable' };
  }
  if (observation.classification === 'numeric' && observation.rawValue === 0) {
    return { state: 'not-applicable', reason: 'source REC flag is explicitly numeric zero' };
  }
  return {
    state: 'insufficient-data',
    reason: `source REC applicability is not an explicit numeric 1 or 0: ${observation.classification}`,
  };
}

const RECOVERY_VALUE_KEYS_V3 = [
  'trimester1',
  'trimester2',
  'trimester3',
  'totalAfterRecovery',
  'originalTrimester1',
  'originalTrimester2',
  'originalTrimester3',
  'originalAnnual',
  'applicabilityTrimester1',
  'applicabilityTrimester2',
  'applicabilityTrimester3',
] as const;

function isRecoveryValuesV3(value: unknown): value is GradebookImportRecoveryValuesV3 {
  return (
    isRecord(value) &&
    hasExactKeys(value, RECOVERY_VALUE_KEYS_V3) &&
    isGradebookImportRecoveryApplicabilityObservationV3(value.applicabilityTrimester1) &&
    isGradebookImportRecoveryApplicabilityObservationV3(value.applicabilityTrimester2) &&
    isGradebookImportRecoveryApplicabilityObservationV3(value.applicabilityTrimester3)
  );
}

function recoveryValuesAsV2(
  value: GradebookImportRecoveryValuesV3,
): GradebookImportRecoveryValuesV1 {
  return {
    trimester1: value.trimester1,
    trimester2: value.trimester2,
    trimester3: value.trimester3,
    totalAfterRecovery: value.totalAfterRecovery,
    originalTrimester1: value.originalTrimester1,
    originalTrimester2: value.originalTrimester2,
    originalTrimester3: value.originalTrimester3,
    originalAnnual: value.originalAnnual,
    eligibleTrimester1: false,
    eligibleTrimester2: false,
    eligibleTrimester3: false,
  };
}

function asInspectionOnlyV2(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(value.sheets)) return null;
  const sheets: unknown[] = [];
  for (const sheet of value.sheets) {
    if (!isRecord(sheet) || sheet.kind !== 'recovery') {
      sheets.push(sheet);
      continue;
    }
    if (!Array.isArray(sheet.students)) return null;
    const students: unknown[] = [];
    for (const student of sheet.students) {
      if (!isRecord(student) || !isRecoveryValuesV3(student.recovery)) return null;
      students.push({ ...student, recovery: recoveryValuesAsV2(student.recovery) });
    }
    sheets.push({ ...sheet, students });
  }
  return { ...value, transportVersion: 2, sheets };
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

export function inspectGradebookImportPersistenceRequestV3(
  value: unknown,
): GradebookImportPersistenceRequestInspectionV3 {
  if (containsGradebookImportPersistenceForbiddenClientFieldV2(value)) {
    return 'forbidden-client-payload';
  }
  const byteLength = serializedByteLength(value);
  if (byteLength === null) return 'invalid-request';
  if (byteLength > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V3.maxBodyBytes) {
    return 'payload-too-large';
  }
  if (
    !isRecord(value) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V3
  ) {
    return 'invalid-request';
  }
  const compatible = asInspectionOnlyV2(value);
  return compatible === null
    ? 'invalid-request'
    : inspectGradebookImportPersistenceRequestV2(compatible);
}

export function isGradebookImportPersistenceRequestV3(
  value: unknown,
): value is GradebookImportPersistenceRequestV3 {
  return inspectGradebookImportPersistenceRequestV3(value) === 'ready';
}

export function isGradebookImportPersistenceResponseV3(
  value: unknown,
): value is GradebookImportPersistenceResponseV3 {
  if (
    !isRecord(value) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V3
  ) {
    return false;
  }
  return isGradebookImportPersistenceResponseV2({ ...value, transportVersion: 2 });
}
