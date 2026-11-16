// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  isQualitativeColumnOrdinalV1,
  meaningfulQualitativeDescriptionV1,
} from '../../../shared/gradebook-contracts/source/qualitative-slot-evidence-v1';
import {
  compareSourceSubjectPresentationV1,
  SOURCE_SUBJECT_PRESENTATION_V1,
  sourceSubjectAbbreviationV1,
  sourceSubjectPresentationOrderV1,
} from '../../../shared/gradebook-contracts/source/subject-abbreviations-v1';
import { termRecoveryVisibilityV1 } from '../../../src/gradebook-domain/calculations/simplified/term-recovery-visibility-v1';
import { resolveSimplifiedTermV1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';

describe('source evidence, not per-student omission #646', () => {
  it.each([undefined, '', '5', ' 5 ', '5,0', '5.00'])(
    'does not manufacture activity from ordinal %s',
    (description) => {
      expect(meaningfulQualitativeDescriptionV1(15, null, description, false)).toBeUndefined();
    },
  );
  it('preserves a maximum, a zero, an unavailable fact, a meaningful numeric title or another slot number', () => {
    expect(meaningfulQualitativeDescriptionV1(15, 1000, '5', false)).toBe('5');
    expect(meaningfulQualitativeDescriptionV1(15, null, '5', true)).toBe('5');
    expect(meaningfulQualitativeDescriptionV1(15, null, '2026', false)).toBe('2026');
    expect(isQualitativeColumnOrdinalV1(15, '4')).toBe(false);
    expect(isQualitativeColumnOrdinalV1(1, '1')).toBe(false);
  });
  it('uses the inspected catalogue without inventing an abbreviation for an unknown subject', () => {
    expect(sourceSubjectAbbreviationV1(' matemática ')).toBe('M');
    expect(sourceSubjectAbbreviationV1('COMPUTAÇÃO')).toBe('CT');
    expect(sourceSubjectAbbreviationV1('Nova disciplina')).toBeNull();
  });
  it('preserves the inspected teacher-configuration presentation order', () => {
    expect(SOURCE_SUBJECT_PRESENTATION_V1.slice(0, 5)).toEqual([
      ['PORTUGUES', 'P'],
      ['MATEMATICA', 'M'],
      ['HISTORIA', 'H'],
      ['GEOGRAFIA', 'G'],
      ['CIENCIAS', 'C'],
    ]);
    expect(sourceSubjectPresentationOrderV1(' português ')).toBe(0);
    expect(sourceSubjectPresentationOrderV1('Nova disciplina')).toBeNull();
    expect(
      ['CIÊNCIAS', 'HISTÓRIA', 'MATEMÁTICA', 'PORTUGUÊS', 'GEOGRAFIA'].sort(
        compareSourceSubjectPresentationV1,
      ),
    ).toEqual(['PORTUGUÊS', 'MATEMÁTICA', 'HISTÓRIA', 'GEOGRAFIA', 'CIÊNCIAS']);
    expect(
      ['Z COMPONENTE', 'A COMPONENTE', 'PORTUGUÊS'].sort(compareSourceSubjectPresentationV1),
    ).toEqual(['PORTUGUÊS', 'A COMPONENTE', 'Z COMPONENTE']);
  });
  it.each([
    [7000, 10000, true, true, true],
    // BN-DEC-033: 7000 + 11000 reaches the term limit before PARA; final REC remains independent.
    [7000, 11000, false, false, false],
    [8100, 1000, true, false, true],
  ])(
    'keeps parallel and final recovery eligibility independent (%i/%i)',
    (quantitative, qualitative, finalRecoveryApplicable, showParallel, showRecovery) => {
      const term = resolveSimplifiedTermV1({
        term: 1,
        instruments: [
          { slot: 1, maximumMilli: 8500, valueMilli: quantitative },
          { slot: 2, maximumMilli: 5000, valueMilli: 0 },
          { slot: 11, maximumMilli: 16500, valueMilli: qualitative },
        ],
      });
      const original = structuredClone(term);
      expect(termRecoveryVisibilityV1(term, finalRecoveryApplicable)).toEqual({
        showParallel,
        showRecovery,
      });
      expect(term).toEqual(original);
      expect(termRecoveryVisibilityV1(term, null).showRecovery).toBe(false);
    },
  );
  it('does not assert recovery eligibility for a missing definition', () => {
    expect(termRecoveryVisibilityV1(null, true)).toEqual({
      showParallel: false,
      showRecovery: false,
    });
  });
});
