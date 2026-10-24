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
  const quantitativeStudents: number[] = [], qualitativeStudents: number[] = [], gains: number[] = [];
  let dimensionComponents = 0;
  const students: PerformanceLearningV1['students'] = value.students.map((student) => {
    const byOffer = new Map((projections.get(student.student.id) ?? []).map((projection) => [projection.offerId, projection]));
    const recurring: PerformanceLearningV1['students'][number]['recurring'] = [];
    const currentParticipation: number[] = [], participationChanges: number[] = [];
    const quantitative: number[] = [], qualitative: number[] = [];
    let recorded = 0, expected = 0, unscaled = 0, parallelImprovements = 0, recurrenceAssessed = false;
    for (const cell of student.cells) {
      const projection = byOffer.get(cell.offerId);
      if (!projection) throw new Error('learning-missing-projection');
      const current = participationValue(participationFacts(projection, selectedTerms));
      recorded += current.recorded;
      expected += current.expected;
      unscaled += current.unscaled;
      if (current.percent !== null) currentParticipation.push(current.percent);
      if (reference !== null && current.percent !== null) {
        const previous = participationValue(participationFacts(projection, [reference]));
        if (previous.percent !== null)
          participationChanges.push(current.percent - previous.percent);
      }
      const instrumentTerms: Term[] = [], consecutiveTerms: Term[] = [];
      for (const term of selectedTerms) {
        const facts = projection.facts.filter((fact) => fact.term === term && fact.slot !== 3 &&
          !(fact.slot >= 11 && isParticipationLabelV1(fact.label)) &&
          fact.valueMilli !== null && fact.maximumMilli !== null && fact.maximumMilli > 0);
        if (facts.length >= 3) {
          recurrenceAssessed = true;
          if (facts.filter((fact) => fact.valueMilli! / fact.maximumMilli! * 100 < value.minimumPercent).length >= 2)
            instrumentTerms.push(term);
        }
        if (term > 1) {
          const currentResult = performanceCellV2(projection, term, 'regular');
          const previousResult = performanceCellV2(projection, (term - 1) as Term, 'regular');
          if (
            performanceResultCountsV2(currentResult.state) &&
            performanceResultCountsV2(previousResult.state)
          ) {
            recurrenceAssessed = true;
            if (currentResult.level === 'below' && previousResult.level === 'below') consecutiveTerms.push(term);
          }
        }
        const outcome = projection.terms[term - 1];
        if (outcome && outcome.quantitativeMaximumMilli > 0 &&
          outcome.quantitativeConsideredMilli > outcome.quantitativeOriginalMilli) {
          parallelImprovements++;
          gains.push((outcome.quantitativeConsideredMilli - outcome.quantitativeOriginalMilli) / outcome.quantitativeMaximumMilli * 100);
        }
      }
      if (instrumentTerms.length || consecutiveTerms.length)
        recurring.push({ offerId: cell.offerId, instrumentTerms, consecutiveTerms });
      // Original two-assessment result, before parallel substitution, on the SAME complete pairs.
      if (cell.quantitative.complete && cell.qualitative.complete && cell.qualitative.percent !== null) {
        const outcomes = selectedTerms.map((term) => projection.terms[term - 1]);
        if (outcomes.every((outcome) => outcome !== null)) {
          const maximum = outcomes.reduce((sum, outcome) => sum + outcome!.quantitativeMaximumMilli, 0);
          const points = outcomes.reduce((sum, outcome) => sum + outcome!.quantitativeOriginalMilli, 0);
          if (maximum > 0) {
            quantitative.push(points / maximum * 100);
            qualitative.push(cell.qualitative.percent);
            dimensionComponents++;
          }
        }
      }
    }
    const q = mean(quantitative), a = mean(qualitative);
    if (q !== null && a !== null) { quantitativeStudents.push(q); qualitativeStudents.push(a); }
    return {
      studentId: student.student.id,
      recurrenceAssessed,
      recurring,
      participation: {
        percent: mean(currentParticipation), deltaPP: mean(participationChanges),
        components: currentParticipation.length, comparedComponents: participationChanges.length,
        recorded, expected, unscaled,
      },
      parallelImprovements,
      // Reuse the exact values already feeding the overview; never the legacy adjusted summaries.
      ...(includeStudentDimensions ? { dimensions: {
        quantitativePercent: q, qualitativePercent: a,
        gapPP: q !== null && a !== null ? a - q : null,
        components: quantitative.length,
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
