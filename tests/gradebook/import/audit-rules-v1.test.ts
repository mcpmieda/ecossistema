import { describe, expect, it } from 'vitest';
import type { SourceFileManifestV1 } from '../../../shared/gradebook-contracts/imports/import-contract-v1';
import type { GradebookNotesImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import { collectGradebookImportDiagnosticsV1 } from '../../../src/features/gradebook/import/import-diagnostics-v1';
import { readWorkbookData } from '../../../src/features/gradebook/import/workbook-reader';
import {
  WORKBOOK_READER_EQUIVALENCE_CASES_V1,
  createFixtureSheetJsV1,
  syntheticResultV1,
  type WorkbookFixtureV1,
} from '../fixtures/workbook-reader-equivalence-v1';

const bytes = Uint8Array.of(1, 2, 3, 4).buffer;
const file = new File([bytes], 'Notas - Docente Fictício - 2026.xlsx', { lastModified: Date.UTC(2026, 0, 5) });
const manifest = {
  id: 'source-file-manifest:audit-rules', fileName: file.name, extension: 'xlsx', reportedMimeType: null,
  sizeBytes: bytes.byteLength, lastModifiedAt: new Date(file.lastModified).toISOString(), sha256: 'c'.repeat(64),
  sourceContractVersion: 2, parserVersion: 'functional-fixture-adapter', readAt: '2026-10-02T12:00:00.000Z',
} as unknown as SourceFileManifestV1;

/** The synthetic teacher, with every activity described and maximised, then the case's change. */
function run(mutate: (sheets: WorkbookFixtureV1['Sheets']) => void = () => {}) {
  const workbook = structuredClone(WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === 'teacher')!.workbook);
  Object.assign(workbook.Sheets['6A3º']!, {
    AA3: { t: 'n', v: 10 }, AE3: { t: 'n', v: 10 }, AA4: { t: 's', v: 'Atividade A' }, AE4: { t: 's', v: 'Atividade E' },
  });
  mutate(workbook.Sheets);
  const result = syntheticResultV1(manifest, readWorkbookData(file, bytes, createFixtureSheetJsV1(workbook), manifest, undefined, true));
  const diagnostics = collectGradebookImportDiagnosticsV1(result);
  let request: GradebookNotesImportRequestV9 | null;
  try {
    request = createGradebookCanonicalImportRequestV9(result) as GradebookNotesImportRequestV9;
  } catch {
    request = null;
  }
  const codes = diagnostics.map((item) => item.code);
  const term1 = request?.ofertas[0]?.trimestres[0];
  return { codes, diagnostics, request, firstStudent: term1?.alunos[0], term1 };
}

describe('audit rules (BN-DEC-046)', () => {
  it('a workbook without problems reports none of the new rules and holds nothing', () => {
    const { codes, firstStudent } = run();
    expect(codes.filter((code) => !['source-unavailable', 'invalid-maximum'].includes(code))).toEqual([]);
    expect(firstStudent?.[2]).not.toEqual(['u']);
  });

  it('1. grades in an activity without description hold the column and those students’ results', () => {
    const { codes, term1, firstStudent } = run((sheets) => { sheets['6A1º']!.AE4 = { t: 's', v: '' }; });
    expect(codes).toContain('activity-without-description');
    expect(term1?.unavailableValueSlots).toContain(15);
    const column = term1!.instrumentos.findIndex(([slot]) => slot === 15);
    expect(firstStudent?.[1][column]).toEqual(['u']);
    expect(firstStudent?.[2]).toEqual(['u']);
  });

  it('2. grades in an activity without a valid maximum hold the column', () => {
    const { codes, term1 } = run((sheets) => { sheets['6A1º']!.AD5 = { t: 'n', v: 1 }; });
    expect(codes).toContain('activity-without-maximum');
    expect(term1?.unavailableValueSlots).toContain(14);
  });

  it('3/14 are server rules: not raised by the workbook alone', () => {
    const { codes } = run();
    expect(codes).not.toContain('wrong-year');
    expect(codes).not.toContain('student-name-mismatch');
  });

  it('4 and 6. activities above the qualitative ceiling hold the results', () => {
    const { codes, firstStudent } = run((sheets) => { sheets['6A1º']!.AK3 = { t: 'n', v: 5 }; });
    expect(codes).toContain('qualitative-maxima-over-ceiling');
    expect(codes).toContain('qualitative-over-ceiling');
    expect(firstStudent?.[2]).toEqual(['u']);
  });

  it('6. maxima above the ceiling are reported, but hold nothing while no student passes it', () => {
    // An extra activity whose maximum alone passes the ceiling, still without grades.
    const { diagnostics, term1 } = run((sheets) => {
      Object.assign(sheets['6A1º']!, { AK3: { t: 'n', v: 16.5 }, AJ3: { t: 'n', v: 20 }, AJ4: { t: 's', v: 'Atividade J' } });
    });
    const found = diagnostics.find((item) => item.code === 'qualitative-maxima-over-ceiling');
    expect(found?.severity).toBe('warning');
    expect(diagnostics.some((item) => item.code === 'qualitative-over-ceiling')).toBe(false);
    expect(term1?.alunos.every(([, , am]) => !Array.isArray(am) || am[0] !== 'u')).toBe(true);
  });

  it('5. a grade above its maximum is held with the student result', () => {
    const { codes, firstStudent } = run((sheets) => { sheets['6A1º']!.R5 = { t: 'n', v: 9 }; });
    expect(codes).toContain('above-maximum');
    expect(firstStudent?.[1][0]).toEqual(['u']);
    expect(firstStudent?.[2]).toEqual(['u']);
  });

  it('7. a header naming another term holds the whole class/subject', () => {
    const { codes, request } = run((sheets) => { sheets['6A1º']!.K4 = { t: 's', v: '2º trimestre' }; });
    expect(codes).toContain('header-mismatch');
    expect(request).toBeNull();
  });

  it('8. a final recovery above the term maximum holds it and U', () => {
    const { codes, request } = run((sheets) => {
      Object.assign(sheets['6A1º']!, { T3: { t: 'n', v: 13.5 }, AK3: { t: 'n', v: 16.5 } });
      sheets['6AREC']!.R5 = { t: 'n', v: 31 };
    });
    expect(codes).toContain('recovery-above-maximum');
    const row = request!.ofertas[0]!.recuperacao![0]!;
    expect(row[1]).toEqual(['u']);
    expect(row[4]).toEqual(['u']);
  });

  it('9. a work grade with the work block off holds the result', () => {
    const { codes, firstStudent } = run((sheets) => { sheets['6A1º']!.U5 = { t: 'n', v: 2 }; });
    expect(codes).toContain('work-without-weight');
    expect(firstStudent?.[2]).toEqual(['u']);
  });

  it('10. a grade in a row without a student is only reported', () => {
    const { codes, diagnostics } = run((sheets) => { sheets['6A1º']!.R40 = { t: 'n', v: 5 }; });
    expect(codes).toContain('grade-without-student');
    expect(diagnostics.find((item) => item.code === 'grade-without-student')?.severity).toBe('warning');
  });

  it('11. AV2 filled in "1 AVALIAÇÃO" mode holds the result', () => {
    const { codes, firstStudent } = run((sheets) => {
      Object.assign(sheets['6A1º']!, { L1: { t: 's', v: '1 AVALIAÇÃO' }, S5: { t: 'n', v: 3 } });
    });
    expect(codes).toContain('one-assessment-mode');
    expect(firstStudent?.[2]).toEqual(['u']);
  });

  it('12. a typed AM among formula AMs is held; a sheet of typed AMs is not judged', () => {
    expect(run().codes).not.toContain('manual-term-result');
    const { codes } = run((sheets) => {
      Object.assign(sheets['6A1º']!, {
        J6: { t: 'n', v: 2 }, K6: { t: 's', v: 'Estudante Fictício 02' }, AM6: { t: 'n', v: 8, f: 'ROUND(B6,1)' },
      });
    });
    expect(codes).toContain('manual-term-result');
  });
});
