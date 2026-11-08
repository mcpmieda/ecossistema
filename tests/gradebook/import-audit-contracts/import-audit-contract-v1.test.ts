// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AcademicYearId, StudentId } from '../../../shared/gradebook-contracts/entities';
import type {
  ComparedGradeValueV1,
  TermResultId,
} from '../../../shared/gradebook-contracts/results/results-contract-v1';
import { SOURCE_CONTRACT_V1 } from '../../../shared/gradebook-contracts/source/source-contract-v1';
import type { SourceCellEvidenceV1 } from '../../../shared/gradebook-contracts/source/source-contract-v1';
import { AUDIT_OCCURRENCE_STATES_V1, AUDIT_SEVERITIES_V1, RECONCILIATION_STATUSES_V1 } from '../../../shared/gradebook-contracts/audit/audit-contract-v1';
import type {
  AuditOccurrenceId,
  AuditOccurrenceV1,
  ReconciliationResultId,
  ReconciliationResultV1,
} from '../../../shared/gradebook-contracts/audit/audit-contract-v1';
import { IMPORT_BATCH_STATUSES_V1 } from '../../../shared/gradebook-contracts/imports/import-contract-v1';
import type {
  ImportBatchResultV1,
  ImportFileDiagnosticV1,
  SourceFileManifestV1,
} from '../../../shared/gradebook-contracts/imports/import-contract-v1';
import type {
  ImportBatchId,
  ImportFileDiagnosticId,
  ImportFileId,
  SourceFileManifestId,
} from '../../../shared/gradebook-contracts/imports/import-ids-v1';

const academicYearId = 'academic-year:synthetic-2026' as AcademicYearId;
const studentId = 'student:synthetic-001' as StudentId;
const manifestId = 'source-file:synthetic-a' as SourceFileManifestId;
const batchId = 'import-batch:synthetic-001' as ImportBatchId;
const firstImportFileId = 'import-file:synthetic-a' as ImportFileId;
const secondImportFileId = 'import-file:synthetic-b' as ImportFileId;

const sourceEvidence = {
  provenance: {
    fileName: 'notas-sinteticas.xlsx',
    fileSha256: 'a'.repeat(64),
    sheetName: '6A1º',
    cellAddress: 'AM5',
  },
  classification: 'manual-positive-number',
  rawValue: 8,
} satisfies SourceCellEvidenceV1;

const comparedValue = {
  imported: {
    value: { state: 'numeric', value: 8 },
    evidence: [sourceEvidence],
  },
  calculated: {
    value: { state: 'numeric', value: 7.5 },
  },
} satisfies ComparedGradeValueV1;

const manifest = {
  id: manifestId,
  fileName: 'notas-sinteticas.xlsx',
  extension: 'xlsx',
  reportedMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  sizeBytes: 4096,
  lastModifiedAt: '2026-08-01T12:00:00Z',
  sha256: 'a'.repeat(64),
  sourceContractVersion: SOURCE_CONTRACT_V1.version,
  parserVersion: '1.0.0',
  readAt: '2026-08-31T17:00:00Z',
  suggestedAcademicYear: 2026,
  confirmedAcademicYearId: academicYearId,
  suggestedTeacherName: 'Professor Sintético',
} satisfies SourceFileManifestV1;

describe('import, reconciliation and audit contracts v1', () => {
  it('keeps the file manifest compatible with SourceContractV1 without local paths', () => {
    expect(SOURCE_CONTRACT_V1.acceptedExtensions).toContain(manifest.extension);
    expect(manifest.sourceContractVersion).toBe(SOURCE_CONTRACT_V1.version);
    expect(manifest.sha256).toHaveLength(64);
    expect(manifest).not.toHaveProperty('path');
    expect(manifest).not.toHaveProperty('localPath');
  });

  it('represents an individual file failure without turning the whole batch into total failure', () => {
    const criticalDiagnostic = {
      id: 'diagnostic:synthetic:critical' as ImportFileDiagnosticId,
      importBatchId: batchId,
      importFileId: secondImportFileId,
      severity: 'critical-error',
      code: 'FILE-READ-FAILED',
      message: 'Falha sintética ao preparar o segundo arquivo.',
      location: { kind: 'file' },
    } satisfies ImportFileDiagnosticV1;

    const batch = {
      id: batchId,
      status: 'review-required',
      files: [
        {
          id: firstImportFileId,
          sourceFile: {
            fileName: manifest.fileName,
            extension: manifest.extension,
            reportedMimeType: manifest.reportedMimeType,
            sizeBytes: manifest.sizeBytes,
            lastModifiedAt: manifest.lastModifiedAt,
          },
          manifest,
          status: 'approved',
          diagnosticIds: [],
        },
        {
          id: secondImportFileId,
          sourceFile: {
            fileName: 'arquivo-sintetico-com-falha.xlsx',
            extension: 'xlsx',
            reportedMimeType: null,
            sizeBytes: 2048,
            lastModifiedAt: null,
          },
          manifest: null,
          status: 'failed',
          diagnosticIds: [criticalDiagnostic.id],
        },
      ],
      diagnostics: [criticalDiagnostic],
      summary: {
        totalFileCount: 2,
        processedFileCount: 2,
        approvedFileCount: 1,
        reviewRequiredFileCount: 0,
        rejectedFileCount: 0,
        failedFileCount: 1,
        informationCount: 0,
        warningCount: 0,
        blockingErrorCount: 0,
        criticalErrorCount: 1,
      },
      receivedAt: '2026-08-31T17:00:00Z',
      updatedAt: '2026-08-31T17:00:05Z',
    } satisfies ImportBatchResultV1;

    expect(batch.status).toBe('review-required');
    expect(batch.status).not.toBe('failed');
    expect(batch.files.map((file) => file.status)).toEqual(['approved', 'failed']);
    expect(batch.summary.criticalErrorCount).toBe(1);

    const approvedBatch = {
      id: 'import-batch:synthetic-approved' as ImportBatchId,
      status: 'approved',
      files: [batch.files[0]!],
      diagnostics: [],
      summary: {
        totalFileCount: 1,
        processedFileCount: 1,
        approvedFileCount: 1,
        reviewRequiredFileCount: 0,
        rejectedFileCount: 0,
        failedFileCount: 0,
        informationCount: 0,
        warningCount: 0,
        blockingErrorCount: 0,
        criticalErrorCount: 0,
      },
      receivedAt: batch.receivedAt,
      updatedAt: batch.updatedAt,
    } satisfies ImportBatchResultV1;

    expect(approvedBatch.summary.criticalErrorCount).toBe(0);
    expect(approvedBatch.summary.blockingErrorCount).toBe(0);
  });

  it('points diagnostics to file, cell and official entity ids without exposing a local path', () => {
    const diagnostic = {
      id: 'diagnostic:synthetic:cell' as ImportFileDiagnosticId,
      importBatchId: batchId,
      importFileId: firstImportFileId,
      sourceFileManifestId: manifest.id,
      severity: 'warning',
      code: 'CELL-DIVERGENCE',
      message: 'Divergência sintética para teste de contrato.',
      location: { kind: 'cell', sheetName: '6A1º', cellAddress: 'AM5' },
      entity: { kind: 'student', id: studentId },
      sourceEvidence,
    } satisfies ImportFileDiagnosticV1;

    expect(diagnostic.sourceFileManifestId).toBe(manifest.id);
    expect(diagnostic.location).toEqual({ kind: 'cell', sheetName: '6A1º', cellAddress: 'AM5' });
    expect(diagnostic.entity).toEqual({ kind: 'student', id: studentId });
    expect(diagnostic.sourceEvidence).toBe(sourceEvidence);
    expect(diagnostic).not.toHaveProperty('path');
    expect(diagnostic).not.toHaveProperty('localPath');
  });

  it('keeps imported/native values, tolerance and rule version for every reconciliation status', () => {
    const termResultId = 'term-result:synthetic-001' as TermResultId;
    const base = {
      target: { kind: 'term-result' as const, id: termResultId },
      value: comparedValue,
      ruleVersion: 'academic-rule:2026-v1',
    };

    const reconciliations: ReconciliationResultV1[] = [
      {
        ...base,
        id: 'reconciliation:match' as ReconciliationResultId,
        status: 'match',
        difference: 0,
        tolerance: 0.01,
      },
      {
        ...base,
        id: 'reconciliation:expected' as ReconciliationResultId,
        status: 'expected-difference',
        difference: 0.5,
        tolerance: 0.01,
        explanation: 'Diferença sintética esperada pela versão de regra.',
      },
      {
        ...base,
        id: 'reconciliation:mismatch' as ReconciliationResultId,
        status: 'mismatch',
        difference: 1,
        tolerance: 0.01,
      },
      {
        ...base,
        id: 'reconciliation:not-comparable' as ReconciliationResultId,
        status: 'not-comparable',
        difference: null,
        tolerance: null,
        explanation: 'Cobertura sintética insuficiente.',
      },
    ];

    expect(reconciliations.map((item) => item.status)).toEqual(RECONCILIATION_STATUSES_V1);
    expect(reconciliations[0]?.value.imported.value).toEqual({ state: 'numeric', value: 8 });
    expect(reconciliations[0]?.value.calculated.value).toEqual({ state: 'numeric', value: 7.5 });
    expect(reconciliations[0]?.tolerance).toBe(0.01);
    expect(reconciliations[0]?.ruleVersion).toBe('academic-rule:2026-v1');
    expect(reconciliations[3]?.difference).toBeNull();
  });

  it('makes critical severity explicit and preserves the full resolution transition', () => {
    const occurrence = {
      id: 'audit-occurrence:synthetic-001' as AuditOccurrenceId,
      importBatchId: batchId,
      severity: 'critical-error',
      category: 'source-integrity',
      entity: { kind: 'student', id: studentId },
      source: {
        kind: 'cell',
        sourceFileManifestId: manifest.id,
        evidence: sourceEvidence,
      },
      message: 'Ocorrência sintética crítica para teste.',
      recommendedAction: 'Revisar a origem sintética.',
      createdAt: '2026-08-31T17:01:00Z',
      state: 'resolved',
      stateHistory: [
        {
          previousState: 'open',
          nextState: 'resolved',
          actorId: 'user:synthetic-reviewer',
          occurredAt: '2026-08-31T17:02:00Z',
          justification: 'Evidência sintética revisada e reconciliada.',
        },
      ],
    } satisfies AuditOccurrenceV1;

    const resolution = occurrence.stateHistory.at(-1);
    expect(occurrence.severity).toBe('critical-error');
    expect(occurrence.state).toBe('resolved');
    expect(resolution).toMatchObject({
      previousState: 'open',
      nextState: 'resolved',
      actorId: 'user:synthetic-reviewer',
      occurredAt: '2026-08-31T17:02:00Z',
      justification: 'Evidência sintética revisada e reconciliada.',
    });
  });
});
