// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  resolveSimplifiedTermV1,
  type SimplifiedAcademicTermV1,
  type SimplifiedInstrumentFactV1,
} from '../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';

// Synthetic vectors only; no student, class, offer or production mark fixtures.
function facts(
  term: SimplifiedAcademicTermV1,
  av1: number | null,
  av2: number | null,
  parallel: number | null,
  qualitative: number | null,
): SimplifiedInstrumentFactV1[] {
  return [
    { slot: 1, maximumMilli: term === 3 ? 13000 : 8500, valueMilli: av1 },
    { slot: 2, maximumMilli: 5000, valueMilli: av2 },
    { slot: 3, maximumMilli: null, valueMilli: parallel },
    { slot: 11, maximumMilli: term === 3 ? 22000 : 16500, valueMilli: qualitative },
  ];
}
function calculate(
  term: SimplifiedAcademicTermV1,
  av1: number | null,
  av2: number | null,
  parallel: number | null,
  qualitative: number | null,
) {
  return resolveSimplifiedTermV1({
    term,
    instruments: facts(term, av1, av2, parallel, qualitative),
  });
}

describe('parallel recovery, corrected by BN-DEC-035', () => {
  it.each([1, 2, 3] as const)('does not require either assessment in term %s', (term) => {
    for (const [av1, av2] of [
      [null, 200],
      [200, null],
      [null, null],
    ] as const) {
      const instruments = facts(term, av1, av2, 7000, 12000);
      const before = structuredClone(instruments);
      const result = resolveSimplifiedTermV1({ term, instruments });
      expect(result.parallelApplicable).toBe(true);
      expect(result.quantitativeOriginalMilli).toBe((av1 ?? 0) + (av2 ?? 0));
      expect(result.quantitativeConsideredMilli).toBe(7000);
      expect(result.rawMilli).toBe(19000);
      expect(result.coverage.complete).toBe(true);
      expect(result.coverage.reasons).not.toContain('parallel-applicability-unresolved');
      expect(instruments).toEqual(before);
    }
  });

  it.each([1, 2, 3] as const)(
    'uses strict institutional quantitative limits in term %s',
    (term) => {
      const cutoff = term === 3 ? 10800 : 8100;
      expect(calculate(term, cutoff - 1, 0, null, 0).parallelApplicable).toBe(true);
      for (const value of [cutoff, cutoff + 1]) {
        const result = calculate(term, value, 0, null, 0);
        expect(result.parallelApplicable).toBe(false);
        expect(result.rawMilli).toBe(value);
        const recorded = calculate(term, value, 0, 12000, 0);
        expect(recorded.parallelApplicable).toBe(true);
        expect(recorded.rawMilli).toBe(12000);
      }
    },
  );

  it.each([1, 2, 3] as const)(
    'dispenses with an unrecorded PARA at the unrounded term limit in term %s',
    (term) => {
      const cutoff = term === 3 ? 24000 : 18000;
      const below = calculate(term, 2000, null, 8000, cutoff - 2001);
      expect(below.parallelApplicable).toBe(true);
      expect(below.rawMilli).toBe(cutoff - 2001 + 8000);
      expect(calculate(term, 2000, null, null, cutoff - 2001).parallelApplicable).toBe(true);
      for (const value of [cutoff, cutoff + 1]) {
        const result = calculate(term, 2000, null, null, value - 2000);
        expect(result.parallelApplicable).toBe(false);
        expect(result.quantitativeConsideredMilli).toBe(2000);
        expect(result.rawMilli).toBe(value);
        const recorded = calculate(term, 2000, null, 8000, value - 2000);
        expect(recorded.parallelApplicable).toBe(true);
        expect(recorded.rawMilli).toBe(value - 2000 + 8000);
        expect(recorded.warnings.map((warning) => warning.code)).not.toContain(
          'parallel-present-when-not-applicable',
        );
      }
    },
  );

  it('uses a superior PARA instead of Q while preserving original quantitative evidence', () => {
    const result = calculate(2, 200, null, 7000, 12000);
    expect(result.parallelApplicable).toBe(true);
    expect(result.quantitativeOriginalMilli).toBe(200);
    expect(result.quantitativeConsideredMilli).toBe(7000);
    expect(result.rawMilli).toBe(19000);
    expect(result.roundedMilli).toBe(19000);
  });

  it.each([null, 0, 2999, 3000])('keeps the normal sum when PARA is %s', (parallel) => {
    const result = calculate(1, 2000, 1000, parallel, 9000);
    expect(result.parallelApplicable).toBe(true);
    expect(result.quantitativeConsideredMilli).toBe(3000);
    expect(result.rawMilli).toBe(12000);
  });

  it('uses PARA only when strictly greater than AV1 plus AV2', () => {
    const result = calculate(1, 2000, 1000, 3001, 9000);
    expect(result.quantitativeConsideredMilli).toBe(3001);
    expect(result.rawMilli).toBe(12001);
  });

  it('does not test eligibility against a total that already includes PARA', () => {
    const result = calculate(1, 4000, 2000, 8000, 11000);
    expect(result.parallelApplicable).toBe(true);
    expect(result.rawMilli).toBe(19000);
    expect(calculate(1, 4000, 2000, null, 11000).parallelApplicable).toBe(true);
  });

  it('preserves different coverage for absent marks and recorded zero', () => {
    const absent = calculate(2, null, null, 7000, 12000);
    const zeros = calculate(2, 0, 0, 7000, 12000);
    expect(absent.rawMilli).toBe(zeros.rawMilli);
    expect(absent.parallelApplicable).toBe(zeros.parallelApplicable);
    expect(absent.coverage.missingSlots).toEqual([1, 2]);
    expect(zeros.coverage.complete).toBe(true);
  });

  it('counts an eligible PARA even when no regular mark exists', () => {
    const result = calculate(3, null, null, 7000, null);
    expect(result.parallelApplicable).toBe(true);
    expect(result.rawMilli).toBe(7000);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.resolvedSlots).toEqual([3]);
    const empty = calculate(3, null, null, null, null);
    expect(empty.parallelApplicable).toBe(true);
    expect(empty.rawMilli).toBe(0);
    expect(empty.coverage.resolvedSlots).toEqual([]);
  });

  it('does not substitute malformed configured maxima for institutional limits', () => {
    const instruments = facts(1, 7000, 0, null, 0).map((fact) =>
      fact.slot === 1 || fact.slot === 2 ? { ...fact, maximumMilli: 5000 } : fact,
    );
    const result = resolveSimplifiedTermV1({ term: 1, instruments });
    expect(result.parallelApplicable).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'quantitative-maximum-mismatch',
    );
  });

  it('still refuses missing structural assessment definitions', () => {
    expect(() => resolveSimplifiedTermV1({ term: 1, instruments: [] })).toThrow(/AV1 and AV2/);
  });
});
