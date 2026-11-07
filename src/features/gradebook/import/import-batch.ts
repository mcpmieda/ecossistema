import type {
  ImportBatchFileResultV1,
  ImportBatchResultV1,
  ImportFileDiagnosticV1,
  SourceFileDescriptorV1,
  SourceFileManifestV1,
} from '../../../../shared/gradebook-contracts/imports/import-contract-v1';
import type {
  ImportBatchId,
  ImportFileDiagnosticId,
  ImportFileId,
} from '../../../../shared/gradebook-contracts/imports/import-ids-v1';
import { createSourceFileManifest, type FileManifestRuntime } from './file-manifest';
import {
  ACCEPTED_EXTENSIONS,
  fileExtension,
  type ClassRecognition,
  type GradeSheetRecognition,
  type SheetJs,
  type WorkbookSummary,
} from './spreadsheet-recognizer';
import { readWorkbookData, type WorkbookReadTimingV1 } from './workbook-reader';

export const MAX_NOTES_IMPORT_FILES = 50;

export type BatchSuccess = {
  id: ImportFileId;
  summary: WorkbookSummary;
  manifest: SourceFileManifestV1;
};

export type BatchFailure = {
  fileName: string;
  message: string;
};

export type BatchFailureStage = 'preparation' | 'recognition';

export type BatchFailureDetail = BatchFailure & {
  id: ImportFileId;
  stage: BatchFailureStage;
  manifest: SourceFileManifestV1 | null;
  diagnostic: ImportFileDiagnosticV1;
};

type BatchProgressStage = 'preparing' | 'recognizing';

type BatchProgress = {
  current: number;
  total: number;
  fileName: string;
  stage: BatchProgressStage;
};

export interface ImportWorkbookFileTimingV1 {
  readonly fileIndex: number;
  readonly current: number;
  readonly total: number;
  readonly fileReadMs: number | null;
  readonly manifestMs: number | null;
  readonly yieldMs: number | null;
  readonly recognitionMs: number | null;
  readonly workbookReadMs: number | null;
  readonly xlsxReadMs: number | null;
  readonly masterRelationRecognitionMs: number | null;
  readonly recognizeWorkbookMs: number | null;
  readonly canonicalRostersMs: number | null;
  readonly outcome: 'recognized' | 'failed';
  readonly failureStage:
    | 'unsupported-format'
    | 'file-read'
    | 'manifest'
    | NonNullable<WorkbookReadTimingV1['failureStage']>
    | null;
}

interface WorkbookOperationalComponentV1 {
  readonly discipline: string;
  readonly disciplineIndex: string;
}

type BatchResult = {
  successes: BatchSuccess[];
  failures: BatchFailure[];
  failureDetails: BatchFailureDetail[];
  batch: ImportBatchResultV1;
};

interface ImportBatchRuntime extends FileManifestRuntime {
  readonly captureValues?: boolean;
  readonly onStageProgress?: (progress: BatchProgress) => void;
  readonly yieldBeforeRecognition?: () => Promise<void>;
  readonly onFileTiming?: (timing: ImportWorkbookFileTimingV1) => void;
}

export function validateBatchSize(files: File[]): string | null {
  return files.length > MAX_NOTES_IMPORT_FILES
    ? `Selecione no máximo ${MAX_NOTES_IMPORT_FILES} planilhas por lote.`
    : null;
}

function normalizeOperationalLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toUpperCase();
}

function isOperationalTermSheet(sheet: GradeSheetRecognition): boolean {
  return (
    sheet.stage === 'trimester-1' || sheet.stage === 'trimester-2' || sheet.stage === 'trimester-3'
  );
}

function operationalComponentKey(sheet: GradeSheetRecognition): string {
  return JSON.stringify([
    normalizeOperationalLabel(sheet.className),
    normalizeOperationalLabel(sheet.discipline),
    sheet.disciplineIndex.trim().toUpperCase(),
  ]);
}

export function countWorkbookOperationalClassesV1(summary: WorkbookSummary): number {
  return new Set(summary.gradeSheets.filter(isOperationalTermSheet).map(operationalComponentKey))
    .size;
}

export function workbookClassComponentsV1(
  classroom: ClassRecognition,
): readonly WorkbookOperationalComponentV1[] {
  const unique = new Map<string, WorkbookOperationalComponentV1>();
  for (const sheet of classroom.sheets) {
    if (!isOperationalTermSheet(sheet)) continue;
    const component = {
      discipline: sheet.discipline.trim(),
      disciplineIndex: sheet.disciplineIndex.trim().toUpperCase(),
    };
    const key = JSON.stringify([
      normalizeOperationalLabel(component.discipline),
      component.disciplineIndex,
    ]);
    if (!unique.has(key)) unique.set(key, component);
  }
  return [...unique.values()].sort(
    (a, b) =>
      a.disciplineIndex.localeCompare(b.disciplineIndex, 'pt-BR', { numeric: true }) ||
      a.discipline.localeCompare(b.discipline, 'pt-BR'),
  );
}

function sourceFileDescriptor(file: File): SourceFileDescriptorV1 {
  const extension = fileExtension(file.name);
  const modifiedAt = new Date(file.lastModified);

  return {
    fileName: file.name,
    extension: extension || null,
    reportedMimeType: file.type || null,
    sizeBytes: file.size,
    lastModifiedAt: Number.isNaN(modifiedAt.getTime()) ? null : modifiedAt.toISOString(),
  };
}

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function nowMs(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

function observeDiagnostic<Value>(
  observer: ((value: Value) => void) | undefined,
  value: Value,
): void {
  try {
    observer?.(value);
  } catch {
    // Optional diagnostics must not alter import progress, results or failures.
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function createDiagnostic(
  batchId: ImportBatchId,
  importFileId: ImportFileId,
  manifest: SourceFileManifestV1 | null,
  code: string,
  message: string,
): ImportFileDiagnosticV1 {
  return {
    id: `import-file-diagnostic:${String(importFileId)}:${code}` as ImportFileDiagnosticId,
    importBatchId: batchId,
    importFileId,
    sourceFileManifestId: manifest?.id,
    severity: 'blocking-error',
    code,
    message,
    location: { kind: 'file' },
  };
}

type FailureRecord = {
  readonly batchId: ImportBatchId;
  readonly importFileId: ImportFileId;
  readonly descriptor: SourceFileDescriptorV1;
  readonly fileName: string;
  readonly message: string;
  readonly stage: BatchFailureStage;
  readonly manifest: SourceFileManifestV1 | null;
  readonly code: string;
};

type FailureCollections = {
  readonly failures: BatchFailure[];
  readonly failureDetails: BatchFailureDetail[];
  readonly diagnostics: ImportFileDiagnosticV1[];
  readonly fileResults: ImportBatchFileResultV1[];
};

function recordFailure(record: FailureRecord, collections: FailureCollections): void {
  const diagnostic = createDiagnostic(
    record.batchId,
    record.importFileId,
    record.manifest,
    record.code,
    record.message,
  );
  collections.failures.push({ fileName: record.fileName, message: record.message });
  collections.failureDetails.push({
    id: record.importFileId,
    fileName: record.fileName,
    message: record.message,
    stage: record.stage,
    manifest: record.manifest,
    diagnostic,
  });
  collections.diagnostics.push(diagnostic);
  collections.fileResults.push({
    id: record.importFileId,
    sourceFile: record.descriptor,
    manifest: record.manifest,
    status: 'failed',
    diagnosticIds: [diagnostic.id],
  });
}

function createBatchResult(
  batchId: ImportBatchId,
  files: ImportBatchFileResultV1[],
  diagnostics: ImportFileDiagnosticV1[],
  receivedAt: string,
  updatedAt: string,
): ImportBatchResultV1 {
  const approvedFileCount = files.filter((file) => file.status === 'approved').length;
  const failedFileCount = files.filter((file) => file.status === 'failed').length;
  const commonSummary = {
    totalFileCount: files.length,
    processedFileCount: files.length,
    approvedFileCount,
    reviewRequiredFileCount: 0,
    rejectedFileCount: 0,
    failedFileCount,
    informationCount: 0,
    warningCount: 0,
    blockingErrorCount: diagnostics.length,
    criticalErrorCount: 0,
  };
  const common = { id: batchId, files, diagnostics, receivedAt, updatedAt };

  if (failedFileCount === 0) {
    return {
      ...common,
      status: 'approved',
      summary: {
        ...commonSummary,
        reviewRequiredFileCount: 0,
        rejectedFileCount: 0,
        failedFileCount: 0,
        blockingErrorCount: 0,
        criticalErrorCount: 0,
      },
    };
  }

  return {
    ...common,
    status: approvedFileCount > 0 ? 'review-required' : 'failed',
    summary: commonSummary,
  };
}

export async function importWorkbookBatch(
  files: File[],
  xlsx: SheetJs,
  onProgress: (progress: BatchProgress) => void,
  runtime: ImportBatchRuntime = {},
): Promise<BatchResult> {
  const receivedAt = (runtime.now?.() ?? new Date()).toISOString();
  const batchId = `import-batch:${receivedAt}:${files.length}` as ImportBatchId;
  const successes: BatchSuccess[] = [];
  const failures: BatchFailure[] = [];
  const failureDetails: BatchFailureDetail[] = [];
  const fileResults: ImportBatchFileResultV1[] = [];
  const diagnostics: ImportFileDiagnosticV1[] = [];
  const failureCollections = { failures, failureDetails, fileResults, diagnostics };

  for (const [index, file] of files.entries()) {
    const current = index + 1;
    const importFileId = `import-file:${String(batchId)}:${index}` as ImportFileId;
    const descriptor = sourceFileDescriptor(file);
    const preparationProgress = {
      current,
      total: files.length,
      fileName: file.name,
      stage: 'preparing',
    } satisfies BatchProgress;
    onProgress(preparationProgress);
    observeDiagnostic(runtime.onStageProgress, preparationProgress);

    let fileReadMs: number | null = null;
    let manifestMs: number | null = null;
    let yieldMs: number | null = null;
    let recognitionMs: number | null = null;
    let workbookTiming: WorkbookReadTimingV1 | null = null;
    const emitFileTiming = (
      outcome: ImportWorkbookFileTimingV1['outcome'],
      failureStage: ImportWorkbookFileTimingV1['failureStage'],
    ): void => {
      observeDiagnostic(runtime.onFileTiming, {
        fileIndex: index,
        current,
        total: files.length,
        fileReadMs,
        manifestMs,
        yieldMs,
        recognitionMs,
        workbookReadMs: workbookTiming?.totalMs ?? null,
        xlsxReadMs: workbookTiming?.xlsxReadMs ?? null,
        masterRelationRecognitionMs: workbookTiming?.masterRelationRecognitionMs ?? null,
        recognizeWorkbookMs: workbookTiming?.recognizeWorkbookMs ?? null,
        canonicalRostersMs: workbookTiming?.canonicalRostersMs ?? null,
        outcome,
        failureStage,
      });
    };

    const extension = fileExtension(file.name);
    if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
      const message = 'Formato não suportado.';
      recordFailure(
        {
          batchId,
          importFileId,
          descriptor,
          fileName: file.name,
          message,
          stage: 'preparation',
          manifest: null,
          code: 'UNSUPPORTED-FILE-FORMAT',
        },
        failureCollections,
      );
      emitFileTiming('failed', 'unsupported-format');
      continue;
    }

    let data: ArrayBuffer;
    const fileReadStartedAt = nowMs();
    try {
      data = await file.arrayBuffer();
    } catch (cause) {
      fileReadMs = elapsedMs(fileReadStartedAt);
      const message = failureMessage(cause, 'Não foi possível ler o arquivo.');
      recordFailure(
        {
          batchId,
          importFileId,
          descriptor,
          fileName: file.name,
          message,
          stage: 'preparation',
          manifest: null,
          code: 'FILE-READ-FAILED',
        },
        failureCollections,
      );
      emitFileTiming('failed', 'file-read');
      continue;
    }
    fileReadMs = elapsedMs(fileReadStartedAt);

    let manifest: SourceFileManifestV1;
    const manifestStartedAt = nowMs();
    try {
      manifest = await createSourceFileManifest(file, data, xlsx.version, runtime);
    } catch (cause) {
      manifestMs = elapsedMs(manifestStartedAt);
      const message = failureMessage(cause, 'Não foi possível calcular o SHA-256 do arquivo.');
      recordFailure(
        {
          batchId,
          importFileId,
          descriptor,
          fileName: file.name,
          message,
          stage: 'preparation',
          manifest: null,
          code: 'FILE-HASH-FAILED',
        },
        failureCollections,
      );
      emitFileTiming('failed', 'manifest');
      continue;
    }
    manifestMs = elapsedMs(manifestStartedAt);

    observeDiagnostic(runtime.onStageProgress, {
      current,
      total: files.length,
      fileName: file.name,
      stage: 'recognizing',
    });
    const yieldStartedAt = nowMs();
    await (runtime.yieldBeforeRecognition?.() ?? yieldToBrowser());
    yieldMs = elapsedMs(yieldStartedAt);

    const recognitionStartedAt = nowMs();
    let outcome: ImportWorkbookFileTimingV1['outcome'] = 'failed';
    try {
      const summary = readWorkbookData(
        file,
        data,
        xlsx,
        manifest,
        (timing) => {
          workbookTiming = timing;
        },
        runtime.captureValues,
      );
      successes.push({ id: importFileId, summary, manifest });
      fileResults.push({
        id: importFileId,
        sourceFile: descriptor,
        manifest,
        status: 'approved',
        diagnosticIds: [],
      });
      outcome = 'recognized';
    } catch (cause) {
      const message = failureMessage(cause, 'Não foi possível reconhecer a planilha.');
      recordFailure(
        {
          batchId,
          importFileId,
          descriptor,
          fileName: file.name,
          message,
          stage: 'recognition',
          manifest,
          code: 'WORKBOOK-RECOGNITION-FAILED',
        },
        failureCollections,
      );
    } finally {
      const measuredWorkbookTiming = workbookTiming as WorkbookReadTimingV1 | null;
      recognitionMs = elapsedMs(recognitionStartedAt);
      emitFileTiming(
        outcome,
        outcome === 'recognized'
          ? null
          : (measuredWorkbookTiming?.failureStage ?? 'workbook-recognition'),
      );
    }
  }

  const updatedAt = (runtime.now?.() ?? new Date()).toISOString();
  return {
    successes,
    failures,
    failureDetails,
    batch: createBatchResult(batchId, fileResults, diagnostics, receivedAt, updatedAt),
  };
}
