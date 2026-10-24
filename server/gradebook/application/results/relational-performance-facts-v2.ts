import { performanceResultCountsV2 } from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import {
  resolveSimplifiedTermV1,
  resolveSimplifiedComponentRecoveryV1,
  SIMPLIFIED_TERM_MAXIMUM_MILLI_V1,
  type SimplifiedAcademicTermV1,
  type SimplifiedInstrumentFactV1,
  type SimplifiedTermOutcomeV1,
  type SimplifiedComponentRecoveryOutcomeV1,
  type SimplifiedRecoveryValueV1,
} from '../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import type {
  PerformanceCellV2,
  PerformanceModeV2,
  PerformancePeriodV2,
} from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { resolveStudentMarkPresentationV1 } from '../../../../src/gradebook-domain/calculations/simplified/resolve-student-mark-presentation-v1';

export interface PerformanceFactV2 extends SimplifiedInstrumentFactV1 {
  readonly term: SimplifiedAcademicTermV1;
  readonly label: string;
  readonly observed?: boolean;
}
export interface PerformanceClosingV2 {
  readonly am: readonly [number | null, number | null, number | null];
  readonly rec: readonly [
    SimplifiedRecoveryValueV1,
    SimplifiedRecoveryValueV1,
    SimplifiedRecoveryValueV1,
  ];
  readonly u: number | null;
}
export const EMPTY_PERFORMANCE_CLOSING_V2: PerformanceClosingV2 = {
  am: [null, null, null],
  rec: [null, null, null],
  u: null,
};
export interface PerformanceProjectionV2 {
  readonly offerId: number;
  readonly facts: readonly PerformanceFactV2[];
  readonly terms: readonly [
    SimplifiedTermOutcomeV1 | null,
    SimplifiedTermOutcomeV1 | null,
    SimplifiedTermOutcomeV1 | null,
  ];
  readonly recovery: SimplifiedComponentRecoveryOutcomeV1 | null;
  readonly closing: PerformanceClosingV2;
  readonly minimumApprovalMilli: number;
}

export function performanceRecoveryCellIsRelevantV2(cell: PerformanceCellV2): boolean {
  return cell.recoveryApplicable === true || cell.state === 'repeat-failure';
}

const TERMS = [1, 2, 3] as const;
const ANNUAL_MAXIMUM = TERMS.reduce((sum, term) => sum + SIMPLIFIED_TERM_MAXIMUM_MILLI_V1[term], 0);

/** No academic formula here: incomplete structural definitions remain unavailable. */
export function projectPerformanceFactsV2(
  offerId: number,
  facts: readonly PerformanceFactV2[],
  closing: PerformanceClosingV2,
  minimumApprovalMilli: number,
): PerformanceProjectionV2 {
  const terms = TERMS.map((term) => {
    const instruments = facts.filter((fact) => fact.term === term);
    if (
      ![1, 2].every((slot) =>
        instruments.some((fact) => fact.slot === slot && fact.maximumMilli !== null),
      )
    )
      return null;
    return resolveSimplifiedTermV1({ term, instruments });
  }) as unknown as PerformanceProjectionV2['terms'];
  const [t1, t2, t3] = terms;
  const recovery =
    t1 && t2 && t3
      ? resolveSimplifiedComponentRecoveryV1({
          terms: [t1, t2, t3],
          recovery: { 1: closing.rec[0], 2: closing.rec[1], 3: closing.rec[2] },
          minimumApprovalMilli,
        })
      : null;
  return { offerId, facts, closing, terms, recovery, minimumApprovalMilli };
}

export function performanceCellV2(
  projection: PerformanceProjectionV2,
  period: PerformancePeriodV2,
  mode: PerformanceModeV2,
  includeRawSum = false,
): PerformanceCellV2 {
  const term = period === 'annual' ? null : (projection.terms[period - 1] ?? null);
  const recovery = projection.recovery;
  const maximumMilli =
    period === 'annual' ? ANNUAL_MAXIMUM : SIMPLIFIED_TERM_MAXIMUM_MILLI_V1[period];
  const applicable =
    period === 'annual'
      ? (recovery?.recoveryRequired ?? null)
      : (recovery?.recoveryTerms[period].applicable ?? null);
  const warnings = [
    ...(period === 'annual'
      ? projection.terms.flatMap((value) => value?.warnings ?? [])
      : (term?.warnings ?? [])),
    ...(mode === 'recovery'
      ? (recovery?.warnings.filter((value) => period === 'annual' || value.term === period) ?? [])
      : []),
  ];
  // The source's own result to compare with: U for the annual recovery, AM for a regular term.
  let sourceReferenceMilli = null;
  if (period === 'annual') {
    if (mode === 'recovery') sourceReferenceMilli = projection.closing.u;
  } else if (mode === 'regular') {
    sourceReferenceMilli = projection.closing.am[period - 1]!;
  }
  const base = {
    offerId: projection.offerId,
    maximumMilli,
    sourceReferenceMilli,
    recoveryApplicable: applicable,
    warningCodes: [...new Set(warnings.map((value) => value.code))],
  };
  let state: PerformanceCellV2['state'] = 'unavailable';
  let valueMilli: number | null = null;
  if (mode === 'regular') {
    const outcomes = period === 'annual' ? projection.terms : [term];
    if (outcomes.every((value) => value !== null)) {
      // BN-DEC-042: every result counts. "partial" only marks that some instrument is blank.
      state = outcomes.every((value) => value!.coverage.missingSlots.length === 0)
        ? 'complete'
        : 'partial';
      if (state === 'complete' || state === 'partial')
        valueMilli = period === 'annual' ? recovery!.originalTotalMilli : term!.roundedMilli;
    }
  } else if (period === 'annual' && recovery?.classification === 'failed-repeat') {
    state = 'repeat-failure';
  } else if (period !== 'annual' && recovery?.recoveryTerms[period].source === 'RR') {
    state = 'repeat-failure';
  } else if (applicable === false) state = 'not-applicable';
  else if (applicable === true && recovery !== null) {
    if (period === 'annual') {
      if (recovery.classification === 'failed-repeat') state = 'repeat-failure';
      else if (recovery.classification === 'failed-no-show') state = 'no-show';
      else if (recovery.postRecoveryTotalMilli === null) state = 'recovery-pending';
      else {
        state = 'complete';
        valueMilli = recovery.postRecoveryTotalMilli;
      }
    } else {
      const value = recovery.recoveryTerms[period].source;
      if (value === 'RR') state = 'repeat-failure';
      else if (value === 'NC') state = 'no-show';
      else if (value === null) state = 'recovery-pending';
      else {
        state = 'complete';
        valueMilli = value;
      }
    }
  }
  const meetsMinimum =
    state === 'complete' || state === 'partial'
      ? resolveStudentMarkPresentationV1({
          valueMilli,
          maximumMilli,
          minimumApprovalMilli: projection.minimumApprovalMilli,
        })
      : null;
  let level: 'below' | 'not-classified' | 'at-or-above' = 'below';
  if (state !== 'repeat-failure' && meetsMinimum === null) level = 'not-classified';
  else if (state !== 'repeat-failure' && meetsMinimum) level = 'at-or-above';
  let sourceComparison: 'unavailable' | 'match' | 'mismatch' = 'unavailable';
  if (performanceResultCountsV2(state) && base.sourceReferenceMilli !== null && valueMilli !== null)
    sourceComparison = valueMilli === base.sourceReferenceMilli ? 'match' : 'mismatch';
  return {
    ...base,
    state,
    valueMilli,
    ...(includeRawSum && mode === 'regular' && term !== null && valueMilli !== null
      ? { rawMilli: term.rawMilli }
      : {}),
    // This is a read-only proportional classification using the configured annual threshold.
    // It is not the separate central rule that determines REC eligibility.
    level,
    sourceComparison,
  };
}
