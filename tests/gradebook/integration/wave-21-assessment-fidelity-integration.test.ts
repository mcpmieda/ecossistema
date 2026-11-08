// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { recognizeWorkbook } from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import {
  SYNTHETIC_FILES,
  SYNTHETIC_TEACHER_WORKBOOK,
  createSyntheticFile,
  createSyntheticSheetJs,
} from '../fixtures/synthetic-teacher-workbooks';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('integração final da onda 21 — fidelidade das avaliações trimestrais', () => {
  it('reconhece cabeçalhos V2 separados dos alunos', () => {
    const fileSha256 = '9'.repeat(64);
    const gradeSheet = recognizeWorkbook(
      createSyntheticFile(SYNTHETIC_FILES.xlsx),
      SYNTHETIC_TEACHER_WORKBOOK,
      createSyntheticSheetJs(),
      { fileSha256 },
    ).gradeSheets.find(({ name }) => name === '6A1º');
    if (!gradeSheet) throw new Error('Guia sintética regular ausente.');

    expect(gradeSheet.students[0]?.row).toBe(5);
    expect(gradeSheet.assessmentDefinitions.map(({ sourceSlot }) => sourceSlot)).toEqual([
      'R',
      'S',
      'AA',
      'AB',
      'AC',
      'AD',
      'AE',
      'AF',
      'AG',
      'AH',
      'AI',
      'AJ',
    ]);
    expect(gradeSheet.students.some(({ name }) => name.includes('Pesquisa sobre frações'))).toBe(
      false,
    );
  });

  it('lê os agregados T, AK, AM e AN sem simulação', () => {
    const recognizer = source('src/features/gradebook/import/spreadsheet-recognizer.ts');
    expect(recognizer).toContain(
      'quantitativeTotal: readGrades ? readNote(sheet, `T${row}`) : null',
    );
    expect(recognizer).toContain(
      'qualitativeTotal: readGrades ? readNote(sheet, `AK${row}`) : null',
    );
    expect(recognizer).toContain('official: readGrades ? readNote(sheet, `AM${row}`) : null');
    expect(recognizer).toContain('annual: readGrades ? readNote(sheet, `AN${row}`) : null');
    expect(recognizer).not.toContain('simulation:');
  });

  it('preserva o catálogo D1 0001–0006 como memória histórica', () => {
    const migrations = readdirSync(join(root, 'Aprendizados/RUNTIME-D1-RETIRADO-1079/migrations/gradebook')).sort();
    expect(migrations).toEqual([
      '0001_gradebook_context_entities_imports_v1.sql',
      '0002_gradebook_records_audit_v1.sql',
      '0003_logical_source_record_catalog_v1.sql',
      '0004_bulletin_council_durability_v1.sql',
      '0005_council_session_durability_v2.sql',
      '0006_import_staging_v1.sql',
    ]);
  });
});
