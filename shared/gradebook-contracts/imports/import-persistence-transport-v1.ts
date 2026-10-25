import type { AuditSeverityV1 } from '../audit/audit-contract-v1';
import type {
  AcademicYearId,
  EnrollmentId,
  EntityIdV1,
  StudentId,
  TeachingAssignmentId,
} from '../entities';
import {
  SOURCE_FILE_EXTENSIONS_V1,
  type SourceDisciplineIndexV1,
  type SourceFileExtensionV1,
} from '../source/source-contract-v1';
import {
  SOURCE_ASSESSMENT_MAXIMUM_CONFIGURATION_STATES_V2,
  SOURCE_ASSESSMENT_NAME_STATES_V2,
  SOURCE_CONTRACT_VERSION_V2,
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2,
  SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2,
  type SourceAssessmentSlotV2,
  type SourceQualitativeActivitySlotV2,
  type SourceQuantitativeAssessmentSlotV2,
} from '../source/source-contract-v2';
import { scalarTextV1 } from '../../scalar-text-v1';

/**
 * Bounded JSON transport between the local workbook recognizer and a future authorized backend.
 * It is deliberately an observation contract, not a persistence plan.
 */
export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V1 = 1 as const;
export const GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V1 = 'persist-recognized-file' as const;

export const GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1 = {
  maxFilesSelectedInBrowser: 50,
  maxFilesPerRequest: 1,
  maxBodyBytes: 8_388_608,
  maxSheetsPerRequest: 128,
  maxStudentsPerSheet: 512,
  maxStudentObservationsPerRequest: 20_000,
  maxAssessmentDefinitionsPerTermSheet: 12,
  maxAssessmentValuesPerStudent: 12,
  maxDiagnosticsPerRequest: 256,
  maxIdentifierLength: 256,
  maxFileNameLength: 512,
  maxSheetNameLength: 256,
  maxSuggestionLength: 512,
  maxDiagnosticCodeLength: 128,
  maxParserVersionLength: 128,
  maxMimeTypeLength: 256,
  maxFormulaLength: 4_096,
} as const;

export const GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V1 = [
  'arrayBuffer',
  'authorityMode',
  'binary',
  'buffer',
  'bytes',
  'cas',
  'councilDecision',
  'databaseId',
  'ddl',
  'd1DatabaseId',
  'expectedBatchVersion',
  'expectedVersion',
  'filePath',
  'importChangePlan',
  'localPath',
  'mutations',
  'nativeResult',
  'path',
  'persistedPayload',
  'promotionRequest',
  'resourceId',
  'sql',
  'workbook',
  'worksheet',
  'writes',
] as const;

export const GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V1 = {
  capability: 'gradebook.persistence.admin',
  requireAuth: true,
  officialOrigin: true,
  writeOrigin: true,
  cacheControl: 'no-store',
  productionGate: 'GRADEBOOK_PRODUCTION_ENABLED',
  browserPersistentAcademicStorage: 'forbidden',
} as const;

export type GradebookImportLogicalSourceIdV1 = EntityIdV1<'LogicalSourceV1'>;

export interface GradebookImportSourceManifestV1 {
  readonly fileName: string;
  readonly extension: SourceFileExtensionV1;
  readonly reportedMimeType: string | null;
  readonly sizeBytes: number;
  readonly lastModifiedAt: string | null;
  readonly sha256: string;
  readonly sourceContractVersion: typeof SOURCE_CONTRACT_VERSION_V2;
  readonly parserVersion: string;
  readonly readAt: string;
}

/** Labels recognized from the workbook remain suggestions and never become technical identity. */
export interface GradebookImportRecognizedSuggestionsV1 {
  readonly academicYear: number | null;
  readonly teacherName: string | null;
}

/** Existing opaque references confirmed before transport. The server must validate them again. */
export interface GradebookImportConfirmedContextV1 {
  readonly academicYearId: AcademicYearId;
  readonly logicalSourceId: GradebookImportLogicalSourceIdV1;
}

export interface GradebookImportRecognizedSheetContextV1 {
  readonly classGroupLabel: string;
  readonly subjectLabel: string;
  readonly disciplineIndex: SourceDisciplineIndexV1;
}

export type GradebookImportRecognizedNoteV1 =
  | {
      readonly kind: 'manual';
      readonly source: number;
      readonly value: number;
    }
  | {
      readonly kind: 'formula';
      readonly source: number;
      readonly value: number;
      readonly formula: string;
    }
  | {
      readonly kind: 'official-zero';
      readonly source: 0.1;
      readonly value: 0;
    }
  | {
      readonly kind: 'legacy-zero';
      readonly source: 0;
      readonly value: 0;
    }
  | {
      readonly kind: 'negative';
      readonly source: number;
      readonly value: number;
    };

export type GradebookImportAssessmentMaximumV1 =
  | { readonly state: 'numeric'; readonly rawValue: number }
  | { readonly state: 'ambiguous-empty'; readonly rawValue: null | '' }
  | { readonly state: 'ambiguous-marker'; readonly rawValue: '*' }
  | { readonly state: 'missing-field' }
  | { readonly state: 'unrecognized'; readonly rawValue: string | boolean };

export type GradebookImportAssessmentNameV1 =
  | { readonly state: 'text'; readonly rawValue: string }
  | { readonly state: 'empty'; readonly rawValue: null | '' }
  | { readonly state: 'missing-field' }
  | { readonly state: 'unrecognized'; readonly rawValue: number | boolean };

export type GradebookImportAssessmentDefinitionV1 =
  | {
      readonly sourceSlot: SourceQuantitativeAssessmentSlotV2;
      readonly maximumConfiguration: GradebookImportAssessmentMaximumV1;
    }
  | {
      readonly sourceSlot: SourceQualitativeActivitySlotV2;
      readonly maximumConfiguration: GradebookImportAssessmentMaximumV1;
      readonly name: GradebookImportAssessmentNameV1;
    };

export interface GradebookImportAssessmentValueV1 {
  readonly sourceSlot: SourceAssessmentSlotV2;
  readonly value: GradebookImportRecognizedNoteV1;
}

export interface GradebookImportConfirmedStudentReferenceV1 {
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
}

export interface GradebookImportTermAggregatesV1 {
  readonly quantitativeTotal: GradebookImportRecognizedNoteV1 | null;
  readonly parallelAssessment: GradebookImportRecognizedNoteV1 | null;
  readonly qualitativeTotal: GradebookImportRecognizedNoteV1 | null;
  readonly officialTermGrade: GradebookImportRecognizedNoteV1 | null;
  readonly annualAccumulatedTotal: GradebookImportRecognizedNoteV1 | null;
}

export interface GradebookImportTermStudentObservationV1 {
  readonly sourceRow: number;
  readonly confirmedStudent: GradebookImportConfirmedStudentReferenceV1;
  readonly assessmentValues: readonly GradebookImportAssessmentValueV1[];
  readonly aggregates: GradebookImportTermAggregatesV1;
}

export interface GradebookImportRecoveryValuesV1 {
  readonly trimester1: GradebookImportRecognizedNoteV1 | null;
  readonly trimester2: GradebookImportRecognizedNoteV1 | null;
  readonly trimester3: GradebookImportRecognizedNoteV1 | null;
  readonly totalAfterRecovery: GradebookImportRecognizedNoteV1 | null;
  readonly originalTrimester1: GradebookImportRecognizedNoteV1 | null;
  readonly originalTrimester2: GradebookImportRecognizedNoteV1 | null;
  readonly originalTrimester3: GradebookImportRecognizedNoteV1 | null;
  readonly originalAnnual: GradebookImportRecognizedNoteV1 | null;
  readonly eligibleTrimester1: boolean;
  readonly eligibleTrimester2: boolean;
  readonly eligibleTrimester3: boolean;
}

export interface GradebookImportRecoveryStudentObservationV1 {
  readonly sourceRow: number;
  readonly confirmedStudent: GradebookImportConfirmedStudentReferenceV1;
  readonly recovery: GradebookImportRecoveryValuesV1;
}

interface GradebookImportSheetBaseV1 {
  readonly sourceSheetName: string;
  readonly recognizedContext: GradebookImportRecognizedSheetContextV1;
  readonly teachingAssignmentId: TeachingAssignmentId;
}

export interface GradebookImportTermSheetObservationV1 extends GradebookImportSheetBaseV1 {
  readonly kind: 'term';
  readonly term: 1 | 2 | 3;
  readonly assessmentDefinitions: readonly GradebookImportAssessmentDefinitionV1[];
  readonly students: readonly GradebookImportTermStudentObservationV1[];
}

export interface GradebookImportRecoverySheetObservationV1 extends GradebookImportSheetBaseV1 {
  readonly kind: 'recovery';
  readonly students: readonly GradebookImportRecoveryStudentObservationV1[];
}

export type GradebookImportAcademicSheetObservationV1 =
  GradebookImportTermSheetObservationV1 | GradebookImportRecoverySheetObservationV1;

export type GradebookImportRecognitionDiagnosticV1 =
  | {
      readonly severity: AuditSeverityV1;
      readonly code: string;
      readonly scope: 'file';
    }
  | {
      readonly severity: AuditSeverityV1;
      readonly code: string;
      readonly scope: 'sheet';
      readonly sourceSheetName: string;
    };

export interface GradebookImportPersistenceRequestV1 {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V1;
  readonly operation: typeof GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V1;
  readonly manifest: GradebookImportSourceManifestV1;
  readonly recognizedSuggestions: GradebookImportRecognizedSuggestionsV1;
  readonly confirmedContext: GradebookImportConfirmedContextV1;
  readonly sheets: readonly GradebookImportAcademicSheetObservationV1[];
  readonly diagnostics: readonly GradebookImportRecognitionDiagnosticV1[];
}

export const GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V1 = [
  'invalid-request',
  'forbidden-client-payload',
  'payload-too-large',
  'invalid-context',
  'duplicate-identity',
  'blocked-definition',
  'blocking-diagnostic',
  'invalid-academic-shape',
] as const;
export type GradebookImportPersistenceRequestRejectionV1 =
  (typeof GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V1)[number];
export type GradebookImportPersistenceRequestInspectionV1 =
  'ready' | GradebookImportPersistenceRequestRejectionV1;

export interface GradebookImportAssessmentDefinitionCountsV1 {
  readonly total: number;
  readonly resolved: number;
  readonly blocked: number;
}

export interface GradebookImportAssessmentComponentCountsV1 {
  readonly unchanged: number;
  readonly new: number;
  readonly changed: number;
  readonly blocked: number;
}

export interface GradebookImportAcademicRecordCountsV1 {
  readonly unchanged: number;
  readonly new: number;
  readonly changed: number;
  readonly missingFromNewSource: number;
  readonly blocked: number;
}

export interface GradebookImportPersistenceSummaryV1 {
  readonly assessmentDefinitions: GradebookImportAssessmentDefinitionCountsV1;
  readonly assessmentComponents: GradebookImportAssessmentComponentCountsV1;
  readonly academicRecords: GradebookImportAcademicRecordCountsV1;
  readonly plannedVersionWrites: number;
  readonly committedVersionWrites: number;
}

export const GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_CODES_V1 = [
  'invalid-context',
  'incompatible-reference',
  'duplicate-identity',
  'blocked-definition',
  'blocking-diagnostic',
  'invalid-academic-shape',
  'missing-from-new-source',
  'planning-failed',
] as const;
export type GradebookImportPersistenceIssueCodeV1 =
  (typeof GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_CODES_V1)[number];

export const GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_SCOPES_V1 = [
  'file',
  'sheet',
  'student',
  'assessment-definition',
] as const;
export type GradebookImportPersistenceIssueScopeV1 =
  (typeof GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_SCOPES_V1)[number];

export interface GradebookImportPersistenceIssueV1 {
  readonly code: GradebookImportPersistenceIssueCodeV1;
  readonly scope: GradebookImportPersistenceIssueScopeV1;
  readonly sourceSheetName?: string;
  readonly sourceRow?: number;
  readonly sourceSlot?: SourceAssessmentSlotV2;
}

interface GradebookImportPersistenceResponseBaseV1 {
  readonly transportVersion: typeof GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V1;
}

export type GradebookImportPersistenceResponseV1 =
  | (GradebookImportPersistenceResponseBaseV1 & {
      readonly state: 'applied' | 'no-changes';
      readonly summary: GradebookImportPersistenceSummaryV1;
    })
  | (GradebookImportPersistenceResponseBaseV1 & {
      readonly state: 'review-required' | 'blocked';
      readonly summary: GradebookImportPersistenceSummaryV1;
      readonly issues: readonly [
        GradebookImportPersistenceIssueV1,
        ...GradebookImportPersistenceIssueV1[],
      ];
    })
  | (GradebookImportPersistenceResponseBaseV1 & {
      readonly state: 'conflict';
    })
  | (GradebookImportPersistenceResponseBaseV1 & {
      readonly state: 'invalid-request';
      readonly reason: GradebookImportPersistenceRequestRejectionV1;
    })
  | (GradebookImportPersistenceResponseBaseV1 & {
      readonly state: 'not-authorized' | 'unavailable';
    });

export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_V1 = {
  version: GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V1,
  operation: GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V1,
  unit: 'one-recognized-source-file-per-request',
  bounds: GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1,
  security: GRADEBOOK_IMPORT_PERSISTENCE_SECURITY_V1,
  trustBoundary: {
    browserInput: 'untrusted-recognized-academic-observations',
    confirmedReferences: [
      'academicYearId',
      'logicalSourceId',
      'teachingAssignmentId',
      'studentId',
      'enrollmentId',
    ],
    serverDerived: [
      'import-batch-identity-and-version',
      'source-file-manifest-identity',
      'assessment-component-identity',
      'grade-entry-identity',
      'academic-record-identity',
      'change-state',
      'write-plan',
      'expected-version-and-cas',
      'authority-mode',
    ],
    forbiddenClientFields: GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V1,
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
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0)
  );
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveSourceRow(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 5;
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function validOpaqueId(value: unknown): value is string {
  return boundedString(value, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxIdentifierLength);
}

const FORBIDDEN_CLIENT_FIELD_SET = new Set<string>(
  GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V1,
);

export function containsGradebookImportPersistenceForbiddenClientFieldV1(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsGradebookImportPersistenceForbiddenClientFieldV1);
  }
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (
      FORBIDDEN_CLIENT_FIELD_SET.has(key) ||
      containsGradebookImportPersistenceForbiddenClientFieldV1(nested)
    ) {
      return true;
    }
  }
  return false;
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function isManifest(value: unknown): value is GradebookImportSourceManifestV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'fileName',
      'extension',
      'reportedMimeType',
      'sizeBytes',
      'lastModifiedAt',
      'sha256',
      'sourceContractVersion',
      'parserVersion',
      'readAt',
    ]) ||
    !boundedString(value.fileName, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxFileNameLength) ||
    !(SOURCE_FILE_EXTENSIONS_V1 as readonly unknown[]).includes(value.extension) ||
    (value.reportedMimeType !== null &&
      !boundedString(
        value.reportedMimeType,
        GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxMimeTypeLength,
        true,
      )) ||
    !nonNegativeInteger(value.sizeBytes) ||
    (value.lastModifiedAt !== null && !validIsoTimestamp(value.lastModifiedAt)) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    value.sourceContractVersion !== SOURCE_CONTRACT_VERSION_V2 ||
    !boundedString(
      value.parserVersion,
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxParserVersionLength,
    ) ||
    !validIsoTimestamp(value.readAt)
  ) {
    return false;
  }
  return true;
}

function isRecognizedSuggestions(value: unknown): value is GradebookImportRecognizedSuggestionsV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['academicYear', 'teacherName']) &&
    (value.academicYear === null ||
      (Number.isSafeInteger(value.academicYear) && Number(value.academicYear) > 0)) &&
    (value.teacherName === null ||
      boundedString(value.teacherName, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSuggestionLength))
  );
}

function isConfirmedContext(value: unknown): value is GradebookImportConfirmedContextV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['academicYearId', 'logicalSourceId']) &&
    validOpaqueId(value.academicYearId) &&
    validOpaqueId(value.logicalSourceId)
  );
}

function isRecognizedSheetContext(
  value: unknown,
): value is GradebookImportRecognizedSheetContextV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['classGroupLabel', 'subjectLabel', 'disciplineIndex']) &&
    boundedString(
      value.classGroupLabel,
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSuggestionLength,
    ) &&
    boundedString(value.subjectLabel, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSuggestionLength) &&
    typeof value.disciplineIndex === 'string' &&
    /^D[1-9]\d*$/u.test(value.disciplineIndex)
  );
}

function isRecognizedNote(value: unknown): value is GradebookImportRecognizedNoteV1 {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'formula') {
    return (
      hasExactKeys(value, ['kind', 'source', 'value', 'formula']) &&
      finiteNumber(value.source) &&
      value.source !== 0 &&
      finiteNumber(value.value) &&
      value.value === value.source &&
      boundedString(value.formula, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxFormulaLength)
    );
  }
  if (!hasExactKeys(value, ['kind', 'source', 'value'])) return false;
  switch (value.kind) {
    case 'manual':
      return finiteNumber(value.source) && value.source > 0 && value.value === value.source;
    case 'negative':
      return finiteNumber(value.source) && value.source < 0 && value.value === value.source;
    case 'official-zero':
      return value.source === 0.1 && value.value === 0; // NOSONAR: the exact literal the source/profile carries, never a computed value
    case 'legacy-zero':
      return value.source === 0 && value.value === 0;
    default:
      return false;
  }
}

function isNullableRecognizedNote(value: unknown): boolean {
  return value === null || isRecognizedNote(value);
}

function isAssessmentMaximum(value: unknown): value is GradebookImportAssessmentMaximumV1 {
  if (
    !isRecord(value) ||
    !(SOURCE_ASSESSMENT_MAXIMUM_CONFIGURATION_STATES_V2 as readonly unknown[]).includes(value.state)
  ) {
    return false;
  }
  if (value.state === 'missing-field') return hasExactKeys(value, ['state']);
  if (!hasExactKeys(value, ['state', 'rawValue'])) return false;
  switch (value.state) {
    case 'numeric':
      return finiteNumber(value.rawValue);
    case 'ambiguous-empty':
      return value.rawValue === null || value.rawValue === '';
    case 'ambiguous-marker':
      return value.rawValue === '*';
    case 'unrecognized':
      return (
        typeof value.rawValue === 'boolean' ||
        boundedString(
          value.rawValue,
          GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSuggestionLength,
          true,
        )
      );
    default:
      return false;
  }
}

function isAssessmentName(value: unknown): value is GradebookImportAssessmentNameV1 {
  if (
    !isRecord(value) ||
    !(SOURCE_ASSESSMENT_NAME_STATES_V2 as readonly unknown[]).includes(value.state)
  ) {
    return false;
  }
  if (value.state === 'missing-field') return hasExactKeys(value, ['state']);
  if (!hasExactKeys(value, ['state', 'rawValue'])) return false;
  switch (value.state) {
    case 'text':
      return boundedString(
        value.rawValue,
        GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSuggestionLength,
        true,
      );
    case 'empty':
      return value.rawValue === null || value.rawValue === '';
    case 'unrecognized':
      return finiteNumber(value.rawValue) || typeof value.rawValue === 'boolean';
    default:
      return false;
  }
}

const QUANTITATIVE_SLOTS = new Set<string>(
  SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2.map((slot) => slot.sourceSlot),
);
const QUALITATIVE_SLOTS = new Set<string>(
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.map((slot) => slot.sourceSlot),
);
const ALL_ASSESSMENT_SLOTS = new Set<string>([...QUANTITATIVE_SLOTS, ...QUALITATIVE_SLOTS]);

function isAssessmentDefinition(value: unknown): value is GradebookImportAssessmentDefinitionV1 {
  if (!isRecord(value) || typeof value.sourceSlot !== 'string') return false;
  if (QUANTITATIVE_SLOTS.has(value.sourceSlot)) {
    return (
      hasExactKeys(value, ['sourceSlot', 'maximumConfiguration']) &&
      isAssessmentMaximum(value.maximumConfiguration)
    );
  }
  return (
    QUALITATIVE_SLOTS.has(value.sourceSlot) &&
    hasExactKeys(value, ['sourceSlot', 'maximumConfiguration', 'name']) &&
    isAssessmentMaximum(value.maximumConfiguration) &&
    isAssessmentName(value.name)
  );
}

function isDefinitionResolved(value: GradebookImportAssessmentDefinitionV1): boolean {
  if (
    value.maximumConfiguration.state !== 'numeric' ||
    !Number.isFinite(value.maximumConfiguration.rawValue) ||
    value.maximumConfiguration.rawValue <= 0
  ) {
    return false;
  }
  return (
    !('name' in value) || (value.name.state === 'text' && value.name.rawValue.trim().length > 0)
  );
}

function isConfirmedStudent(value: unknown): value is GradebookImportConfirmedStudentReferenceV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['studentId', 'enrollmentId']) &&
    validOpaqueId(value.studentId) &&
    validOpaqueId(value.enrollmentId)
  );
}

function isAssessmentValue(value: unknown): value is GradebookImportAssessmentValueV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['sourceSlot', 'value']) &&
    typeof value.sourceSlot === 'string' &&
    ALL_ASSESSMENT_SLOTS.has(value.sourceSlot) &&
    isRecognizedNote(value.value)
  );
}

function isTermAggregates(value: unknown): value is GradebookImportTermAggregatesV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'quantitativeTotal',
      'parallelAssessment',
      'qualitativeTotal',
      'officialTermGrade',
      'annualAccumulatedTotal',
    ]) &&
    isNullableRecognizedNote(value.quantitativeTotal) &&
    isNullableRecognizedNote(value.parallelAssessment) &&
    isNullableRecognizedNote(value.qualitativeTotal) &&
    isNullableRecognizedNote(value.officialTermGrade) &&
    isNullableRecognizedNote(value.annualAccumulatedTotal)
  );
}

function isTermStudent(value: unknown, definitionSlots: ReadonlySet<string>): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['sourceRow', 'confirmedStudent', 'assessmentValues', 'aggregates']) ||
    !positiveSourceRow(value.sourceRow) ||
    !isConfirmedStudent(value.confirmedStudent) ||
    !Array.isArray(value.assessmentValues) ||
    value.assessmentValues.length >
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxAssessmentValuesPerStudent ||
    !isTermAggregates(value.aggregates)
  ) {
    return false;
  }
  const slots = new Set<string>();
  for (const assessment of value.assessmentValues) {
    if (
      !isAssessmentValue(assessment) ||
      !definitionSlots.has(assessment.sourceSlot) ||
      slots.has(assessment.sourceSlot)
    ) {
      return false;
    }
    slots.add(assessment.sourceSlot);
  }
  return true;
}

function isRecoveryValues(value: unknown): value is GradebookImportRecoveryValuesV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'trimester1',
      'trimester2',
      'trimester3',
      'totalAfterRecovery',
      'originalTrimester1',
      'originalTrimester2',
      'originalTrimester3',
      'originalAnnual',
      'eligibleTrimester1',
      'eligibleTrimester2',
      'eligibleTrimester3',
    ]) &&
    isNullableRecognizedNote(value.trimester1) &&
    isNullableRecognizedNote(value.trimester2) &&
    isNullableRecognizedNote(value.trimester3) &&
    isNullableRecognizedNote(value.totalAfterRecovery) &&
    isNullableRecognizedNote(value.originalTrimester1) &&
    isNullableRecognizedNote(value.originalTrimester2) &&
    isNullableRecognizedNote(value.originalTrimester3) &&
    isNullableRecognizedNote(value.originalAnnual) &&
    typeof value.eligibleTrimester1 === 'boolean' &&
    typeof value.eligibleTrimester2 === 'boolean' &&
    typeof value.eligibleTrimester3 === 'boolean'
  );
}

function isRecoveryStudent(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['sourceRow', 'confirmedStudent', 'recovery']) &&
    positiveSourceRow(value.sourceRow) &&
    isConfirmedStudent(value.confirmedStudent) &&
    isRecoveryValues(value.recovery)
  );
}

type SheetInspection =
  | { readonly state: 'valid'; readonly studentCount: number; readonly blockedDefinition: boolean }
  | { readonly state: 'invalid' }
  | { readonly state: 'payload-too-large' }
  | { readonly state: 'duplicate-identity' };

function inspectStudents(
  students: readonly unknown[],
  validator: (student: unknown) => boolean,
): 'valid' | 'invalid' | 'payload-too-large' | 'duplicate-identity' {
  if (students.length > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxStudentsPerSheet) {
    return 'payload-too-large';
  }
  const rows = new Set<number>();
  const studentIds = new Set<string>();
  const enrollmentIds = new Set<string>();
  for (const student of students) {
    if (!validator(student) || !isRecord(student) || !isRecord(student.confirmedStudent)) {
      return 'invalid';
    }
    const row = Number(student.sourceRow);
    const studentId = String(student.confirmedStudent.studentId);
    const enrollmentId = String(student.confirmedStudent.enrollmentId);
    if (rows.has(row) || studentIds.has(studentId) || enrollmentIds.has(enrollmentId)) {
      return 'duplicate-identity';
    }
    rows.add(row);
    studentIds.add(studentId);
    enrollmentIds.add(enrollmentId);
  }
  return 'valid';
}

/** The term's assessment slots, each declared once, and whether any definition is unresolved. */
function termDefinitionsV1(
  definitions: readonly unknown[],
): { slots: Set<string>; blockedDefinition: boolean } | SheetInspection {
  const slots = new Set<string>();
  let blockedDefinition = false;
  for (const definition of definitions) {
    if (!isAssessmentDefinition(definition) || slots.has(definition.sourceSlot)) {
      return slots.has(String((definition as Record<string, unknown>)?.sourceSlot))
        ? { state: 'duplicate-identity' }
        : { state: 'invalid' };
    }
    slots.add(definition.sourceSlot);
    if (!isDefinitionResolved(definition)) blockedDefinition = true;
  }
  return { slots, blockedDefinition };
}

function inspectSheet(value: unknown): SheetInspection {
  if (
    !isRecord(value) ||
    !boundedString(
      value.sourceSheetName,
      GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSheetNameLength,
    ) ||
    !isRecognizedSheetContext(value.recognizedContext) ||
    !validOpaqueId(value.teachingAssignmentId) ||
    !Array.isArray(value.students)
  ) {
    return { state: 'invalid' };
  }

  if (value.kind === 'term') {
    if (
      !hasExactKeys(value, [
        'kind',
        'sourceSheetName',
        'recognizedContext',
        'teachingAssignmentId',
        'term',
        'assessmentDefinitions',
        'students',
      ]) ||
      ![1, 2, 3].includes(Number(value.term)) ||
      !Array.isArray(value.assessmentDefinitions) ||
      value.assessmentDefinitions.length !==
        GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxAssessmentDefinitionsPerTermSheet
    ) {
      return { state: 'invalid' };
    }
    const definitions = termDefinitionsV1(value.assessmentDefinitions);
    if ('state' in definitions) return definitions;
    const { slots, blockedDefinition } = definitions;
    if (slots.size !== ALL_ASSESSMENT_SLOTS.size) return { state: 'invalid' };
    const students = inspectStudents(value.students, (student) => isTermStudent(student, slots));
    return students === 'valid'
      ? { state: 'valid', studentCount: value.students.length, blockedDefinition }
      : { state: students };
  }

  if (
    value.kind !== 'recovery' ||
    !hasExactKeys(value, [
      'kind',
      'sourceSheetName',
      'recognizedContext',
      'teachingAssignmentId',
      'students',
    ])
  ) {
    return { state: 'invalid' };
  }
  const students = inspectStudents(value.students, isRecoveryStudent);
  return students === 'valid'
    ? { state: 'valid', studentCount: value.students.length, blockedDefinition: false }
    : { state: students };
}

function isDiagnostic(value: unknown): value is GradebookImportRecognitionDiagnosticV1 {
  if (
    !isRecord(value) ||
    !['information', 'warning', 'blocking-error', 'critical-error'].includes(
      String(value.severity),
    ) ||
    !boundedString(value.code, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxDiagnosticCodeLength) ||
    !/^[A-Z0-9][A-Z0-9-]*$/u.test(value.code)
  ) {
    return false;
  }
  if (value.scope === 'file') return hasExactKeys(value, ['severity', 'code', 'scope']);
  return (
    value.scope === 'sheet' &&
    hasExactKeys(value, ['severity', 'code', 'scope', 'sourceSheetName']) &&
    boundedString(value.sourceSheetName, GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSheetNameLength)
  );
}

/** One sheet: valid, its name and academic scope not seen before, and its enrollments consistent. */
function registerSheetV1(
  sheet: unknown,
  seen: {
    sheetNames: Set<string>;
    academicScopes: Set<string>;
    assignmentStudentToEnrollment: Map<string, string>;
    enrollmentToStudent: Map<string, string>;
  },
):
  | GradebookImportPersistenceRequestInspectionV1
  | { studentCount: number; blockedDefinition: boolean } {
  const inspection = inspectSheet(sheet);
  if (inspection.state === 'payload-too-large') return 'payload-too-large';
  if (inspection.state === 'duplicate-identity') return 'duplicate-identity';
  if (inspection.state === 'invalid' || !isRecord(sheet)) return 'invalid-academic-shape';
  const sheetName = String(sheet.sourceSheetName);
  const scope = `${String(sheet.teachingAssignmentId)}:${String(sheet.kind)}:${scalarTextV1(sheet.term ?? '')}`;
  if (seen.sheetNames.has(sheetName) || seen.academicScopes.has(scope)) return 'duplicate-identity';
  seen.sheetNames.add(sheetName);
  seen.academicScopes.add(scope);
  if (!consistentEnrollmentsV1(sheet, seen.assignmentStudentToEnrollment, seen.enrollmentToStudent))
    return 'invalid-context';
  return inspection;
}

/** Each student keeps one enrollment per teaching assignment, and each enrollment one student. */
function consistentEnrollmentsV1(
  sheet: Record<string, unknown>,
  assignmentStudentToEnrollment: Map<string, string>,
  enrollmentToStudent: Map<string, string>,
) {
  for (const student of sheet.students as readonly Record<string, unknown>[]) {
    const confirmed = student.confirmedStudent as Record<string, unknown>;
    const studentId = String(confirmed.studentId);
    const enrollmentId = String(confirmed.enrollmentId);
    const assignmentStudentKey = `${String(sheet.teachingAssignmentId)}:${studentId}`;
    if (
      (assignmentStudentToEnrollment.has(assignmentStudentKey) &&
        assignmentStudentToEnrollment.get(assignmentStudentKey) !== enrollmentId) ||
      (enrollmentToStudent.has(enrollmentId) && enrollmentToStudent.get(enrollmentId) !== studentId)
    ) {
      return false;
    }
    assignmentStudentToEnrollment.set(assignmentStudentKey, enrollmentId);
    enrollmentToStudent.set(enrollmentId, studentId);
  }
  return true;
}

/** A sheet diagnostic names a sheet of the request; a blocking one stops the import. */
function diagnosticsIssueV1(
  diagnostics: readonly GradebookImportRecognitionDiagnosticV1[],
  sheetNames: ReadonlySet<string>,
): 'invalid-academic-shape' | 'blocking-diagnostic' | null {
  for (const diagnostic of diagnostics) {
    if (diagnostic.scope === 'sheet' && !sheetNames.has(diagnostic.sourceSheetName)) {
      return 'invalid-academic-shape';
    }
    if (diagnostic.severity === 'blocking-error' || diagnostic.severity === 'critical-error') {
      return 'blocking-diagnostic';
    }
  }
  return null;
}

export function inspectGradebookImportPersistenceRequestV1(
  value: unknown,
): GradebookImportPersistenceRequestInspectionV1 {
  if (containsGradebookImportPersistenceForbiddenClientFieldV1(value)) {
    return 'forbidden-client-payload';
  }
  const byteLength = serializedByteLength(value);
  if (byteLength === null) return 'invalid-request';
  if (byteLength > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxBodyBytes) {
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
      'sheets',
      'diagnostics',
    ]) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V1 ||
    value.operation !== GRADEBOOK_IMPORT_PERSISTENCE_OPERATION_V1 ||
    !isManifest(value.manifest) ||
    !isRecognizedSuggestions(value.recognizedSuggestions) ||
    !Array.isArray(value.sheets) ||
    value.sheets.length === 0 ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(isDiagnostic)
  ) {
    return 'invalid-request';
  }
  if (
    value.sheets.length > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSheetsPerRequest ||
    value.diagnostics.length > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxDiagnosticsPerRequest
  ) {
    return 'payload-too-large';
  }
  if (!isConfirmedContext(value.confirmedContext)) return 'invalid-context';

  const sheetNames = new Set<string>();
  const academicScopes = new Set<string>();
  const assignmentStudentToEnrollment = new Map<string, string>();
  const enrollmentToStudent = new Map<string, string>();
  let totalStudents = 0;
  let blockedDefinition = false;
  const seen = { sheetNames, academicScopes, assignmentStudentToEnrollment, enrollmentToStudent };
  for (const sheet of value.sheets) {
    const registered = registerSheetV1(sheet, seen);
    if (typeof registered === 'string') return registered;
    totalStudents += registered.studentCount;
    blockedDefinition ||= registered.blockedDefinition;
  }
  if (totalStudents > GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxStudentObservationsPerRequest) {
    return 'payload-too-large';
  }
  const diagnosticIssue = diagnosticsIssueV1(value.diagnostics, sheetNames);
  if (diagnosticIssue) return diagnosticIssue;
  if (blockedDefinition) return 'blocked-definition';
  return 'ready';
}

export function isGradebookImportPersistenceRequestV1(
  value: unknown,
): value is GradebookImportPersistenceRequestV1 {
  return inspectGradebookImportPersistenceRequestV1(value) === 'ready';
}

function isNonNegativeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSummary(value: unknown): value is GradebookImportPersistenceSummaryV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'assessmentDefinitions',
      'assessmentComponents',
      'academicRecords',
      'plannedVersionWrites',
      'committedVersionWrites',
    ]) ||
    !isRecord(value.assessmentDefinitions) ||
    !hasExactKeys(value.assessmentDefinitions, ['total', 'resolved', 'blocked']) ||
    !isNonNegativeCount(value.assessmentDefinitions.total) ||
    !isNonNegativeCount(value.assessmentDefinitions.resolved) ||
    !isNonNegativeCount(value.assessmentDefinitions.blocked) ||
    value.assessmentDefinitions.total !==
      value.assessmentDefinitions.resolved + value.assessmentDefinitions.blocked ||
    !isRecord(value.assessmentComponents) ||
    !hasExactKeys(value.assessmentComponents, ['unchanged', 'new', 'changed', 'blocked']) ||
    !Object.values(value.assessmentComponents).every(isNonNegativeCount) ||
    !isRecord(value.academicRecords) ||
    !hasExactKeys(value.academicRecords, [
      'unchanged',
      'new',
      'changed',
      'missingFromNewSource',
      'blocked',
    ]) ||
    !Object.values(value.academicRecords).every(isNonNegativeCount) ||
    !isNonNegativeCount(value.plannedVersionWrites) ||
    !isNonNegativeCount(value.committedVersionWrites) ||
    value.committedVersionWrites > value.plannedVersionWrites
  ) {
    return false;
  }
  return true;
}

function isResponseIssue(value: unknown): value is GradebookImportPersistenceIssueV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'scope'], ['sourceSheetName', 'sourceRow', 'sourceSlot']) ||
    !(GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_CODES_V1 as readonly unknown[]).includes(value.code) ||
    !(GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_SCOPES_V1 as readonly unknown[]).includes(value.scope) ||
    (value.sourceSheetName !== undefined &&
      !boundedString(
        value.sourceSheetName,
        GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxSheetNameLength,
      )) ||
    (value.sourceRow !== undefined && !positiveSourceRow(value.sourceRow)) ||
    (value.sourceSlot !== undefined &&
      (typeof value.sourceSlot !== 'string' || !ALL_ASSESSMENT_SLOTS.has(value.sourceSlot)))
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
    value.sourceSlot !== undefined &&
    value.sourceRow === undefined
  );
}

export function isGradebookImportPersistenceResponseV1(
  value: unknown,
): value is GradebookImportPersistenceResponseV1 {
  if (
    !isRecord(value) ||
    value.transportVersion !== GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V1 ||
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
      (GRADEBOOK_IMPORT_PERSISTENCE_REQUEST_REJECTIONS_V1 as readonly unknown[]).includes(
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
    return value.state === 'applied'
      ? value.summary.committedVersionWrites > 0 &&
          value.summary.committedVersionWrites === value.summary.plannedVersionWrites
      : value.summary.committedVersionWrites === 0 && value.summary.plannedVersionWrites === 0;
  }
  if (value.state === 'review-required' || value.state === 'blocked') {
    return (
      hasExactKeys(value, ['transportVersion', 'state', 'summary', 'issues']) &&
      isSummary(value.summary) &&
      value.summary.committedVersionWrites === 0 &&
      Array.isArray(value.issues) &&
      value.issues.length > 0 &&
      value.issues.length <= GRADEBOOK_IMPORT_PERSISTENCE_BOUNDS_V1.maxDiagnosticsPerRequest &&
      value.issues.every(isResponseIssue)
    );
  }
  return false;
}
