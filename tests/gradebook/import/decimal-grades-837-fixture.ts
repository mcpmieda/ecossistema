import {
  recognizeWorkbook,
  type Workbook,
  type Worksheet,
} from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import type { BatchSuccess } from '../../../src/features/gradebook/import/import-batch';
import {
  createSyntheticFile,
  createSyntheticSheetJs,
  SYNTHETIC_FILES,
} from '../fixtures/synthetic-teacher-workbooks';

/** Synthetic workbook only: no production pupil, file or value is used. */
export function decimalGradeBatch837(
  cells: Partial<Worksheet> = {},
  recoveryCells: Partial<Worksheet> = {},
): BatchSuccess {
  const term = (index: number): Worksheet => ({
    '!ref': 'A1:AN5',
    J1: { v: 1 },
    K2: { v: 'SYNTHETIC SUBJECT' },
    K3: { v: 'TEST' },
    K4: { v: `${index}º trimestre` },
    R3: { v: index === 3 ? 9 : 6.75 },
    S3: { v: index === 3 ? 9 : 6.75 },
    AA3: { v: index === 3 ? 11 : 8.25 },
    AB3: { v: index === 3 ? 11 : 8.25 },
    AA4: { v: 'PART 1' },
    AB4: { v: 'ATIVIDADE SINTETICA' },
    J5: { v: 1 },
    K5: { v: 'SYNTHETIC STUDENT' },
    R5: { v: 0.1 },
    S5: { v: 0.1, f: '1/10' },
    Z5: { v: '' },
    AA5: { v: 0 },
    AB5: { v: '' },
    AM5: { v: 0.1 },
    ...(index === 1 ? cells : {}),
  });
  const workbook: Workbook = {
    SheetNames: ['CONFIGURAÇÃO', 'TEST1º', 'TEST2º', 'TEST3º', 'TESTREC'],
    Sheets: {
      CONFIGURAÇÃO: { '!ref': 'A1:C2', A2: { v: 'SYNTHETIC TEACHER' }, C2: { v: 2026 } },
      TEST1º: term(1),
      TEST2º: term(2),
      TEST3º: term(3),
      TESTREC: {
        '!ref': 'A1:AN5',
        K2: { v: 'SYNTHETIC SUBJECT' },
        K3: { v: 'TEST' },
        J5: { v: 1 },
        K5: { v: 'SYNTHETIC STUDENT' },
        R5: { v: 0.1 },
        S5: { v: '0,1' },
        T5: { v: 0.1, f: '1/10' },
        U5: { v: 0.1 },
        ...recoveryCells,
      },
    },
  };
  const file = createSyntheticFile(SYNTHETIC_FILES.xlsx);
  const sha256 = 'b'.repeat(64);
  const summary = recognizeWorkbook(file, workbook, createSyntheticSheetJs(), {
    fileSha256: sha256,
    captureValues: true,
  });
  return {
    id: 'import-file:synthetic-decimal-837' as BatchSuccess['id'],
    summary,
    manifest: {
      id: `source-file-manifest:${sha256}` as BatchSuccess['manifest']['id'],
      fileName: 'SYNTHETIC837.xlsx',
      sha256,
      parserVersion: 'synthetic',
      sizeBytes: 1,
      extension: 'xlsx',
      reportedMimeType: null,
      lastModifiedAt: null,
      sourceContractVersion: 2,
      readAt: '2026-09-17T13:35:00.000Z',
    },
  };
}
