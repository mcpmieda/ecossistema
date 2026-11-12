// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { learningFixtureV1 } from './learning-fixture-v1';
import {
  performanceCellV2,
  type PerformanceProjectionV2,
} from '../../../server/gradebook/application/results/relational-performance-facts-v2';
import {
  buildPerformanceAnalysisV3,
} from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import {
  buildPerformanceDashboardOverviewV5,
} from '../../../server/gradebook/application/read-models/performance/performance-dashboard-v5';
import {
  buildPerformanceTermComparisonV4,
} from '../../../server/gradebook/application/read-models/performance/performance-term-comparison-v4';
import {
  performanceAnalysisRequestSchemaV3,
  type AnalysisReadingV3,
  type PerformanceAnalysisRequestV3,
  type PerformanceAnalysisV3,
} from '../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import {
  performanceTermComparisonRequestSchemaV4,
  type PerformanceTermComparisonValueV4,
} from '../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';
import type {
  PerformanceAnalyticsStatsV6,
  PerformanceAnalyticsSummaryV6,
  PerformanceAnalyticsV6,
} from '../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import type {
  PerformanceMatrixV2,
  PerformancePeriodV2,
} from '../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { isParticipationLabelV1 } from '../../../shared/gradebook-contracts/performance/performance-learning-v1';
import { SIMPLIFIED_TERM_MAXIMUM_MILLI_V1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';

const TERMS = [1, 2, 3] as const;
const ANNUAL_MAXIMUM = TERMS.reduce(
  (sum, term) => sum + SIMPLIFIED_TERM_MAXIMUM_MILLI_V1[term],
  0,
);
const numeric = (values: readonly (number | null)[]) =>
  values.filter((value): value is number => value !== null);
const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null;
const ratio = (value: number | null, maximum: number | null) =>
  value !== null && maximum !== null && maximum > 0 ? (value / maximum) * 100 : null;

/** BN-DEC-042: complete and partial results both count in the indicators. */
const counts = (state: string) => state === 'complete' || state === 'partial';

function stats(values: readonly number[]): PerformanceAnalyticsStatsV6 {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length)
    return { n: 0, mean: null, median: null, deviation: null, min: null, max: null };
  const average = mean(sorted)!;
  const mid = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    mean: average,
    median:
      sorted.length % 2
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2,
    deviation: Math.sqrt(
      sorted.reduce(
        (sum, value) => sum + (value - average) ** 2 / sorted.length,
        0,
      ),
    ),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

function expectMetric(actual: number | null, expected: number | null) {
  if (expected === null) expect(actual).toBeNull();
  else expect(actual).toBeCloseTo(expected, 10);
}
function expectStats(actual: PerformanceAnalyticsStatsV6, expected: PerformanceAnalyticsStatsV6) {
  expect(actual.n).toBe(expected.n);
  for (const key of ['mean', 'median', 'deviation', 'min', 'max'] as const)
    expectMetric(actual[key], expected[key]);
}

type OracleDimension = {
  valueMilli: number | null;
  maximumMilli: number | null;
  percent: number | null;
  complete: boolean;
  state: 'complete' | 'partial' | 'not-recorded' | 'unavailable';
};

function oracleDimension(
  projection: PerformanceProjectionV2,
  period: PerformancePeriodV2,
  quantitative: boolean,
): OracleDimension {
  const terms = period === 'annual' ? TERMS : [period];
  const outcomes = terms.map((term) => projection.terms[term - 1]);
  if (outcomes.some((outcome) => outcome === null))
    return {
      valueMilli: null,
      maximumMilli: null,
      percent: null,
      complete: false,
      state: 'unavailable',
    };
  const factsByTerm = terms.map((term, index) =>
    projection.facts.filter(
      (fact) =>
        fact.term === term &&
        (quantitative
          ? fact.slot <= 3 && outcomes[index]!.coverage.requiredSlots.includes(fact.slot)
          : fact.slot >= 11),
    ),
  );
  if (factsByTerm.some((facts) => facts.length === 0))
    return {
      valueMilli: null,
      maximumMilli: null,
      percent: null,
      complete: false,
      state: 'unavailable',
    };
  const resolved = factsByTerm.flatMap((facts, index) =>
    facts.map((fact) => outcomes[index]!.coverage.resolvedSlots.includes(fact.slot)),
  );
  const hasGain =
    quantitative &&
    outcomes.some(
      (outcome) => outcome!.quantitativeConsideredMilli > outcome!.quantitativeOriginalMilli,
    );
  // BN-DEC-042: a blank instrument was not done, so a dimension always has its value.
  const complete = resolved.every(Boolean);
  void hasGain;
  const maxima = quantitative
    ? outcomes.map((outcome) => outcome!.quantitativeMaximumMilli)
    : factsByTerm.flat().map((fact) => fact.maximumMilli);
  const maximumMilli = maxima.some((value) => value === null)
    ? null
    : (maxima as number[]).reduce((sum, value) => sum + value, 0) || null;
  const valueMilli = outcomes.reduce(
        (sum, outcome) =>
          sum +
          (quantitative
            ? outcome!.quantitativeConsideredMilli
            : outcome!.qualitativeOperationalMilli),
        0,
      );
  return {
    valueMilli,
    maximumMilli,
    percent: ratio(valueMilli, maximumMilli),
    complete: true,
    state: complete ? 'complete' : 'partial',
  };
}

type OraclePair = {
  studentId: number;
  projection: PerformanceProjectionV2;
  result: PerformanceMatrixV2['rows'][number]['cells'][number];
  quantitative: OracleDimension;
  qualitative: OracleDimension;
  timeline: readonly (number | null)[];
  direction: -1 | 0 | 1 | null;
  deltaPP: number | null;
};

function oraclePairs(
  matrix: PerformanceMatrixV2,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
): OraclePair[] {
  return matrix.rows.flatMap((row) => {
    const byOffer = new Map(
      (projections.get(row.student.id) ?? []).map((projection) => [
        projection.offerId,
        projection,
      ]),
    );
    return row.cells.map((result) => {
      const projection = byOffer.get(result.offerId);
      if (!projection) throw new Error('proof-missing-projection');
      const reference =
        matrix.period === 2 || matrix.period === 3
          ? performanceCellV2(projection, (matrix.period - 1) as 1 | 2, 'regular')
          : null;
      const comparable = counts(result.state) && reference !== null && counts(reference.state);
      const comparison = comparable
        ? BigInt(result.valueMilli!) * BigInt(reference!.maximumMilli) -
          BigInt(reference!.valueMilli!) * BigInt(result.maximumMilli)
        : null;
      return {
        studentId: row.student.id,
        projection,
        result,
        quantitative: oracleDimension(projection, matrix.period, true),
        qualitative: oracleDimension(projection, matrix.period, false),
        timeline: TERMS.map((term) => {
          const cell = performanceCellV2(projection, term, 'regular');
          return counts(cell.state) ? ratio(cell.valueMilli, cell.maximumMilli) : null;
        }),
        direction:
          comparison === null ? null : comparison > 0n ? 1 : comparison < 0n ? -1 : 0,
        deltaPP:
          comparison === null
            ? null
            : (Number(comparison) / (result.maximumMilli * reference!.maximumMilli)) * 100,
      };
    });
  });
}

function oracleSummary(
  matrix: PerformanceMatrixV2,
  pairs: readonly OraclePair[],
  studentIds: readonly number[],
): PerformanceAnalyticsSummaryV6 {
  const selectedTerms = matrix.period === 'annual' ? TERMS : [matrix.period];
  const complete = pairs.filter((pair) => counts(pair.result.state));
  const below = complete.filter((pair) => pair.result.level === 'below');
  const byStudent = new Map(
    studentIds.map((id) => [id, pairs.filter((pair) => pair.studentId === id)]),
  );
  const studentsBelow = new Set(below.map((pair) => pair.studentId)).size;
  const studentsAtOrAbove = [...byStudent.values()].filter(
    (items) =>
      items.length > 0 &&
      items.every(
        (pair) =>
          counts(pair.result.state) && pair.result.level === 'at-or-above',
      ),
  ).length;
  const facts = pairs.flatMap((pair) =>
    pair.projection.facts.filter(
      (fact) =>
        selectedTerms.includes(fact.term) &&
        (fact.slot !== 3 ||
          pair.projection.terms[fact.term - 1]?.coverage.requiredSlots.includes(3)),
    ),
  );
  const paired = pairs.filter(
    (pair) => pair.quantitative.percent !== null && pair.qualitative.percent !== null,
  );
  const quantitativePoints = paired.reduce(
    (sum, pair) => sum + pair.quantitative.valueMilli!,
    0,
  );
  const qualitativePoints = paired.reduce(
    (sum, pair) => sum + pair.qualitative.valueMilli!,
    0,
  );
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
  const recoveryGains: number[] = [];
  const parallelGains: number[] = [];
  let parallelApplicable = 0;
  let parallelApplied = 0;
  for (const pair of pairs) {
    for (const term of selectedTerms) {
      const currentRecovery = pair.projection.recovery?.recoveryTerms[term];
      if (currentRecovery?.source === 'RR') recovery.repeatFailure++;
      if (currentRecovery?.applicable == null) recovery.unknown++;
      if (currentRecovery?.applicable === true) {
        recovery.applicable++;
        if (currentRecovery.source === 'NC') recovery.noShow++;
        else if (currentRecovery.source === null) recovery.pending++;
        else if (typeof currentRecovery.source === 'number') {
          recovery.recorded++;
          const original = pair.projection.terms[term - 1];
          if (original?.coverage.complete && currentRecovery.replacementMilli !== null) {
            const gain = currentRecovery.replacementMilli - original.roundedMilli;
            recoveryGains.push(gain);
            if (gain !== 0) recovery.changed++;
          }
        }
      }
      const outcome = pair.projection.terms[term - 1];
      if (outcome?.parallelApplicable === true) parallelApplicable++;
      if (
        outcome &&
        outcome.quantitativeConsideredMilli > outcome.quantitativeOriginalMilli
      ) {
        parallelApplied++;
        parallelGains.push(
          outcome.quantitativeConsideredMilli - outcome.quantitativeOriginalMilli,
        );
      }
    }
  }
  recovery.meanGainMilli = mean(recoveryGains);
  const percentages = complete.map((pair) => ratio(pair.result.valueMilli, pair.result.maximumMilli)!);
  const distribution = ['0–<20%', '20–<40%', '40–<60%', '60–<80%', '80–100%', '>100%'].map(
    (label) => ({ label, count: 0 }),
  );
  for (const percentage of percentages)
    distribution[
      percentage > 100 ? 5 : Math.min(4, Math.floor(percentage / 20))
    ]!.count++;
  const changes = pairs.filter((pair) => pair.direction !== null);
  const comparableSource = pairs.filter(
    (pair) => pair.result.sourceComparison !== 'unavailable',
  );
  return {
    students: studentIds.length,
    readings: pairs.length,
    complete: complete.length,
    partial: 0,
    missing: pairs.filter((pair) => pair.result.state === 'not-recorded').length,
    unavailable: pairs.filter((pair) => pair.result.state === 'unavailable').length,
    above: complete.length - below.length,
    below: below.length,
    studentsBelow,
    studentsAtOrAbove,
    studentsPending: studentIds.length - studentsBelow - studentsAtOrAbove,
    result: stats(percentages),
    quantitative: stats(numeric(pairs.map((pair) => pair.quantitative.percent))),
    qualitative: stats(numeric(pairs.map((pair) => pair.qualitative.percent))),
    dimensionGap: {
      n: paired.length,
      meanPP: mean(
        paired.map((pair) => pair.qualitative.percent! - pair.quantitative.percent!),
      ),
    },
    composition: {
      n: paired.length,
      quantitativeShare: ratio(
        quantitativePoints,
        quantitativePoints + qualitativePoints,
      ),
      qualitativeShare: ratio(
        qualitativePoints,
        quantitativePoints + qualitativePoints,
      ),
    },
    coverage: {
      expected: facts.length,
      recorded: facts.filter((fact) => fact.valueMilli !== null).length,
      missing: facts.filter((fact) => fact.valueMilli === null).length,
      zeros: facts.filter((fact) => fact.valueMilli === 0).length,
      percent: facts.length
        ? (facts.filter((fact) => fact.valueMilli !== null).length / facts.length) * 100
        : null,
    },
    recovery,
    parallel: {
      applicable: parallelApplicable,
      applied: parallelApplied,
      meanGainMilli: mean(parallelGains),
    },
    movement: {
      reference: matrix.period === 2 ? 1 : matrix.period === 3 ? 2 : null,
      n: changes.length,
      increased: changes.filter((pair) => pair.direction === 1).length,
      decreased: changes.filter((pair) => pair.direction === -1).length,
      unchanged: changes.filter((pair) => pair.direction === 0).length,
      meanDeltaPP: mean(changes.map((pair) => pair.deltaPP!)),
    },
    timeline: TERMS.map((term) => ({
      term,
      ...stats(numeric(pairs.map((pair) => pair.timeline[term - 1]!))),
    })),
    distribution,
    source: {
      recorded: pairs.filter((pair) => pair.result.sourceReferenceMilli !== null).length,
      comparable: comparableSource.length,
      different: comparableSource.filter(
        (pair) => pair.result.sourceComparison === 'mismatch',
      ).length,
    },
  };
}

function expectSummary(
  actual: PerformanceAnalyticsSummaryV6,
  expected: PerformanceAnalyticsSummaryV6,
) {
  for (const key of [
    'students',
    'readings',
    'complete',
    'partial',
    'missing',
    'unavailable',
    'above',
    'below',
    'studentsBelow',
    'studentsAtOrAbove',
    'studentsPending',
  ] as const)
    expect(actual[key]).toBe(expected[key]);
  expectStats(actual.result, expected.result);
  expectStats(actual.quantitative, expected.quantitative);
  expectStats(actual.qualitative, expected.qualitative);
  expect(actual.dimensionGap.n).toBe(expected.dimensionGap.n);
  expectMetric(actual.dimensionGap.meanPP, expected.dimensionGap.meanPP);
  expect(actual.composition.n).toBe(expected.composition.n);
  expectMetric(actual.composition.quantitativeShare, expected.composition.quantitativeShare);
  expectMetric(actual.composition.qualitativeShare, expected.composition.qualitativeShare);
  expect(actual.coverage).toMatchObject({
    expected: expected.coverage.expected,
    recorded: expected.coverage.recorded,
    missing: expected.coverage.missing,
    zeros: expected.coverage.zeros,
  });
  expectMetric(actual.coverage.percent, expected.coverage.percent);
  for (const key of [
    'applicable',
    'recorded',
    'pending',
    'noShow',
    'repeatFailure',
    'unknown',
    'changed',
  ] as const)
    expect(actual.recovery[key]).toBe(expected.recovery[key]);
  expectMetric(actual.recovery.meanGainMilli, expected.recovery.meanGainMilli);
  expect(actual.parallel.applicable).toBe(expected.parallel.applicable);
  expect(actual.parallel.applied).toBe(expected.parallel.applied);
  expectMetric(actual.parallel.meanGainMilli, expected.parallel.meanGainMilli);
  expect(actual.movement).toMatchObject({
    reference: expected.movement.reference,
    n: expected.movement.n,
    increased: expected.movement.increased,
    decreased: expected.movement.decreased,
    unchanged: expected.movement.unchanged,
  });
  expectMetric(actual.movement.meanDeltaPP, expected.movement.meanDeltaPP);
  expect(actual.timeline.map((item) => item.term)).toEqual([1, 2, 3]);
  actual.timeline.forEach((item, index) => expectStats(item, expected.timeline[index]!));
  expect(actual.distribution).toEqual(expected.distribution);
  expect(actual.source).toEqual(expected.source);
}


type OracleInstrument = PerformanceAnalyticsV6['components'][number]['instruments'][number];

function oracleInstruments(
  pairs: readonly OraclePair[],
  period: PerformancePeriodV2,
): OracleInstrument[] {
  const groups = new Map<
    string,
    { pair: OraclePair; fact: PerformanceProjectionV2['facts'][number] }[]
  >();
  for (const pair of pairs)
    for (const fact of pair.projection.facts) {
      if (period !== 'annual' && fact.term !== period) continue;
      const key =
        String(pair.projection.offerId) + ':' + String(fact.term) + ':' + String(fact.slot);
      const group = groups.get(key) ?? [];
      group.push({ pair, fact });
      groups.set(key, group);
    }
  return [...groups]
    .map(([key, entries]) => {
      const first = entries[0]!.fact;
      const effectiveMaximum =
        first.slot === 3
          ? (entries[0]!.pair.projection.terms[first.term - 1]
              ?.quantitativeMaximumMilli ?? null)
          : first.maximumMilli;
      const applicable = entries.filter(
        ({ pair, fact }) =>
          fact.slot !== 3 ||
          pair.projection.terms[fact.term - 1]?.parallelApplicable === true,
      );
      const recorded = applicable.filter(({ fact }) => fact.valueMilli !== null);
      const percentages = numeric(
        recorded.map(({ fact }) => ratio(fact.valueMilli, effectiveMaximum)),
      );
      const minimum = entries[0]!.pair.projection.minimumApprovalMilli;
      const expected = applicable.length;
      return {
        key,
        term: first.term,
        slot: first.slot,
        label: first.label,
        maximumMilli: effectiveMaximum,
        stats: stats(percentages),
        coverage: {
          expected,
          recorded: recorded.length,
          missing: expected - recorded.length,
          zeros: recorded.filter(({ fact }) => fact.valueMilli === 0).length,
          percent: expected ? (recorded.length / expected) * 100 : null,
        },
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
    .filter(
      (instrument) => instrument.slot !== 3 || instrument.coverage.expected > 0,
    )
    .sort((left, right) => left.term - right.term || left.slot - right.slot);
}

function rawParticipation(
  projection: PerformanceProjectionV2,
  terms: readonly (1 | 2 | 3)[],
) {
  const facts = projection.facts.filter(
    (fact) =>
      terms.includes(fact.term) &&
      fact.slot >= 11 &&
      isParticipationLabelV1(fact.label),
  );
  const valid = facts.filter(
    (fact) =>
      fact.valueMilli !== null &&
      fact.maximumMilli !== null &&
      fact.maximumMilli > 0,
  );
  // BN-DEC-042: blank scaled instruments keep their maximum and add no points.
  const maximum = facts
    .filter((fact) => fact.maximumMilli !== null && fact.maximumMilli > 0)
    .reduce((sum, fact) => sum + fact.maximumMilli!, 0);
  const points = valid.reduce((sum, fact) => sum + fact.valueMilli!, 0);
  return {
    percent: maximum > 0 ? (points / maximum) * 100 : null,
    complete: facts.length > 0 && facts.length === valid.length,
    recorded: valid.length,
    expected: facts.length,
    unscaled: facts.filter(
      (fact) => fact.maximumMilli === null || fact.maximumMilli <= 0,
    ).length,
  };
}

function proveLearningStudentFromFacts(
  value: PerformanceAnalyticsV6,
  studentId: number,
  projections: readonly PerformanceProjectionV2[],
) {
  const actual = value.learning!.students.find((item) => item.studentId === studentId)!;
  const selectedTerms = value.period === 'annual' ? TERMS : [value.period];
  const reference = value.period === 2 ? 1 : value.period === 3 ? 2 : null;
  const recurring: typeof actual.recurring = [];
  const currentParticipation: number[] = [];
  const participationChanges: number[] = [];
  const quantitative: number[] = [];
  const qualitative: number[] = [];
  let recorded = 0;
  let expected = 0;
  let unscaled = 0;
  let recurrenceAssessed = false;
  let parallelImprovements = 0;
  const parallelGainsPP: number[] = [];

  for (const projection of projections) {
    const current = rawParticipation(projection, selectedTerms);
    recorded += current.recorded;
    expected += current.expected;
    unscaled += current.unscaled;
    if (current.percent !== null) currentParticipation.push(current.percent);
    if (reference !== null && current.percent !== null) {
      const previous = rawParticipation(projection, [reference]);
      if (previous.percent !== null)
        participationChanges.push(current.percent - previous.percent);
    }

    const instrumentTerms: (1 | 2 | 3)[] = [];
    const consecutiveTerms: (1 | 2 | 3)[] = [];
    for (const term of selectedTerms) {
      const facts = projection.facts.filter(
        (fact) =>
          fact.term === term &&
          fact.slot !== 3 &&
          !(fact.slot >= 11 && isParticipationLabelV1(fact.label)) &&
          fact.valueMilli !== null &&
          fact.maximumMilli !== null &&
          fact.maximumMilli > 0,
      );
      if (facts.length >= 3) {
        recurrenceAssessed = true;
        if (
          facts.filter(
            (fact) =>
              (fact.valueMilli! / fact.maximumMilli!) * 100 < value.minimumPercent,
          ).length >= 2
        )
          instrumentTerms.push(term);
      }
      if (term > 1) {
        const currentResult = performanceCellV2(projection, term, 'regular');
        const previousResult = performanceCellV2(
          projection,
          (term - 1) as 1 | 2,
          'regular',
        );
        if (
          counts(currentResult.state) &&
          counts(previousResult.state)
        ) {
          recurrenceAssessed = true;
          if (
            currentResult.level === 'below' &&
            previousResult.level === 'below'
          )
            consecutiveTerms.push(term);
        }
      }
      const outcome = projection.terms[term - 1];
      if (
        outcome &&
        outcome.quantitativeConsideredMilli > outcome.quantitativeOriginalMilli
      ) {
        parallelImprovements++;
        if (outcome.quantitativeMaximumMilli > 0)
          parallelGainsPP.push(
            ((outcome.quantitativeConsideredMilli - outcome.quantitativeOriginalMilli) /
              outcome.quantitativeMaximumMilli) *
              100,
          );
      }
    }
    if (instrumentTerms.length || consecutiveTerms.length)
      recurring.push({
        offerId: projection.offerId,
        instrumentTerms,
        consecutiveTerms,
      });

    const qDimension = oracleDimension(projection, value.period, true);
    const aDimension = oracleDimension(projection, value.period, false);
    if (
      qDimension.complete &&
      aDimension.complete &&
      aDimension.percent !== null
    ) {
      const outcomes = selectedTerms.map((term) => projection.terms[term - 1]);
      if (outcomes.every((outcome) => outcome !== null)) {
        const maximum = outcomes.reduce(
          (sum, outcome) => sum + outcome!.quantitativeMaximumMilli,
          0,
        );
        const points = outcomes.reduce(
          (sum, outcome) => sum + outcome!.quantitativeOriginalMilli,
          0,
        );
        if (maximum > 0) {
          quantitative.push((points / maximum) * 100);
          qualitative.push(aDimension.percent);
        }
      }
    }
  }

  expect(actual.recurrenceAssessed).toBe(recurrenceAssessed);
  expect(actual.recurring).toEqual(recurring);
  expect(actual.parallelImprovements).toBe(parallelImprovements);
  expect(actual.participation.recorded).toBe(recorded);
  expect(actual.participation.expected).toBe(expected);
  expect(actual.participation.unscaled).toBe(unscaled);
  expect(actual.participation.components).toBe(currentParticipation.length);
  expect(actual.participation.comparedComponents).toBe(participationChanges.length);
  expectMetric(actual.participation.percent, mean(currentParticipation));
  expectMetric(actual.participation.deltaPP, mean(participationChanges));
  expect(actual.dimensions?.components).toBe(quantitative.length);
  expectMetric(actual.dimensions?.quantitativePercent ?? null, mean(quantitative));
  expectMetric(actual.dimensions?.qualitativePercent ?? null, mean(qualitative));
  const expectedGap =
    quantitative.length && qualitative.length
      ? mean(qualitative)! - mean(quantitative)!
      : null;
  expectMetric(actual.dimensions?.gapPP ?? null, expectedGap);
  return {
    studentId,
    recurrenceAssessed,
    recurring,
    participation: {
      percent: mean(currentParticipation),
      deltaPP: mean(participationChanges),
      components: currentParticipation.length,
      comparedComponents: participationChanges.length,
      recorded,
      expected,
      unscaled,
    },
    parallelImprovements,
    parallelGainsPP,
    dimensions: {
      quantitativePercent: mean(quantitative),
      qualitativePercent: mean(qualitative),
      gapPP: expectedGap,
      components: quantitative.length,
    },
  };
}

function proofAllV6Scopes(
  value: PerformanceAnalyticsV6,
  matrix: PerformanceMatrixV2,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
) {
  const pairs = oraclePairs(matrix, projections);
  const studentIds = matrix.rows.map((row) => row.student.id);
  expectSummary(value.summary, oracleSummary(matrix, pairs, studentIds));

  for (const student of value.students) {
    const own = pairs.filter((pair) => pair.studentId === student.student.id);
    expectSummary(student.summary, oracleSummary(matrix, own, [student.student.id]));
  }
  for (const component of value.components) {
    const own = pairs.filter(
      (pair) => pair.projection.offerId === component.offer.id,
    );
    expectSummary(component.summary, oracleSummary(matrix, own, studentIds));
    const instruments = oracleInstruments(own, matrix.period);
    expect(component.instruments.map((item) => item.key)).toEqual(
      instruments.map((item) => item.key),
    );
    component.instruments.forEach((actual, index) => {
      const expected = instruments[index]!;
      expect(actual).toMatchObject({
        key: expected.key,
        term: expected.term,
        slot: expected.slot,
        label: expected.label,
        maximumMilli: expected.maximumMilli,
        below: expected.below,
        notApplicable: expected.notApplicable,
        coverage: {
          expected: expected.coverage.expected,
          recorded: expected.coverage.recorded,
          missing: expected.coverage.missing,
          zeros: expected.coverage.zeros,
        },
      });
      expectMetric(actual.coverage.percent, expected.coverage.percent);
      expectStats(actual.stats, expected.stats);
    });
  }
  for (const teacher of value.teachers) {
    const own = pairs.filter((pair) => teacher.offerIds.includes(pair.projection.offerId));
    expectSummary(teacher.summary, oracleSummary(matrix, own, studentIds));
    for (const student of teacher.students) {
      const expected = oracleSummary(
        matrix,
        own.filter((pair) => pair.studentId === student.studentId),
        [student.studentId],
      );
      expect(student.complete).toBe(expected.complete);
      expect(student.partial).toBe(
        own.filter(
          (pair) => pair.studentId === student.studentId && pair.result.state === 'partial',
        ).length,
      );
      expect(student.below).toBe(expected.below);
      expectMetric(student.meanPercent, expected.result.mean);
      expectMetric(student.deltaPP, expected.movement.meanDeltaPP);
    }
  }

  const learning = value.learning!;
  expect(learning.students.map((item) => item.studentId)).toEqual(studentIds);
  const rawLearning = studentIds.map((studentId) =>
    proveLearningStudentFromFacts(
      value,
      studentId,
      projections.get(studentId) ?? [],
    ),
  );
  const participationPercents = numeric(
    rawLearning.map((item) => item.participation.percent),
  );
  const participationChanges = numeric(
    rawLearning.map((item) => item.participation.deltaPP),
  );
  expect(learning.participation.students).toBe(participationPercents.length);
  expect(learning.participation.comparedStudents).toBe(
    participationChanges.length,
  );
  expect(learning.participation.recorded).toBe(
    rawLearning.reduce((sum, item) => sum + item.participation.recorded, 0),
  );
  expect(learning.participation.expected).toBe(
    rawLearning.reduce((sum, item) => sum + item.participation.expected, 0),
  );
  expect(learning.participation.unscaled).toBe(
    rawLearning.reduce((sum, item) => sum + item.participation.unscaled, 0),
  );
  expectMetric(learning.participation.percent, mean(participationPercents));
  expectMetric(learning.participation.deltaPP, mean(participationChanges));
  expect(learning.parallel.students).toBe(
    rawLearning.filter((item) => item.parallelImprovements > 0).length,
  );
  expect(learning.parallel.improvements).toBe(
    rawLearning.reduce((sum, item) => sum + item.parallelImprovements, 0),
  );
  expectMetric(
    learning.parallel.meanGainPP,
    mean(rawLearning.flatMap((item) => item.parallelGainsPP)),
  );
  expect(learning.dimensions.students).toBe(
    rawLearning.filter((item) => item.dimensions.components > 0).length,
  );
  expect(learning.dimensions.components).toBe(
    rawLearning.reduce((sum, item) => sum + item.dimensions.components, 0),
  );
  const qStudents = numeric(
    rawLearning.map((item) => item.dimensions.quantitativePercent),
  );
  const aStudents = numeric(
    rawLearning.map((item) => item.dimensions.qualitativePercent),
  );
  const quantitativeMean = mean(qStudents);
  const qualitativeMean = mean(aStudents);
  expectMetric(learning.dimensions.quantitativePercent, quantitativeMean);
  expectMetric(learning.dimensions.qualitativePercent, qualitativeMean);
  expectMetric(
    learning.dimensions.gapPP,
    quantitativeMean !== null && qualitativeMean !== null
      ? qualitativeMean - quantitativeMean
      : null,
  );
  const rawInstruments = value.components.flatMap((component) =>
    oracleInstruments(
      pairs.filter((pair) => pair.projection.offerId === component.offer.id),
      matrix.period,
    ),
  );
  const expectedActivities = rawInstruments
    .filter(
      (instrument) =>
        instrument.slot >= 11 &&
        !isParticipationLabelV1(instrument.label) &&
        instrument.stats.n >= 3 &&
        instrument.maximumMilli !== null &&
        instrument.maximumMilli > 0 &&
        instrument.below > 0,
    )
    .sort(
      (left, right) =>
        right.below / right.stats.n - left.below / left.stats.n ||
        (left.stats.mean ?? Infinity) - (right.stats.mean ?? Infinity) ||
        left.key.localeCompare(right.key),
    )
    .map((instrument) => instrument.key);
  expect(learning.activitiesToReview).toEqual(expectedActivities);

  expect(value.summary.complete + value.summary.partial + value.summary.missing + value.summary.unavailable)
    .toBe(value.summary.readings);
  expect(value.summary.above + value.summary.below).toBe(value.summary.complete);
  expect(value.summary.studentsAtOrAbove + value.summary.studentsBelow + value.summary.studentsPending)
    .toBe(value.summary.students);
  expect(value.summary.distribution.reduce((sum, bin) => sum + bin.count, 0))
    .toBe(value.summary.complete);
}

function analysisRequest(
  matrix: PerformanceMatrixV2,
  lens: 'result' | 'quantitative' | 'qualitative' | 'assessments',
  offerId: number | null,
  period: PerformancePeriodV2 = matrix.period,
): PerformanceAnalysisRequestV3 {
  return performanceAnalysisRequestSchemaV3.parse({
    transportVersion: 3,
    operation: 'analysis',
    year: matrix.context.year,
    classId: matrix.classGroup.id,
    period,
    mode: matrix.mode,
    statuses: [null, 7],
    lens,
    offerId,
  });
}

type OracleAnalysis = {
  columns: PerformanceAnalysisV3['columns'];
  rows: PerformanceAnalysisV3['rows'];
};

type OracleRawReading = {
  valueMilli: number | null;
  maximumMilli: number | null;
  recordedMilli: number | null;
  state: AnalysisReadingV3['state'];
  notDone?: true;
};

function oracleAnalysis(
  matrix: PerformanceMatrixV2,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
  request: PerformanceAnalysisRequestV3,
): OracleAnalysis {
  const selectedProjections = matrix.rows.flatMap((row) =>
    (projections.get(row.student.id) ?? []).filter(
      (projection) =>
        request.offerId !== null && projection.offerId === request.offerId,
    ),
  );
  const source = selectedProjections[0];
  const parallelTerms = new Set(
    selectedProjections.flatMap((projection) =>
      projection.terms.flatMap((term) =>
        term?.parallelApplicable === true ? [term.term] : [],
      ),
    ),
  );
  const baseColumns =
    request.lens === 'assessments'
      ? (source?.facts ?? [])
          .filter(
            (fact) => request.period === 'annual' || fact.term === request.period,
          )
          .filter((fact) => fact.slot !== 3 || parallelTerms.has(fact.term))
          .map((fact) => ({
            key:
              String(request.offerId) +
              ':' +
              String(fact.term) +
              ':' +
              String(fact.slot),
            offerId: request.offerId!,
            term: fact.term,
            slot: fact.slot,
            label:
              request.period === 'annual'
                ? 'T' + fact.term + ' · ' + fact.label
                : fact.label,
          }))
      : matrix.offers.map((offer) => ({
          key: String(offer.id),
          offerId: offer.id,
          term: null,
          slot: null,
          label: offer.subject.label,
        }));
  const offerIndexes = new Map(matrix.offers.map((offer, index) => [offer.id, index]));

  const rows: PerformanceAnalysisV3['rows'] = matrix.rows.map((row) => {
    const byOffer = new Map(
      (projections.get(row.student.id) ?? []).map((projection) => [
        projection.offerId,
        projection,
      ]),
    );
    return {
      studentId: row.student.id,
      values: baseColumns.map((column): AnalysisReadingV3 => {
        const projection = byOffer.get(column.offerId);
        if (!projection)
          return {
            key: column.key,
            valueMilli: null,
            maximumMilli: null,
            recordedMilli: null,
            state: 'unavailable',
            percent: null,
            bucket: 'excluded',
          };
        const matrixCell = row.cells[offerIndexes.get(column.offerId)!]!;
        const scopeCell =
          request.period === matrix.period
            ? matrixCell
            : request.period === 'annual'
              ? matrixCell
              : performanceCellV2(projection, request.period, request.mode);

        let raw: OracleRawReading;
        if (request.lens === 'result') {
          raw = {
            valueMilli: scopeCell.valueMilli,
            maximumMilli: scopeCell.maximumMilli,
            recordedMilli: null,
            state: scopeCell.state,
          };
        } else if (request.lens === 'quantitative' || request.lens === 'qualitative') {
          const dimension = oracleDimension(
            projection,
            request.period,
            request.lens === 'quantitative',
          );
          raw = {
            valueMilli: dimension.valueMilli,
            maximumMilli: dimension.maximumMilli,
            recordedMilli: null,
            state: dimension.state,
          };
        } else {
          const fact = projection.facts.find(
            (item) => item.term === column.term && item.slot === column.slot,
          );
          if (!fact) {
            raw = {
              valueMilli: null,
              maximumMilli: null,
              recordedMilli: null,
              state: 'unavailable',
            };
          } else {
            const outcome = projection.terms[fact.term - 1];
            const maximumMilli =
              fact.slot === 3
                ? (outcome?.quantitativeMaximumMilli ?? null)
                : fact.maximumMilli;
            if (fact.slot === 3 && outcome?.parallelApplicable !== true) {
              raw = {
                valueMilli: null,
                maximumMilli,
                recordedMilli: null,
                state:
                  outcome?.parallelApplicable === false
                    ? 'not-applicable'
                    : 'unavailable',
              };
            } else {
              raw = {
                valueMilli: fact.valueMilli,
                maximumMilli,
                recordedMilli: fact.valueMilli,
                state: fact.valueMilli === null ? 'not-recorded' : 'complete',
                ...(fact.observed === true && fact.valueMilli === null
                  ? { notDone: true as const }
                  : {}),
              };
            }
          }
        }

        const classificationReady =
          counts(raw.state);
        const readingPercent =
          classificationReady &&
          raw.valueMilli !== null &&
          raw.maximumMilli !== null
            ? (raw.valueMilli / raw.maximumMilli) * 100
            : null;
        const recoveryRelevant =
          scopeCell.recoveryApplicable === true ||
          scopeCell.state === 'repeat-failure';
        const eligible =
          row.student.indicatorEligible &&
          (request.mode === 'regular' || recoveryRelevant);
        const bucket: AnalysisReadingV3['bucket'] =
          !eligible || raw.state === 'not-applicable'
            ? 'excluded'
            : raw.state === 'repeat-failure'
              ? 'below'
              : raw.state === 'no-show'
                ? 'no-show'
                : !classificationReady
                  ? 'incomplete'
                  : readingPercent === null
                    ? 'unscaled'
                    : BigInt(raw.valueMilli!) * BigInt(ANNUAL_MAXIMUM) >=
                        BigInt(raw.maximumMilli!) *
                          BigInt(matrix.context.minimumApprovalMilli)
                      ? 'above'
                      : 'below';
        return {
          key: column.key,
          valueMilli: raw.valueMilli,
          maximumMilli: raw.maximumMilli,
          recordedMilli: raw.recordedMilli,
          ...(raw.notDone ? { notDone: true as const } : {}),
          state: raw.state,
          percent: readingPercent,
          bucket,
        };
      }),
    };
  });

  const columns: PerformanceAnalysisV3['columns'] = baseColumns.map(
    (column, columnIndex) => {
      const groups = {
        above: [] as number[],
        below: [] as number[],
        incomplete: [] as number[],
        'no-show': [] as number[],
        unscaled: [] as number[],
      };
      const percentages: number[] = [];
      for (const row of rows) {
        const value = row.values[columnIndex]!;
        if (value.bucket === 'excluded') continue;
        groups[value.bucket].push(row.studentId);
        if (value.percent !== null) percentages.push(value.percent);
      }
      const ordered = [...percentages].sort((left, right) => left - right);
      const mid = Math.floor(ordered.length / 2);
      return {
        ...column,
        summary: {
          considered:
            groups.above.length +
            groups.below.length +
            groups.incomplete.length +
            groups['no-show'].length +
            groups.unscaled.length,
          scaled: percentages.length,
          meanPercent: mean(percentages),
          medianPercent: ordered.length
            ? ordered.length % 2
              ? ordered[mid]!
              : (ordered[mid - 1]! + ordered[mid]!) / 2
            : null,
          groups,
        },
      };
    },
  );
  return { columns, rows };
}

function expectAnalysis(actual: PerformanceAnalysisV3, expected: OracleAnalysis) {
  expect(
    actual.columns.map((column) => ({
      key: column.key,
      offerId: column.offerId,
      term: column.term,
      slot: column.slot,
      label: column.label,
    })),
  ).toEqual(
    expected.columns.map((column) => ({
      key: column.key,
      offerId: column.offerId,
      term: column.term,
      slot: column.slot,
      label: column.label,
    })),
  );
  expect(actual.rows.map((row) => row.studentId)).toEqual(
    expected.rows.map((row) => row.studentId),
  );
  actual.rows.forEach((row, rowIndex) =>
    row.values.forEach((reading, columnIndex) => {
      const expectedReading = expected.rows[rowIndex]!.values[columnIndex]!;
      expect(reading).toMatchObject({
        key: expectedReading.key,
        valueMilli: expectedReading.valueMilli,
        maximumMilli: expectedReading.maximumMilli,
        recordedMilli: expectedReading.recordedMilli,
        state: expectedReading.state,
        bucket: expectedReading.bucket,
      });
      expect(reading.notDone).toBe(expectedReading.notDone);
      expectMetric(reading.percent, expectedReading.percent);
    }),
  );
  actual.columns.forEach((column, index) => {
    const expectedColumn = expected.columns[index]!;
    expect(column.summary.considered).toBe(expectedColumn.summary.considered);
    expect(column.summary.scaled).toBe(expectedColumn.summary.scaled);
    expect(column.summary.groups).toEqual(expectedColumn.summary.groups);
    expectMetric(column.summary.meanPercent, expectedColumn.summary.meanPercent);
    expectMetric(column.summary.medianPercent, expectedColumn.summary.medianPercent);
  });
}

function proveAnalysisAndDashboard(
  matrix: PerformanceMatrixV2,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
  lens: 'result' | 'quantitative' | 'qualitative' | 'assessments',
) {
  const offerId = lens === 'assessments' ? matrix.offers[0]!.id : null;
  const request = analysisRequest(matrix, lens, offerId);
  const analysis = buildPerformanceAnalysisV3(matrix, projections, request);
  const oracle = oracleAnalysis(matrix, projections, request);
  expectAnalysis(analysis, oracle);

  const overview = buildPerformanceDashboardOverviewV5(analysis);
  const eligibleIds = matrix.rows
    .filter((row) => row.student.indicatorEligible)
    .map((row) => row.student.id);
  const rows = new Map(oracle.rows.map((row) => [row.studentId, row]));
  const expected = {
    allAtOrAbove: [] as number[],
    withBelow: [] as number[],
    pending: [] as number[],
  };
  for (const studentId of eligibleIds) {
    const buckets = rows.get(studentId)?.values.map((value) => value.bucket) ?? [];
    if (buckets.some((bucket) => bucket === 'below')) expected.withBelow.push(studentId);
    else if (buckets.length > 0 && buckets.every((bucket) => bucket === 'above'))
      expected.allAtOrAbove.push(studentId);
    else expected.pending.push(studentId);
  }
  expect(overview.groups).toEqual(expected);
  expect(overview.students).toEqual({
    eligible: eligibleIds.length,
    classified: expected.allAtOrAbove.length + expected.withBelow.length,
    allAtOrAbove: expected.allAtOrAbove.length,
    withBelow: expected.withBelow.length,
    pending: expected.pending.length,
  });
  expect(overview.students.eligible).toBe(
    overview.students.classified + overview.students.pending,
  );

  for (const [index, column] of overview.columns.entries()) {
    const source = oracle.columns[index]!;
    expect(column).toMatchObject({
      considered: source.summary.considered,
      atOrAbove: source.summary.groups.above.length,
      below: source.summary.groups.below.length,
      incomplete: source.summary.groups.incomplete.length,
      noShow: source.summary.groups['no-show'].length,
      unscaled: source.summary.groups.unscaled.length,
    });
    expect(
      column.atOrAbove +
        column.below +
        column.incomplete +
        column.noShow +
        column.unscaled,
    ).toBe(column.considered);
  }

  const ranking = matrix.rows
    .filter(
      (row) =>
        row.student.indicatorEligible &&
        row.cells.length > 0 &&
        row.cells.every((cell) => cell.valueMilli !== null),
    )
    .map((row) => ({
      studentId: row.student.id,
      totalMilli: Number(
        row.cells.reduce((sum, cell) => sum + BigInt(cell.valueMilli!), 0n),
      ),
      partial: row.cells.some((cell) => cell.state === 'partial'),
      number: row.student.number,
    }))
    .sort(
      (left, right) =>
        right.totalMilli - left.totalMilli ||
        left.number - right.number ||
        left.studentId - right.studentId,
    )
    // Equal totals share a place (1º, 2º, 2º, 4º): everyone up to the tenth place is listed.
    .filter((entry, _index, sorted) => sorted.filter((other) => other.totalMilli > entry.totalMilli).length < 10)
    .map(({ number: _number, ...entry }) => entry);
  expect(overview.ranking).toEqual(ranking);

  return { analysis, overview, oracle };
}

function oracleComparison(
  current: AnalysisReadingV3,
  reference: AnalysisReadingV3,
): PerformanceTermComparisonValueV4 {
  const unavailableReason =
    current.bucket === 'excluded'
      ? 'current-excluded'
      : reference.bucket === 'excluded'
        ? 'reference-excluded'
        : !counts(current.state)
          ? 'current-incomplete'
          : !counts(reference.state)
            ? 'reference-incomplete'
            : current.maximumMilli === null || current.maximumMilli <= 0
              ? 'current-no-positive-maximum'
              : 'reference-no-positive-maximum';
  if (
    current.bucket === 'excluded' ||
    reference.bucket === 'excluded' ||
    !counts(current.state) ||
    !counts(reference.state) ||
    current.valueMilli === null ||
    reference.valueMilli === null ||
    current.maximumMilli === null ||
    reference.maximumMilli === null ||
    current.maximumMilli <= 0 ||
    reference.maximumMilli <= 0 ||
    current.percent === null ||
    reference.percent === null
  )
    return {
      key: current.key,
      state: 'unavailable',
      currentPercent: current.percent,
      referencePercent: reference.percent,
      deltaPercentagePoints: null,
      relation: null,
      reason: unavailableReason,
    };

  const left = BigInt(current.valueMilli) * BigInt(reference.maximumMilli);
  const right = BigInt(reference.valueMilli) * BigInt(current.maximumMilli);
  const relation = left === right ? 'equal' : left > right ? 'higher' : 'lower';
  return {
    key: current.key,
    state: 'comparable',
    currentPercent: current.percent,
    referencePercent: reference.percent,
    deltaPercentagePoints:
      relation === 'equal' ? 0 : current.percent - reference.percent,
    relation,
    reason: null,
  };
}

function proveTermComparison(
  matrix: PerformanceMatrixV2,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
  lens: 'result' | 'quantitative' | 'qualitative',
) {
  if (matrix.period !== 2 && matrix.period !== 3)
    throw new Error('proof-comparison-requires-current-term');
  const referencePeriod = (matrix.period - 1) as 1 | 2;
  const request = performanceTermComparisonRequestSchemaV4.parse({
    transportVersion: 4,
    operation: 'term-comparison',
    year: matrix.context.year,
    classId: matrix.classGroup.id,
    period: matrix.period,
    referencePeriod,
    mode: matrix.mode,
    statuses: [null, 7],
    lens,
    offerId: null,
  });
  const comparison = buildPerformanceTermComparisonV4(matrix, projections, request);
  const currentRequest = analysisRequest(matrix, lens, null, matrix.period);
  const referenceRequest = analysisRequest(matrix, lens, null, referencePeriod);
  const currentOracle = oracleAnalysis(matrix, projections, currentRequest);
  const referenceOracle = oracleAnalysis(matrix, projections, referenceRequest);
  expectAnalysis(comparison.analysis, currentOracle);

  const expectedRows = currentOracle.rows.map((row, rowIndex) => ({
    studentId: row.studentId,
    values: row.values.map((value, columnIndex) =>
      oracleComparison(
        value,
        referenceOracle.rows[rowIndex]!.values[columnIndex]!,
      ),
    ),
  }));
  expect(comparison.rows.map((row) => row.studentId)).toEqual(
    expectedRows.map((row) => row.studentId),
  );
  comparison.rows.forEach((row, rowIndex) =>
    row.values.forEach((value, columnIndex) => {
      const expectedValue = expectedRows[rowIndex]!.values[columnIndex]!;
      expect(value).toMatchObject({
        key: expectedValue.key,
        state: expectedValue.state,
        relation: expectedValue.relation,
        reason: expectedValue.reason,
      });
      expectMetric(value.currentPercent, expectedValue.currentPercent);
      expectMetric(value.referencePercent, expectedValue.referencePercent);
      expectMetric(
        value.deltaPercentagePoints,
        expectedValue.deltaPercentagePoints,
      );
    }),
  );

  comparison.columns.forEach((column, columnIndex) => {
    const groups = {
      higher: expectedRows
        .filter((row) => row.values[columnIndex]!.relation === 'higher')
        .map((row) => row.studentId),
      equal: expectedRows
        .filter((row) => row.values[columnIndex]!.relation === 'equal')
        .map((row) => row.studentId),
      lower: expectedRows
        .filter((row) => row.values[columnIndex]!.relation === 'lower')
        .map((row) => row.studentId),
      unavailable: expectedRows
        .filter((row) => row.values[columnIndex]!.state === 'unavailable')
        .map((row) => row.studentId),
    };
    expect(column.summary.groups).toEqual(groups);
    expect(column.summary.comparable).toBe(
      groups.higher.length + groups.equal.length + groups.lower.length,
    );
    expect(column.summary.unavailable).toBe(groups.unavailable.length);
  });
  return comparison;
}

describe('performance count proof #852', () => {
  it.each([
    { period: 1 as const, label: 'T1' },
    { period: 2 as const, label: 'T2' },
    { period: 3 as const, label: 'T3 empty' },
    { period: 'annual' as const, label: 'annual' },
  ])('recounts every V6 denominator from raw matrix/projection facts: $label', ({ period }) => {
    const { value, matrix, projections } = learningFixtureV1({ period });
    proofAllV6Scopes(value, matrix, projections);
  });

  it('keeps zero, missing eligible PARA, superior PARA, >100% and unknown maximum separated', () => {
    const { value, matrix, projections } = learningFixtureV1({
      period: 2,
      override: (fact, student, component) => {
        if (student === 0 && component === 0 && fact.term === 2 && fact.slot === 3)
          return { valueMilli: null };
        if (student === 1 && component === 0 && fact.term === 2 && fact.slot === 3)
          return { valueMilli: 13_000 };
        if (student === 2 && component === 1 && fact.term === 2 && fact.slot === 13)
          return { valueMilli: (fact.maximumMilli ?? 1) * 2 };
        if (component === 2 && fact.term === 2 && fact.slot === 13)
          return { maximumMilli: null };
        return {};
      },
    });
    proofAllV6Scopes(value, matrix, projections);
    expect(value.summary.partial).toBe(0);
    expect(
      value.students.some((item) => item.cells.some((cell) => cell.result.state === 'partial')),
    ).toBe(true);
    expect(value.summary.parallel.applied).toBeGreaterThan(0);
    expect(value.summary.coverage.zeros).toBeGreaterThan(0);
    expect(value.components.some((component) =>
      component.instruments.some((instrument) => instrument.stats.max !== null && instrument.stats.max > 100),
    )).toBe(true);
    expect(value.components.some((component) =>
      component.instruments.some((instrument) => instrument.maximumMilli === null),
    )).toBe(true);
    for (const lens of ['result', 'quantitative', 'qualitative', 'assessments'] as const)
      proveAnalysisAndDashboard(matrix, projections, lens);
  });

  it.each(['result', 'quantitative', 'qualitative', 'assessments'] as const)(
    'recounts every V3/V5 bar, panorama bucket and ranking for lens %s',
    (lens) => {
      const { matrix, projections } = learningFixtureV1({ period: 2 });
      proveAnalysisAndDashboard(matrix, projections, lens);
    },
  );

  it.each(['result', 'quantitative', 'qualitative'] as const)(
    'recomputes every V4 relation independently for lens %s',
    (lens) => {
      const { matrix, projections } = learningFixtureV1({ period: 2 });
      const comparison = proveTermComparison(matrix, projections, lens);
      expect(
        comparison.rows.reduce((sum, row) => sum + row.values.length, 0),
      ).toBe(comparison.rows.length * comparison.columns.length);
    },
  );

  it.each(['result', 'quantitative', 'qualitative'] as const)(
    'recomputes V4 relation edge cases independently for lens %s',
    (lens) => {
      const { matrix, projections } = learningFixtureV1({
        period: 2,
        override: (fact, student, component) => {
          if (student === 0 && component === 0 && fact.term === 2 && fact.slot === 3)
            return { valueMilli: null };
          if (student === 1 && component === 0 && fact.term === 2 && fact.slot === 3)
            return { valueMilli: 13_000 };
          if (student === 2 && component === 1 && fact.term === 2 && fact.slot === 13)
            return { maximumMilli: null };
          return {};
        },
      });
      proveTermComparison(matrix, projections, lens);
    },
  );
});
