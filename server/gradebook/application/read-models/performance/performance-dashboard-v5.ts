import {
  dashboardAnalysisRequestV3,
  performanceDashboardMatchesV5,
  performanceDashboardRequestSchemaV5,
  performanceDashboardResponseSchemaV5,
  type PerformanceDashboardResponseV5,
  type PerformanceDashboardV5,
} from '../../../../../shared/gradebook-contracts/performance/performance-dashboard-v5';
import { performanceTermComparisonRequestSchemaV4 } from '../../../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';
import type { PerformanceAnalysisV3 } from '../../../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import type { PerformanceProjectionV2 } from '../../results/relational-performance-facts-v2';
import { type GradebookPostgresWritePortV1, type GradebookPostgresTransactionV1  } from '../../../persistence/postgres/postgres-database-v1';

import { buildPerformanceAnalysisV3 } from './performance-analysis-v3';
import { buildPerformanceTermComparisonV4 } from './performance-term-comparison-v4';
import { readRelationalPerformanceV2 } from './relational-performance-v2';

export function buildPerformanceDashboardOverviewV5(
  analysis: PerformanceAnalysisV3,
): PerformanceDashboardV5['overview'] {
  const eligibleIds = analysis.matrix.rows
    .filter((row) => row.student.indicatorEligible)
    .map((row) => row.student.id);
  const groups = {
    allAtOrAbove: [] as number[],
    withBelow: [] as number[],
    pending: [] as number[],
  };
  const rows = new Map(analysis.rows.map((row) => [row.studentId, row]));
  for (const studentId of eligibleIds) {
    const row = rows.get(studentId);
    const buckets = row?.values.map((value) => value.bucket) ?? [];
    // A UI test reads this exact comparison in the source.
    if (buckets.some((bucket) => bucket === 'below')) groups.withBelow.push(studentId); // NOSONAR
    else if (buckets.length > 0 && buckets.every((bucket) => bucket === 'above')) {
      groups.allAtOrAbove.push(studentId);
    } else groups.pending.push(studentId);
  }
  const ranking = analysis.matrix.rows
    .filter((row) =>
      row.student.indicatorEligible &&
      row.cells.length > 0 &&
      row.cells.every((cell) => cell.valueMilli !== null),
    )
    .map((row) => {
      const total = row.cells.reduce((sum, cell) => sum + BigInt(cell.valueMilli!), 0n);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('performance-ranking-overflow');
      return {
        studentId: row.student.id,
        totalMilli: Number(total),
        partial: row.cells.some((cell) => cell.state === 'partial'),
        number: row.student.number,
      };
    })
    .sort((left, right) => right.totalMilli - left.totalMilli || left.number - right.number || left.studentId - right.studentId)
    .slice(0, 10)
    .map((entry) => ({ studentId: entry.studentId, totalMilli: entry.totalMilli, partial: entry.partial }));
  return {
    denominator: 'eligible-students-in-current-scope',
    students: {
      eligible: eligibleIds.length,
      classified: groups.allAtOrAbove.length + groups.withBelow.length,
      allAtOrAbove: groups.allAtOrAbove.length,
      withBelow: groups.withBelow.length,
      pending: groups.pending.length,
    },
    groups,
    ranking,
    columns: analysis.columns.map((column) => ({
      key: column.key,
      offerId: column.offerId,
      label: column.label,
      considered: column.summary.considered,
      atOrAbove: column.summary.groups.above.length,
      below: column.summary.groups.below.length,
      incomplete: column.summary.groups.incomplete.length,
      noShow: column.summary.groups['no-show'].length,
      unscaled: column.summary.groups.unscaled.length,
    })),
  };
}

export function createPerformanceDashboardV5(database: GradebookPostgresWritePortV1) {
  return {
    async execute(input: unknown): Promise<PerformanceDashboardResponseV5> {
      const parsed = performanceDashboardRequestSchemaV5.safeParse(input);
      if (!parsed.success) return { transportVersion: 5, state: 'invalid-request' };
      if (!('transaction' in database) || typeof database.transaction !== 'function') {
        return { transportVersion: 5, state: 'unavailable' };
      }
      const request = parsed.data;
      const db = database as GradebookPostgresWritePortV1 & {
        transaction<T>(operation: (tx: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
      };
      return db.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
        let projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]> = new Map();
        const matrix = await readRelationalPerformanceV2(
          tx,
          {
            transportVersion: 2,
            operation: 'matrix',
            year: request.year,
            classId: request.classId,
            period: request.period,
            mode: request.mode,
            statuses: request.statuses,
          },
          {
            ...(request.offerId === null ? {} : { descriptionOfferId: request.offerId }),
            collect: (value) => {
              projections = value;
            },
          },
        );
        if (matrix.state !== 'ready') return { transportVersion: 5, state: matrix.state } as const;
        if (matrix.operation !== 'matrix') throw new Error('unexpected-dashboard-operation');
        if (
          request.offerId !== null &&
          !matrix.offers.some((offer) => offer.id === request.offerId)
        ) {
          return { transportVersion: 5, state: 'not-found' } as const;
        }
        const view =
          request.referencePeriod === null
            ? buildPerformanceAnalysisV3(
                matrix,
                projections,
                dashboardAnalysisRequestV3(request),
              )
            : buildPerformanceTermComparisonV4(
                matrix,
                projections,
                performanceTermComparisonRequestSchemaV4.parse({
                  transportVersion: 4,
                  operation: 'term-comparison',
                  year: request.year,
                  classId: request.classId,
                  period: request.period,
                  mode: request.mode,
                  statuses: request.statuses,
                  lens: request.lens,
                  offerId: null,
                  referencePeriod: request.referencePeriod,
                }),
              );
        const analysis = view.operation === 'term-comparison' ? view.analysis : view;
        const response = performanceDashboardResponseSchemaV5.parse({
          transportVersion: 5,
          operation: 'dashboard',
          state: 'ready',
          view,
          overview: buildPerformanceDashboardOverviewV5(analysis),
        });
        if (!performanceDashboardMatchesV5(request, response)) {
          throw new Error('inconsistent-dashboard-response');
        }
        return response;
      });
    },
  };
}
