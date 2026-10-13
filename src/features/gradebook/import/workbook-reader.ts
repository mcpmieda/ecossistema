import type { SourceFileManifestV1 } from '../../../../shared/gradebook-contracts/imports/import-contract-v1';
import { createSourceFileManifest } from './file-manifest';
import { recognizeWorkbook, type SheetJs, type WorkbookSummary } from './spreadsheet-recognizer';
import { recognizeMasterRelationV9, type MasterRelationRecognitionV9 } from './master-relation-v9';
import { isStudentReportWorkbookV1 } from './student-report-reader-v1';

export const WORKBOOK_READ_OPTIONS = {
  type: 'array',
  cellFormula: true,
  cellText: true,
  cellDates: false,
  cellNF: false,
  cellStyles: false,
  cellHTML: false,
  sheetRows: 50,
} as const;

export interface WorkbookReadTimingV1 {
  readonly totalMs: number;
  readonly xlsxReadMs: number | null;
  readonly masterRelationRecognitionMs: number | null;
  readonly recognizeWorkbookMs: number | null;
  /** Kept in timing output for log compatibility after the retired V6 roster pass was removed. */
  readonly canonicalRostersMs: number | null;
  readonly outcome: 'recognized' | 'failed';
  readonly failureStage: 'workbook-read' | 'relation-recognition' | 'workbook-recognition' | null;
}

export interface WorkbookSummaryWithRelationV9 extends WorkbookSummary {
  readonly masterRelationV9?: MasterRelationRecognitionV9;
}

function nowMs(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

function originalWorksheetDimensions(
  sheet: ReturnType<SheetJs['read']>['Sheets'][string] | undefined,
  xlsx: SheetJs,
): { readonly range: string; readonly rows: number; readonly columns: number } | null {
  const range = sheet?.['!fullref'];
  if (typeof range !== 'string' || range.length === 0) return null;
  try {
    const decoded = xlsx.utils.decode_range(range);
    return {
      range,
      rows: decoded.e.r - decoded.s.r + 1,
      columns: decoded.e.c - decoded.s.c + 1,
    };
  } catch {
    return null;
  }
}

function preserveOriginalWorksheetDimensions(
  summary: ReturnType<typeof recognizeWorkbook>,
  parsed: ReturnType<SheetJs['read']>,
  xlsx: SheetJs,
): ReturnType<typeof recognizeWorkbook> {
  const dimensions = new Map(
    parsed.SheetNames.flatMap((name) => {
      const value = originalWorksheetDimensions(parsed.Sheets[name], xlsx);
      return value ? [[name, value] as const] : [];
    }),
  );
  if (dimensions.size === 0) return summary;
  return {
    ...summary,
    sheets: summary.sheets.map((sheet) => ({ ...sheet, ...dimensions.get(sheet.name) })),
    gradeSheets: summary.gradeSheets.map((sheet) => ({
      ...sheet,
      ...dimensions.get(sheet.name),
    })),
  };
}

export function readWorkbookData(
  file: File,
  data: ArrayBuffer,
  xlsx: SheetJs,
  manifest: SourceFileManifestV1,
  onTiming?: (timing: WorkbookReadTimingV1) => void,
  captureValues = false,
): WorkbookSummaryWithRelationV9 {
  const totalStartedAt = nowMs();
  let xlsxReadMs: number | null = null;
  let masterRelationRecognitionMs: number | null = null;
  let recognizeWorkbookMs: number | null = null;
  let outcome: WorkbookReadTimingV1['outcome'] = 'failed';
  let failureStage: WorkbookReadTimingV1['failureStage'] = 'workbook-read';
  try {
    const readStartedAt = nowMs();
    let parsed: ReturnType<SheetJs['read']>;
    try {
      parsed = xlsx.read(data, WORKBOOK_READ_OPTIONS);
    } finally {
      xlsxReadMs = elapsedMs(readStartedAt);
    }
    if (parsed.SheetNames.length === 0) {
      throw new Error('A planilha não contém abas reconhecíveis.');
    }
    if (isStudentReportWorkbookV1(parsed, xlsx)) {
      throw new Error('Selecione este arquivo pelo botão Relatório.');
    }

    failureStage = 'relation-recognition';
    const relationStartedAt = nowMs();
    let masterRelationV9: MasterRelationRecognitionV9 | null;
    try {
      masterRelationV9 = recognizeMasterRelationV9(parsed);
    } finally {
      masterRelationRecognitionMs = elapsedMs(relationStartedAt);
    }

    failureStage = 'workbook-recognition';
    const recognizeStartedAt = nowMs();
    let summary: WorkbookSummary;
    try {
      const recognized = recognizeWorkbook(file, parsed, xlsx, {
        fileSha256: manifest.sha256,
        captureValues,
      });
      summary = preserveOriginalWorksheetDimensions(recognized, parsed, xlsx);
    } finally {
      recognizeWorkbookMs = elapsedMs(recognizeStartedAt);
    }
    if (summary.gradeSheets.length === 0 && !masterRelationV9) {
      throw new Error('Nenhuma guia corresponde ao padrão de notas configurado.');
    }

    outcome = 'recognized';
    failureStage = null;
    return {
      ...summary,
      ...(masterRelationV9
        ? { academicYear: masterRelationV9.ano, teacherName: null, masterRelationV9 }
        : {}),
    };
  } finally {
    try {
      onTiming?.({
        totalMs: elapsedMs(totalStartedAt),
        xlsxReadMs,
        masterRelationRecognitionMs,
        recognizeWorkbookMs,
        canonicalRostersMs: outcome === 'recognized' ? 0 : null,
        outcome,
        failureStage,
      });
    } catch {
      // Optional diagnostics must not change the recognized result or the original error.
    }
  }
}

export async function readWorkbook(
  file: File,
  xlsx: SheetJs,
): Promise<WorkbookSummaryWithRelationV9> {
  const data = await file.arrayBuffer();
  const manifest = await createSourceFileManifest(file, data, xlsx.version);
  return readWorkbookData(file, data, xlsx, manifest);
}
