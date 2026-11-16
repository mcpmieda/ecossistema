import { performanceAnalyticsFixtureV6 } from './performance-analytics-fixture-v6';
import { buildPerformanceAnalyticsV6 } from '../../../server/gradebook/application/read-models/performance/performance-analytics-v6';
import {
  projectPerformanceFactsV2,
  performanceCellV2,
  EMPTY_PERFORMANCE_CLOSING_V2,
  type PerformanceFactV2,
} from '../../../server/gradebook/application/results/relational-performance-facts-v2';
import type {
  PerformanceMatrixV2,
  PerformancePeriodV2,
} from '../../../shared/gradebook-contracts/performance/relational-performance-v2';

/** Synthetic evidence only; names, rates and identities are invented. */
export function learningFixtureV1(
  options: {
    period?: PerformancePeriodV2;
    studentCount?: number;
    componentCount?: number;
    override?: (
      fact: PerformanceFactV2,
      student: number,
      component: number,
    ) => Partial<PerformanceFactV2>;
  } = {},
) {
  const period = options.period ?? 2;
  const base = performanceAnalyticsFixtureV6({
    period,
    studentCount: options.studentCount ?? 4,
    componentCount: options.componentCount ?? 3,
  });
  const offers = base.components.map((item) => item.offer);
  const projections = new Map(
    base.students.map((student, index) => [
      student.student.id,
      offers.map((offer, component) => {
        const facts: PerformanceFactV2[] = ([1, 2, 3] as const).flatMap((term) =>
          ([1, 2, 3, 11, 12, 13] as const).map((slot) => {
            const scale = term === 3 ? 4 / 3 : 1;
            const maximumMilli =
              slot === 3
                ? null
                : Math.round(
                    (slot <= 2 ? 6750 : slot === 11 ? 3000 : slot === 12 ? 6000 : 7500) * scale,
                  );
            const rate =
              index === 0
                ? term === 1
                  ? 0.45
                  : 0.35
                : index === 1
                  ? term === 1
                    ? 0.55
                    : 0.8
                  : term === 1
                    ? 0.9
                    : 0.8;
            const participationRate = term === 1 ? 0.6 : 0.8;
            const fact: PerformanceFactV2 = {
              slot,
              term,
              maximumMilli,
              label:
                slot <= 2
                  ? `Avaliação ${slot}`
                  : slot === 3
                    ? 'Paralela'
                    : slot === 11
                      ? 'PART 1'
                      : slot === 12
                        ? 'PARTICIPAÇÃO II'
                        : 'Trabalho livre',
              // Completed learning examples have an explicit PARA zero, not an unresolved blank.
              // Empty students/terms remain empty; overrides can exercise missing eligible PARA.
              valueMilli:
                index === 3 || term === 3
                  ? null
                  : slot === 3
                    ? 0
                    : maximumMilli === null
                      ? null
                      : Math.round(
                          maximumMilli * (slot === 11 || slot === 12 ? participationRate : rate),
                        ),
              observed: true,
            };
            return { ...fact, ...options.override?.(fact, index, component) };
          }),
        );
        return projectPerformanceFactsV2(
          offer.id,
          facts,
          EMPTY_PERFORMANCE_CLOSING_V2,
          base.context.minimumApprovalMilli,
        );
      }),
    ]),
  );
  const rows: PerformanceMatrixV2['rows'] = base.students.map((student) => ({
    student: student.student,
    calculatedAnnual: student.annualResult,
    formalCouncilDecision: student.councilDecision,
    cells: projections
      .get(student.student.id)!
      .map((projection) => performanceCellV2(projection, period, 'regular')),
  }));
  const matrix: PerformanceMatrixV2 = {
    transportVersion: 2,
    operation: 'matrix',
    state: 'ready',
    authority: 'calculated-preview',
    context: base.context,
    classGroup: base.classGroup,
    readAt: base.readAt,
    period,
    mode: 'regular',
    offers,
    rows,
    statistics: {
      classRows: rows.length,
      visibleRows: rows.length,
      eligibleRows: rows.length,
      recoveryUnknownRows: 0,
      consideredCells: rows.length * offers.length,
      completeCells: rows.flatMap((row) => row.cells).filter((cell) => cell.state === 'complete')
        .length,
      noShowCells: 0,
      incompleteCells: rows.flatMap((row) => row.cells).filter((cell) => cell.state !== 'complete')
        .length,
      attentionRows: 0,
    },
    comparison: { available: false, reason: 'comparability-not-contracted' },
  };
  return { value: buildPerformanceAnalyticsV6(matrix, projections), matrix, projections };
}
