// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { performanceCellV2 } from '../../../server/gradebook/application/results/relational-performance-facts-v2';
import { buildPerformanceAnalysisV3 } from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import { buildPerformanceAnalyticsV6 } from '../../../server/gradebook/application/read-models/performance/performance-analytics-v6';
import { performanceAnalyticsResponseSchemaV6 } from '../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import { performanceAnalysisResponseSchemaV3 } from '../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import { parallelFixture848 } from './parallel-visibility-fixture-848';

describe('applicable parallel coverage with BN-DEC-035 numeric exception', () => {
  it.each([1, 2, 3] as const)('marks a missing eligible PARA partial in trimester %s', (term) => {
    for (const observed of [true, false]) {
      const fixture = parallelFixture848({ term, observed });
      const outcome = fixture.projection.terms[term - 1]!;
      expect(outcome.parallelApplicable).toBe(true);
      expect(outcome.coverage).toMatchObject({
        complete: true,
        requiredSlots: [1, 2, 3, 11],
        resolvedSlots: [1, 2, 11],
        missingSlots: [3],
        reasons: ['missing-slot:3'],
      });
      expect(outcome.rawMilli).toBe(14000);
      expect(fixture.cell).toMatchObject({ state: 'partial', valueMilli: 14000 });
      expect(
        fixture.detail.terms[term - 1]!.instruments.find((fact) => fact.slot === 3)?.notDone,
      ).toBe(observed ? true : undefined);
    }
  });

  it.each([0, 3000, 4000, 5000])(
    'resolves an eligible PARA value of %s, including zero and no gain',
    (parallel) => {
      const fixture = parallelFixture848({ parallel });
      const outcome = fixture.projection.terms[1]!;
      expect(outcome.parallelApplicable).toBe(true);
      expect(outcome.coverage).toMatchObject({
        complete: true,
        missingSlots: [],
        resolvedSlots: [1, 2, 3, 11],
      });
      expect(outcome.rawMilli).toBe(Math.max(4000, parallel) + 10000);
      expect(fixture.cell.state).toBe('complete');
    },
  );

  it.each([1, 2, 3] as const)(
    'uses a recorded exception after either exact exemption limit in trimester %s',
    (term) => {
      const quantitativeCutoff = term === 3 ? 10800 : 8100;
      const termCutoff = term === 3 ? 24000 : 18000;
      for (const parallel of [null, 0, 5000, 15000]) {
        for (const options of [
          { av1: quantitativeCutoff - 2000, qualitative: 1000 },
          { av1: 2000, qualitative: termCutoff - 4000 },
        ]) {
          const fixture = parallelFixture848({ term, parallel, ...options });
          const outcome = fixture.projection.terms[term - 1]!;
          expect(outcome.parallelApplicable).toBe(parallel !== null);
          expect(outcome.parallelMilli).toBe(parallel);
          expect(outcome.coverage).toMatchObject({
            complete: true,
            requiredSlots: parallel === null ? [1, 2, 11] : [1, 2, 3, 11],
            missingSlots: [],
          });
          expect(outcome.rawMilli).toBe(
            Math.max(options.av1 + 2000, parallel ?? 0) + options.qualitative,
          );
          expect(fixture.cell.state).toBe('complete');
          expect(fixture.detail.terms[term - 1]!.showParallel).toBe(parallel !== null);
        }
      }
    },
  );

  it('removes only the PARA pending flag, not another missing assessment', () => {
    const pending = parallelFixture848({ av2: null });
    expect(pending.projection.terms[1]!.coverage.missingSlots).toEqual([2, 3]);
    const scoredZero = parallelFixture848({ av2: null, parallel: 0 });
    expect(scoredZero.projection.terms[1]!.coverage.missingSlots).toEqual([2]);
    expect(scoredZero.cell.state).toBe('partial');
    const exempt = parallelFixture848({ av2: null, qualitative: 16000 });
    expect(exempt.projection.terms[1]!.parallelApplicable).toBe(false);
    expect(exempt.projection.terms[1]!.coverage.missingSlots).toEqual([2]);
    expect(exempt.cell.state).toBe('partial');
  });

  it('keeps a parallel-only zero visible and reads an entirely empty period as not done', () => {
    const zero = parallelFixture848({ av1: null, av2: null, qualitative: null, parallel: 0 });
    expect(zero.projection.terms[1]!.coverage.resolvedSlots).toEqual([3]);
    expect(zero.cell).toMatchObject({ state: 'partial', valueMilli: 0 });
    const empty = parallelFixture848({ av1: null, av2: null, qualitative: null });
    expect(empty.cell).toMatchObject({ state: 'partial', valueMilli: 0 });
  });

  it('compares a result with a blank instrument with the imported AM, like the projection does', () => {
    const { projection } = parallelFixture848();
    const withAm = (am: number | null) =>
      ({
        ...projection,
        closing: {
          ...projection.closing,
          am: projection.closing.am.map((value, index) => (index === 1 ? am : value)),
        },
      }) as unknown as typeof projection;
    expect(performanceCellV2(withAm(9000), 2, 'regular')).toMatchObject({
      state: 'partial',
      valueMilli: 14000,
      sourceReferenceMilli: 9000,
      sourceComparison: 'mismatch',
    });
    expect(performanceCellV2(withAm(14000), 2, 'regular')).toMatchObject({
      state: 'partial',
      sourceComparison: 'match',
    });
    // No imported AM: nothing to compare with.
    expect(performanceCellV2(withAm(null), 2, 'regular')).toMatchObject({
      state: 'partial',
      sourceReferenceMilli: null,
      sourceComparison: 'unavailable',
    });
  });

  it('does not fabricate an unconfigured instrument and propagates coverage to the annual result', () => {
    const unconfigured = parallelFixture848({ includeParallel: false });
    expect(unconfigured.projection.terms[1]!.coverage.requiredSlots).toEqual([1, 2, 11]);
    expect(unconfigured.cell.state).toBe('complete');
    expect(performanceCellV2(parallelFixture848().projection, 'annual', 'regular').state).toBe(
      'partial',
    );
    expect(
      performanceCellV2(parallelFixture848({ parallel: 0 }).projection, 'annual', 'regular').state,
    ).toBe('complete');
  });

  it.each([null, 0, 5000])(
    'keeps aggregate, considered quantitative and annual consumers coherent (PARA=%s)',
    (parallel) => {
      const { matrix, projections } = parallelFixture848({ parallel });
      const analytics = buildPerformanceAnalyticsV6(matrix, projections);
      expect(performanceAnalyticsResponseSchemaV6.safeParse(analytics).success).toBe(true);
      const complete = parallel !== null;
      expect(analytics.students[0]!.cells[0]!.result.state).toBe(complete ? 'complete' : 'partial');
      expect(analytics.students[0]!.cells[0]!.quantitative.complete).toBe(true);
      expect(analytics.students[0]!.cells[0]!.qualitative.complete).toBe(true);
      expect(analytics.summary.coverage).toMatchObject({
        expected: 4,
        recorded: complete ? 4 : 3,
        missing: complete ? 0 : 1,
        zeros: parallel === 0 ? 1 : 0,
      });
      expect(analytics.summary.partial).toBe(0);
      expect(analytics.summary.movement.n).toBe(1);
      expect(analytics.teachers[0]!.students[0]!.partial).toBe(complete ? 0 : 1);
      expect(
        analytics.components[0]!.instruments.find((item) => item.slot === 3)?.coverage,
      ).toMatchObject({ expected: 1, recorded: complete ? 1 : 0, missing: complete ? 0 : 1 });
    },
  );

  it('omits only an unrecorded dispensed PARA and counts numeric exceptions as resolved', () => {
    for (const parallel of [null, 0, 5000]) {
      const { matrix, projections } = parallelFixture848({ parallel, qualitative: 14000 });
      const result = buildPerformanceAnalyticsV6(matrix, projections);
      const expected = parallel === null ? 3 : 4;
      expect(result.summary.coverage).toMatchObject({
        expected,
        recorded: expected,
        missing: 0,
        zeros: parallel === 0 ? 1 : 0,
      });
      expect(result.summary.partial).toBe(0);
      expect(result.components[0]!.instruments.some((item) => item.slot === 3)).toBe(
        parallel !== null,
      );
    }
  });

  it.each([null, 0, 5000])(
    'respects the numeric exception in a shared assessment column (%s)',
    (parallel) => {
      const eligible = parallelFixture848({ studentId: 848001, parallel: 0 });
      const exempt = parallelFixture848({ studentId: 848002, parallel, qualitative: 14000 });
      const matrix = {
        ...eligible.matrix,
        rows: [...eligible.matrix.rows, ...exempt.matrix.rows],
        statistics: {
          ...eligible.matrix.statistics,
          classRows: 2,
          visibleRows: 2,
          eligibleRows: 2,
          consideredCells: 2,
          completeCells: 2,
          incompleteCells: 0,
        },
      };
      const projections = new Map([...eligible.projections, ...exempt.projections]);
      const request = {
        transportVersion: 3 as const,
        operation: 'analysis' as const,
        year: 2026,
        classId: 848001,
        period: 2 as const,
        mode: 'regular' as const,
        statuses: [null],
        lens: 'assessments' as const,
        offerId: 848001,
      };
      const result = buildPerformanceAnalysisV3(matrix, projections, request);
      expect(performanceAnalysisResponseSchemaV3.safeParse(result).success).toBe(true);
      const index = result.columns.findIndex((column) => column.slot === 3);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(result.rows[0]!.values[index]).toMatchObject({
        valueMilli: 0,
        recordedMilli: 0,
        state: 'complete',
      });
      expect(result.rows[1]!.values[index]).toMatchObject({
        valueMilli: parallel,
        recordedMilli: parallel,
        state: parallel === null ? 'not-applicable' : 'complete',
        bucket: parallel === null ? 'excluded' : 'below',
      });
      expect(result.rows[1]!.values[index]).not.toHaveProperty('notDone');
      expect(result.columns[index]!.summary.considered).toBe(parallel === null ? 1 : 2);
      // An out-of-scope eligible student does not keep a column, but an in-scope numeric exception does.
      const filtered = buildPerformanceAnalysisV3(exempt.matrix, projections, request);
      expect(filtered.columns.some((column) => column.slot === 3)).toBe(parallel !== null);
    },
  );
});
