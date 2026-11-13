import type { GradebookImportPersistenceRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { GradebookImportDiagnosticsAuditRequestV1 } from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import { importWorkbookBatch } from '../../../src/features/gradebook/import/import-batch';
import {
  blockingGradebookImportDiagnosticsV1,
  collectGradebookImportDiagnosticsV1,
  gradebookImportDiagnosticsAuditRequestV1,
} from '../../../src/features/gradebook/import/import-diagnostics-v1';
import type { SheetJs } from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import { createFastTeacherSheetJsV1 } from '../../../src/features/gradebook/import/workbook-fast-read-v1';

/**
 * Server-side preparation of one teacher workbook, through the browser's own import path
 * (`importWorkbookBatch` → diagnostics → canonical V9), with the fast `.xlsb` read. Nothing is
 * written: the caller decides what to persist. The outcome carries no names or grades in its
 * summary fields, so it can be logged.
 */
export type TeacherWorkbookPreparationV1 =
  | {
      readonly outcome: 'ready';
      readonly request: GradebookImportPersistenceRequestV9;
      readonly audit: GradebookImportDiagnosticsAuditRequestV1;
      readonly summary: PreparationSummaryV1;
    }
  | {
      readonly outcome: 'blocked';
      readonly audit: GradebookImportDiagnosticsAuditRequestV1;
      readonly summary: PreparationSummaryV1;
    }
  | { readonly outcome: 'unreadable'; readonly code: string; readonly summary: PreparationSummaryV1 };

export type PreparationSummaryV1 = {
  readonly bytes: number;
  readonly readMs: number;
  readonly prepareMs: number;
  readonly diagnostics: number;
  readonly blocking: number;
  readonly requestBytes: number;
};

export async function prepareTeacherWorkbookV1(input: {
  bytes: ArrayBuffer;
  fileName: string;
  lastModified: number;
  xlsx: SheetJs;
  now?: () => number;
}): Promise<TeacherWorkbookPreparationV1> {
  const now = input.now ?? (() => performance.now());
  const started = now();
  const file = new File([input.bytes], input.fileName, { lastModified: input.lastModified });
  const batch = await importWorkbookBatch([file], createFastTeacherSheetJsV1(input.xlsx), () => {}, {
    captureValues: true,
    yieldBeforeRecognition: async () => {},
  });
  const readMs = now() - started;
  const base = { bytes: input.bytes.byteLength, readMs, diagnostics: 0, blocking: 0, requestBytes: 0 };
  const success = batch.successes[0];
  if (!success) {
    const code = batch.failureDetails[0]?.diagnostic.code ?? 'WORKBOOK-RECOGNITION-FAILED';
    return { outcome: 'unreadable', code, summary: { ...base, prepareMs: now() - started } };
  }
  const diagnostics = collectGradebookImportDiagnosticsV1(success);
  const blocking = blockingGradebookImportDiagnosticsV1(diagnostics).length;
  const audit = gradebookImportDiagnosticsAuditRequestV1(success, diagnostics);
  let request: GradebookImportPersistenceRequestV9;
  try {
    // BN-DEC-045: the builder holds only the cells, results or classes a problem affects.
    request = createGradebookCanonicalImportRequestV9(success);
  } catch {
    // Same rule as the browser: nothing that the builder refuses is ever persisted.
    const summary = { ...base, diagnostics: diagnostics.length, blocking, prepareMs: now() - started };
    if (blocking > 0) return { outcome: 'blocked', audit, summary };
    return { outcome: 'unreadable', code: 'CANONICAL-REJECTED', summary };
  }
  return {
    outcome: 'ready',
    request,
    audit,
    summary: {
      ...base,
      diagnostics: diagnostics.length,
      blocking,
      requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      prepareMs: now() - started,
    },
  };
}
