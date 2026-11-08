import type { AcademicYearId, TeacherId } from '../entities';
import { SOURCE_CONTRACT_V1 } from '../source/source-contract-v1';
import type { SourceContractV2 } from '../source/source-contract-v2';
import type {
  SourceCellEvidenceV1,
  SourceContractV1,
  SourceFileExtensionV1,
} from '../source/source-contract-v1';
import type { AuditEntityReferenceV1, AuditSeverityV1 } from '../audit/audit-contract-v1';
import type {
  ImportBatchId,
  ImportFileDiagnosticId,
  ImportFileId,
  SourceFileManifestId,
} from './import-ids-v1';

export interface SourceFileDescriptorV1 {
  readonly fileName: string;
  readonly extension: string | null;
  readonly reportedMimeType: string | null;
  readonly sizeBytes: number;
  readonly lastModifiedAt: string | null;
}

export interface SourceFileManifestV1 {
  readonly id: SourceFileManifestId;
  readonly fileName: string;
  readonly extension: SourceFileExtensionV1;
  readonly reportedMimeType: string | null;
  readonly sizeBytes: number;
  readonly lastModifiedAt: string | null;
  readonly sha256: string;
  /** Version of the source contract that produced this manifest. V1 envelopes also carry V2 reads. */
  readonly sourceContractVersion: SourceContractV1['version'] | SourceContractV2['version'];
  readonly parserVersion: string;
  readonly readAt: string;
  readonly suggestedAcademicYear?: number;
  readonly confirmedAcademicYearId?: AcademicYearId;
  readonly suggestedTeacherName?: string;
  readonly confirmedTeacherId?: TeacherId;
}

const IMPORT_FILE_STATUSES_V1 = [
  'received',
  'processing',
  'review-required',
  'approved',
  'rejected',
  'failed',
] as const;
export type ImportFileStatusV1 = (typeof IMPORT_FILE_STATUSES_V1)[number];

export const IMPORT_BATCH_STATUSES_V1 = [
  'received',
  'processing',
  'review-required',
  'partially-approved',
  'approved',
  'rejected',
  'failed',
] as const;
export type ImportBatchStatusV1 = (typeof IMPORT_BATCH_STATUSES_V1)[number];

export type ImportFileLocationV1 =
  | { readonly kind: 'file' }
  | { readonly kind: 'sheet'; readonly sheetName: string }
  | {
      readonly kind: 'cell';
      readonly sheetName: string;
      readonly cellAddress: string;
    };

export interface ImportFileDiagnosticV1 {
  readonly id: ImportFileDiagnosticId;
  readonly importBatchId: ImportBatchId;
  readonly importFileId: ImportFileId;
  readonly sourceFileManifestId?: SourceFileManifestId;
  readonly severity: AuditSeverityV1;
  readonly code: string;
  readonly message: string;
  readonly location: ImportFileLocationV1;
  readonly entity?: AuditEntityReferenceV1;
  readonly sourceEvidence?: SourceCellEvidenceV1;
}

export interface ImportBatchFileResultV1 {
  readonly id: ImportFileId;
  readonly sourceFile: SourceFileDescriptorV1;
  readonly manifest: SourceFileManifestV1 | null;
  readonly status: ImportFileStatusV1;
  readonly diagnosticIds: readonly ImportFileDiagnosticId[];
}

export interface ImportBatchSummaryV1 {
  readonly totalFileCount: number;
  readonly processedFileCount: number;
  readonly approvedFileCount: number;
  readonly reviewRequiredFileCount: number;
  readonly rejectedFileCount: number;
  readonly failedFileCount: number;
  readonly informationCount: number;
  readonly warningCount: number;
  readonly blockingErrorCount: number;
  readonly criticalErrorCount: number;
}

export type ImportBatchApprovedSummaryV1 = Omit<
  ImportBatchSummaryV1,
  | 'reviewRequiredFileCount'
  | 'rejectedFileCount'
  | 'failedFileCount'
  | 'blockingErrorCount'
  | 'criticalErrorCount'
> & {
  readonly reviewRequiredFileCount: 0;
  readonly rejectedFileCount: 0;
  readonly failedFileCount: 0;
  readonly blockingErrorCount: 0;
  readonly criticalErrorCount: 0;
};

interface ImportBatchResultBaseV1 {
  readonly id: ImportBatchId;
  readonly files: readonly ImportBatchFileResultV1[];
  readonly diagnostics: readonly ImportFileDiagnosticV1[];
  readonly receivedAt: string;
  readonly updatedAt: string;
}

export type ImportBatchResultV1 =
  | (ImportBatchResultBaseV1 & {
      readonly status: 'approved';
      readonly summary: ImportBatchApprovedSummaryV1;
    })
  | (ImportBatchResultBaseV1 & {
      readonly status: Exclude<ImportBatchStatusV1, 'approved'>;
      readonly summary: ImportBatchSummaryV1;
    });

export const IMPORT_CONTRACT_V1 = {
  version: 1,
  sourceContractVersion: SOURCE_CONTRACT_V1.version,
  fileStatuses: IMPORT_FILE_STATUSES_V1,
  batchStatuses: IMPORT_BATCH_STATUSES_V1,
} as const;
