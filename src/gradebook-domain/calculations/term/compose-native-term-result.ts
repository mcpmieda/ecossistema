import type {
  AcademicGradeValueV1,
  AcademicTermV1,
  ResultCoverageV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';
import {
  ACADEMIC_ROUNDING_PROFILE_V1,
  roundAcademicGrade,
  type RoundingProfileV1,
} from '../../rules/rounding/round-academic-grade';

export interface NativeTermCompositionProfileV1 {
  readonly version: 1;
  readonly academicYear: 2026;
  readonly termMaximums: {
    readonly 1: 30;
    readonly 2: 30;
    readonly 3: 40;
  };
  readonly quantitativeWeight: 0.45;
  readonly qualitativeWeight: 0.55;
  readonly roundingProfile: RoundingProfileV1;
}

export const NATIVE_TERM_COMPOSITION_PROFILE_2026_V1: NativeTermCompositionProfileV1 =
  Object.freeze({
    version: 1,
    academicYear: 2026,
    termMaximums: Object.freeze({
      1: 30,
      2: 30,
      3: 40,
    }),
    quantitativeWeight: 0.45,
    qualitativeWeight: 0.55,
    roundingProfile: ACADEMIC_ROUNDING_PROFILE_V1,
  });

export interface NativeTermCompositionInputV1 {
  readonly term: AcademicTermV1;
  readonly quantitativeConsidered: AcademicGradeValueV1;
  readonly qualitativeOperational: AcademicGradeValueV1;
}

export const NATIVE_TERM_COMPOSITION_FINDING_CODES_V1 = [
  'quantitative-below-zero',
  'quantitative-above-maximum',
  'qualitative-below-zero',
  'qualitative-above-maximum',
] as const;
export type NativeTermCompositionFindingCodeV1 =
  (typeof NATIVE_TERM_COMPOSITION_FINDING_CODES_V1)[number];

export interface NativeTermCompositionFindingV1 {
  readonly code: NativeTermCompositionFindingCodeV1;
  readonly input: 'quantitative-considered' | 'qualitative-operational';
  readonly value: number;
  readonly minimum: 0;
  readonly maximum: number;
  readonly message: string;
}

export interface NativeTermCompositionMaximumsV1 {
  readonly term: number;
  readonly quantitative: number;
  readonly qualitative: number;
}

export interface NativeTermCompositionV1 {
  readonly profileVersion: 1;
  readonly academicYearProfile: 2026;
  readonly term: AcademicTermV1;
  readonly inputs: {
    readonly quantitativeConsidered: AcademicGradeValueV1;
    readonly qualitativeOperational: AcademicGradeValueV1;
  };
  readonly maximums: NativeTermCompositionMaximumsV1;
  readonly rawGrade: AcademicGradeValueV1;
  readonly nativeGrade: AcademicGradeValueV1;
  readonly coverage: ResultCoverageV1;
  readonly findings: readonly NativeTermCompositionFindingV1[];
}

const INVALID_PROFILE_MESSAGE =
  'profile must match native term composition 2026 V1: terms 30/30/40 and weights 0.45/0.55';
const INCOMPLETE_COMPOSITION_REASON =
  'term composition requires valid quantitative and qualitative values';

function validateProfile(profile: NativeTermCompositionProfileV1): void {
  if (
    profile === null ||
    typeof profile !== 'object' ||
    profile.version !== 1 ||
    profile.academicYear !== 2026 ||
    profile.termMaximums?.[1] !== 30 ||
    profile.termMaximums?.[2] !== 30 ||
    profile.termMaximums?.[3] !== 40 ||
    profile.quantitativeWeight !== 0.45 || // NOSONAR: the exact literal the source/profile carries, never a computed value
    profile.qualitativeWeight !== 0.55 // NOSONAR: the exact literal the source/profile carries, never a computed value
  ) {
    throw new RangeError(INVALID_PROFILE_MESSAGE);
  }

  roundAcademicGrade(0, profile.roundingProfile);
}

function termMaximum(term: AcademicTermV1, profile: NativeTermCompositionProfileV1): number {
  switch (term) {
    case 1:
    case 2:
    case 3:
      return profile.termMaximums[term];
    default:
      throw new RangeError('term must be 1, 2, or 3');
  }
}

function numericValue(
  value: AcademicGradeValueV1,
  inputName: 'quantitative-considered' | 'qualitative-operational',
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

function findingForValue(
  input: 'quantitative-considered' | 'qualitative-operational',
  value: number,
  maximum: number,
): NativeTermCompositionFindingV1 | null {
  if (value < 0) {
    const code =
      input === 'quantitative-considered'
        ? 'quantitative-below-zero'
        : 'qualitative-below-zero';
    return {
      code,
      input,
      value,
      minimum: 0,
      maximum,
      message: `${input} value ${value} is below the allowed minimum 0`,
    };
  }

  if (value > maximum) {
    const code =
      input === 'quantitative-considered'
        ? 'quantitative-above-maximum'
        : 'qualitative-above-maximum';
    return {
      code,
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
  input: 'quantitative-considered' | 'qualitative-operational',
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

function specialOutput(
  input: NativeTermCompositionInputV1,
  coverage: ResultCoverageV1,
): Pick<NativeTermCompositionV1, 'rawGrade' | 'nativeGrade'> {
  const values = [input.quantitativeConsidered, input.qualitativeOperational] as const;
  const notApplicable = values.find((value) => value.state === 'not-applicable');

  if (notApplicable?.state === 'not-applicable') {
    const value: AcademicGradeValueV1 = {
      state: 'not-applicable',
      reason: notApplicable.reason ?? 'required term composition input is not applicable',
    };
    return { rawGrade: value, nativeGrade: value };
  }

  const value: AcademicGradeValueV1 = {
    state: 'insufficient-data',
    reason:
      coverage.reasons.length > 0
        ? `${INCOMPLETE_COMPOSITION_REASON}: ${coverage.reasons.join(', ')}`
        : INCOMPLETE_COMPOSITION_REASON,
  };
  return { rawGrade: value, nativeGrade: value };
}

export function composeNativeTermResult(
  input: NativeTermCompositionInputV1,
  profile: NativeTermCompositionProfileV1,
): NativeTermCompositionV1 {
  validateProfile(profile);

  const maximum = termMaximum(input.term, profile);
  const maximums: NativeTermCompositionMaximumsV1 = {
    term: maximum,
    quantitative: maximum * profile.quantitativeWeight,
    qualitative: maximum * profile.qualitativeWeight,
  };

  const quantitativeValue = numericValue(input.quantitativeConsidered, 'quantitative-considered');
  const qualitativeValue = numericValue(input.qualitativeOperational, 'qualitative-operational');

  const findings: NativeTermCompositionFindingV1[] = [];
  if (quantitativeValue !== null) {
    const finding = findingForValue(
      'quantitative-considered',
      quantitativeValue,
      maximums.quantitative,
    );
    if (finding) findings.push(finding);
  }
  if (qualitativeValue !== null) {
    const finding = findingForValue(
      'qualitative-operational',
      qualitativeValue,
      maximums.qualitative,
    );
    if (finding) findings.push(finding);
  }

  const reasons = [
    reasonForState('quantitative-considered', input.quantitativeConsidered),
    reasonForState('qualitative-operational', input.qualitativeOperational),
    ...findings.map((finding) => finding.code),
  ].filter((reason): reason is string => reason !== null);

  const quantitativeResolved = quantitativeValue !== null && !findings.some((finding) =>
    finding.input === 'quantitative-considered'
  );
  const qualitativeResolved = qualitativeValue !== null && !findings.some((finding) =>
    finding.input === 'qualitative-operational'
  );
  const resolvedItemCount = Number(quantitativeResolved) + Number(qualitativeResolved);
  const hasNotApplicable =
    input.quantitativeConsidered.state === 'not-applicable' ||
    input.qualitativeOperational.state === 'not-applicable';
  const hasInsufficientData =
    input.quantitativeConsidered.state === 'insufficient-data' ||
    input.qualitativeOperational.state === 'insufficient-data';
  const hasInvalidFinding = findings.length > 0;

  let coverageState: ResultCoverageV1['state'];
  if (hasNotApplicable) {
    coverageState = 'not-applicable';
  } else if (hasInsufficientData || hasInvalidFinding) {
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

  if (coverage.state !== 'complete' || quantitativeValue === null || qualitativeValue === null) {
    const special = specialOutput(input, coverage);
    return {
      profileVersion: profile.version,
      academicYearProfile: profile.academicYear,
      term: input.term,
      inputs: {
        quantitativeConsidered: input.quantitativeConsidered,
        qualitativeOperational: input.qualitativeOperational,
      },
      maximums,
      ...special,
      coverage,
      findings,
    };
  }

  const rawValue = quantitativeValue + qualitativeValue;
  const roundedValue = roundAcademicGrade(rawValue, profile.roundingProfile);

  return {
    profileVersion: profile.version,
    academicYearProfile: profile.academicYear,
    term: input.term,
    inputs: {
      quantitativeConsidered: input.quantitativeConsidered,
      qualitativeOperational: input.qualitativeOperational,
    },
    maximums,
    rawGrade: { state: 'numeric', value: rawValue },
    nativeGrade: { state: 'numeric', value: roundedValue },
    coverage,
    findings,
  };
}
