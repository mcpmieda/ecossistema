import { performanceResultCountsV2, performanceResponseSchemaV2, type PerformanceMatrixV2  } from '../../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import {
  performanceTermComparisonRequestSchemaV4, performanceTermComparisonResponseSchemaV4,
  performanceTermComparisonMatchesV4, termComparisonAnalysisRequestV3,
  type PerformanceTermComparisonRequestV4,
  type PerformanceTermComparisonResponseV4,
  type PerformanceTermComparisonValueV4,
} from '../../../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';

import { performanceAnalysisRequestSchemaV3, type AnalysisReadingV3 } from '../../../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import {
  performanceCellV2,
  performanceRecoveryCellIsRelevantV2,
  type PerformanceProjectionV2,
} from '../../results/relational-performance-facts-v2';
import { type GradebookPostgresWritePortV1, type GradebookPostgresTransactionV1  } from '../../../persistence/postgres/postgres-database-v1';

import { buildPerformanceAnalysisV3 } from './performance-analysis-v3';
import { readRelationalPerformanceV2 } from './relational-performance-v2';

function projectReferenceMatrix(
  matrix: PerformanceMatrixV2,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
  period: 1 | 2,
): PerformanceMatrixV2 {
  const rows = matrix.rows.map((row) => {
    const byOffer = new Map((projections.get(row.student.id) ?? []).map((projection) => [projection.offerId, projection]));
    return { ...row, cells: matrix.offers.map((offer) => performanceCellV2(byOffer.get(offer.id)!, period, matrix.mode)) };
  });
  const eligible = rows.filter((row) => row.student.indicatorEligible);
  const consideredCells = eligible.flatMap((row) => row.cells).filter((cell) =>
    matrix.mode === 'regular' || performanceRecoveryCellIsRelevantV2(cell));
  return performanceResponseSchemaV2.parse({
    ...matrix, period, rows,
    statistics: {
      classRows: matrix.statistics.classRows, visibleRows: rows.length, eligibleRows: eligible.length,
      recoveryUnknownRows: rows.filter((row) => row.student.indicatorEligible && row.cells.some((cell) => cell.recoveryApplicable === null)).length,
      consideredCells: consideredCells.length, completeCells: consideredCells.filter((cell) => cell.state === 'complete').length,
      noShowCells: consideredCells.filter((cell) => cell.state === 'no-show').length,
      incompleteCells: consideredCells.filter((cell) => cell.state !== 'complete' && cell.state !== 'no-show' && cell.state !== 'repeat-failure').length,
      attentionRows: eligible.filter((row) => row.cells.some((cell) => cell.level === 'below')).length,
    },
  }) as PerformanceMatrixV2;
}

export function buildPerformanceTermComparisonV4(matrix: PerformanceMatrixV2,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>, request: PerformanceTermComparisonRequestV4,
): Extract<PerformanceTermComparisonResponseV4, { state: 'ready' }> {
  const currentRequest = termComparisonAnalysisRequestV3(request);
  const current = buildPerformanceAnalysisV3(matrix, projections, currentRequest);
  const referenceMatrix = projectReferenceMatrix(matrix, projections, request.referencePeriod);
  const referenceRequest = performanceAnalysisRequestSchemaV3.parse({ ...currentRequest, period: request.referencePeriod });
  const reference = buildPerformanceAnalysisV3(referenceMatrix, projections, referenceRequest);
  const rows = current.rows.map((row, rowIndex) => ({ studentId: row.studentId,
    values: row.values.map((value, columnIndex) => compare(value, reference.rows[rowIndex]!.values[columnIndex]!)) }));
  const columns = current.columns.map((column, columnIndex) => {
    const groups = { higher: [] as number[], equal: [] as number[], lower: [] as number[], unavailable: [] as number[] };
    for (const row of rows) {
      const value = row.values[columnIndex]!;
      if (value.state === 'unavailable') groups.unavailable.push(row.studentId); else groups[value.relation].push(row.studentId);
    }
    return { key: column.key, offerId: column.offerId, label: column.label,
      summary: { comparable: groups.higher.length + groups.equal.length + groups.lower.length, unavailable: groups.unavailable.length, groups } };
  });
  return performanceTermComparisonResponseSchemaV4.options[0].parse({ transportVersion: 4, operation: 'term-comparison', state: 'ready',
    authority: 'descriptive-observation', basis: 'percentage-points-of-official-maximum', referencePeriod: request.referencePeriod,
    analysis: current, columns, rows });
}

function unavailable(current: AnalysisReadingV3, reference: AnalysisReadingV3): PerformanceTermComparisonValueV4 {
  const reason = current.bucket === 'excluded' ? 'current-excluded' : reference.bucket === 'excluded' ? 'reference-excluded' :
    !performanceResultCountsV2(current.state) ? 'current-incomplete' : !performanceResultCountsV2(reference.state) ? 'reference-incomplete' :
    current.maximumMilli === null || current.maximumMilli <= 0 ? 'current-no-positive-maximum' : 'reference-no-positive-maximum';
  return { key: current.key, state: 'unavailable', currentPercent: current.percent, referencePercent: reference.percent,
    deltaPercentagePoints: null, relation: null, reason };
}

function compare(current: AnalysisReadingV3, reference: AnalysisReadingV3): PerformanceTermComparisonValueV4 {
  if (current.bucket === 'excluded' || reference.bucket === 'excluded' || !performanceResultCountsV2(current.state) || !performanceResultCountsV2(reference.state) ||
      current.valueMilli === null || reference.valueMilli === null || current.maximumMilli === null || reference.maximumMilli === null ||
      current.maximumMilli <= 0 || reference.maximumMilli <= 0 || current.percent === null || reference.percent === null) return unavailable(current, reference);
  const left = BigInt(current.valueMilli) * BigInt(reference.maximumMilli);
  const right = BigInt(reference.valueMilli) * BigInt(current.maximumMilli);
  const relation = left === right ? 'equal' : left > right ? 'higher' : 'lower';
  return { key: current.key, state: 'comparable', currentPercent: current.percent, referencePercent: reference.percent,
    deltaPercentagePoints: relation === 'equal' ? 0 : current.percent - reference.percent, relation, reason: null };
}

export function createPerformanceTermComparisonV4(database: GradebookPostgresWritePortV1) {
  return { async execute(input: unknown): Promise<PerformanceTermComparisonResponseV4> {
    const parsed = performanceTermComparisonRequestSchemaV4.safeParse(input);
    if (!parsed.success) return { transportVersion: 4, state: 'invalid-request' };
    if (!('transaction' in database) || typeof database.transaction !== 'function') return { transportVersion: 4, state: 'unavailable' };
    const request = parsed.data;
    const db = database as GradebookPostgresWritePortV1 & { transaction<T>(operation: (tx: GradebookPostgresTransactionV1) => Promise<T>): Promise<T> };
    return db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
      let projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]> = new Map();
      const matrix = await readRelationalPerformanceV2(tx, {
        transportVersion: 2, operation: 'matrix', year: request.year, classId: request.classId,
        period: request.period, mode: request.mode, statuses: request.statuses,
      }, { collect: (value) => { projections = value; } });
      if (matrix.state !== 'ready') return { transportVersion: 4, state: matrix.state } as const;
      if (matrix.operation !== 'matrix') throw new Error('unexpected-term-comparison-operation');
      const response = buildPerformanceTermComparisonV4(matrix, projections, request);
      if (!performanceTermComparisonMatchesV4(request, response)) throw new Error('inconsistent-term-comparison-response');
      return response;
    });
  } };
}
