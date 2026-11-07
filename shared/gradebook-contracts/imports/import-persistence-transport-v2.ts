import type { AcademicYearId } from '../entities';
import {
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2,
  SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2,
  type SourceAssessmentSlotV2,
} from '../source/source-contract-v2';
import {
  GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1,
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V1,
  GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_SCOPES_V1,
  GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V1,
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V1,
  GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V1,
  inspectGradebookImportPersistenceRequestV1,
  type GradebookImportAcademicRecordCountsV1,
  type GradebookImportAssessmentComponentCountsV1,
  type GradebookImportAssessmentDefinitionCountsV1,
  type GradebookImportPersistenceIssueScopeV1,
  type GradebookImportPersistenceRequestRejectionV1,
  type GradebookImportPersistenceRequestV1,
} from './import-persistence-transport-v1';

/**
 * First-import evolution of the bounded browser transport. The V1 contract is
 * intentionally left frozen; V2 removes browser authority over logical-source identity.
 */
export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V2 = 2 as const;
export const GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V2 = GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V1;
export const GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V2 = GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1;
export const GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V2 = GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V1;

export const GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V2 = [
  ...GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V1,
  'logicalSourceId',
] as const;

export interface GradebookImportConfirmedContextV2 {
  readonly academicYearId: AcademicYearId;
}

export interface GradebookImportSourceResolutionIntentV2 {
  readonly mode: 'resolve-or-create';
}

export interface GradebookImportPersistenceRequestV2 extends Omit<
  GradebookImportPersistenceRequestV1,
  'transportVersion' | 'confirmedContext'
> {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V2;
  readonly confirmedContext: GradebookImportConfirmedContextV2;
  readonly sourceResolution: GradebookImportSourceResolutionIntentV2;
}

const GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V2 =
  GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V1;
export type GradebookImportPersistenceRequestRejectionV2 =
  GradebookImportPersistenceRequestRejectionV1;
export type GradebookImportPersistenceRequestInspectionV2 =
  'ready' | GradebookImportPersistenceRequestRejectionV2;

export interface GradebookImportPersistenceWriteCountsV2 {
  readonly logicalSources: number;
  readonly sourceFileVersions: number;
  readonly importBatchVersions: number;
  readonly assessmentComponentVersions: number;
  readonly academicRecordVersions: number;
  readonly logicalSourceRecordAssociationVersions: number;
  readonly total: number;
}

export interface GradebookImportPersistenceSummaryV2 {
  readonly assessmentDefinitions: GradebookImportAssessmentDefinitionCountsV1;
  readonly assessmentComponents: GradebookImportAssessmentComponentCountsV1;
  readonly academicRecords: GradebookImportAcademicRecordCountsV1;
  readonly plannedWrites: GradebookImportPersistenceWriteCountsV2;
  readonly committedWrites: GradebookImportPersistenceWriteCountsV2;
}

const GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_CODES_V2 = [
  'invalid-context',
  'incompatible-reference',
  'duplicate-identity',
  'blocked-definition',
  'blocking-diagnostic',
  'invalid-academic-shape',
  'missing-from-new-source',
  'planning-failed',
  'incompatible-logical-source-context',
  'ambiguous-logical-source',
] as const;
export type GradebookImportPersistenceIssueCodeV2 =
  (typeof GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_CODES_V2)[number];

export interface GradebookImportPersistenceIssueV2 {
  readonly code: GradebookImportPersistenceIssueCodeV2;
  readonly scope: GradebookImportPersistenceIssueScopeV1;
  readonly sourceSheetName?: string;
  readonly sourceRow?: number;
  readonly sourceSlot?: SourceAssessmentSlotV2;
}

interface GradebookImportPersistenceResponseBaseV2 {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V2;
}

type GradebookImportPersistenceResponseV2 =
  | (GradebookImportPersistenceResponseBaseV2 & {
      /** `no-changes` means no academic version changed; the audit batch may still be appended. */
      readonly state: 'applied' | 'no-changes';
      readonly summary: GradebookImportPersistenceSummaryV2;
    })
  | (GradebookImportPersistenceResponseBaseV2 & {
      readonly state: 'review-required' | 'blocked';
      readonly summary: GradebookImportPersistenceSummaryV2;
      readonly issues: readonly [
        GradebookImportPersistenceIssueV2,
        ...GradebookImportPersistenceIssueV2[],
      ];
    })
  | (GradebookImportPersistenceResponseBaseV2 & {
      readonly state: 'conflict';
    })
  | (GradebookImportPersistenceResponseBaseV2 & {
      readonly state: 'invalid-request';
      readonly reason: GradebookImportPersistenceRequestRejectionV2;
    })
  | (GradebookImportPersistenceResponseBaseV2 & {
      readonly state: 'not-authorized' | 'unavailable';
    });

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
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

const FORBIDDEN_CLIENT_FIELD_SET_V2 = new Set<string>(
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V2,
);

export function containsGradebookImportPersistenceForbiddenClientFieldV2(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsGradebookImportPersistenceForbiddenClientFieldV2);
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      FORBIDDEN_CLIENT_FIELD_SET_V2.has(key) ||
      containsGradebookImportPersistenceForbiddenClientFieldV2(nested),
  );
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V2.maxIdentifierLength
  );
}

export function inspectGradebookImportPersistenceRequestV2(
  value: unknown,
): GradebookImportPersistenceRequestInspectionV2 {
  if (containsGradebookImportPersistenceForbiddenClientFieldV2(value)) {
    return 'forbidden-client-payload';
  }
  const byteLength = serializedByteLength(value);
  if (byteLength === null) return 'invalid-request';
  if (byteLength > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V2.maxBodyBytes) {
    return 'payload-too-large';
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'transportVersion',
      'operation',
      'manifest',
      'recognizedSuggestions',
      'confirmedContext',
      'sourceResolution',
      'sheets',
      'diagnostics',
    ]) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V2 ||
    value.operation !== GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V2 ||
    !isRecord(value.confirmedContext) ||
    !hasExactKeys(value.confirmedContext, ['academicYearId']) ||
    !validOpaqueId(value.confirmedContext.academicYearId) ||
    !isRecord(value.sourceResolution) ||
    !hasExactKeys(value.sourceResolution, ['mode']) ||
    value.sourceResolution.mode !== 'resolve-or-create'
  ) {
    return 'invalid-request';
  }

  const compatibleV1Request = {
    ...value,
    transportVersion: 1,
    confirmedContext: {
      academicYearId: value.confirmedContext.academicYearId,
      // Inspection-only placeholder. It is never emitted, persisted, or treated as authority.
      logicalSourceId: 'x',
    },
  } as Record<string, unknown>;
  delete compatibleV1Request.sourceResolution;
  return inspectGradebookImportPersistenceRequestV1(compatibleV1Request);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isWriteCounts(value: unknown): value is GradebookImportPersistenceWriteCountsV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'logicalSources',
      'sourceFileVersions',
      'importBatchVersions',
      'assessmentComponentVersions',
      'academicRecordVersions',
      'logicalSourceRecordAssociationVersions',
      'total',
    ]) ||
    !Object.values(value).every(nonNegativeInteger)
  ) {
    return false;
  }
  const counts = value as unknown as GradebookImportPersistenceWriteCountsV2;
  return (
    counts.total ===
    counts.logicalSources +
      counts.sourceFileVersions +
      counts.importBatchVersions +
      counts.assessmentComponentVersions +
      counts.academicRecordVersions +
      counts.logicalSourceRecordAssociationVersions
  );
}

function isAssessmentDefinitionCounts(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['total', 'resolved', 'blocked']) ||
    !Object.values(value).every(nonNegativeInteger)
  ) {
    return false;
  }
  const counts = value as unknown as GradebookImportAssessmentDefinitionCountsV1;
  return counts.total === counts.resolved + counts.blocked;
}

function isStateCounts(value: unknown, keys: readonly string[]): boolean {
  return (
    isRecord(value) && hasExactKeys(value, keys) && Object.values(value).every(nonNegativeInteger)
  );
}

function isSummary(value: unknown): value is GradebookImportPersistenceSummaryV2 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'assessmentDefinitions',
      'assessmentComponents',
      'academicRecords',
      'plannedWrites',
      'committedWrites',
    ]) &&
    isAssessmentDefinitionCounts(value.assessmentDefinitions) &&
    isStateCounts(value.assessmentComponents, ['unchanged', 'new', 'changed', 'blocked']) &&
    isStateCounts(value.academicRecords, [
      'unchanged',
      'new',
      'changed',
      'missingFromNewSource',
      'blocked',
    ]) &&
    isWriteCounts(value.plannedWrites) &&
    isWriteCounts(value.committedWrites)
  );
}

const ASSESSMENT_SLOTS_V2 = new Set<string>([
  ...SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2.map((slot) => slot.sourceSlot),
  ...SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.map((slot) => slot.sourceSlot),
]);

function isIssue(value: unknown): value is GradebookImportPersistenceIssueV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'scope'], ['sourceSheetName', 'sourceRow', 'sourceSlot']) ||
    !(GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_CODES_V2 as readonly unknown[]).includes(value.code) ||
    !(GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_SCOPES_V1 as readonly unknown[]).includes(value.scope) ||
    (value.sourceSheetName !== undefined &&
      (typeof value.sourceSheetName !== 'string' ||
        value.sourceSheetName.trim().length === 0 ||
        value.sourceSheetName.length >
          GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V2.maxSheetNameLength)) ||
    (value.sourceRow !== undefined &&
      (!Number.isSafeInteger(value.sourceRow) || Number(value.sourceRow) < 5)) ||
    (value.sourceSlot !== undefined &&
      (typeof value.sourceSlot !== 'string' || !ASSESSMENT_SLOTS_V2.has(value.sourceSlot)))
  ) {
    return false;
  }
  if (value.scope === 'file') {
    return (
      value.sourceSheetName === undefined &&
      value.sourceRow === undefined &&
      value.sourceSlot === undefined
    );
  }
  if (value.scope === 'sheet') {
    return (
      value.sourceSheetName !== undefined &&
      value.sourceRow === undefined &&
      value.sourceSlot === undefined
    );
  }
  if (value.scope === 'student') {
    return (
      value.sourceSheetName !== undefined &&
      value.sourceRow !== undefined &&
      value.sourceSlot === undefined
    );
  }
  return (
    value.sourceSheetName !== undefined &&
    value.sourceRow === undefined &&
    value.sourceSlot !== undefined
  );
}

function sameWriteCounts(
  left: GradebookImportPersistenceWriteCountsV2,
  right: GradebookImportPersistenceWriteCountsV2,
): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof GradebookImportPersistenceWriteCountsV2] ===
      right[key as keyof GradebookImportPersistenceWriteCountsV2],
  );
}

function academicWriteCount(counts: GradebookImportPersistenceWriteCountsV2): number {
  return (
    counts.assessmentComponentVersions +
    counts.academicRecordVersions +
    counts.logicalSourceRecordAssociationVersions
  );
}

export function isGradebookImportPersistenceResponseV2(
  value: unknown,
): value is GradebookImportPersistenceResponseV2 {
  if (
    !isRecord(value) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V2 ||
    typeof value.state !== 'string'
  ) {
    return false;
  }
  if (
    value.state === 'not-authorized' ||
    value.state === 'unavailable' ||
    value.state === 'conflict'
  ) {
    return hasExactKeys(value, ['transportVersion', 'state']);
  }
  if (value.state === 'invalid-request') {
    return (
      hasExactKeys(value, ['transportVersion', 'state', 'reason']) &&
      (GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V2 as readonly unknown[]).includes(
        value.reason,
      )
    );
  }
  if (value.state === 'applied' || value.state === 'no-changes') {
    if (
      !hasExactKeys(value, ['transportVersion', 'state', 'summary']) ||
      !isSummary(value.summary)
    ) {
      return false;
    }
    if (!sameWriteCounts(value.summary.plannedWrites, value.summary.committedWrites)) return false;
    const academicWrites = academicWriteCount(value.summary.committedWrites);
    return value.state === 'applied' ? academicWrites > 0 : academicWrites === 0;
  }
  if (value.state === 'review-required' || value.state === 'blocked') {
    return (
      hasExactKeys(value, ['transportVersion', 'state', 'summary', 'issues']) &&
      isSummary(value.summary) &&
      value.summary.committedWrites.total === 0 &&
      Array.isArray(value.issues) &&
      value.issues.length > 0 &&
      value.issues.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V2.maxDiagnosticsPerRequest &&
      value.issues.every(isIssue)
    );
  }
  return false;
}
