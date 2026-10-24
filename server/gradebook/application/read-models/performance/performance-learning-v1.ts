import { performanceResultCountsV2 } from '../../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import type { PerformanceAnalyticsV6 } from '../../../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import { isParticipationLabelV1, type PerformanceLearningV1 } from '../../../../../shared/gradebook-contracts/performance/performance-learning-v1';
import { performanceCellV2, type PerformanceProjectionV2, type PerformanceFactV2 } from '../../results/relational-performance-facts-v2';

const TERMS = [1, 2, 3] as const;
type Term = (typeof TERMS)[number];
const mean = (values: readonly number[]) => values.length
  ? values.reduce((sum, item) => sum + item / values.length, 0) : null;
const numeric = (values: readonly (number | null)[]) => values.filter((item): item is number => item !== null);
const participationFacts = (projection: PerformanceProjectionV2, terms: readonly Term[]) =>
  projection.facts.filter((fact) => terms.includes(fact.term) && fact.slot >= 11 && isParticipationLabelV1(fact.label));
function participationValue(facts: readonly PerformanceFactV2[]) {
  // BN-DEC-042: a blank instrument was not done, so it keeps its maximum and adds no points.
  // An instrument without a known maximum cannot be scaled and stays out, as before.
  const scaled = facts.filter((fact) => fact.maximumMilli !== null && fact.maximumMilli > 0);
  const valid = scaled.filter((fact) => fact.valueMilli !== null);
  const maximum = scaled.reduce((sum, fact) => sum + fact.maximumMilli!, 0);
  const points = valid.reduce((sum, fact) => sum + fact.valueMilli!, 0);
  if (!Number.isSafeInteger(maximum) || !Number.isSafeInteger(points)) throw new Error('learning-overflow');
  return {
    percent: maximum > 0 ? points / maximum * 100 : null,
    complete: facts.length > 0 && valid.length === facts.length,
    recorded: valid.length,
    expected: facts.length,
    unscaled: facts.filter((fact) => fact.maximumMilli === null || fact.maximumMilli <= 0).length,
  };
}

type LearningContextV1 = { selectedTerms: readonly Term[]; reference: Term | null; minimumPercent: number };
type LearningCellV1 = PerformanceAnalyticsV6['students'][number]['cells'][number];

/** Instruments of a term (no parallel, no participation) with a value and a maximum. */
function termInstrumentsV1(projection: PerformanceProjectionV2, term: Term) {
  return projection.facts.filter((fact) => fact.term === term && fact.slot !== 3 &&
    !(fact.slot >= 11 && isParticipationLabelV1(fact.label)) &&
    fact.valueMilli !== null && fact.maximumMilli !== null && fact.maximumMilli > 0);
}

/** Recurrence in one term: two or more instruments below the minimum (of three or more), or
 * below in this term and the one before. `assessed` says whether there was enough to tell. */
function termRecurrenceV1(projection: PerformanceProjectionV2, term: Term, minimumPercent: number) {
  let assessed = false, instruments = false, consecutive = false;
  const facts = termInstrumentsV1(projection, term);
  if (facts.length >= 3) {
    assessed = true;
    instruments =
      facts.filter((fact) => fact.valueMilli! / fact.maximumMilli! * 100 < minimumPercent).length >= 2;
  }
  if (term > 1) {
    const currentResult = performanceCellV2(projection, term, 'regular');
    const previousResult = performanceCellV2(projection, (term - 1) as Term, 'regular');
    if (performanceResultCountsV2(currentResult.state) && performanceResultCountsV2(previousResult.state)) {
      assessed = true;
      consecutive = currentResult.level === 'below' && previousResult.level === 'below';
    }
  }
  return { assessed, instruments, consecutive };
}

/** The points the parallel exam added to a term, in percentage points; null when it added none. */
function parallelGainV1(projection: PerformanceProjectionV2, term: Term) {
  const outcome = projection.terms[term - 1];
  if (!outcome || outcome.quantitativeMaximumMilli <= 0 ||
    outcome.quantitativeConsideredMilli <= outcome.quantitativeOriginalMilli) return null;
  return (outcome.quantitativeConsideredMilli - outcome.quantitativeOriginalMilli) / outcome.quantitativeMaximumMilli * 100;
}

/** Original two-assessment result, before parallel substitution, on the SAME complete pairs. */
function originalDimensionV1(cell: LearningCellV1, projection: PerformanceProjectionV2, selectedTerms: readonly Term[]) {
  if (!cell.quantitative.complete || !cell.qualitative.complete || cell.qualitative.percent === null) return null;
  const outcomes = selectedTerms.map((term) => projection.terms[term - 1]);
  if (!outcomes.every((outcome) => outcome !== null)) return null;
  const maximum = outcomes.reduce((sum, outcome) => sum + outcome!.quantitativeMaximumMilli, 0);
  const points = outcomes.reduce((sum, outcome) => sum + outcome!.quantitativeOriginalMilli, 0);
  if (maximum <= 0) return null;
  return { quantitative: points / maximum * 100, qualitative: cell.qualitative.percent };
}

/** One component of a student: participation now and its change, recurrence, parallel gains. */
function cellLearningV1(cell: LearningCellV1, projection: PerformanceProjectionV2, context: LearningContextV1) {
  const current = participationValue(participationFacts(projection, context.selectedTerms));
  let change: number | null = null;
  if (context.reference !== null && current.percent !== null) {
    const previous = participationValue(participationFacts(projection, [context.reference]));
    if (previous.percent !== null) change = current.percent - previous.percent;
  }
  const instrumentTerms: Term[] = [], consecutiveTerms: Term[] = [], gains: number[] = [];
  let assessed = false;
  for (const term of context.selectedTerms) {
    const recurrence = termRecurrenceV1(projection, term, context.minimumPercent);
    if (recurrence.assessed) assessed = true;
    if (recurrence.instruments) instrumentTerms.push(term);
    if (recurrence.consecutive) consecutiveTerms.push(term);
    const gain = parallelGainV1(projection, term);
    if (gain !== null) gains.push(gain);
  }
  const recurring = instrumentTerms.length || consecutiveTerms.length
    ? { offerId: cell.offerId, instrumentTerms, consecutiveTerms } : null;
  return { current, change, assessed, recurring, gains, dimension: originalDimensionV1(cell, projection, context.selectedTerms) };
}

/** A student's evidence over every component, and the totals the overview adds up. */
function studentLearningV1(
  student: PerformanceAnalyticsV6['students'][number],
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
  context: LearningContextV1,
) {
  const byOffer = new Map((projections.get(student.student.id) ?? []).map((projection) => [projection.offerId, projection]));
  const recurring: PerformanceLearningV1['students'][number]['recurring'] = [];
  const currentParticipation: number[] = [], participationChanges: number[] = [];
  const quantitative: number[] = [], qualitative: number[] = [], gains: number[] = [];
  let recorded = 0, expected = 0, unscaled = 0, recurrenceAssessed = false;
  for (const cell of student.cells) {
    const projection = byOffer.get(cell.offerId);
    if (!projection) throw new Error('learning-missing-projection');
    const result = cellLearningV1(cell, projection, context);
    recorded += result.current.recorded;
    expected += result.current.expected;
    unscaled += result.current.unscaled;
    if (result.current.percent !== null) currentParticipation.push(result.current.percent);
    if (result.change !== null) participationChanges.push(result.change);
    if (result.assessed) recurrenceAssessed = true;
    if (result.recurring) recurring.push(result.recurring);
    gains.push(...result.gains);
    if (result.dimension) {
      quantitative.push(result.dimension.quantitative);
      qualitative.push(result.dimension.qualitative);
    }
  }
  return {
    student: {
      studentId: student.student.id,
      recurrenceAssessed,
      recurring,
      participation: {
        percent: mean(currentParticipation), deltaPP: mean(participationChanges),
        components: currentParticipation.length, comparedComponents: participationChanges.length,
        recorded, expected, unscaled,
      },
      parallelImprovements: gains.length,
    },
    gains,
    dimensionComponents: quantitative.length,
    q: mean(quantitative),
    a: mean(qualitative),
  };
}

/** Descriptive evidence over the already authorized, repeatable-read projections.
 * No SQL, writes, academic recalculation, source-history ordering or browser-side inference. */
export function buildPerformanceLearningV1(
  value: PerformanceAnalyticsV6,
  projections: ReadonlyMap<number, readonly PerformanceProjectionV2[]>,
  includeStudentDimensions = true,
): PerformanceLearningV1 {
  const selectedTerms = value.period === 'annual' ? TERMS : [value.period];
  let reference: Term | null;
  if (value.period === 2) {
    reference = 1;
  } else if (value.period === 3) {
    reference = 2;
  } else {
    reference = null;
  }
  const context: LearningContextV1 = { selectedTerms, reference, minimumPercent: value.minimumPercent };
  const quantitativeStudents: number[] = [], qualitativeStudents: number[] = [], gains: number[] = [];
  let dimensionComponents = 0;
  const students: PerformanceLearningV1['students'] = value.students.map((student) => {
    const result = studentLearningV1(student, projections, context);
    gains.push(...result.gains);
    dimensionComponents += result.dimensionComponents;
    if (result.q !== null && result.a !== null) { quantitativeStudents.push(result.q); qualitativeStudents.push(result.a); }
    return {
      ...result.student,
      // Reuse the exact values already feeding the overview; never the legacy adjusted summaries.
      ...(includeStudentDimensions ? { dimensions: {
        quantitativePercent: result.q, qualitativePercent: result.a,
        gapPP: result.q !== null && result.a !== null ? result.a - result.q : null,
        components: result.dimensionComponents,
      } } : {}),
    };
  });
  const participation = students.map((student) => student.participation);
  const q = mean(quantitativeStudents), a = mean(qualitativeStudents);
  return {
    version: 1,
    students,
    participation: {
      percent: mean(numeric(participation.map((item) => item.percent))),
      deltaPP: mean(numeric(participation.map((item) => item.deltaPP))),
      students: participation.filter((item) => item.percent !== null).length,
      comparedStudents: participation.filter((item) => item.deltaPP !== null).length,
      recorded: participation.reduce((sum, item) => sum + item.recorded, 0),
      expected: participation.reduce((sum, item) => sum + item.expected, 0),
      unscaled: participation.reduce((sum, item) => sum + item.unscaled, 0),
    },
    dimensions: {
      quantitativePercent: q, qualitativePercent: a, gapPP: q !== null && a !== null ? a - q : null,
      students: quantitativeStudents.length, components: dimensionComponents,
    },
    parallel: {
      students: students.filter((student) => student.parallelImprovements > 0).length,
      improvements: gains.length, meanGainPP: mean(gains),
    },
    activitiesToReview: value.components.flatMap((component) => component.instruments)
      .filter((instrument) => instrument.slot >= 11 && !isParticipationLabelV1(instrument.label) &&
        instrument.stats.n >= 3 && instrument.maximumMilli !== null && instrument.maximumMilli > 0 && instrument.below > 0)
      .sort((left, right) => right.below / right.stats.n - left.below / left.stats.n ||
        (left.stats.mean ?? Infinity) - (right.stats.mean ?? Infinity) || left.key.localeCompare(right.key))
      .map((instrument) => instrument.key),
  };
}
