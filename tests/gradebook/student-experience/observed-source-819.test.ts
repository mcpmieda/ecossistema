// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  recognizeWorkbook,
  type Worksheet,
} from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import type { BatchSuccess } from '../../../src/features/gradebook/import/import-batch';
import {
  SYNTHETIC_TEACHER_WORKBOOK,
  SYNTHETIC_FILES,
  createSyntheticFile,
  createSyntheticSheetJs,
} from '../fixtures/synthetic-teacher-workbooks';

function observed(cells: Record<string, Worksheet[string]> = {}, captureValues = true) {
  const workbook = structuredClone(SYNTHETIC_TEACHER_WORKBOOK);
  const sheet = workbook.Sheets['6A1º']!;
  for (const address of [
    'R5',
    'S5',
    'Z5',
    'AA5',
    'AB5',
    'AC5',
    'AD5',
    'AE5',
    'AF5',
    'AG5',
    'AH5',
    'AI5',
    'AJ5',
  ])
    delete sheet[address];
  Object.assign(sheet, cells);
  const summary = recognizeWorkbook(
    createSyntheticFile(SYNTHETIC_FILES.xlsx),
    workbook,
    createSyntheticSheetJs(),
    { fileSha256: 'a'.repeat(64), captureValues },
  );
  const term = summary.gradeSheets.find((s) => s.name === '6A1º')!;
  expect(term).toBeTruthy();
  return { summary, term };
}

describe('actual workbook observation #819', () => {
  it('captures omitted Excel cells as blanks only inside recognized student instrument ranges', () => {
    const { term } = observed();
    for (const col of ['R', 'S', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ'])
      expect(term.snapshotCellsV8).toHaveProperty(`${col}5`, null);
    expect(term.snapshotCellsV8).not.toHaveProperty('R51');
    expect(term.snapshotCellsV8).not.toHaveProperty('AA4');
  });
  it('treats omitted known maximum/name cells inside the sheet as observed blanks', () => {
    const workbook = structuredClone(SYNTHETIC_TEACHER_WORKBOOK);
    const sheet = workbook.Sheets['6A1º']!;
    delete sheet.AA3;
    delete sheet.AA4;
    const summary = recognizeWorkbook(
      createSyntheticFile(SYNTHETIC_FILES.xlsx),
      workbook,
      createSyntheticSheetJs(),
      { fileSha256: 'a'.repeat(64), captureValues: true },
    );
    const term = summary.gradeSheets.find((item) => item.name === '6A1º')!;
    const definition = term.assessmentDefinitions.find((item) => item.sourceSlot === 'AA');
    expect(definition).toMatchObject({
      kind: 'qualitative-activity',
      maximumConfiguration: { state: 'ambiguous-empty', rawValue: null },
      name: { state: 'empty', rawValue: null },
    });
  });

  it('keeps an unread definition formula unavailable instead of treating it as deletion', () => {
    const workbook = structuredClone(SYNTHETIC_TEACHER_WORKBOOK);
    const sheet = workbook.Sheets['6A1º']!;
    sheet.AA3 = { f: 'SUM(A1:A2)' };
    const summary = recognizeWorkbook(
      createSyntheticFile(SYNTHETIC_FILES.xlsx),
      workbook,
      createSyntheticSheetJs(),
      { fileSha256: 'a'.repeat(64), captureValues: true },
    );
    const term = summary.gradeSheets.find((item) => item.name === '6A1º')!;
    const definition = term.assessmentDefinitions.find((item) => item.sourceSlot === 'AA');
    expect(definition).toMatchObject({
      maximumConfiguration: { state: 'missing-field' },
    });
  });

  it('preserves typed zero and saved formula zero, independently of displayed text', () => {
    const { term } = observed({ R5: { v: 0 }, S5: { v: 0, f: 'SUM(A1:A2)', w: '' }, Z5: { v: 0 } });
    expect(term.snapshotCellsV8).toMatchObject({ R5: 0, S5: 0, Z5: 0, AA5: null });
  });
  it('records explicit empty cells and cached formula empty strings as blanks', () => {
    const { term } = observed({
      R5: { v: '' },
      S5: { v: '   ' },
      Z5: { v: '', f: 'IF(A1="","",1)' },
    });
    expect(term.snapshotCellsV8).toMatchObject({ R5: null, S5: null, Z5: null });
  });
  it('never interprets a formula without saved cache, error or failed read as not done', () => {
    const { term } = observed({
      R5: { f: 'SUM(A1:A2)' },
      S5: { t: 'e', v: '#VALUE!' },
      Z5: { v: NaN },
    });
    expect(term.snapshotCellsV8).toMatchObject({ R5: ['u'], S5: ['u'], Z5: ['u'] });
    expect(observed({}, false).term.snapshotCellsV8).toBeUndefined();
  });
  it('sends the observed blank and zero through the official canonical V9 producer with a fresh parser version', () => {
    const { summary, term } = observed({ S5: { v: 0 }, Z5: { v: 0, f: '0' }, AM5: { v: 8.25 } });
    // One synthetic offering across three terms, using the actual recognized source row.
    const terms = [1, 2, 3].map((n) => ({
      ...term,
      name: `6A${n}º`,
      stage: `trimester-${n}`,
      declaredStage: `${n}º trimestre`,
      students: term.students.filter((s) => s.row === 5),
    }));
    const result = {
      id: 'synthetic-819',
      manifest: {
        fileName: 'SYNTHETIC819.xlsx',
        sha256: 'a'.repeat(64),
        parserVersion: 'synthetic',
        sizeBytes: 1,
        extension: 'xlsx',
        reportedMimeType: null,
        lastModifiedAt: null,
        sourceContractVersion: 2,
        readAt: '2026-09-16T12:00:00Z',
      },
      summary: {
        ...summary,
        academicYear: 2026,
        teacherName: 'SYNTHETIC TEACHER',
        gradeSheets: terms,
      },
    } as BatchSuccess;
    const request = createGradebookCanonicalImportRequestV9(result);
    expect(request.operation).toBe('persist-notas');
    if (request.operation !== 'persist-notas') throw new Error('missing notes');
    expect(request.granularObservationVersion).toBe(1);
    expect(request.manifest.parserVersion).toContain(':observed-blanks-v1');
    expect(request.ofertas[0]!.trimestres[0].alunos[0]![1].slice(0, 3)).toEqual([null, 0, 0]);
    expect(request.ofertas[0]!.trimestres[0].alunos[0]![2]).toBe(8250);
  });
});
