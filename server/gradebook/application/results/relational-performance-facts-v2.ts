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

type TermOutcomeV2 = PerformanceProjectionV2['terms'][number];
type CellResultV2 = { state: PerformanceCellV2['state']; valueMilli: number | null };

/** The warnings shown with a cell: of its term (or all terms), plus the recovery's in that mode. */
function cellWarningsV2(
  projection: PerformanceProjectionV2,
  period: PerformancePeriodV2,
  mode: PerformanceModeV2,
  term: TermOutcomeV2 | null,
) {
  const recovery = projection.recovery;
  return [
    ...(period === 'annual'
      ? projection.terms.flatMap((value) => value?.warnings ?? [])
      : (term?.warnings ?? [])),
    ...(mode === 'recovery'
      ? (recovery?.warnings.filter((value) => period === 'annual' || value.term === period) ?? [])
      : []),
  ];
}

/** The source's own result to compare with: U for the annual recovery, AM for a regular term. */
function sourceReferenceV2(
  projection: PerformanceProjectionV2,
  period: PerformancePeriodV2,
  mode: PerformanceModeV2,
): number | null {
  if (period === 'annual') return mode === 'recovery' ? projection.closing.u : null;
  return mode === 'regular' ? projection.closing.am[period - 1]! : null;
}

/** The regular result: the term's (or the year's original total) once every term is known. */
function regularResultV2(
  projection: PerformanceProjectionV2,
  period: PerformancePeriodV2,
  term: TermOutcomeV2 | null,
): CellResultV2 {
  const outcomes = period === 'annual' ? projection.terms : [term];
  if (!outcomes.every((value) => value !== null)) return { state: 'unavailable', valueMilli: null };
  // BN-DEC-042: every result counts. "partial" only marks that some instrument is blank.
  const state = outcomes.every((value) => value!.coverage.missingSlots.length === 0)
    ? 'complete'
    : 'partial';
  return {
    state,
    valueMilli: period === 'annual' ? projection.recovery!.originalTotalMilli : term!.roundedMilli,
  };
}

/** The recovery result: R/R first, then not applicable, then the recovery's own value. */
function recoveryResultV2(
  projection: PerformanceProjectionV2,
  period: PerformancePeriodV2,
  applicable: boolean | null,
): CellResultV2 {
  const recovery = projection.recovery;
  if (period === 'annual' && recovery?.classification === 'failed-repeat')
    return { state: 'repeat-failure', valueMilli: null };
  if (period !== 'annual' && recovery?.recoveryTerms[period].source === 'RR')
    return { state: 'repeat-failure', valueMilli: null };
  if (applicable === false) return { state: 'not-applicable', valueMilli: null };
  if (applicable !== true || recovery === null) return { state: 'unavailable', valueMilli: null };
  if (period === 'annual') return annualRecoveryResultV2(recovery);
  return termRecoveryResultV2(recovery.recoveryTerms[period].source);
}

function annualRecoveryResultV2(recovery: NonNullable<PerformanceProjectionV2['recovery']>): CellResultV2 {
  if (recovery.classification === 'failed-repeat') return { state: 'repeat-failure', valueMilli: null };
  if (recovery.classification === 'failed-no-show') return { state: 'no-show', valueMilli: null };
  if (recovery.postRecoveryTotalMilli === null) return { state: 'recovery-pending', valueMilli: null };
  return { state: 'complete', valueMilli: recovery.postRecoveryTotalMilli };
}

/** A term's REC source: R/R, N/C, still to come, or its grade. */
function termRecoveryResultV2(value: number | 'RR' | 'NC' | null): CellResultV2 {
  if (value === 'RR') return { state: 'repeat-failure', valueMilli: null };
  if (value === 'NC') return { state: 'no-show', valueMilli: null };
  if (value === null) return { state: 'recovery-pending', valueMilli: null };
  return { state: 'complete', valueMilli: value };
}

/** A read-only proportional classification using the configured annual threshold. */
function cellLevelV2(state: PerformanceCellV2['state'], meetsMinimum: boolean | null) {
  if (state === 'repeat-failure') return 'below';
  if (meetsMinimum === null) return 'not-classified';
  return meetsMinimum ? 'at-or-above' : 'below';
}

function sourceComparisonV2(
  state: PerformanceCellV2['state'],
  sourceReferenceMilli: number | null,
  valueMilli: number | null,
) {
  if (!performanceResultCountsV2(state) || sourceReferenceMilli === null || valueMilli === null)
    return 'unavailable';
  return valueMilli === sourceReferenceMilli ? 'match' : 'mismatch';
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
  const warnings = cellWarningsV2(projection, period, mode, term);
  const base = {
    offerId: projection.offerId,
    maximumMilli,
    sourceReferenceMilli: sourceReferenceV2(projection, period, mode),
    recoveryApplicable: applicable,
    warningCodes: [...new Set(warnings.map((value) => value.code))],
  };
  const { state, valueMilli } =
    mode === 'regular'
      ? regularResultV2(projection, period, term)
      : recoveryResultV2(projection, period, applicable);
  const meetsMinimum =
    state === 'complete' || state === 'partial'
      ? resolveStudentMarkPresentationV1({
          valueMilli,
          maximumMilli,
          minimumApprovalMilli: projection.minimumApprovalMilli,
        })
      : null;
  return {
    ...base,
    state,
    valueMilli,
    ...(includeRawSum && mode === 'regular' && term !== null && valueMilli !== null
      ? { rawMilli: term.rawMilli }
      : {}),
    // This is a read-only proportional classification using the configured annual threshold.
    // It is not the separate central rule that determines REC eligibility.
    level: cellLevelV2(state, meetsMinimum),
    sourceComparison: sourceComparisonV2(state, base.sourceReferenceMilli, valueMilli),
  };
}
