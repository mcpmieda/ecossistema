import type {
  AcademicGradeValueV1,
  AcademicTermV1,
  ApplicabilityV1,
  ResultCoverageV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';
import {
  NATIVE_TERM_COMPOSITION_PROFILE_2026_V1,
  type NativeTermCompositionProfileV1,
} from '../term/compose-native-term-result';

export interface NativeParallelRecoveryProfileV1 {
  readonly version: 1;
  readonly academicYear: 2026;
  readonly applicabilityRatio: 0.6;
  readonly termCompositionProfile: NativeTermCompositionProfileV1;
}

export const NATIVE_PARALLEL_RECOVERY_PROFILE_2026_V1: NativeParallelRecoveryProfileV1 =
  Object.freeze({
    version: 1,
    academicYear: 2026,
    applicabilityRatio: 0.6,
    termCompositionProfile: NATIVE_TERM_COMPOSITION_PROFILE_2026_V1,
  });

export interface NativeParallelRecoveryInputV1 {
  readonly term: AcademicTermV1;
  readonly quantitativeOriginal: AcademicGradeValueV1;
  readonly parallelRecovery: AcademicGradeValueV1;
}

export const NATIVE_PARALLEL_RECOVERY_FINDING_CODES_V1 = [
  'quantitative-original-below-zero',
  'quantitative-original-above-maximum',
  'parallel-recovery-below-zero',
  'parallel-recovery-above-maximum',
  'parallel-recovery-present-when-not-applicable',
  'parallel-recovery-state-conflicts-with-applicability',
] as const;
export type NativeParallelRecoveryFindingCodeV1 =
  (typeof NATIVE_PARALLEL_RECOVERY_FINDING_CODES_V1)[number];

export interface NativeParallelRecoveryFindingV1 {
  readonly code: NativeParallelRecoveryFindingCodeV1;
  readonly input: 'quantitative-original' | 'parallel-recovery';
  readonly value?: number;
  readonly minimum?: 0;
  readonly maximum?: number;
  readonly message: string;
}

export interface NativeParallelRecoveryV1 {
  readonly profileVersion: 1;
  readonly academicYearProfile: 2026;
  readonly term: AcademicTermV1;
  readonly quantitativeMaximum: number;
  readonly applicabilityCutoff: number;
  readonly applicabilityRatio: 0.6;
  readonly inputs: {
    readonly quantitativeOriginal: AcademicGradeValueV1;
    readonly parallelRecovery: AcademicGradeValueV1;
  };
  readonly applicability: ApplicabilityV1;
  readonly quantitativeConsidered: AcademicGradeValueV1;
  readonly gain: number | null;
  readonly coverage: ResultCoverageV1;
  readonly findings: readonly NativeParallelRecoveryFindingV1[];
}

const INVALID_PROFILE_MESSAGE =
  'profile must match native parallel recovery 2026 V1: applicability 0.6 and integrated term composition profile';

function validateProfile(profile: NativeParallelRecoveryProfileV1): void {
  const composition = profile?.termCompositionProfile;
  const rounding = composition?.roundingProfile;
  const expectedComposition = NATIVE_TERM_COMPOSITION_PROFILE_2026_V1;
  const expectedRounding = expectedComposition.roundingProfile;

  if (
    profile === null ||
    typeof profile !== 'object' ||
    profile.version !== 1 ||
    profile.academicYear !== 2026 ||
    profile.applicabilityRatio !== 0.6 || // NOSONAR: the exact literal the source/profile carries, never a computed value
    composition?.version !== expectedComposition.version ||
    composition.academicYear !== expectedComposition.academicYear ||
    composition.termMaximums?.[1] !== expectedComposition.termMaximums[1] ||
    composition.termMaximums?.[2] !== expectedComposition.termMaximums[2] ||
    composition.termMaximums?.[3] !== expectedComposition.termMaximums[3] ||
    composition.quantitativeWeight !== expectedComposition.quantitativeWeight ||
    composition.qualitativeWeight !== expectedComposition.qualitativeWeight ||
    rounding?.version !== expectedRounding.version ||
    rounding.lowerThreshold !== expectedRounding.lowerThreshold ||
    rounding.upperThreshold !== expectedRounding.upperThreshold ||
    rounding.middleIncrement !== expectedRounding.middleIncrement
  ) {
    throw new RangeError(INVALID_PROFILE_MESSAGE);
  }
}

function quantitativeMaximum(
  term: AcademicTermV1,
  profile: NativeParallelRecoveryProfileV1,
): number {
  switch (term) {
    case 1:
    case 2:
    case 3:
      return normalizeDerivedProfileValue(
        profile.termCompositionProfile.termMaximums[term] *
          profile.termCompositionProfile.quantitativeWeight,
      );
    default:
      throw new RangeError('term must be 1, 2, or 3');
  }
}

// Profile literals are decimal business rules. Normalize only their derived
// arithmetic so public thresholds retain the canonical decimal representation.
function normalizeDerivedProfileValue(value: number): number {
  return Number(value.toFixed(12));
}

function numericValue(
  value: AcademicGradeValueV1,
  inputName: 'quantitative-original' | 'parallel-recovery',
): number | null {
  switch (value.state) {
    case 'numeric':
    case 'official-zero':
    case 'legacy-zero':
      if (!Number.isFinite(value.value)) {
        throw new RangeError(`${inputName} value must be a finite number`);
      }
      return value.value;
    case 'absent':
    case 'not-applicable':
    case 'insufficient-data':
      return null;
  }
}

function rangeFinding(
  input: 'quantitative-original' | 'parallel-recovery',
  value: number,
  maximum: number,
): NativeParallelRecoveryFindingV1 | null {
  if (value < 0) {
    return {
      code:
        input === 'quantitative-original'
          ? 'quantitative-original-below-zero'
          : 'parallel-recovery-below-zero',
      input,
      value,
      minimum: 0,
      maximum,
      message: `${input} value ${value} is below the allowed minimum 0`,
    };
  }

  if (value > maximum) {
    return {
      code:
        input === 'quantitative-original'
          ? 'quantitative-original-above-maximum'
          : 'parallel-recovery-above-maximum',
      input,
      value,
      minimum: 0,
      maximum,
      message: `${input} value ${value} exceeds the allowed maximum ${maximum}`,
    };
  }

  return null;
}

function reasonForState(
  input: 'quantitative-original' | 'parallel-recovery',
  value: AcademicGradeValueV1,
): string | null {
  switch (value.state) {
    case 'absent':
      return `${input}:absent`;
    case 'not-applicable':
      return `${input}:not-applicable${value.reason ? ':' + value.reason : ''}`;
    case 'insufficient-data':
      return `${input}:insufficient-data:${value.reason}`;
    case 'numeric':
    case 'official-zero':
    case 'legacy-zero':
      return null;
  }
}

function resolveApplicability(
  original: AcademicGradeValueV1,
  originalValue: number | null,
  originalFinding: NativeParallelRecoveryFindingV1 | null,
  cutoff: number,
): ApplicabilityV1 {
  if (original.state === 'not-applicable') {
    return {
      state: 'not-applicable',
      reason: original.reason ?? 'quantitative original is not applicable',
    };
  }

  if (originalValue === null || originalFinding) {
    return {
      state: 'insufficient-data',
      reason: 'parallel recovery applicability requires a valid quantitative original',
    };
  }

  if (originalValue < cutoff) {
    return { state: 'applicable' };
  }

  return {
    state: 'not-applicable',
    reason: 'quantitative original reached the 60% applicability cutoff',
  };
}

function unresolvedConsidered(reason: string): AcademicGradeValueV1 {
  return { state: 'insufficient-data', reason };
}

export function resolveNativeParallelRecovery(
  input: NativeParallelRecoveryInputV1,
  profile: NativeParallelRecoveryProfileV1,
): NativeParallelRecoveryV1 {
  validateProfile(profile);

  const maximum = quantitativeMaximum(input.term, profile);
  const cutoff = normalizeDerivedProfileValue(maximum * profile.applicabilityRatio);
  const originalValue = numericValue(input.quantitativeOriginal, 'quantitative-original');
  const parallelValue = numericValue(input.parallelRecovery, 'parallel-recovery');
  const originalFinding =
    originalValue === null ? null : rangeFinding('quantitative-original', originalValue, maximum);
  const parallelFinding =
    parallelValue === null ? null : rangeFinding('parallel-recovery', parallelValue, maximum);
  const applicability = resolveApplicability(
    input.quantitativeOriginal,
    originalValue,
    originalFinding,
    cutoff,
  );

  const findings: NativeParallelRecoveryFindingV1[] = [];
  if (originalFinding) findings.push(originalFinding);
  if (parallelFinding) findings.push(parallelFinding);

  if (applicability.state === 'not-applicable' && parallelValue !== null) {
    findings.push({
      code: 'parallel-recovery-present-when-not-applicable',
      input: 'parallel-recovery',
      value: parallelValue,
      minimum: 0,
      maximum,
      message: 'parallel-recovery was provided even though the quantitative cutoff was reached',
    });
  }

  if (applicability.state === 'applicable' && input.parallelRecovery.state === 'not-applicable') {
    findings.push({
      code: 'parallel-recovery-state-conflicts-with-applicability',
      input: 'parallel-recovery',
      message:
        'parallel-recovery is marked not-applicable although the quantitative cutoff applies',
    });
  }

  const originalResolved = originalValue !== null && originalFinding === null;
  const parallelResolved = parallelValue !== null && parallelFinding === null;
  const resolvedItemCount = Number(originalResolved) + Number(parallelResolved);
  const reasons = [
    reasonForState('quantitative-original', input.quantitativeOriginal),
    reasonForState('parallel-recovery', input.parallelRecovery),
    applicability.state === 'applicable'
      ? null
      : `applicability:${applicability.state}:${applicability.reason ?? ''}`,
    ...findings.map((finding) => finding.code),
  ].filter((reason): reason is string => reason !== null);

  let coverageState: ResultCoverageV1['state'];
  if (applicability.state === 'not-applicable') {
    coverageState = 'not-applicable';
  } else if (
    applicability.state === 'insufficient-data' ||
    input.parallelRecovery.state === 'not-applicable' ||
    input.parallelRecovery.state === 'insufficient-data' ||
    findings.length > 0
  ) {
    coverageState = 'insufficient-data';
  } else if (resolvedItemCount === 2) {
    coverageState = 'complete';
  } else if (resolvedItemCount === 1) {
    coverageState = 'partial';
  } else {
    coverageState = 'insufficient-data';
  }

  const coverage: ResultCoverageV1 = {
    state: coverageState,
    expectedItemCount: 2,
    resolvedItemCount,
    missingItemCount: 2 - resolvedItemCount,
    reasons,
  };

  let quantitativeConsidered: AcademicGradeValueV1;
  if (!originalResolved) {
    quantitativeConsidered =
      input.quantitativeOriginal.state === 'not-applicable'
        ? input.quantitativeOriginal
        : unresolvedConsidered('quantitative considered requires a valid quantitative original');
  } else if (
    applicability.state === 'applicable' &&
    parallelResolved &&
    parallelValue > originalValue
  ) {
    quantitativeConsidered = input.parallelRecovery;
  } else {
    quantitativeConsidered = input.quantitativeOriginal;
  }

  let gain;
  if (originalResolved && parallelResolved) {
    if (applicability.state === 'applicable') {
      gain = Math.max(0, parallelValue - originalValue);
    } else {
      gain = 0;
    }
  } else {
    gain = null;
  }

  return {
    profileVersion: profile.version,
    academicYearProfile: profile.academicYear,
    term: input.term,
    quantitativeMaximum: maximum,
    applicabilityCutoff: cutoff,
    applicabilityRatio: profile.applicabilityRatio,
    inputs: {
      quantitativeOriginal: input.quantitativeOriginal,
      parallelRecovery: input.parallelRecovery,
    },
    applicability,
    quantitativeConsidered,
    gain,
    coverage,
    findings,
  };
}
