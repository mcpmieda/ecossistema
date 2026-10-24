import {
  ACADEMIC_TERMS_V1,
  type AcademicGradeValueV1,
  type AcademicTermV1,
  type ApplicabilityV1,
  type ResultCoverageV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';
import {
  NATIVE_TERM_COMPOSITION_PROFILE_2026_V1,
  type NativeTermCompositionProfileV1,
} from '../term/compose-native-term-result';

export interface NativeFinalRecoveryProfileV1 {
  readonly version: 1;
  readonly academicYear: 2026;
  readonly applicabilityRatio: 0.6;
  readonly termCompositionProfile: NativeTermCompositionProfileV1;
}

export const NATIVE_FINAL_RECOVERY_PROFILE_2026_V1: NativeFinalRecoveryProfileV1 = Object.freeze({
  version: 1,
  academicYear: 2026,
  applicabilityRatio: 0.6,
  termCompositionProfile: NATIVE_TERM_COMPOSITION_PROFILE_2026_V1,
});

export interface AcademicTermGradeMapV1 {
  readonly 1: AcademicGradeValueV1;
  readonly 2: AcademicGradeValueV1;
  readonly 3: AcademicGradeValueV1;
}

export interface NativeFinalRecoveryInputV1 {
  readonly originalTermGrades: AcademicTermGradeMapV1;
  readonly recoveryGrades: AcademicTermGradeMapV1;
}

export interface AcademicTermApplicabilityMapV1 {
  readonly 1: ApplicabilityV1;
  readonly 2: ApplicabilityV1;
  readonly 3: ApplicabilityV1;
}

export type FinalRecoveryApplicabilityInputV1 =
  | { readonly mode: 'native-derived' }
  | {
      readonly mode: 'source-observed';
      readonly terms: AcademicTermApplicabilityMapV1;
    };

export interface FinalRecoveryProjectionInputV1 extends NativeFinalRecoveryInputV1 {
  readonly applicability: FinalRecoveryApplicabilityInputV1;
}

export const NATIVE_FINAL_RECOVERY_FINDING_CODES_V1 = [
  'original-term-grade-below-zero',
  'original-term-grade-above-maximum',
  'recovery-grade-below-zero',
  'recovery-grade-above-maximum',
  'recovery-present-when-not-applicable',
  'recovery-state-conflicts-with-applicability',
] as const;
export type NativeFinalRecoveryFindingCodeV1 =
  (typeof NATIVE_FINAL_RECOVERY_FINDING_CODES_V1)[number];

export interface NativeFinalRecoveryFindingV1 {
  readonly code: NativeFinalRecoveryFindingCodeV1;
  readonly term: AcademicTermV1;
  readonly input: 'original-term-grade' | 'recovery-grade';
  readonly value?: number;
  readonly minimum?: 0;
  readonly maximum?: number;
  readonly message: string;
}

export interface NativeFinalRecoveryTermOutcomeV1 {
  readonly term: AcademicTermV1;
  readonly maximum: number;
  readonly applicabilityCutoff: number;
  readonly originalTermGrade: AcademicGradeValueV1;
  readonly applicability: ApplicabilityV1;
  readonly recoveryGrade: AcademicGradeValueV1;
  readonly replacementTermGrade: AcademicGradeValueV1;
  readonly coverage: ResultCoverageV1;
}

export interface NativeFinalRecoveryTermOutcomeMapV1 {
  readonly 1: NativeFinalRecoveryTermOutcomeV1;
  readonly 2: NativeFinalRecoveryTermOutcomeV1;
  readonly 3: NativeFinalRecoveryTermOutcomeV1;
}

export interface NativeFinalRecoveryOutcomeV1 {
  readonly profileVersion: 1;
  readonly academicYearProfile: 2026;
  readonly annualMaximum: number;
  readonly annualApplicabilityCutoff: number;
  readonly applicabilityRatio: 0.6;
  readonly inputs: NativeFinalRecoveryInputV1;
  readonly originalTotal: AcademicGradeValueV1;
  readonly annualApplicability: ApplicabilityV1;
  readonly terms: NativeFinalRecoveryTermOutcomeMapV1;
  readonly postRecoveryTotal: AcademicGradeValueV1;
  readonly coverage: ResultCoverageV1;
  readonly findings: readonly NativeFinalRecoveryFindingV1[];
}

const INVALID_PROFILE_MESSAGE =
  'profile must match native final recovery 2026 V1: applicability 0.6 and integrated term composition profile';

function validateProfile(profile: NativeFinalRecoveryProfileV1): void {
  const composition = profile?.termCompositionProfile;
  const expected = NATIVE_TERM_COMPOSITION_PROFILE_2026_V1;
  const rounding = composition?.roundingProfile;
  const expectedRounding = expected.roundingProfile;

  if (
    profile === null ||
    typeof profile !== 'object' ||
    profile.version !== 1 ||
    profile.academicYear !== 2026 ||
    profile.applicabilityRatio !== 0.6 || // NOSONAR: the exact literal the source/profile carries, never a computed value
    composition?.version !== expected.version ||
    composition.academicYear !== expected.academicYear ||
    composition.termMaximums?.[1] !== expected.termMaximums[1] ||
    composition.termMaximums?.[2] !== expected.termMaximums[2] ||
    composition.termMaximums?.[3] !== expected.termMaximums[3] ||
    composition.quantitativeWeight !== expected.quantitativeWeight ||
    composition.qualitativeWeight !== expected.qualitativeWeight ||
    rounding?.version !== expectedRounding.version ||
    rounding.lowerThreshold !== expectedRounding.lowerThreshold ||
    rounding.upperThreshold !== expectedRounding.upperThreshold ||
    rounding.middleIncrement !== expectedRounding.middleIncrement
  ) {
    throw new RangeError(INVALID_PROFILE_MESSAGE);
  }
}

function normalizeDerivedProfileValue(value: number): number {
  return Number(value.toFixed(12));
}

function numericValue(
  value: AcademicGradeValueV1,
  input: 'original-term-grade' | 'recovery-grade',
  term: AcademicTermV1,
): number | null {
  switch (value.state) {
    case 'numeric':
    case 'official-zero':
    case 'legacy-zero':
      if (!Number.isFinite(value.value)) {
        throw new RangeError(`${input}[${term}] value must be a finite number`);
      }
      return value.value;
    case 'absent':
    case 'not-applicable':
    case 'insufficient-data':
      return null;
  }
}

function rangeFinding(
  input: 'original-term-grade' | 'recovery-grade',
  term: AcademicTermV1,
  value: number,
  maximum: number,
): NativeFinalRecoveryFindingV1 | null {
  if (value < 0) {
    return {
      code:
        input === 'original-term-grade'
          ? 'original-term-grade-below-zero'
          : 'recovery-grade-below-zero',
      term,
      input,
      value,
      minimum: 0,
      maximum,
      message: `${input}[${term}] value ${value} is below the allowed minimum 0`,
    };
  }

  if (value > maximum) {
    return {
      code:
        input === 'original-term-grade'
          ? 'original-term-grade-above-maximum'
          : 'recovery-grade-above-maximum',
      term,
      input,
      value,
      minimum: 0,
      maximum,
      message: `${input}[${term}] value ${value} exceeds the allowed maximum ${maximum}`,
    };
  }

  return null;
}

function reasonForState(
  input: 'original-term-grade' | 'recovery-grade',
  term: AcademicTermV1,
  value: AcademicGradeValueV1,
): string | null {
  switch (value.state) {
    case 'absent':
      return `${input}[${term}]:absent`;
    case 'not-applicable':
      return `${input}[${term}]:not-applicable${value.reason ? ':' + value.reason : ''}`;
    case 'insufficient-data':
      return `${input}[${term}]:insufficient-data:${value.reason}`;
    case 'numeric':
    case 'official-zero':
    case 'legacy-zero':
      return null;
  }
}

function unresolvedGrade(reason: string): AcademicGradeValueV1 {
  return { state: 'insufficient-data', reason };
}

function isComparable(value: AcademicGradeValueV1): boolean {
  return (
    value.state === 'numeric' || value.state === 'official-zero' || value.state === 'legacy-zero'
  );
}

function annualOriginalTotal(
  input: NativeFinalRecoveryInputV1,
  originalValues: Readonly<Record<AcademicTermV1, number | null>>,
  originalFindings: Readonly<Record<AcademicTermV1, NativeFinalRecoveryFindingV1 | null>>,
): AcademicGradeValueV1 {
  const notApplicable = ACADEMIC_TERMS_V1.find(
    (term) => input.originalTermGrades[term].state === 'not-applicable',
  );
  if (notApplicable !== undefined) {
    const grade = input.originalTermGrades[notApplicable];
    return {
      state: 'not-applicable',
      reason:
        grade.state === 'not-applicable'
          ? (grade.reason ?? `original term grade ${notApplicable} is not applicable`)
          : `original term grade ${notApplicable} is not applicable`,
    };
  }

  const allResolved = ACADEMIC_TERMS_V1.every(
    (term) => originalValues[term] !== null && originalFindings[term] === null,
  );
  if (allResolved) {
    return {
      state: 'numeric',
      value: normalizeDerivedProfileValue(
        ACADEMIC_TERMS_V1.reduce((total, term) => total + (originalValues[term] ?? 0), 0),
      ),
    };
  }

  const reasons = ACADEMIC_TERMS_V1.flatMap((term) => {
    const stateReason = reasonForState('original-term-grade', term, input.originalTermGrades[term]);
    const finding = originalFindings[term];
    return [stateReason, finding?.code ?? null].filter(
      (reason): reason is string => reason !== null,
    );
  });
  return unresolvedGrade(
    `annual original total requires three valid term grades: ${reasons.join(', ')}`,
  );
}

function annualApplicability(originalTotal: AcademicGradeValueV1, cutoff: number): ApplicabilityV1 {
  if (originalTotal.state === 'not-applicable') {
    return {
      state: 'not-applicable',
      reason: originalTotal.reason ?? 'annual original total is not applicable',
    };
  }

  if (originalTotal.state !== 'numeric') {
    return {
      state: 'insufficient-data',
      reason: 'final recovery applicability requires a comparable annual original total',
    };
  }

  if (originalTotal.value < cutoff) return { state: 'applicable' };
  return {
    state: 'not-applicable',
    reason: 'annual original total reached the 60 point applicability cutoff',
  };
}

function observedAnnualApplicability(terms: AcademicTermApplicabilityMapV1): ApplicabilityV1 {
  const insufficientTerm = ACADEMIC_TERMS_V1.find(
    (term) => terms[term].state === 'insufficient-data',
  );
  if (insufficientTerm !== undefined) {
    const value = terms[insufficientTerm];
    return {
      state: 'insufficient-data',
      reason:
        value.state === 'insufficient-data'
          ? `source applicability for term ${insufficientTerm} is unresolved: ${value.reason}`
          : `source applicability for term ${insufficientTerm} is unresolved`,
    };
  }
  if (ACADEMIC_TERMS_V1.some((term) => terms[term].state === 'applicable')) {
    return { state: 'applicable' };
  }
  return {
    state: 'not-applicable',
    reason: 'all three source REC flags are explicitly not applicable',
  };
}

function termApplicability(
  annual: ApplicabilityV1,
  originalValue: number | null,
  originalFinding: NativeFinalRecoveryFindingV1 | null,
  cutoff: number,
): ApplicabilityV1 {
  if (annual.state === 'not-applicable') {
    return {
      state: 'not-applicable',
      reason: annual.reason ?? 'final recovery is not applicable to the annual result',
    };
  }
  if (annual.state === 'insufficient-data' || originalValue === null || originalFinding) {
    return {
      state: 'insufficient-data',
      reason:
        'term recovery applicability requires an applicable annual result and valid original term grade',
    };
  }
  if (originalValue < cutoff) return { state: 'applicable' };
  return {
    state: 'not-applicable',
    reason: 'original term grade reached the 60% applicability cutoff',
  };
}

function termCoverage(
  term: AcademicTermV1,
  applicability: ApplicabilityV1,
  originalResolved: boolean,
  recoveryResolved: boolean,
  original: AcademicGradeValueV1,
  recovery: AcademicGradeValueV1,
  termFindings: readonly NativeFinalRecoveryFindingV1[],
): ResultCoverageV1 {
  const recoverySlotResolved = applicability.state === 'not-applicable' || recoveryResolved;
  const resolvedItemCount = Number(originalResolved) + Number(recoverySlotResolved);
  const reasons = Array.from(
    new Set(
      [
        reasonForState('original-term-grade', term, original),
        applicability.state === 'applicable'
          ? reasonForState('recovery-grade', term, recovery)
          : null,
        applicability.state === 'insufficient-data'
          ? `applicability:insufficient-data:${applicability.reason}`
          : null,
        ...termFindings.map((finding) => finding.code),
      ].filter((reason): reason is string => reason !== null),
    ),
  );

  let state: ResultCoverageV1['state'];
  if (applicability.state === 'not-applicable') {
    state = 'not-applicable';
  } else if (
    applicability.state === 'insufficient-data' ||
    original.state === 'insufficient-data' ||
    recovery.state === 'insufficient-data' ||
    (applicability.state === 'applicable' && recovery.state === 'not-applicable') ||
    termFindings.length > 0
  ) {
    state = 'insufficient-data';
  } else if (resolvedItemCount === 2) {
    state = 'complete';
  } else if (resolvedItemCount > 0) {
    state = 'partial';
  } else {
    state = 'insufficient-data';
  }

  return {
    state,
    expectedItemCount: 2,
    resolvedItemCount,
    missingItemCount: 2 - resolvedItemCount,
    reasons,
  };
}

function replacementGrade(
  term: AcademicTermV1,
  applicability: ApplicabilityV1,
  original: AcademicGradeValueV1,
  originalResolved: boolean,
  recovery: AcademicGradeValueV1,
  recoveryResolved: boolean,
): AcademicGradeValueV1 {
  if (applicability.state === 'applicable') {
    return recoveryResolved
      ? recovery
      : unresolvedGrade(`term ${term} requires a valid recovery grade for replacement`);
  }
  if (applicability.state === 'not-applicable') {
    if (originalResolved || original.state === 'not-applicable') return original;
    return unresolvedGrade(`term ${term} requires a valid original grade`);
  }
  return unresolvedGrade(`term ${term} replacement cannot be resolved before applicability`);
}

function postRecoveryTotal(
  originalTotal: AcademicGradeValueV1,
  annual: ApplicabilityV1,
  terms: NativeFinalRecoveryTermOutcomeMapV1,
): AcademicGradeValueV1 {
  if (annual.state === 'not-applicable') return originalTotal;
  if (annual.state === 'insufficient-data') {
    return unresolvedGrade('post-recovery total requires a comparable annual original total');
  }

  const values = ACADEMIC_TERMS_V1.map((term) => terms[term].replacementTermGrade);
  if (!values.every(isComparable)) {
    return unresolvedGrade('post-recovery total requires all necessary term replacements');
  }
  return {
    state: 'numeric',
    value: normalizeDerivedProfileValue(
      values.reduce((total, grade) => {
        if (
          grade.state === 'numeric' ||
          grade.state === 'official-zero' ||
          grade.state === 'legacy-zero'
        ) {
          return total + grade.value;
        }
        return total;
      }, 0),
    ),
  };
}

function consolidatedCoverage(
  annual: ApplicabilityV1,
  terms: NativeFinalRecoveryTermOutcomeMapV1,
): ResultCoverageV1 {
  const resolvedItemCount = ACADEMIC_TERMS_V1.reduce(
    (total, term) => total + terms[term].coverage.resolvedItemCount,
    0,
  );
  const expectedItemCount = ACADEMIC_TERMS_V1.length * 2;
  const reasons = Array.from(
    new Set(
      ACADEMIC_TERMS_V1.flatMap((term) =>
        terms[term].coverage.reasons.map((reason) => `term-${term}:${reason}`),
      ),
    ),
  );

  let state: ResultCoverageV1['state'];
  if (annual.state === 'not-applicable') {
    state = 'not-applicable';
  } else if (
    annual.state === 'insufficient-data' ||
    ACADEMIC_TERMS_V1.some((term) => terms[term].coverage.state === 'insufficient-data')
  ) {
    state = 'insufficient-data';
  } else if (resolvedItemCount === expectedItemCount) {
    state = 'complete';
  } else if (resolvedItemCount > 0) {
    state = 'partial';
  } else {
    state = 'insufficient-data';
  }

  return {
    state,
    expectedItemCount,
    resolvedItemCount,
    missingItemCount: expectedItemCount - resolvedItemCount,
    reasons,
  };
}

export function resolveFinalRecoveryProjectionV1(
  input: FinalRecoveryProjectionInputV1,
  profile: NativeFinalRecoveryProfileV1,
): NativeFinalRecoveryOutcomeV1 {
  validateProfile(profile);

  const maximums = profile.termCompositionProfile.termMaximums;
  const originalValues = {} as Record<AcademicTermV1, number | null>;
  const recoveryValues = {} as Record<AcademicTermV1, number | null>;
  const originalFindings = {} as Record<AcademicTermV1, NativeFinalRecoveryFindingV1 | null>;
  const recoveryFindings = {} as Record<AcademicTermV1, NativeFinalRecoveryFindingV1 | null>;

  for (const term of ACADEMIC_TERMS_V1) {
    originalValues[term] = numericValue(
      input.originalTermGrades[term],
      'original-term-grade',
      term,
    );
    recoveryValues[term] = numericValue(input.recoveryGrades[term], 'recovery-grade', term);
    originalFindings[term] =
      originalValues[term] === null
        ? null
        : rangeFinding('original-term-grade', term, originalValues[term], maximums[term]);
    recoveryFindings[term] =
      recoveryValues[term] === null
        ? null
        : rangeFinding('recovery-grade', term, recoveryValues[term], maximums[term]);
  }

  const annualMaximum = ACADEMIC_TERMS_V1.reduce((total, term) => total + maximums[term], 0);
  const annualApplicabilityCutoff = normalizeDerivedProfileValue(
    annualMaximum * profile.applicabilityRatio,
  );
  const originalTotal = annualOriginalTotal(input, originalValues, originalFindings);
  const calculatedAnnualApplicability =
    input.applicability.mode === 'native-derived'
      ? annualApplicability(originalTotal, annualApplicabilityCutoff)
      : observedAnnualApplicability(input.applicability.terms);
  const findings: NativeFinalRecoveryFindingV1[] = [];
  const termOutcomes = {} as Record<AcademicTermV1, NativeFinalRecoveryTermOutcomeV1>;

  for (const term of ACADEMIC_TERMS_V1) {
    const termMaximum = maximums[term];
    const applicabilityCutoff = normalizeDerivedProfileValue(
      termMaximum * profile.applicabilityRatio,
    );
    const applicability =
      input.applicability.mode === 'native-derived'
        ? termApplicability(
            calculatedAnnualApplicability,
            originalValues[term],
            originalFindings[term],
            applicabilityCutoff,
          )
        : input.applicability.terms[term];
    const termFindings: NativeFinalRecoveryFindingV1[] = [];
    if (originalFindings[term]) termFindings.push(originalFindings[term]);
    if (recoveryFindings[term]) termFindings.push(recoveryFindings[term]);

    if (applicability.state === 'not-applicable' && recoveryValues[term] !== null) {
      termFindings.push({
        code: 'recovery-present-when-not-applicable',
        term,
        input: 'recovery-grade',
        value: recoveryValues[term] ?? undefined,
        minimum: 0,
        maximum: termMaximum,
        message: `recovery-grade[${term}] was provided even though final recovery is not applicable`,
      });
    }
    if (
      applicability.state === 'applicable' &&
      input.recoveryGrades[term].state === 'not-applicable'
    ) {
      termFindings.push({
        code: 'recovery-state-conflicts-with-applicability',
        term,
        input: 'recovery-grade',
        message: `recovery-grade[${term}] is marked not-applicable although final recovery applies`,
      });
    }

    findings.push(...termFindings);
    const originalResolved = originalValues[term] !== null && originalFindings[term] === null;
    const recoveryResolved = recoveryValues[term] !== null && recoveryFindings[term] === null;
    termOutcomes[term] = {
      term,
      maximum: termMaximum,
      applicabilityCutoff,
      originalTermGrade: input.originalTermGrades[term],
      applicability,
      recoveryGrade: input.recoveryGrades[term],
      replacementTermGrade: replacementGrade(
        term,
        applicability,
        input.originalTermGrades[term],
        originalResolved,
        input.recoveryGrades[term],
        recoveryResolved,
      ),
      coverage: termCoverage(
        term,
        applicability,
        originalResolved,
        recoveryResolved,
        input.originalTermGrades[term],
        input.recoveryGrades[term],
        termFindings,
      ),
    };
  }

  const terms: NativeFinalRecoveryTermOutcomeMapV1 = {
    1: termOutcomes[1],
    2: termOutcomes[2],
    3: termOutcomes[3],
  };
  return {
    profileVersion: profile.version,
    academicYearProfile: profile.academicYear,
    annualMaximum,
    annualApplicabilityCutoff,
    applicabilityRatio: profile.applicabilityRatio,
    inputs: {
      originalTermGrades: input.originalTermGrades,
      recoveryGrades: input.recoveryGrades,
    },
    originalTotal,
    annualApplicability: calculatedAnnualApplicability,
    terms,
    postRecoveryTotal: postRecoveryTotal(originalTotal, calculatedAnnualApplicability, terms),
    coverage: consolidatedCoverage(calculatedAnnualApplicability, terms),
    findings,
  };
}

/** Existing native API preserved exactly; it delegates to the shared resolver core. */
export function resolveNativeFinalRecovery(
  input: NativeFinalRecoveryInputV1,
  profile: NativeFinalRecoveryProfileV1,
): NativeFinalRecoveryOutcomeV1 {
  return resolveFinalRecoveryProjectionV1(
    { ...input, applicability: { mode: 'native-derived' } },
    profile,
  );
}
