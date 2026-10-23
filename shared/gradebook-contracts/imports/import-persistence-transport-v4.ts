import type { SourceCellRawValueV1 } from '../source/source-contract-v1';
import type {
  GradebookImportPersistenceIssueV2,
  GradebookImportPersistenceSummaryV2,
} from './import-persistence-transport-v2';
import type {
  GradebookImportAssessmentDefinitionV1,
  GradebookImportAssessmentValueV1,
  GradebookImportConfirmedStudentReferenceV1,
  GradebookImportRecognizedNoteV1,
  GradebookImportTermSheetObservationV1,
} from './import-persistence-transport-v1';
import {
  GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V3,
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V3,
  GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V3,
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V3,
  GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V3,
  inspectGradebookImportPersistenceRequestV3,
  isGradebookImportPersistenceResponseV3,
  isGradebookImportRecoveryApplicabilityObservationV3,
  type GradebookImportPersistenceRequestInspectionV3,
  type GradebookImportPersistenceRequestRejectionV3,
  type GradebookImportPersistenceRequestV3,
  type GradebookImportRecoverySheetObservationV3,
  type GradebookImportRecoveryStudentObservationV3,
  type GradebookImportRecoveryValuesV3,
} from './import-persistence-transport-v3';

/**
 * V4 preserves direct result-cell observations that earlier transports collapsed to `note | null`.
 * Provenance is deliberately absent and must be reconstructed by the authorized server.
 */
export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V4 = 4 as const;
export const GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V4 = GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V3;
export const GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V4 = GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V3;
export const GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V4 = GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V3;
export const GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V4 =
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V3;
export const GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V4 =
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V3;

export type GradebookImportResultCellObservationV4 =
  | { readonly classification: 'missing-field' }
  | { readonly classification: 'empty'; readonly rawValue: null | '' }
  | { readonly classification: 'manual-positive-number'; readonly rawValue: number }
  | { readonly classification: 'manual-negative-number'; readonly rawValue: number }
  | { readonly classification: 'manual-legacy-zero'; readonly rawValue: 0 }
  | { readonly classification: 'manual-official-zero-marker'; readonly rawValue: 0.1 }
  | {
      readonly classification: 'formula-nonzero';
      readonly rawValue: SourceCellRawValueV1;
      readonly formula: string;
      readonly cachedValue: number;
    }
  | {
      readonly classification: 'formula-zero';
      readonly rawValue: SourceCellRawValueV1;
      readonly formula: string;
      readonly cachedValue: 0;
    }
  | {
      readonly classification: 'formula-error-or-missing-cache';
      readonly rawValue: SourceCellRawValueV1;
      readonly formula: string;
      readonly cachedValue: null;
      readonly sourceError: string | null;
    }
  | { readonly classification: 'invalid-text'; readonly rawValue: string };

export interface GradebookImportTermResultObservationsV4 {
  readonly quantitativeTotal: GradebookImportResultCellObservationV4;
  readonly parallelAssessment: GradebookImportResultCellObservationV4;
  readonly qualitativeTotal: GradebookImportResultCellObservationV4;
  readonly officialTermGrade: GradebookImportResultCellObservationV4;
  readonly annualAccumulatedTotal: GradebookImportResultCellObservationV4;
}

export interface GradebookImportTermStudentObservationV4 {
  readonly sourceRow: number;
  readonly confirmedStudent: GradebookImportConfirmedStudentReferenceV1;
  readonly assessmentValues: readonly GradebookImportAssessmentValueV1[];
  readonly aggregates: GradebookImportTermResultObservationsV4;
}

export interface GradebookImportTermSheetObservationV4 extends Omit<
  GradebookImportTermSheetObservationV1,
  'students'
> {
  readonly assessmentDefinitions: readonly GradebookImportAssessmentDefinitionV1[];
  readonly students: readonly GradebookImportTermStudentObservationV4[];
}

export interface GradebookImportRecoveryValuesV4 extends Omit<
  GradebookImportRecoveryValuesV3,
  | 'trimester1'
  | 'trimester2'
  | 'trimester3'
  | 'totalAfterRecovery'
  | 'originalTrimester1'
  | 'originalTrimester2'
  | 'originalTrimester3'
  | 'originalAnnual'
> {
  readonly trimester1: GradebookImportResultCellObservationV4;
  readonly trimester2: GradebookImportResultCellObservationV4;
  readonly trimester3: GradebookImportResultCellObservationV4;
  readonly totalAfterRecovery: GradebookImportResultCellObservationV4;
  readonly originalTrimester1: GradebookImportResultCellObservationV4;
  readonly originalTrimester2: GradebookImportResultCellObservationV4;
  readonly originalTrimester3: GradebookImportResultCellObservationV4;
  readonly originalAnnual: GradebookImportResultCellObservationV4;
}

export interface GradebookImportRecoveryStudentObservationV4 extends Omit<
  GradebookImportRecoveryStudentObservationV3,
  'recovery'
> {
  readonly recovery: GradebookImportRecoveryValuesV4;
}

export interface GradebookImportRecoverySheetObservationV4 extends Omit<
  GradebookImportRecoverySheetObservationV3,
  'students'
> {
  readonly students: readonly GradebookImportRecoveryStudentObservationV4[];
}

export type GradebookImportAcademicSheetObservationV4 =
  | GradebookImportTermSheetObservationV4
  | GradebookImportRecoverySheetObservationV4;

export interface GradebookImportPersistenceRequestV4 extends Omit<
  GradebookImportPersistenceRequestV3,
  'transportVersion' | 'sheets'
> {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V4;
  readonly sheets: readonly GradebookImportAcademicSheetObservationV4[];
}

export type GradebookImportPersistenceRequestRejectionV4 =
  GradebookImportPersistenceRequestRejectionV3;
export type GradebookImportPersistenceRequestInspectionV4 =
  GradebookImportPersistenceRequestInspectionV3;

interface GradebookImportPersistenceResponseBaseV4 {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V4;
}

export type GradebookImportPersistenceResponseV4 =
  | (GradebookImportPersistenceResponseBaseV4 & {
      readonly state: 'applied' | 'no-changes';
      readonly summary: GradebookImportPersistenceSummaryV2;
    })
  | (GradebookImportPersistenceResponseBaseV4 & {
      readonly state: 'review-required' | 'blocked';
      readonly summary: GradebookImportPersistenceSummaryV2;
      readonly issues: readonly [
        GradebookImportPersistenceIssueV2,
        ...GradebookImportPersistenceIssueV2[],
      ];
    })
  | (GradebookImportPersistenceResponseBaseV4 & { readonly state: 'conflict' })
  | (GradebookImportPersistenceResponseBaseV4 & {
      readonly state: 'invalid-request';
      readonly reason: GradebookImportPersistenceRequestRejectionV4;
    })
  | (GradebookImportPersistenceResponseBaseV4 & {
      readonly state: 'not-authorized' | 'unavailable';
    });

export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_V4 = {
  version: GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V4,
  operation: GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V4,
  unit: 'one-recognized-source-file-per-request',
  bounds: GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V4,
  security: GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V4,
  directResultCells: {
    term: ['T', 'Z', 'AK', 'AM', 'AN'],
    recovery: ['R', 'S', 'T', 'U', 'X', 'Y', 'AA', 'AB'],
    recoveryApplicability: ['AC', 'AD', 'AE'],
    provenance: 'server-reconstructed',
  },
  trustBoundary: {
    browserInput: 'untrusted-classified-source-observation',
    academicSemantics: 'server-interpret-source-cell',
    provenance: 'server-only',
    forbiddenClientFields: GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V4,
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rawSourceValue(value: unknown): value is SourceCellRawValueV1 {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function validFormula(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V4.maxFormulaLength
  );
}

export function isGradebookImportResultCellObservationV4(
  value: unknown,
): value is GradebookImportResultCellObservationV4 {
  if (!isRecord(value) || typeof value.classification !== 'string') return false;
  switch (value.classification) {
    case 'missing-field':
      return hasExactKeys(value, ['classification']);
    case 'empty':
      return (
        hasExactKeys(value, ['classification', 'rawValue']) &&
        (value.rawValue === null || value.rawValue === '')
      );
    case 'manual-positive-number':
      return (
        hasExactKeys(value, ['classification', 'rawValue']) && finite(value.rawValue) && value.rawValue > 0
      );
    case 'manual-negative-number':
      return (
        hasExactKeys(value, ['classification', 'rawValue']) && finite(value.rawValue) && value.rawValue < 0
      );
    case 'manual-legacy-zero':
      return hasExactKeys(value, ['classification', 'rawValue']) && value.rawValue === 0;
    case 'manual-official-zero-marker':
      return hasExactKeys(value, ['classification', 'rawValue']) && value.rawValue === 0.1; // NOSONAR: the exact literal the source/profile carries, never a computed value
    case 'formula-nonzero':
      return (
        hasExactKeys(value, ['classification', 'rawValue', 'formula', 'cachedValue']) &&
        rawSourceValue(value.rawValue) &&
        validFormula(value.formula) &&
        finite(value.cachedValue) &&
        value.cachedValue !== 0
      );
    case 'formula-zero':
      return (
        hasExactKeys(value, ['classification', 'rawValue', 'formula', 'cachedValue']) &&
        rawSourceValue(value.rawValue) &&
        validFormula(value.formula) &&
        value.cachedValue === 0
      );
    case 'formula-error-or-missing-cache':
      return (
        hasExactKeys(value, [
          'classification',
          'rawValue',
          'formula',
          'cachedValue',
          'sourceError',
        ]) &&
        rawSourceValue(value.rawValue) &&
        validFormula(value.formula) &&
        value.cachedValue === null &&
        (value.sourceError === null || typeof value.sourceError === 'string')
      );
    case 'invalid-text':
      return (
        hasExactKeys(value, ['classification', 'rawValue']) &&
        typeof value.rawValue === 'string' &&
        value.rawValue.length > 0 &&
        value.rawValue.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V4.maxSuggestionLength
      );
    default:
      return false;
  }
}

const TERM_AGGREGATE_KEYS_V4 = [
  'quantitativeTotal',
  'parallelAssessment',
  'qualitativeTotal',
  'officialTermGrade',
  'annualAccumulatedTotal',
] as const;

const RECOVERY_DIRECT_KEYS_V4 = [
  'trimester1',
  'trimester2',
  'trimester3',
  'totalAfterRecovery',
  'originalTrimester1',
  'originalTrimester2',
  'originalTrimester3',
  'originalAnnual',
] as const;

const RECOVERY_APPLICABILITY_KEYS_V4 = [
  'applicabilityTrimester1',
  'applicabilityTrimester2',
  'applicabilityTrimester3',
] as const;

function observationAsHistoricalNote(
  observation: GradebookImportResultCellObservationV4,
): GradebookImportRecognizedNoteV1 | null {
  switch (observation.classification) {
    case 'manual-positive-number':
      return { kind: 'manual', source: observation.rawValue, value: observation.rawValue };
    case 'manual-negative-number':
      return { kind: 'negative', source: observation.rawValue, value: observation.rawValue };
    case 'manual-legacy-zero':
      return { kind: 'legacy-zero', source: 0, value: 0 };
    case 'manual-official-zero-marker':
      return { kind: 'official-zero', source: 0.1, value: 0 };
    case 'formula-nonzero':
      return {
        kind: 'formula',
        source: observation.cachedValue,
        value: observation.cachedValue,
        formula: observation.formula,
      };
    case 'missing-field':
    case 'empty':
    case 'formula-zero':
    case 'formula-error-or-missing-cache':
    case 'invalid-text':
      return null;
  }
}

function isTermAggregatesV4(value: unknown): value is GradebookImportTermResultObservationsV4 {
  return (
    isRecord(value) &&
    hasExactKeys(value, TERM_AGGREGATE_KEYS_V4) &&
    TERM_AGGREGATE_KEYS_V4.every((key) => isGradebookImportResultCellObservationV4(value[key]))
  );
}

function isRecoveryValuesV4(value: unknown): value is GradebookImportRecoveryValuesV4 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [...RECOVERY_DIRECT_KEYS_V4, ...RECOVERY_APPLICABILITY_KEYS_V4]) &&
    RECOVERY_DIRECT_KEYS_V4.every((key) => isGradebookImportResultCellObservationV4(value[key])) &&
    RECOVERY_APPLICABILITY_KEYS_V4.every((key) =>
      isGradebookImportRecoveryApplicabilityObservationV3(value[key]),
    )
  );
}

function asInspectionOnlyV3(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(value.sheets)) return null;
  const sheets: unknown[] = [];
  for (const sheet of value.sheets) {
    if (!isRecord(sheet) || !Array.isArray(sheet.students)) return null;
    if (sheet.kind === 'term') {
      const students: unknown[] = [];
      for (const student of sheet.students) {
        if (!isRecord(student)) return null;
        const aggregates = student.aggregates;
        if (!isTermAggregatesV4(aggregates)) return null;
        students.push({
          ...student,
          aggregates: Object.fromEntries(
            TERM_AGGREGATE_KEYS_V4.map((key) => [key, observationAsHistoricalNote(aggregates[key])]),
          ),
        });
      }
      sheets.push({ ...sheet, students });
      continue;
    }
    if (sheet.kind === 'recovery') {
      const students: unknown[] = [];
      for (const student of sheet.students) {
        if (!isRecord(student) || !isRecoveryValuesV4(student.recovery)) return null;
        const recovery = student.recovery;
        students.push({
          ...student,
          recovery: {
            ...Object.fromEntries(
              RECOVERY_DIRECT_KEYS_V4.map((key) => [key, observationAsHistoricalNote(recovery[key])]),
            ),
            applicabilityTrimester1: recovery.applicabilityTrimester1,
            applicabilityTrimester2: recovery.applicabilityTrimester2,
            applicabilityTrimester3: recovery.applicabilityTrimester3,
          },
        });
      }
      sheets.push({ ...sheet, students });
      continue;
    }
    return null;
  }
  return { ...value, transportVersion: 3, sheets };
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

export function inspectGradebookImportPersistenceRequestV4(
  value: unknown,
): GradebookImportPersistenceRequestInspectionV4 {
  const bytes = serializedByteLength(value);
  if (bytes === null) return 'invalid-request';
  if (bytes > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V4.maxBodyBytes) return 'payload-too-large';
  if (
    !isRecord(value) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V4
  ) {
    return 'invalid-request';
  }
  const compatible = asInspectionOnlyV3(value);
  return compatible === null ? 'invalid-request' : inspectGradebookImportPersistenceRequestV3(compatible);
}

export function isGradebookImportPersistenceRequestV4(
  value: unknown,
): value is GradebookImportPersistenceRequestV4 {
  return inspectGradebookImportPersistenceRequestV4(value) === 'ready';
}

export function isGradebookImportPersistenceResponseV4(
  value: unknown,
): value is GradebookImportPersistenceResponseV4 {
  if (
    !isRecord(value) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V4
  ) {
    return false;
  }
  return isGradebookImportPersistenceResponseV3({ ...value, transportVersion: 3 });
}
