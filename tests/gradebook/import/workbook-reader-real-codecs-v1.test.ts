// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import { createSourceFileManifest } from '../../../src/features/gradebook/import/file-manifest';
import { collectGradebookImportDiagnosticsV1 } from '../../../src/features/gradebook/import/import-diagnostics-v1';
import { readWorkbookData } from '../../../src/features/gradebook/import/workbook-reader';
import { loadCandidateReaderV1, type CandidateReaderV1 } from '../fixtures/reader-candidate-v1';
import type { SheetJs } from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import { createRelationalImportIdempotencyFixtureV11 } from '../fixtures/relational-import-idempotency-v11';
import {
  loadRealSheetJsV1,
  writeRealWorkbookV1,
  type RealSheetJsV1,
} from '../fixtures/sheetjs-real-v1';
import {
  WORKBOOK_READER_EQUIVALENCE_CASES_V1,
  syntheticResultV1,
} from '../fixtures/workbook-reader-equivalence-v1';

let xlsx: RealSheetJsV1;
let candidate: CandidateReaderV1;
beforeAll(async () => {
  xlsx = await loadRealSheetJsV1();
  candidate = await loadCandidateReaderV1();
});
const fixedNow = () => new Date('2026-10-02T12:00:00Z');
const formats = ['xlsx', 'xlsb', 'xls'] as const;

async function prepareReader(id: string, format: (typeof formats)[number]) {
  const source = WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === id)!;
  const bytes = writeRealWorkbookV1(xlsx, source.workbook, format);
  const before = new Uint8Array(bytes).slice();
  const file = new File([bytes], `SYNTHETIC-${id}.${format}`, {
    lastModified: Date.UTC(2026, 0, 1),
  });
  const manifest = await createSourceFileManifest(file, bytes, xlsx.version, { now: fixedNow });
  return (variant: 'S0' | 'S1' | 'D1') => {
    const library: SheetJs = {
      ...xlsx,
      read: (data, options) =>
        xlsx.read(data, variant === 'D1' ? { ...options, dense: true } : options),
    };
    // Use the same test realm for both results; preserve undefined, holes and dates.
    const summary = structuredClone(
      (variant === 'S0' ? readWorkbookData : candidate.readWorkbookData)(
        file,
        bytes,
        library,
        manifest,
        undefined,
        true,
      ),
    );
    const result = syntheticResultV1(manifest, summary);
    const output = {
      summary,
      diagnostics: collectGradebookImportDiagnosticsV1(result),
      request: createGradebookCanonicalImportRequestV9(result),
    };
    expect(new Uint8Array(bytes)).toStrictEqual(before);
    return output;
  };
}

describe('H-R17/H-R22 — real pinned codecs and V11/V10/V9', () => {
  for (const format of formats) {
    it(`${format}: real sheetRows keeps fullref dimensions without extending capture`, async () => {
      const source = structuredClone(
        WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === 'teacher')!.workbook,
      );
      const sheet = source.Sheets['6A1º']!;
      sheet['!ref'] = 'A1:AZ120';
      sheet.AZ120 = { t: 's', v: 'SYNTHETIC DIMENSION SENTINEL' };
      const bytes = writeRealWorkbookV1(xlsx, source, format);
      const file = new File([bytes], `SYNTHETIC-dimensions.${format}`);
      const manifest = await createSourceFileManifest(file, bytes, xlsx.version, { now: fixedNow });
      const original = structuredClone(
        readWorkbookData(file, bytes, xlsx, manifest, undefined, true),
      );
      const dense: SheetJs = {
        ...xlsx,
        read: (data, options) => xlsx.read(data, { ...options, dense: true }),
      };
      expect(
        candidate.readWorkbookData(file, bytes, dense, manifest, undefined, true),
      ).toStrictEqual(original);
      const recognition = original.gradeSheets.find((value) => value.name === '6A1º');
      expect(recognition).toMatchObject({ range: 'A1:AZ120', rows: 120, columns: 52 });
      expect(recognition?.students.every((student) => student.row <= 50)).toBe(true);
      expect(recognition?.snapshotCellsV8).not.toHaveProperty('AZ120');
    });
    it(`${format}: same complete teacher/relation output, stable byte reads and persisted requests`, async () => {
      const readTeacher = await prepareReader('teacher', format);
      const readRelation = await prepareReader('relation', format);
      const teacher = readTeacher('S0');
      expect(readTeacher('S0')).toStrictEqual(teacher);
      expect(readTeacher('S1')).toStrictEqual(teacher);
      expect(readTeacher('D1')).toStrictEqual(teacher);
      const relation = readRelation('S0');
      expect(readRelation('S1')).toStrictEqual(relation);
      expect(readRelation('D1')).toStrictEqual(relation);
      const fixture = await createRelationalImportIdempotencyFixtureV11();
      try {
        expect((await fixture.execute(relation.request)).response.state).toBe('applied');
        expect((await fixture.execute(teacher.request)).response.state).toBe('applied');
        const before = await fixture.snapshot();
        const revision = await fixture.revision();
        for (const request of [
          teacher.request,
          readTeacher('S1').request,
          readTeacher('D1').request,
        ]) {
          const repeat = await fixture.execute(request);
          expect(repeat.response.state).toBe('no-changes');
          expect(repeat.counts).toMatchObject({ dml: {}, revisionCalls: 0, lifecycleCalls: 0 });
          expect(repeat.metrics.sqlWriteCalls).toBe(0);
        }
        expect(await fixture.snapshot()).toStrictEqual(before);
        expect(await fixture.revision()).toStrictEqual(revision);
      } finally {
        await fixture.close();
      }
    });
  }
});
