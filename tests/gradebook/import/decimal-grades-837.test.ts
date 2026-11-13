// @vitest-environment node
import { expect, it } from 'vitest';
import { decimalGradeBatch837 } from './decimal-grades-837-fixture';
import { createGradebookCanonicalImportRequestV9, canonicalMilliV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import { formatNote } from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import { collectGradebookImportDiagnosticsV1 } from '../../../src/features/gradebook/import/import-diagnostics-v1';
import { resolveSimplifiedTermV1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import { learningFixtureV1 } from '../performance/learning-fixture-v1';

const request = (batch = decimalGradeBatch837()) => {
  const value = createGradebookCanonicalImportRequestV9(batch);
  if (value.operation !== 'persist-notas') throw new Error('notes expected');
  return value;
};
it.each([0.1, '0,1', ' 0.1 ', '0,100'])('preserves decimal %s from recognition through canonical millipoints', (raw) => {
  const batch = decimalGradeBatch837({ R5: { v: raw }, AM5: { v: raw } });
  const sheet = batch.summary.gradeSheets.find((item) => item.name === 'TEST1º')!;
  expect(sheet.students[0]!.quantitativeAssessments[0]).toEqual({ source: 0.1, value: 0.1, kind: 'manual' });
  expect(formatNote(sheet.students[0]!.quantitativeAssessments[0]!)).toBe('0,1');
  expect(sheet.officialZeros).toBe(0);
  const value = request(batch);
  expect(value.ofertas[0]!.trimestres[0].alunos[0]![1].slice(0, 5)).toEqual([100, 100, null, 0, null]);
  expect(value.ofertas[0]!.trimestres[0].alunos[0]![2]).toBe(100);
  expect(value.manifest.parserVersion).toContain(':decimal-grades-v1');
  expect(value.granularObservationVersion).toBe(1);
});
it('preserves saved formula decimals, numeric zero and blank without relying on formatted text', () => {
  const value = request(decimalGradeBatch837({
    R5: { v: 0.1, f: '1/10', w: '0' }, S5: { v: 0, f: '0', w: '' },
    Z5: { v: '', f: 'IF(1=1,"",1)' }, AM5: { v: 0.1, f: '1/10' },
  }));
  expect(value.ofertas[0]!.trimestres[0].alunos[0]![1].slice(0, 3)).toEqual([100, 0, null]);
  expect(value.ofertas[0]!.trimestres[0].alunos[0]![2]).toBe(100);
});
it('does not manufacture a grade for an error or missing formula cache', () => {
  const value = request(decimalGradeBatch837({ R5: { f: '1/10' }, S5: { v: '#VALUE!', t: 'e' } }));
  expect(value.ofertas[0]!.trimestres[0].alunos[0]![1].slice(0, 2)).toEqual([['u'], ['u']]);
});
it('preserves decimals in REC/U while retaining NC/RR and the existing non-granular zero convention', () => {
  expect(request().ofertas[0]!.recuperacao![0]).toEqual([1, 100, 100, 100, 100]);
  const marked = request(decimalGradeBatch837({}, { R5: { v: 'N/C' }, S5: { v: 'R/R' }, T5: { f: '1/10' }, U5: { v: 0 } }));
  expect(marked.ofertas[0]!.recuperacao![0]).toEqual([1, ['n'], ['r'], ['u'], null]);
});
it('reads a zero typed in a recovery column as the grade 0, while a zero in U stays blank', () => {
  const zeros = request(decimalGradeBatch837({}, { R5: { v: 0 }, S5: { v: '0' }, T5: { v: '0,0' }, U5: { v: 0 } }));
  expect(zeros.ofertas[0]!.recuperacao![0]).toEqual([1, 0, 0, 0, null]);
  const blanks = request(decimalGradeBatch837({}, { R5: { v: '' }, S5: { v: null }, T5: { v: 0, f: '0' }, U5: { v: '' } }));
  expect(blanks.ofertas[0]!.recuperacao![0]).toEqual([1, null, null, null, null]);
});
it('stops the file when a student sits below row 50 instead of dropping that student', () => {
  const batch = decimalGradeBatch837({ '!ref': 'A1:AN51', J51: { v: 47 }, K51: { v: 'SYNTHETIC LATE STUDENT' } });
  expect(() => request(batch)).toThrow(/linha 51 de TEST1º.*até a linha 50/u);
});
it('does not prefer the old zero interpretation over a newly captured decimal source value', () => {
  const batch = decimalGradeBatch837();
  const sheet = batch.summary.gradeSheets.find((item) => item.name === 'TEST1º')!;
  sheet.students[0]!.quantitativeAssessments = [{ source: 0.1, value: 0, kind: 'official-zero' }, null];
  sheet.students[0]!.termResultObservations = { ...sheet.students[0]!.termResultObservations!,
    officialTermGrade: { classification: 'manual-official-zero-marker', rawValue: 0.1 } };
  expect(request(batch).ofertas[0]!.trimestres[0].alunos[0]![1][0]).toBe(100);
  expect(request(batch).ofertas[0]!.trimestres[0].alunos[0]![2]).toBe(100);
});
it('counts 0.1 plus 0.1 in the raw engine sum, retaining the separate existing final rounding', () => {
  const result = resolveSimplifiedTermV1({ term: 1, instruments: [
    { slot: 1, valueMilli: canonicalMilliV9(0.1), maximumMilli: 6750 },
    { slot: 2, valueMilli: canonicalMilliV9(0.1), maximumMilli: 6750 },
    { slot: 11, valueMilli: 0, maximumMilli: 16500 },
  ] });
  expect(result.quantitativeOriginalMilli).toBe(200);
  expect(result.rawMilli).toBe(200);
  expect(result.roundedMilli).toBe(0);
  expect(result.coverage.complete).toBe(true);
});
it('includes positive decimal scores in analytics without counting them as recorded zeros', () => {
  // A recorded PARA below Q resolves coverage without adding credit or inventing a zero.
  const { value } = learningFixtureV1({ studentCount: 1, componentCount: 1, override() {
    return { valueMilli: 100 };
  } });
  expect(value.summary.coverage.zeros).toBe(0);
  expect(value.summary.quantitative.mean).toBeCloseTo(200 / 13500 * 100);
  expect(value.learning!.participation.percent).toBeGreaterThan(0);
});
it('retains positive decimals and counts a result with a pending eligible PARA as partial', () => {
  const { value, matrix } = learningFixtureV1({ studentCount: 1, componentCount: 1, override(fact) {
    return { valueMilli: fact.slot === 3 ? null : 100 };
  } });
  expect(value.summary.coverage.zeros).toBe(0);
  expect(value.summary.coverage.missing).toBe(1);
  expect(matrix.rows[0]!.cells[0]!.state).toBe('partial');
  expect(value.students[0]!.cells[0]!.quantitative.valueMilli).toBe(200);
  expect(value.summary.quantitative.mean).toBeCloseTo(1.4815, 3);
  expect(value.learning!.participation.percent).toBeGreaterThan(0);
});
it('applies the ordinary precision and maximum diagnostics to 0.1 as to any grade', () => {
  const diagnostics = collectGradebookImportDiagnosticsV1(decimalGradeBatch837({ AA3: { v: 0.05 }, AA5: { v: 0.1 } }));
  expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'above-maximum', cellAddress: 'AA5' })]));
  // BN-DEC-045: the invalid grade and the student's AM are held (unavailable); nothing else changes.
  for (const value of [0.1001, -0.1]) {
    const held = request(decimalGradeBatch837({ R5: { v: value } }));
    if (held.operation !== 'persist-notas') throw new Error('unexpected operation');
    const [, values, am] = held.ofertas[0]!.trimestres[0].alunos[0]!;
    expect(values[0]).toEqual(['u']);
    expect(am).toEqual(['u']);
  }
});
