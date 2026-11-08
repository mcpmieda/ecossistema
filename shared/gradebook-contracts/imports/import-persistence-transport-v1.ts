import type { AuditSeverityV1 } from '../audit/audit-contract-v1';
import type {
  AcademicYearId,
  EnrollmentId,
  EntityIdV1,
  StudentId,
  TeachingAssignmentId,
} from '../entities';
import { type SourceDisciplineIndexV1, type SourceFileExtensionV1 } from '../source/source-contract-v1';
import { SOURCE_CONTRACT_VERSION_V2, type SourceAssessmentSlotV2, type SourceQualitativeActivitySlotV2, type SourceQuantitativeAssessmentSlotV2 } from '../source/source-contract-v2';

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

type GradebookImportLogicalSourceIdV1 = EntityIdV1<'LogicalSourceV1'>;

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

interface GradebookImportRecognizedSheetContextV1 {
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

type GradebookImportAssessmentMaximumV1 =
  | { readonly state: 'numeric'; readonly rawValue: number }
  | { readonly state: 'ambiguous-empty'; readonly rawValue: null | '' }
  | { readonly state: 'ambiguous-marker'; readonly rawValue: '*' }
  | { readonly state: 'missing-field' }
  | { readonly state: 'unrecognized'; readonly rawValue: string | boolean };

type GradebookImportAssessmentNameV1 =
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

interface GradebookImportAssessmentValueV1 {
  readonly sourceSlot: SourceAssessmentSlotV2;
  readonly value: GradebookImportRecognizedNoteV1;
}

export interface GradebookImportConfirmedStudentReferenceV1 {
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
}

interface GradebookImportTermAggregatesV1 {
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

export const GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_SCOPES_V1 = [
  'file',
  'sheet',
  'student',
  'assessment-definition',
] as const;
export type GradebookImportPersistenceIssueScopeV1 =
  (typeof GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_SCOPES_V1)[number];
