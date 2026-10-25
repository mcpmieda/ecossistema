export type SimplifiedAcademicTermV1 = 1 | 2 | 3;

export const SIMPLIFIED_TERM_MAXIMUM_MILLI_V1 = Object.freeze({
  1: 30_000,
  2: 30_000,
  3: 40_000,
} as const);

export const SIMPLIFIED_ROUNDING_LOWER_MILLI_V1 = 300 as const;
export const SIMPLIFIED_ROUNDING_UPPER_MILLI_V1 = 750 as const;

export const SIMPLIFIED_INSTRUMENT_SLOTS_V1 = [
  1, 2, 3, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
] as const;
export type SimplifiedInstrumentSlotV1 = (typeof SIMPLIFIED_INSTRUMENT_SLOTS_V1)[number];

export interface SimplifiedInstrumentFactV1 {
  readonly slot: SimplifiedInstrumentSlotV1;
  readonly maximumMilli: number | null;
  readonly valueMilli: number | null;
}

export const SIMPLIFIED_ENGINE_WARNING_CODES_V1 = [
  'value-above-maximum',
  'parallel-present-when-not-applicable',
  'quantitative-maximum-mismatch',
  'qualitative-maximum-incomplete',
  'qualitative-maximum-mismatch',
  'recovery-above-term-maximum',
  'recovery-present-when-not-applicable',
] as const;
export type SimplifiedEngineWarningCodeV1 =
  (typeof SIMPLIFIED_ENGINE_WARNING_CODES_V1)[number];

export interface SimplifiedEngineWarningV1 {
  readonly code: SimplifiedEngineWarningCodeV1;
  readonly term: SimplifiedAcademicTermV1;
  readonly slot?: SimplifiedInstrumentSlotV1;
  readonly valueMilli?: number;
  readonly maximumMilli?: number;
}

export interface SimplifiedCoverageV1 {
  readonly complete: boolean;
  readonly requiredSlots: readonly SimplifiedInstrumentSlotV1[];
  readonly resolvedSlots: readonly SimplifiedInstrumentSlotV1[];
  readonly missingSlots: readonly SimplifiedInstrumentSlotV1[];
  readonly reasons: readonly string[];
}

export interface SimplifiedTermInputV1 {
  readonly term: SimplifiedAcademicTermV1;
  readonly instruments: readonly SimplifiedInstrumentFactV1[];
}

export interface SimplifiedTermOutcomeV1 {
  readonly term: SimplifiedAcademicTermV1;
  readonly termMaximumMilli: number;
  readonly expectedQuantitativeMaximumMilli: number;
  readonly expectedQualitativeMaximumMilli: number;
  readonly quantitativeOriginalMilli: number;
  readonly quantitativeMaximumMilli: number;
  readonly parallelMilli: number | null;
  /** Effective applicability: normal eligibility OR an explicitly recorded numeric PARA (#850). */
  readonly parallelApplicable: boolean | null;
  readonly quantitativeConsideredMilli: number;
  readonly qualitativeOperationalMilli: number;
  readonly rawMilli: number;
  readonly roundedMilli: number;
  readonly coverage: SimplifiedCoverageV1;
  readonly warnings: readonly SimplifiedEngineWarningV1[];
}

export type SimplifiedRecoveryValueV1 = number | null | 'NC' | 'RR';

export interface SimplifiedComponentRecoveryInputV1 {
  readonly terms: readonly [
    SimplifiedTermOutcomeV1,
    SimplifiedTermOutcomeV1,
    SimplifiedTermOutcomeV1,
  ];
  readonly recovery: Readonly<Record<SimplifiedAcademicTermV1, SimplifiedRecoveryValueV1>>;
  readonly minimumApprovalMilli: number;
}

export const SIMPLIFIED_COMPONENT_CLASSIFICATIONS_V1 = [
  'in-progress',
  'approved-direct',
  'recovery-pending',
  'approved-after-recovery',
  'not-approved',
  'failed-no-show',
  'failed-repeat',
] as const;
export type SimplifiedComponentClassificationV1 =
  (typeof SIMPLIFIED_COMPONENT_CLASSIFICATIONS_V1)[number];

export interface SimplifiedRecoveryTermOutcomeV1 {
  readonly term: SimplifiedAcademicTermV1;
  readonly applicable: boolean | null;
  readonly source: SimplifiedRecoveryValueV1;
  readonly replacementMilli: number | null;
}

export interface SimplifiedComponentRecoveryOutcomeV1 {
  readonly originalTotalMilli: number;
  readonly originalComplete: boolean;
  readonly recoveryRequired: boolean | null;
  readonly recoveryTerms: Readonly<Record<SimplifiedAcademicTermV1, SimplifiedRecoveryTermOutcomeV1>>;
  readonly postRecoveryTotalMilli: number | null;
  readonly classification: SimplifiedComponentClassificationV1;
  readonly warnings: readonly SimplifiedEngineWarningV1[];
}

function assertMilli(value: number, label: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
}

function termMaximum(term: SimplifiedAcademicTermV1): number {
  return SIMPLIFIED_TERM_MAXIMUM_MILLI_V1[term];
}

function expectedQuantitativeMaximum(term: SimplifiedAcademicTermV1): number {
  return (termMaximum(term) * 45) / 100;
}

function expectedQualitativeMaximum(term: SimplifiedAcademicTermV1): number {
  return (termMaximum(term) * 55) / 100;
}

export function roundSimplifiedGradeMilliV1(valueMilli: number): number {
  assertMilli(valueMilli, 'valueMilli');
  const whole = Math.floor(valueMilli / 1000) * 1000;
  const fraction = valueMilli % 1000;
  if (fraction < SIMPLIFIED_ROUNDING_LOWER_MILLI_V1) return whole;
  if (fraction < SIMPLIFIED_ROUNDING_UPPER_MILLI_V1) return whole + 500;
  return whole + 1000;
}

function instrumentMap(
  instruments: readonly SimplifiedInstrumentFactV1[],
): ReadonlyMap<SimplifiedInstrumentSlotV1, SimplifiedInstrumentFactV1> {
  const result = new Map<SimplifiedInstrumentSlotV1, SimplifiedInstrumentFactV1>();
  for (const instrument of instruments) {
    if (!SIMPLIFIED_INSTRUMENT_SLOTS_V1.includes(instrument.slot)) {
      throw new RangeError(`unsupported instrument slot ${String(instrument.slot)}`);
    }
    if (result.has(instrument.slot)) throw new RangeError(`duplicate instrument slot ${instrument.slot}`);
    if (instrument.maximumMilli !== null) assertMilli(instrument.maximumMilli, 'maximumMilli', false);
    if (instrument.valueMilli !== null) assertMilli(instrument.valueMilli, 'valueMilli');
    result.set(instrument.slot, instrument);
  }
  return result;
}

function sumValues(
  slots: readonly SimplifiedInstrumentSlotV1[],
  facts: ReadonlyMap<SimplifiedInstrumentSlotV1, SimplifiedInstrumentFactV1>,
): number {
  return slots.reduce((total, slot) => total + (facts.get(slot)?.valueMilli ?? 0), 0);
}

function valueWarning(
  term: SimplifiedAcademicTermV1,
  fact: SimplifiedInstrumentFactV1,
  effectiveMaximum: number | null = fact.maximumMilli,
): SimplifiedEngineWarningV1 | null {
  if (fact.valueMilli === null || effectiveMaximum === null || fact.valueMilli <= effectiveMaximum) {
    return null;
  }
  return {
    code: 'value-above-maximum',
    term,
    slot: fact.slot,
    valueMilli: fact.valueMilli,
    maximumMilli: effectiveMaximum,
  };
}

export function resolveSimplifiedTermV1(input: SimplifiedTermInputV1): SimplifiedTermOutcomeV1 {
  const maximum = termMaximum(input.term);
  const expectedQuantitative = expectedQuantitativeMaximum(input.term);
  const expectedQualitative = expectedQualitativeMaximum(input.term);
  const facts = instrumentMap(input.instruments);
  const av1 = facts.get(1);
  const av2 = facts.get(2);
  if (!av1 || !av2 || av1.maximumMilli === null || av2.maximumMilli === null) {
    throw new RangeError('AV1 and AV2 must exist with positive maximums');
  }

  const quantitativeSlots = [1, 2] as const;
  const qualitativeSlots = SIMPLIFIED_INSTRUMENT_SLOTS_V1.filter(
    (slot): slot is SimplifiedInstrumentSlotV1 => slot >= 11,
  ).filter((slot) => facts.has(slot));
  const quantitativeOriginal = sumValues(quantitativeSlots, facts);
  const quantitativeMaximum = av1.maximumMilli + av2.maximumMilli;
  const qualitativeOperational = sumValues(qualitativeSlots, facts);
  const totalBeforeParallel = quantitativeOriginal + qualitativeOperational;
  const parallel = facts.get(3)?.valueMilli ?? null;
  // BN-DEC-035: normal eligibility is evaluated BEFORE PARA and rounding.
  // A recorded numeric PARA (including zero) is the sole exception to eligibility.
  const parallelEligible =
    quantitativeOriginal * 5 < expectedQuantitative * 3 &&
    totalBeforeParallel * 5 < maximum * 3;
  const parallelApplicable = parallelEligible || parallel !== null;
  const quantitativeConsidered =
    parallelApplicable && parallel !== null && parallel > quantitativeOriginal
      ? parallel
      : quantitativeOriginal;
  const raw = quantitativeConsidered + qualitativeOperational;

  const warnings: SimplifiedEngineWarningV1[] = [];
  for (const fact of facts.values()) {
    const effectiveMaximum = fact.slot === 3 ? quantitativeMaximum : fact.maximumMilli;
    const warning = valueWarning(input.term, fact, effectiveMaximum);
    if (warning) warnings.push(warning);
  }
  // The historical parallel-present-when-not-applicable code remains decodable,
  // but a recorded PARA is now an allowed exception and must not emit that warning.
  if (quantitativeMaximum !== expectedQuantitative) {
    warnings.push({
      code: 'quantitative-maximum-mismatch',
      term: input.term,
      maximumMilli: quantitativeMaximum,
      valueMilli: expectedQuantitative,
    });
  }

  const qualitativeMaximumFacts = qualitativeSlots.map((slot) => facts.get(slot)!);
  const hasUnknownQualitativeMaximum = qualitativeMaximumFacts.some((fact) => fact.maximumMilli === null);
  const qualitativeMaximum = qualitativeMaximumFacts.reduce(
    (total, fact) => total + (fact.maximumMilli ?? 0),
    0,
  );
  if (hasUnknownQualitativeMaximum) {
    warnings.push({ code: 'qualitative-maximum-incomplete', term: input.term });
  } else if (qualitativeMaximum !== expectedQualitative) {
    warnings.push({
      code: 'qualitative-maximum-mismatch',
      term: input.term,
      maximumMilli: qualitativeMaximum,
      valueMilli: expectedQualitative,
    });
  }

  // An existing PARA participates when normally eligible or numerically recorded.
  // The exception is already resolved, so it never creates a missing-slot pendency.
  // Numeric zero resolves PARA; no other absence is cleared.
  const requiredSlots: SimplifiedInstrumentSlotV1[] = [
    1, 2, ...(parallelApplicable && facts.has(3) ? [3 as const] : []), ...qualitativeSlots,
  ];
  const resolvedSlots = requiredSlots.filter((slot) => facts.get(slot)?.valueMilli !== null && facts.get(slot)?.valueMilli !== undefined);
  const missingSlots = requiredSlots.filter((slot) => !resolvedSlots.includes(slot));
  const reasons: string[] = [];
  for (const slot of missingSlots) reasons.push(`missing-slot:${slot}`);

  return {
    term: input.term,
    termMaximumMilli: maximum,
    expectedQuantitativeMaximumMilli: expectedQuantitative,
    expectedQualitativeMaximumMilli: expectedQualitative,
    quantitativeOriginalMilli: quantitativeOriginal,
    quantitativeMaximumMilli: quantitativeMaximum,
    parallelMilli: parallel,
    parallelApplicable,
    quantitativeConsideredMilli: quantitativeConsidered,
    qualitativeOperationalMilli: qualitativeOperational,
    rawMilli: raw,
    roundedMilli: roundSimplifiedGradeMilliV1(raw),
    coverage: {
      // BN-DEC-042: a blank instrument is one the student did not do, so every term result is
      // final as it stands. The missing slots stay listed: they are what marks it "Parcial".
      complete: true,
      requiredSlots,
      resolvedSlots,
      missingSlots,
      reasons,
    },
    warnings,
  };
}

function orderedTerms(
  terms: SimplifiedComponentRecoveryInputV1['terms'],
): Readonly<Record<SimplifiedAcademicTermV1, SimplifiedTermOutcomeV1>> {
  const result = {} as Record<SimplifiedAcademicTermV1, SimplifiedTermOutcomeV1>;
  for (const term of terms) {
    if (result[term.term]) throw new RangeError(`duplicate term ${term.term}`);
    result[term.term] = term;
  }
  if (!result[1] || !result[2] || !result[3]) throw new RangeError('terms 1, 2, and 3 are required');
  return result;
}

type RecoveryTermInputV1 = SimplifiedComponentRecoveryInputV1['terms'][number];
type RecoverySourceV1 = SimplifiedComponentRecoveryInputV1['recovery'][SimplifiedAcademicTermV1];

/** A recovery value where none applies, or above the term's maximum. */
function recoveryWarningsV1(
  warnings: SimplifiedEngineWarningV1[],
  termNumber: SimplifiedAcademicTermV1,
  term: RecoveryTermInputV1,
  source: RecoverySourceV1,
  applicable: boolean | null,
) {
  if (applicable === false && source !== null) {
    warnings.push({
      code: 'recovery-present-when-not-applicable',
      term: termNumber,
      valueMilli: typeof source === 'number' ? source : undefined,
      maximumMilli: term.termMaximumMilli,
    });
  }
  if (typeof source === 'number' && source > term.termMaximumMilli) {
    warnings.push({
      code: 'recovery-above-term-maximum',
      term: termNumber,
      valueMilli: source,
      maximumMilli: term.termMaximumMilli,
    });
  }
}

/** The term's value after recovery: the recovery grade where it applies, the term grade where it
 * does not, and none while it is pending, missing, NC or RR. */
function recoveryReplacementV1(
  term: RecoveryTermInputV1,
  source: RecoverySourceV1,
  applicable: boolean | null,
): number | null {
  if (applicable === false) return term.roundedMilli;
  if (applicable === null) return null;
  return typeof source === 'number' ? source : null;
}

/** RR first, then an incomplete year, direct approval, NC, a pending recovery, and the total. */
function componentClassificationV1(facts: {
  hasRr: boolean;
  originalComplete: boolean;
  recoveryRequired: boolean | null;
  hasNc: boolean;
  missingApplicableRecovery: boolean;
  postRecoveryTotal: number | null;
  minimumApprovalMilli: number;
}): SimplifiedComponentClassificationV1 {
  if (facts.hasRr) return 'failed-repeat';
  if (!facts.originalComplete) return 'in-progress';
  if (facts.recoveryRequired === false) return 'approved-direct';
  if (facts.hasNc) return 'failed-no-show';
  if (facts.missingApplicableRecovery || facts.postRecoveryTotal === null) return 'recovery-pending';
  if (facts.postRecoveryTotal >= facts.minimumApprovalMilli) return 'approved-after-recovery';
  return 'not-approved';
}

export function resolveSimplifiedComponentRecoveryV1(
  input: SimplifiedComponentRecoveryInputV1,
): SimplifiedComponentRecoveryOutcomeV1 {
  assertMilli(input.minimumApprovalMilli, 'minimumApprovalMilli', false);
  const terms = orderedTerms(input.terms);
  const originalTotal = terms[1].roundedMilli + terms[2].roundedMilli + terms[3].roundedMilli;
  const originalComplete = terms[1].coverage.complete && terms[2].coverage.complete && terms[3].coverage.complete;
  const recoveryRequired = originalComplete ? originalTotal < input.minimumApprovalMilli : null;
  const warnings: SimplifiedEngineWarningV1[] = [];

  const recoveryTerms = {} as Record<SimplifiedAcademicTermV1, SimplifiedRecoveryTermOutcomeV1>;
  let hasRr = false;
  for (const termNumber of [1, 2, 3] as const) {
    const term = terms[termNumber];
    const source = input.recovery[termNumber];
    if (typeof source === 'number') assertMilli(source, `recovery[${termNumber}]`);
    if (source === 'RR') hasRr = true;
    const applicable =
      recoveryRequired === null
        ? null
        : recoveryRequired && term.roundedMilli * 5 < term.termMaximumMilli * 3;
    recoveryWarningsV1(warnings, termNumber, term, source, applicable);
    const replacement = recoveryReplacementV1(term, source, applicable);

    recoveryTerms[termNumber] = {
      term: termNumber,
      applicable,
      source,
      replacementMilli: replacement,
    };
  }

  const applied = Object.values(recoveryTerms).filter((term) => term.applicable === true);
  const hasNc = applied.some((term) => term.source === 'NC');
  const missingApplicableRecovery = applied.some((term) => term.source === null);
  const replacements = [
    recoveryTerms[1].replacementMilli,
    recoveryTerms[2].replacementMilli,
    recoveryTerms[3].replacementMilli,
  ];
  const postRecoveryTotal = replacements.every((value): value is number => value !== null)
    ? replacements.reduce((total, value) => total + value, 0)
    : null;

  const classification = componentClassificationV1({
    hasRr,
    originalComplete,
    recoveryRequired,
    hasNc,
    missingApplicableRecovery,
    postRecoveryTotal,
    minimumApprovalMilli: input.minimumApprovalMilli,
  });

  return {
    originalTotalMilli: originalTotal,
    originalComplete,
    recoveryRequired,
    recoveryTerms,
    postRecoveryTotalMilli: postRecoveryTotal,
    classification,
    warnings,
  };
}
