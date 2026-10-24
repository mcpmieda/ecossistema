import { performanceResultCountsV2,
  type PerformanceMatrixV2,
  type PerformancePeriodV2 } from '../../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import {
  performanceAnalyticsRequestSchemaV6,
  performanceAnalyticsResponseSchemaV6,
  type PerformanceAnalyticsV6,
  type PerformanceAnalyticsRequestV6,
  type PerformanceAnalyticsResponseV6,
  type PerformanceAnalyticsSummaryV6,
  type PerformanceAnalyticsStatsV6,
} from '../../../../../shared/gradebook-contracts/performance/performance-analytics-v6';

import type { AnalysisReadingV3 } from '../../../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import { SIMPLIFIED_TERM_MAXIMUM_MILLI_V1 } from '../../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import {
  performanceCellV2,
  type PerformanceProjectionV2,
} from '../../results/relational-performance-facts-v2';
import { type GradebookPostgresWritePortV1, type GradebookPostgresTransactionV1  } from '../../../persistence/postgres/postgres-database-v1';

import { buildPerformanceAnalysisV3 } from './performance-analysis-v3';
import { readRelationalPerformanceV2 } from './relational-performance-v2';
import { buildPerformanceLearningV1 } from './performance-learning-v1';

const TERMS = [1, 2, 3] as const;
const ANNUAL_MAXIMUM = TERMS.reduce((sum, term) => sum + SIMPLIFIED_TERM_MAXIMUM_MILLI_V1[term], 0);
const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null;
const ratio = (value: number | null, maximum: number | null) =>
  value !== null && maximum !== null && maximum > 0 ? (value / maximum) * 100 : null;
/** The trimester before (T2 → T1, T3 → T2); none for T1 or the year. */
function previousTermV6(period: unknown) {
  if (period === 2) return 1;
  return period === 3 ? 2 : null;
}

function signOfV6(comparison: bigint) {
  if (comparison > 0n) return 1;
  return comparison < 0n ? -1 : 0;
}

/** Descriptive statistics only; no academic result is created here. Population deviation, not sample deviation. */
export function analyticsStatsV6(values: readonly number[]): PerformanceAnalyticsStatsV6 {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  const average = mean(values);
  if (average === null)
    return { n: 0, mean: null, median: null, deviation: null, min: null, max: null };
  const mid = Math.floor(n / 2);
  return {
    n,
    mean: average,
    median: n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    deviation: Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2 / n, 0)),
    min: sorted[0]!,
    max: sorted[n - 1]!,
  };
}
function coverage(
  expected: number,
  recorded: number,
  zeros: number,
): PerformanceAnalyticsSummaryV6['coverage'] {
  return {
    expected,
    recorded,
    zeros,
    missing: expected - recorded,
    percent: expected ? (recorded / expected) * 100 : null,
  };
}
type Cell = PerformanceAnalyticsV6['students'][number]['cells'][number];
type Pair = {
  studentId: number;
  projection: PerformanceProjectionV2;
  cell: Cell;
  timeline: readonly (number | null)[];
  direction: -1 | 0 | 1 | null;
};
const numeric = (values: readonly (number | null)[]): number[] =>
  values.filter((value): value is number => value !== null);
function dimensions(reading: AnalysisReadingV3): Cell['quantitative'] {
  return {
    valueMilli: reading.valueMilli,
    maximumMilli: reading.maximumMilli,
    percent: performanceResultCountsV2(reading.state) ? reading.percent : null,
    complete: performanceResultCountsV2(reading.state),
  };
}
function recoveryState(
  projection: PerformanceProjectionV2,
  period: PerformancePeriodV2,
): Cell['recoveryState'] {
  const cell = performanceCellV2(projection, period, 'recovery');
  if (cell.state === 'complete') {
    return 'complete';
  }
  if (cell.state === 'recovery-pending') {
    return 'pending';
  }
  if (cell.state === 'no-show') {
    return 'no-show';
  }
  if (cell.state === 'repeat-failure') {
    return 'repeat-failure';
  }
  if (cell.state === 'not-applicable') {
    return 'not-applicable';
  }
  return 'unknown';
}
function summarize(
  pairs: readonly Pair[],
  period: PerformancePeriodV2,
  studentIds: readonly number[],
): PerformanceAnalyticsSummaryV6 {
  const selectedTerms = period === 'annual' ? TERMS : [period];
  const results = pairs.filter((pair) => performanceResultCountsV2(pair.cell.result.state));
  const below = pairs.filter(
    (pair) =>
      performanceResultCountsV2(pair.cell.result.state) && pair.cell.result.level === 'below',
  );
  const byStudent = new Map(studentIds.map((id) => [id, [] as Pair[]]));
  for (const pair of pairs) byStudent.get(pair.studentId)?.push(pair);
  const studentsBelow = new Set(below.map((pair) => pair.studentId)).size;
  const studentsAtOrAbove = [...byStudent.values()].filter(
    (items) =>
      items.length &&
      items.every(
        (pair) =>
          performanceResultCountsV2(pair.cell.result.state) &&
          pair.cell.result.level === 'at-or-above',
      ),
  ).length;
  const facts = pairs.flatMap((pair) =>
    pair.projection.facts.filter((fact) => selectedTerms.includes(fact.term) &&
      (fact.slot !== 3 || pair.projection.terms[fact.term - 1]?.coverage.requiredSlots.includes(3))),
  );
  const pairedDimensions = pairs.filter(
    ({ cell }) => cell.quantitative.percent !== null && cell.qualitative.percent !== null,
  );
  const quantTotal = pairedDimensions.reduce(
    (sum, { cell }) => sum + cell.quantitative.valueMilli!,
    0,
  );
  const qualTotal = pairedDimensions.reduce(
    (sum, { cell }) => sum + cell.qualitative.valueMilli!,
    0,
  );
  if (
    !Number.isSafeInteger(quantTotal) ||
    !Number.isSafeInteger(qualTotal) ||
    !Number.isSafeInteger(quantTotal + qualTotal)
  )
    throw new Error('analytics-overflow');
  const changes = pairs.filter((pair) => pair.direction !== null);
  const recovery = {
    applicable: 0,
    recorded: 0,
    pending: 0,
    noShow: 0,
    repeatFailure: 0,
    unknown: 0,
    changed: 0,
    meanGainMilli: null as number | null,
  };
  const gains: number[] = [],
    parallelGains: number[] = [];
  let parallelApplicable = 0,
    parallelApplied = 0;
  for (const pair of pairs) {
    for (const t of selectedTerms) {
      const r = pair.projection.recovery?.recoveryTerms[t];
      if (r?.source === 'RR') recovery.repeatFailure++;
      if (r?.applicable == null) recovery.unknown++;
      if (r?.applicable === true) {
        recovery.applicable++;
        if (r.source === 'NC') recovery.noShow++;
        else if (r.source === null) recovery.pending++;
        else if (typeof r.source === 'number') {
          recovery.recorded++;
          const original = pair.projection.terms[t - 1];
          if (original?.coverage.complete && r.replacementMilli !== null) {
            const gain = r.replacementMilli - original.roundedMilli;
            gains.push(gain);
            if (gain !== 0) recovery.changed++;
          }
        }
      }
      const outcome = pair.projection.terms[t - 1];
      if (outcome?.parallelApplicable === true) parallelApplicable++;
      if (outcome && outcome.quantitativeConsideredMilli > outcome.quantitativeOriginalMilli) {
        parallelApplied++;
        parallelGains.push(outcome.quantitativeConsideredMilli - outcome.quantitativeOriginalMilli);
      }
    }
  }
  recovery.meanGainMilli = mean(gains);
  const percentages = numeric(results.map((pair) => pair.cell.percent));
  const bins = ['0–<20%', '20–<40%', '40–<60%', '60–<80%', '80–100%', '>100%'].map((label) => ({
    label,
    count: 0,
  }));
  for (const percent of percentages)
    bins[percent > 100 ? 5 : Math.min(4, Math.floor(percent / 20))]!.count++;
  const sourceComparable = pairs.filter(
    (pair) => pair.cell.result.sourceComparison !== 'unavailable',
  );
  return {
    students: studentIds.length,
    readings: pairs.length,
    complete: results.length,
    // BN-DEC-042: every result is counted in "complete". The sum of the four counters stays
    // equal to the readings, which is what clients opened before this rule validate; the
    // blank-instrument marker is read from each cell's state.
    partial: 0,
    missing: pairs.filter((pair) => pair.cell.result.state === 'not-recorded').length,
    unavailable: pairs.filter((pair) => pair.cell.result.state === 'unavailable').length,
    above: results.length - below.length,
    below: below.length,
    studentsBelow,
    studentsAtOrAbove,
    studentsPending: studentIds.length - studentsBelow - studentsAtOrAbove,
    result: analyticsStatsV6(percentages),
    quantitative: analyticsStatsV6(numeric(pairs.map((pair) => pair.cell.quantitative.percent))),
    qualitative: analyticsStatsV6(numeric(pairs.map((pair) => pair.cell.qualitative.percent))),
    dimensionGap: {
      n: pairedDimensions.length,
      meanPP: mean(
        pairedDimensions.map(({ cell }) => cell.qualitative.percent! - cell.quantitative.percent!),
      ),
    },
    composition: {
      n: pairedDimensions.length,
      quantitativeShare: ratio(quantTotal, quantTotal + qualTotal),
      qualitativeShare: ratio(qualTotal, quantTotal + qualTotal),
    },
    coverage: coverage(
      facts.length,
      facts.filter((fact) => fact.valueMilli !== null).length,
      facts.filter((fact) => fact.valueMilli === 0).length,
    ),
    recovery,
    parallel: {
      applicable: parallelApplicable,
      applied: parallelApplied,
      meanGainMilli: mean(parallelGains),
    },
    movement: {
      reference: previousTermV6(period),
      n: changes.length,
      increased: changes.filter((pair) => pair.direction === 1).length,
      decreased: changes.filter((pair) => pair.direction === -1).length,
      unchanged: changes.filter((pair) => pair.direction === 0).length,
      meanDeltaPP: mean(changes.map((pair) => pair.cell.deltaPP!)),
    },
    timeline: TERMS.map((term) => ({
      term,
      ...analyticsStatsV6(numeric(pairs.map((pair) => pair.timeline[term - 1]!))),
    })),
    distribution: bins,
    source: {
      recorded: pairs.filter((pair) => pair.cell.result.sourceReferenceMilli !== null).length,
      comparable: sourceComparable.length,
      different: sourceComparable.filter((pair) => pair.cell.result.sourceComparison === 'mismatch')
        .length,
    },
  };
}

function instrumentSummaries(
  pairs: readonly Pair[],
  period: PerformancePeriodV2,
): PerformanceAnalyticsV6['components'][number]['instruments'] {
  const groups = new Map<
    string,
    { pair: Pair; fact: PerformanceProjectionV2['facts'][number] }[]
  >();
  for (const pair of pairs)
    for (const fact of pair.projection.facts) {
      if (period !== 'annual' && period !== fact.term) continue;
      const key = `${pair.projection.offerId}:${fact.term}:${fact.slot}`;
      const group = groups.get(key) ?? [];
      group.push({ pair, fact });
      groups.set(key, group);
    }
  return [...groups]
    .map(([key, entries]) => {
      const first = entries[0]!.fact;
      const effectiveMaximum =
        first.slot === 3
          ? (entries[0]!.pair.projection.terms[first.term - 1]?.quantitativeMaximumMilli ?? null)
          : first.maximumMilli;
      const applicable = entries.filter(
        ({ pair, fact }) =>
          fact.slot !== 3 || pair.projection.terms[fact.term - 1]?.parallelApplicable === true,
      );
      const recorded = applicable.filter(({ fact }) => fact.valueMilli !== null);
      const percentages = numeric(
        recorded.map(({ fact }) => ratio(fact.valueMilli, effectiveMaximum)),
      );
      const minimum = entries[0]!.pair.projection.minimumApprovalMilli;
      return {
        key,
        term: first.term,
        slot: first.slot,
        label: first.label,
        maximumMilli: effectiveMaximum,
        stats: analyticsStatsV6(percentages),
        coverage: coverage(
          applicable.length,
          recorded.length,
          recorded.filter(({ fact }) => fact.valueMilli === 0).length,
        ),
        below:
          effectiveMaximum === null
            ? 0
            : recorded.filter(
                ({ fact }) =>
                  BigInt(fact.valueMilli!) * BigInt(ANNUAL_MAXIMUM) <
                  BigInt(effectiveMaximum) * BigInt(minimum),
              ).length,
        notApplicable: entries.length - applicable.length,
      };
    })
    .filter((instrument) => instrument.slot !== 3 || instrument.coverage.expected > 0)
    .sort((a, b) => a.term - b.term || a.slot - b.slot);
}

export function buildPerformanceAnalyticsV6(
  matrix: PerformanceMatrixV2,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
  includeLearning = true,
  includeStudentDimensions = true,
): PerformanceAnalyticsV6 {
  const period = matrix.period;
  const dimensionRequest = {
    transportVersion: 3 as const,
    operation: 'analysis' as const,
    year: matrix.context.year,
    classId: matrix.classGroup.id,
    period,
    mode: 'regular' as const,
    statuses: [null, 7] as (null | 7)[],
    offerId: null,
  };
  // Reuse the existing composition lenses; never reimplement academic rules in analytics.
  const quantitative = buildPerformanceAnalysisV3(matrix, projections, {
    ...dimensionRequest,
    lens: 'quantitative',
  });
  const qualitative = buildPerformanceAnalysisV3(matrix, projections, {
    ...dimensionRequest,
    lens: 'qualitative',
  });
  const minimumPercent = (matrix.context.minimumApprovalMilli / ANNUAL_MAXIMUM) * 100;
  const pairs: Pair[] = matrix.rows.flatMap((row, index) => {
    const byOffer = new Map(
      (projections.get(row.student.id) ?? []).map((projection) => [projection.offerId, projection]),
    );
    return row.cells.map((result, column) => {
      const projection = byOffer.get(result.offerId);
      if (!projection) throw new Error('analytics-missing-projection');
      const timeline = TERMS.map((term) => {
        const cell = performanceCellV2(projection, term, 'regular');
        return performanceResultCountsV2(cell.state)
          ? ratio(cell.valueMilli, cell.maximumMilli)
          : null;
      });
      const reference =
        period === 2 || period === 3
          ? performanceCellV2(projection, (period - 1) as 1 | 2, 'regular')
          : null;
      const comparable =
        performanceResultCountsV2(result.state) &&
        reference !== null &&
        performanceResultCountsV2(reference.state);
      const comparison = comparable
        ? BigInt(result.valueMilli!) * BigInt(reference!.maximumMilli) -
          BigInt(reference!.valueMilli!) * BigInt(result.maximumMilli)
        : null;
      const percent = ratio(result.valueMilli, result.maximumMilli);
      return {
        studentId: row.student.id,
        projection,
        timeline,
        direction: comparison === null ? null : signOfV6(comparison),
        cell: {
          offerId: result.offerId,
          result,
          percent,
          gapMilli:
            result.valueMilli === null
              ? null
              : (() => {
                  const numerator =
                    BigInt(result.maximumMilli) * BigInt(matrix.context.minimumApprovalMilli) -
                    BigInt(result.valueMilli) * BigInt(ANNUAL_MAXIMUM);
                  const difference =
                    numerator <= 0n
                      ? 0n
                      : (numerator + BigInt(ANNUAL_MAXIMUM) - 1n) / BigInt(ANNUAL_MAXIMUM);
                  if (difference > BigInt(Number.MAX_SAFE_INTEGER))
                    throw new Error('analytics-overflow');
                  return Number(difference);
                })(),
          deltaPP:
            comparison === null
              ? null
              : (Number(comparison) / (result.maximumMilli * reference!.maximumMilli)) * 100,
          quantitative: dimensions(quantitative.rows[index]!.values[column]!),
          qualitative: dimensions(qualitative.rows[index]!.values[column]!),
          recoveryState: recoveryState(projection, period),
        },
      } satisfies Pair;
    });
  });
  const studentIds = matrix.rows.map((row) => row.student.id);
  const teacherMap = new Map(matrix.offers.map((offer) => [offer.teacher.id, offer.teacher]));
  const byStudent = new Map(studentIds.map((id) => [id, [] as Pair[]]));
  const byOffer = new Map(matrix.offers.map((offer) => [offer.id, [] as Pair[]]));
  const byTeacher = new Map([...teacherMap.keys()].map((id) => [id, [] as Pair[]]));
  const teacherStudents = new Map([...teacherMap.keys()].map((id) => [id, new Map<number, Pair[]>()]));
  const teacherOffers = new Map([...teacherMap.keys()].map((id) => [id, [] as number[]]));
  const offerTeacher = new Map(matrix.offers.map((offer) => [offer.id, offer.teacher.id]));
  for (const offer of matrix.offers) teacherOffers.get(offer.teacher.id)!.push(offer.id);
  for (const pair of pairs) {
    byStudent.get(pair.studentId)!.push(pair);
    byOffer.get(pair.projection.offerId)!.push(pair);
    const teacherId = offerTeacher.get(pair.projection.offerId)!;
    byTeacher.get(teacherId)!.push(pair);
    const students = teacherStudents.get(teacherId)!;
    const own = students.get(pair.studentId) ?? [];
    own.push(pair);
    students.set(pair.studentId, own);
  }
  const result: PerformanceAnalyticsV6 = {
    transportVersion: 6,
    operation: 'analytics',
    state: 'ready',
    authority: 'calculated-preview',
    context: matrix.context,
    classGroup: matrix.classGroup,
    period,
    readAt: matrix.readAt,
    minimumPercent,
    classStudents: matrix.statistics.classRows,
    summary: summarize(pairs, period, studentIds),
    students: matrix.rows.map((row) => {
      const own = byStudent.get(row.student.id)!;
      return {
        student: row.student,
        annualResult: row.calculatedAnnual,
        councilDecision: row.formalCouncilDecision,
        summary: summarize(own, period, [row.student.id]),
        cells: own.map((pair) => pair.cell),
      };
    }),
    components: matrix.offers.map((offer) => {
      const own = byOffer.get(offer.id)!;
      return {
        offer,
        summary: summarize(own, period, studentIds),
        instruments: instrumentSummaries(own, period),
      };
    }),
    teachers: [...teacherMap.values()].map((teacher) => {
      const offerIds = teacherOffers.get(teacher.id)!;
      const own = byTeacher.get(teacher.id)!;
      return {
        ...teacher,
        offerIds,
        summary: summarize(own, period, studentIds),
        students: studentIds.map((studentId) => {
          const own = teacherStudents.get(teacher.id)!.get(studentId) ?? [];
          const summary = summarize(own, period, [studentId]);
          return {
            studentId,
            meanPercent: summary.result.mean,
            below: summary.below,
            complete: summary.complete,
            // The marker of blank instruments, read from the cells (BN-DEC-042).
            partial: own.filter((pair) => pair.cell.result.state === 'partial').length,
            deltaPP: summary.movement.meanDeltaPP,
          };
        }),
      };
    }),
  };
  return includeLearning ? { ...result, learning: buildPerformanceLearningV1(result, projections, includeStudentDimensions) } : result;
}

export function createPerformanceAnalyticsV6(database: GradebookPostgresWritePortV1) {
  return {
    async execute(input: unknown): Promise<PerformanceAnalyticsResponseV6> {
      const parsed = performanceAnalyticsRequestSchemaV6.safeParse(input);
      if (!parsed.success) return { transportVersion: 6, state: 'invalid-request' };
      if (!('transaction' in database) || typeof database.transaction !== 'function')
        return { transportVersion: 6, state: 'unavailable' };
      const request: PerformanceAnalyticsRequestV6 = parsed.data;
      const { includeLearning, includeStudentDimensions, ...matrixRequest } = request;
      const db = database as GradebookPostgresWritePortV1 & {
        transaction<T>(operation: (tx: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
      };
      return db.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
        let projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]> = new Map();
        const matrix = await readRelationalPerformanceV2(
          tx,
          {
            ...matrixRequest,
            transportVersion: 2,
            operation: 'matrix',
            mode: 'regular',
            statuses: [null, 7],
          },
          {
            includeInstrumentDescriptions: includeLearning === true,
            collect: (values) => {
              projections = values;
            },
          },
        );
        if (matrix.state !== 'ready') return { transportVersion: 6, state: matrix.state } as const;
        if (matrix.operation !== 'matrix') throw new Error('unexpected-analytics-operation');
        return performanceAnalyticsResponseSchemaV6.parse(
          buildPerformanceAnalyticsV6(matrix, projections, includeLearning === true, includeStudentDimensions === true),
        );
      });
    },
  };
}
