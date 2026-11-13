// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import { importWorkbookBatch } from '../../../src/features/gradebook/import/import-batch';
import { prepareTeacherWorkbookV1 } from '../../../server/gradebook/onedrive-sync/teacher-workbook-preparation-v1';
import { loadRealSheetJsV1, writeRealWorkbookV1, type RealSheetJsV1 } from '../fixtures/sheetjs-real-v1';
import { WORKBOOK_READER_EQUIVALENCE_CASES_V1 } from '../fixtures/workbook-reader-equivalence-v1';

let xlsx: RealSheetJsV1;
beforeAll(async () => {
  xlsx = await loadRealSheetJsV1();
});
const caseBytes = (id: string) =>
  writeRealWorkbookV1(xlsx, WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === id)!.workbook, 'xlsb');

describe('server-side teacher workbook preparation', () => {
  it('builds the same import request as the browser path, without writing', async () => {
    const bytes = caseBytes('teacher');
    const prepared = await prepareTeacherWorkbookV1({ bytes, fileName: 'SINTETICO.xlsb', lastModified: 0, xlsx });
    expect(prepared.outcome).toBe('ready');
    const browser = await importWorkbookBatch([new File([bytes], 'SINTETICO.xlsb', { lastModified: 0 })], xlsx, () => {}, {
      captureValues: true, yieldBeforeRecognition: async () => {},
    });
    const expected = createGradebookCanonicalImportRequestV9(browser.successes[0]!);
    if (prepared.outcome !== 'ready') throw new Error('unexpected');
    const withoutTime = (value: unknown) => JSON.stringify(value, (key, item) => (key === 'readAt' ? undefined : item));
    expect(withoutTime(prepared.request)).toBe(withoutTime(expected));
    expect(prepared.summary.requestBytes).toBeGreaterThan(0);
  });

  it('never prepares a request the canonical builder rejects', async () => {
    const prepared = await prepareTeacherWorkbookV1({
      bytes: caseBytes('negative-grade'), fileName: 'SINTETICO.xlsb', lastModified: 0, xlsx,
    });
    expect(prepared.outcome).not.toBe('ready');
  });

  it('reports a file it cannot read', async () => {
    const prepared = await prepareTeacherWorkbookV1({
      bytes: new Uint8Array([1, 2, 3]).buffer, fileName: 'SINTETICO.xlsb', lastModified: 0, xlsx,
    });
    expect(prepared.outcome).toBe('unreadable');
  });
});
