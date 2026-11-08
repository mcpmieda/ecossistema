import type { AcademicYearId } from '../entities';
import { type SourceAssessmentSlotV2 } from '../source/source-contract-v2';
import { GRADEBOOK_IMPORT_PERSISTENCE_FORBIDDEN_CLIENT_FIELDS_V1, type GradebookImportAcademicRecordCountsV1, type GradebookImportAssessmentComponentCountsV1, type GradebookImportAssessmentDefinitionCountsV1, type GradebookImportPersistenceIssueScopeV1, type GradebookImportPersistenceRequestRejectionV1, type GradebookImportPersistenceRequestV1 } from './import-persistence-transport-v1';

/**
 * First-import evolution of the bounded browser transport. The V1 contract is
 * intentionally left frozen; V2 removes browser authority over logical-source identity.
 */
export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V2 = 2 as const;

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

export const GRADEBOOK_IMPORT_PERSISTENCE_ISSUE_CODES_V2 = [
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
