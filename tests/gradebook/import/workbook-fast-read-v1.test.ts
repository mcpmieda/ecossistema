import { beforeAll, describe, expect, it } from 'vitest';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import { createSourceFileManifest } from '../../../src/features/gradebook/import/file-manifest';
import {
  collectGradebookImportDiagnosticsV1,
  gradebookImportDiagnosticsAuditRequestV1,
} from '../../../src/features/gradebook/import/import-diagnostics-v1';
import type { SheetJs, Workbook } from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import {
  createFastTeacherSheetJsV1,
  isSheetSkippedByFastReadV1,
} from '../../../src/features/gradebook/import/workbook-fast-read-v1';
import { WORKBOOK_READ_OPTIONS, readWorkbookData } from '../../../src/features/gradebook/import/workbook-reader';
import { loadRealSheetJsV1, writeRealWorkbookV1, type RealSheetJsV1 } from '../fixtures/sheetjs-real-v1';
import {
  WORKBOOK_READER_EQUIVALENCE_CASES_V1,
  syntheticResultV1,
  type WorkbookFixtureV1,
} from '../fixtures/workbook-reader-equivalence-v1';
import { injectXlsbFormulasV1, type XlsbFormulaInjectionV1 } from '../fixtures/xlsb-formula-injection-v1';

let xlsx: RealSheetJsV1;
beforeAll(async () => {
  xlsx = await loadRealSheetJsV1();
});
const fixedNow = () => new Date('2026-10-02T12:00:00Z');

/** The synthetic teacher workbook plus the tabs the fast read skips, all with synthetic data. */
function teacherWithAuxiliaryTabsV1(): WorkbookFixtureV1 {
  const workbook = structuredClone(
    WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === 'teacher')!.workbook,
  );
  const extra: Record<string, WorkbookFixtureV1['Sheets'][string]> = {
    '6AVG': { '!ref': 'A1:C3', A1: { t: 's', v: 'VISÃO GERAL SINTÉTICA' }, C3: { t: 'n', v: 9.5 } },
    RELAÇÃO: { '!ref': 'A1:B2', A1: { t: 's', v: 'Nº' }, B2: { t: 's', v: 'ESTUDANTE SINTÉTICO' } },
    INICIO: { '!ref': 'A1:Q2', Q2: { t: 'n', v: 2026 } },
  };
  for (const [name, sheet] of Object.entries(extra)) {
    if (!workbook.SheetNames.includes(name)) workbook.SheetNames.push(name);
    workbook.Sheets[name] = { ...workbook.Sheets[name], ...sheet };
  }
  const configuration = workbook.Sheets['CONFIGURAÇÃO']!;
  configuration['!ref'] = 'A1:Z14';
  for (const row of [10, 11, 12, 13, 14]) configuration[`Z${row}`] = { t: 'n', v: row * 10 };
  workbook.Sheets['6A1º']!.S5 = { t: 'n', v: 7 };
  return workbook;
}

const INJECTIONS_V1: readonly XlsbFormulaInjectionV1[] = [
  { kind: 'plain', sheet: '6A1º', row: 4, column: 18, value: 7 }, // S5
  { kind: 'shared', sheet: 'CONFIGURAÇÃO', firstRow: 9, lastRow: 10, column: 25, value: 3 }, // Z10:Z11
  { kind: 'array', sheet: 'CONFIGURAÇÃO', firstRow: 11, lastRow: 13, column: 25, value: 4 }, // Z12:Z14
];

function syntheticXlsbV1(): ArrayBuffer {
  return injectXlsbFormulasV1(xlsx, writeRealWorkbookV1(xlsx, teacherWithAuxiliaryTabsV1(), 'xlsb'), INJECTIONS_V1);
}

type CellViewV1 = { v?: unknown; w?: string; t?: string; f?: string };
function cellsV1(workbook: Workbook, sheet: string) {
  const out: Record<string, { v: unknown; w: unknown; t: unknown; formula: boolean }> = {};
  for (const [address, value] of Object.entries(workbook.Sheets[sheet] ?? {})) {
    if (address.startsWith('!') || !value || typeof value !== 'object') continue;
    const cell = value as CellViewV1;
    out[address] = { v: cell.v, w: cell.w, t: cell.t, formula: Boolean(cell.f) };
  }
  return out;
}

describe('fast teacher read V1 — same import as the full SheetJS read', () => {
  it('the synthetic file really carries plain, shared and array formulas', () => {
    const full = xlsx.read(syntheticXlsbV1(), { ...WORKBOOK_READ_OPTIONS });
    const formulas = (sheet: string) =>
      Object.entries(cellsV1(full, sheet)).filter(([, cell]) => cell.formula).map(([address]) => address);
    expect(formulas('6A1º')).toContain('S5');
    // Array members after the anchor carry no `f` in SheetJS; the anchor and shared cells do.
    expect(formulas('CONFIGURAÇÃO')).toEqual(expect.arrayContaining(['Z10', 'Z11', 'Z12']));
    expect(formulas('CONFIGURAÇÃO')).not.toContain('Z13');
    expect(formulas('CONFIGURAÇÃO')).not.toContain('Z14');
  });

  it('keeps every value, text, type and formula mark of the sheets it opens', () => {
    const bytes = syntheticXlsbV1();
    const full = xlsx.read(bytes, { ...WORKBOOK_READ_OPTIONS });
    const fast = createFastTeacherSheetJsV1(xlsx).read(bytes, { ...WORKBOOK_READ_OPTIONS });
    expect(fast.SheetNames).toEqual(full.SheetNames);
    for (const name of full.SheetNames) {
      if (isSheetSkippedByFastReadV1(name)) expect(fast.Sheets[name]).toBeUndefined();
      else expect(cellsV1(fast, name)).toEqual(cellsV1(full, name));
    }
    expect(['6AVG', 'RELAÇÃO', 'INICIO'].every((name) => fast.Sheets[name] === undefined)).toBe(true);
  });

  it('produces the same import request and Auditoria request', async () => {
    const bytes = syntheticXlsbV1();
    const file = new File([bytes], 'SYNTHETIC-fast-read.xlsb', { lastModified: Date.UTC(2026, 0, 1) });
    const manifest = await createSourceFileManifest(file, bytes, xlsx.version, { now: fixedNow });
    const prepare = (library: SheetJs) => {
      const summary = structuredClone(readWorkbookData(file, bytes, library, manifest, undefined, true));
      const result = syntheticResultV1(manifest, summary);
      const diagnostics = collectGradebookImportDiagnosticsV1(result);
      return {
        request: createGradebookCanonicalImportRequestV9(result),
        audit: gradebookImportDiagnosticsAuditRequestV1(result, diagnostics),
      };
    };
    expect(prepare(createFastTeacherSheetJsV1(xlsx))).toEqual(prepare(xlsx));
  });

  it('falls back to the full read for other formats and for the master Relação workbook', () => {
    const fast = createFastTeacherSheetJsV1(xlsx);
    const teacher = teacherWithAuxiliaryTabsV1();
    const xlsxBytes = writeRealWorkbookV1(xlsx, teacher, 'xlsx');
    expect(fast.read(xlsxBytes, { ...WORKBOOK_READ_OPTIONS })).toEqual(xlsx.read(xlsxBytes, { ...WORKBOOK_READ_OPTIONS }));

    const master = structuredClone(teacher);
    master.SheetNames.push('VÍNCULO AGENDA');
    master.Sheets['VÍNCULO AGENDA'] = { '!ref': 'A1', A1: { t: 's', v: 'SINTÉTICO' } };
    const masterBytes = writeRealWorkbookV1(xlsx, master, 'xlsb');
    expect(fast.read(masterBytes, { ...WORKBOOK_READ_OPTIONS })).toEqual(xlsx.read(masterBytes, { ...WORKBOOK_READ_OPTIONS }));
  });

  it('falls back to the full read when a sheet part cannot be scanned', () => {
    const bytes = syntheticXlsbV1();
    const corrupted: SheetJs = {
      ...xlsx,
      read: (data, options) => {
        const workbook = xlsx.read(data, options) as Workbook & { files?: Record<string, { content?: Uint8Array }> };
        for (const [path, entry] of Object.entries(workbook.files ?? {}))
          if (/worksheets\/sheet\d+\.bin$/iu.test(path)) entry.content = Uint8Array.of(0x00, 0x7f);
        return workbook;
      },
    };
    expect(createFastTeacherSheetJsV1(corrupted).read(bytes, { ...WORKBOOK_READ_OPTIONS })).toEqual(
      xlsx.read(bytes, { ...WORKBOOK_READ_OPTIONS }),
    );
  });
});
