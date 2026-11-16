// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parallelFixture848, PARALLEL_VERSION_848 } from './parallel-visibility-fixture-848';
import { buildPerformanceAnalysisV3 } from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import { buildPerformanceAnalyticsV6 } from '../../../server/gradebook/application/read-models/performance/performance-analytics-v6';
import { AcademicStudentReaderPostgresV1 } from '../../../server/student-portal/academic/academic-reader-v1';
import { resolveSimplifiedTermV1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';

const terms = [1, 2, 3] as const;
function analysis(fixture: ReturnType<typeof parallelFixture848>, lens: 'quantitative' | 'assessments') {
  return buildPerformanceAnalysisV3(fixture.matrix, fixture.projections, {
    transportVersion: 3, operation: 'analysis', year: 2026, classId: 848001,
    period: fixture.matrix.period, mode: 'regular', statuses: [null], lens,
    offerId: lens === 'assessments' ? 848001 : null,
  });
}

describe('BN-DEC-035: PARA improves Q; it is never an extra assessment', () => {
  it.each(terms)('keeps Q=4, P=7, L=10 equal to 17, never 21, in term %s', (term) => {
    const f = parallelFixture848({ term, parallel: 7000 });
    const outcome = f.projection.terms[term - 1]!;
    expect(outcome).toMatchObject({ quantitativeOriginalMilli: 4000,
      quantitativeConsideredMilli: 7000, qualitativeOperationalMilli: 10000,
      rawMilli: 17000, roundedMilli: 17000, parallelApplicable: true });
    expect(outcome.quantitativeMaximumMilli).toBe(term === 3 ? 18000 : 13500);
    expect(f.cell).toMatchObject({ state: 'complete', valueMilli: 17000 });
    expect(analysis(f, 'quantitative').rows[0]!.values[0]).toMatchObject({ valueMilli: 7000, state: 'complete' });
    const analytics = buildPerformanceAnalyticsV6(f.matrix, f.projections);
    expect(analytics.summary.parallel).toMatchObject({ applicable: 1, applied: 1, meanGainMilli: 3000 });
    expect(analytics.students[0]!.cells[0]!.quantitative).toMatchObject({ valueMilli: 7000, complete: true });
  });

  it.each(terms)('applies the recorded exception independently of either normal threshold in term %s', (term) => {
    const qCutoff = term === 3 ? 10800 : 8100;
    const totalCutoff = term === 3 ? 24000 : 18000;
    for (const [av1, av2, qualitative] of [[qCutoff - 2000, 2000, 1000], [2000, 2000, totalCutoff - 4000]]) {
      const q = av1! + av2!;
      const unrecorded = parallelFixture848({ term, av1, av2, qualitative, parallel: null });
      expect(unrecorded.projection.terms[term - 1]!.parallelApplicable).toBe(false);
      expect(unrecorded.detail.terms[term - 1]!.showParallel).toBe(false);
      for (const parallel of [0, q - 1, q, q + 1]) {
        const f = parallelFixture848({ term, av1, av2, qualitative, parallel });
        const outcome = f.projection.terms[term - 1]!;
        expect(outcome.parallelApplicable).toBe(true);
        expect(outcome.quantitativeOriginalMilli).toBe(q);
        expect(outcome.quantitativeConsideredMilli).toBe(Math.max(q, parallel));
        expect(outcome.rawMilli).toBe(Math.max(q, parallel) + qualitative!);
        expect(outcome.coverage.complete).toBe(true);
        expect(outcome.coverage.resolvedSlots).toContain(3);
        expect(outcome.warnings.map((warning) => warning.code)).not.toContain('parallel-present-when-not-applicable');
        expect(f.detail.terms[term - 1]!.showParallel).toBe(true);
        const assessments = analysis(f, 'assessments');
        const index = assessments.columns.findIndex((column) => column.slot === 3);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(assessments.rows[0]!.values[index]).toMatchObject({ valueMilli: parallel, recordedMilli: parallel, state: 'complete' });
        expect(assessments.rows[0]!.values[index]).not.toHaveProperty('notDone');
        const analytics = buildPerformanceAnalyticsV6(f.matrix, f.projections);
        expect(analytics.components[0]!.instruments.some((item) => item.slot === 3)).toBe(true);
        expect(analytics.summary.parallel.applied).toBe(parallel > q ? 1 : 0);
        expect(analytics.summary.parallel.meanGainMilli).toBe(parallel > q ? parallel - q : null);
      }
    }
  });

  it.each(terms)('keeps strict normal thresholds when no PARA has been recorded in term %s', (term) => {
    const qCutoff = term === 3 ? 10800 : 8100;
    const totalCutoff = term === 3 ? 24000 : 18000;
    for (const delta of [-1, 0, 1]) {
      const q = parallelFixture848({ term, av1: qCutoff - 2000 + delta, av2: 2000, qualitative: 0 });
      expect(q.projection.terms[term - 1]!.parallelApplicable).toBe(delta < 0);
      const total = parallelFixture848({ term, qualitative: totalCutoff - 4000 + delta });
      expect(total.projection.terms[term - 1]!.parallelApplicable).toBe(delta < 0);
    }
  });

  it.each([null, 0, 3000, 4000])('never reduces Q or adds a non-improving PARA of %s', (parallel) => {
    const f = parallelFixture848({ parallel });
    const outcome = f.projection.terms[1]!;
    expect(outcome.quantitativeConsideredMilli).toBe(4000);
    expect(outcome.rawMilli).toBe(14000);
    expect(outcome.coverage.missingSlots).toEqual(parallel === null ? [3] : []);
    expect(f.cell.state).toBe(parallel === null ? 'partial' : 'complete');
  });

  it('does not require either AV and never clears their missing status with a PARA', () => {
    for (const [av1, av2] of [[null, 2000], [2000, null], [null, null]] as const) {
      const f = parallelFixture848({ av1, av2, parallel: 7000 });
      expect(f.projection.terms[1]!).toMatchObject({ parallelApplicable: true,
        quantitativeOriginalMilli: (av1 ?? 0) + (av2 ?? 0), quantitativeConsideredMilli: 7000, rawMilli: 17000 });
      expect(f.cell.state).toBe('partial');
      expect(f.projection.terms[1]!.coverage.missingSlots).not.toContain(3);
    }
  });

  it('reads an empty period as not done and does not invent an absent PARA definition', () => {
    const empty = parallelFixture848({ av1: null, av2: null, qualitative: null });
    expect(empty.cell).toMatchObject({ state: 'partial', valueMilli: 0 });
    const zero = parallelFixture848({ av1: null, av2: null, qualitative: null, parallel: 0 });
    expect(zero.cell).toMatchObject({ state: 'partial', valueMilli: 0 });
    const without = parallelFixture848({ includeParallel: false });
    expect(without.projection.terms[1]!.coverage.requiredSlots).not.toContain(3);
  });

  it.each([null, 0, 5000])('uses only approved Portal edition facts for exceptional PARA %s', (parallel) => {
    const f = parallelFixture848({ qualitative: 14000, parallel });
    const original = structuredClone(f.portalSource);
    const unsafe = vi.fn(async () => { throw new Error('unexpected-current-notes-query'); });
    const reader = new AcademicStudentReaderPostgresV1({ unsafe });
    const result = reader.projectPreparedSourceV2(f.link, PARALLEL_VERSION_848, f.portalSource);
    expect(result).not.toBeNull();
    const period = result!.student.subjects[0]!.periods.find((item) => item.period === 'T2')!;
    expect(period.final).toMatchObject({ kind: 'score', valueMilli: 26000 });
    const item = period.partials!.find((value) => value.assessmentId === 8480203);
    if (parallel === null) expect(item).toBeUndefined();
    else expect(item).toMatchObject({ mark: { kind: 'score', valueMilli: parallel } });
    expect(result!.student.subjects[0]!.officialAnnual).toMatchObject({ valueMilli: 86000 });
    expect(f.portalSource).toEqual(original);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('matches an independent integer reference across normal and exceptional cases', () => {
    let count = 0;
    for (const term of terms) for (const av1 of [null, 0, 100, 4000, 6000])
      for (const av2 of [null, 0, 100, 4000]) for (const qualitative of [null, 0, 10000, 14000, 20000])
        for (const parallel of [null, 0, 100, 4000, 7000, 12000]) {
          const instruments = [
            { slot: 1 as const, maximumMilli: term === 3 ? 9000 : 6750, valueMilli: av1 },
            { slot: 2 as const, maximumMilli: term === 3 ? 9000 : 6750, valueMilli: av2 },
            { slot: 3 as const, maximumMilli: null, valueMilli: parallel },
            { slot: 11 as const, maximumMilli: term === 3 ? 22000 : 16500, valueMilli: qualitative },
          ];
          const before = structuredClone(instruments);
          const q = BigInt(av1 ?? 0) + BigInt(av2 ?? 0);
          const l = BigInt(qualitative ?? 0);
          const eligible = q * 5n < BigInt(term === 3 ? 18000 : 13500) * 3n &&
            (q + l) * 5n < BigInt(term === 3 ? 40000 : 30000) * 3n;
          const considered = parallel !== null && BigInt(parallel) > q ? BigInt(parallel) : q;
          const result = resolveSimplifiedTermV1({ term, instruments });
          expect(result.parallelApplicable).toBe(eligible || parallel !== null);
          expect(result.quantitativeOriginalMilli).toBe(Number(q));
          expect(result.quantitativeConsideredMilli).toBe(Number(considered));
          expect(result.rawMilli).toBe(Number(considered + l));
          expect(result.coverage.missingSlots.includes(3)).toBe(eligible && parallel === null);
          expect(instruments).toEqual(before);
          count++;
        }
    expect(count).toBe(1800);
  });
});
