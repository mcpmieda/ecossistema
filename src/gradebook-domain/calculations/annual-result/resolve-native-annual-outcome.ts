import type {
  AcademicGradeValueV1,
  AcademicResultStateV1,
  AnnualFinalDecisionV1,
  ResultCoverageV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';

export interface NativeAnnualOutcomeProfileV1 {
  readonly version: 1;
  readonly academicYear: 2026;
  readonly componentMinimum: 0;
  readonly componentMaximum: 100;
  readonly approvalCutoff: 60;
  readonly councilEligibilityMaximumNotApprovedComponents: 2;
}

export const NATIVE_ANNUAL_OUTCOME_PROFILE_2026_V1: NativeAnnualOutcomeProfileV1 =
  Object.freeze({
    version: 1,
    academicYear: 2026,
    componentMinimum: 0,
    componentMaximum: 100,
    approvalCutoff: 60,
    councilEligibilityMaximumNotApprovedComponents: 2,
  });

export interface NativeAnnualComponentInputV1 {
  readonly componentKey: string;
  readonly originalTotal: AcademicGradeValueV1;
  readonly postRecoveryTotal: AcademicGradeValueV1;
  readonly coverage: ResultCoverageV1;
}

export interface NativeAnnualOutcomeInputV1 {
  readonly components: readonly NativeAnnualComponentInputV1[];
  readonly finalDecision: AnnualFinalDecisionV1;
}

export const NATIVE_ANNUAL_COMPONENT_CLASSIFICATIONS_V1 = [
  'approved-direct',
  'approved-after-recovery',
  'not-approved',
  'not-applicable',
  'insufficient-data',
] as const;
export type NativeAnnualComponentClassificationV1 =
  (typeof NATIVE_ANNUAL_COMPONENT_CLASSIFICATIONS_V1)[number];

export const NATIVE_COUNCIL_ELIGIBILITY_STATES_V1 = [
  'not-required',
  'eligible',
  'not-eligible',
  'insufficient-data',
] as const;
export type NativeCouncilEligibilityStateV1 =
  (typeof NATIVE_COUNCIL_ELIGIBILITY_STATES_V1)[number];

export const NATIVE_ANNUAL_OUTCOME_FINDING_CODES_V1 = [
  'empty-component-set',
  'component-original-total-below-minimum',
  'component-original-total-above-maximum',
  'component-post-recovery-total-below-minimum',
  'component-post-recovery-total-above-maximum',
  'component-original-total-unresolved',
  'component-post-recovery-total-unresolved',
  'component-coverage-incomplete',
] as const;
export type NativeAnnualOutcomeFindingCodeV1 =
  (typeof NATIVE_ANNUAL_OUTCOME_FINDING_CODES_V1)[number];

type AnnualTotalInputV1 = 'original-total' | 'post-recovery-total';

export interface NativeAnnualOutcomeFindingV1 {
  readonly code: NativeAnnualOutcomeFindingCodeV1;
  readonly componentKey?: string;
  readonly input: 'components' | AnnualTotalInputV1 | 'coverage';
  readonly state?: AcademicGradeValueV1['state'] | ResultCoverageV1['state'];
  readonly value?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly message: string;
}

export interface NativeAnnualComponentOutcomeV1 {
  readonly componentKey: string;
  readonly originalTotal: AcademicGradeValueV1;
  readonly postRecoveryTotal: AcademicGradeValueV1;
  readonly classification: NativeAnnualComponentClassificationV1;
  readonly resolved: boolean;
  readonly approved: boolean;
  readonly countsAsNotApproved: boolean;
  readonly coverage: ResultCoverageV1;
  readonly reasons: readonly string[];
  readonly findings: readonly NativeAnnualOutcomeFindingV1[];
}

export interface NativeCouncilEligibilityV1 {
  readonly state: NativeCouncilEligibilityStateV1;
  readonly notApprovedComponentCount: number;
  readonly maximumNotApprovedComponents: 2;
  readonly reasons: readonly string[];
}

export interface NativeAnnualOutcomeV1 {
  readonly profileVersion: 1;
  readonly academicYearProfile: 2026;
  readonly componentMinimum: 0;
  readonly componentMaximum: 100;
  readonly approvalCutoff: 60;
  readonly councilEligibilityMaximumNotApprovedComponents: 2;
  readonly components: readonly NativeAnnualComponentOutcomeV1[];
  readonly expectedComponentCount: number;
  readonly resolvedComponentCount: number;
  readonly approvedComponentCount: number;
  readonly approvedDirectComponentCount: number;
  readonly approvedAfterRecoveryComponentCount: number;
  readonly notApprovedComponentCount: number;
  readonly notApplicableComponentCount: number;
  readonly insufficientDataComponentCount: number;
  readonly unresolvedComponentCount: number;
  readonly calculatedAcademicState: AcademicResultStateV1;
  readonly councilEligibility: NativeCouncilEligibilityV1;
  readonly finalDecision: AnnualFinalDecisionV1;
  readonly effectiveAcademicState: AcademicResultStateV1;
  readonly effectiveStateSource: 'calculated' | 'formal-decision';
  readonly coverage: ResultCoverageV1;
  readonly findings: readonly NativeAnnualOutcomeFindingV1[];
}

const INVALID_PROFILE_MESSAGE =
  'profile must match native annual outcome 2026 V1: component scale 0-100, cutoff 60, and council limit 2';

function validateProfile(profile: NativeAnnualOutcomeProfileV1): void {
  if (
    profile === null ||
    typeof profile !== 'object' ||
    profile.version !== 1 ||
    profile.academicYear !== 2026 ||
    profile.componentMinimum !== 0 ||
    profile.componentMaximum !== 100 ||
    profile.approvalCutoff !== 60 ||
    profile.councilEligibilityMaximumNotApprovedComponents !== 2
  ) {
    throw new RangeError(INVALID_PROFILE_MESSAGE);
  }
}

function validateComponentKeys(components: readonly NativeAnnualComponentInputV1[]): void {
  const seen = new Set<string>();
  for (const component of components) {
    if (typeof component.componentKey !== 'string' || component.componentKey.trim() === '') {
      throw new RangeError('componentKey must be a non-empty string');
    }
    if (seen.has(component.componentKey)) {
      throw new RangeError(`componentKey must be unique: ${component.componentKey}`);
    }
    seen.add(component.componentKey);
  }
}

function comparableValue(
  grade: AcademicGradeValueV1,
  input: AnnualTotalInputV1,
  componentKey: string,
): number | null {
  switch (grade.state) {
    case 'numeric':
    case 'official-zero':
    case 'legacy-zero':
      if (!Number.isFinite(grade.value)) {
        throw new RangeError(
          `components[${componentKey}].${input} value must be a finite number`,
        );
      }
      return grade.value;
    case 'absent':
    case 'not-applicable':
    case 'insufficient-data':
      return null;
  }
}

function unresolvedFinding(
  grade: AcademicGradeValueV1,
  input: AnnualTotalInputV1,
  componentKey: string,
): NativeAnnualOutcomeFindingV1 | null {
  if (
    grade.state === 'numeric' ||
    grade.state === 'official-zero' ||
    grade.state === 'legacy-zero'
  ) {
    return null;
  }

  let detail;
  if (grade.state === 'absent') {
    detail = 'is absent';
  } else if (grade.state === 'not-applicable') {
    detail = `is not applicable${grade.reason ? `: ${grade.reason}` : ''}`;
  } else {
    detail = `has insufficient data: ${grade.reason}`;
  }
  return {
    code:
      input === 'original-total'
        ? 'component-original-total-unresolved'
        : 'component-post-recovery-total-unresolved',
    componentKey,
    input,
    state: grade.state,
    message: `${input} for component ${componentKey} ${detail}`,
  };
}

function rangeFinding(
  value: number,
  input: AnnualTotalInputV1,
  componentKey: string,
  profile: NativeAnnualOutcomeProfileV1,
): NativeAnnualOutcomeFindingV1 | null {
  const below = value < profile.componentMinimum;
  const above = value > profile.componentMaximum;
  if (!below && !above) return null;

  const original = input === 'original-total';
  return {
    code: below
      ? original
        ? 'component-original-total-below-minimum'
        : 'component-post-recovery-total-below-minimum'
      : original
        ? 'component-original-total-above-maximum'
        : 'component-post-recovery-total-above-maximum',
    componentKey,
    input,
    value,
    minimum: profile.componentMinimum,
    maximum: profile.componentMaximum,
    message: `${input} for component ${componentKey} ${
      below ? 'is below the allowed minimum' : 'exceeds the allowed maximum'
    } ${below ? profile.componentMinimum : profile.componentMaximum}`,
  };
}

function coverageFinding(
  component: NativeAnnualComponentInputV1,
): NativeAnnualOutcomeFindingV1 | null {
  if (
    component.coverage.state !== 'partial' &&
    component.coverage.state !== 'insufficient-data'
  ) {
    return null;
  }
  return {
    code: 'component-coverage-incomplete',
    componentKey: component.componentKey,
    input: 'coverage',
    state: component.coverage.state,
    message: `coverage for component ${component.componentKey} is ${component.coverage.state}`,
  };
}

function resolveComponent(
  component: NativeAnnualComponentInputV1,
  profile: NativeAnnualOutcomeProfileV1,
): NativeAnnualComponentOutcomeV1 {
  const originalValue = comparableValue(
    component.originalTotal,
    'original-total',
    component.componentKey,
  );
  const postRecoveryValue = comparableValue(
    component.postRecoveryTotal,
    'post-recovery-total',
    component.componentKey,
  );
  const originalRange =
    originalValue === null
      ? null
      : rangeFinding(originalValue, 'original-total', component.componentKey, profile);
  const postRecoveryRange =
    postRecoveryValue === null
      ? null
      : rangeFinding(
          postRecoveryValue,
          'post-recovery-total',
          component.componentKey,
          profile,
        );
  const findings = [
    unresolvedFinding(component.originalTotal, 'original-total', component.componentKey),
    originalRange,
    unresolvedFinding(
      component.postRecoveryTotal,
      'post-recovery-total',
      component.componentKey,
    ),
    postRecoveryRange,
    coverageFinding(component),
  ].filter((finding): finding is NativeAnnualOutcomeFindingV1 => finding !== null);

  let classification: NativeAnnualComponentClassificationV1;
  if (
    component.originalTotal.state === 'not-applicable' ||
    component.postRecoveryTotal.state === 'not-applicable'
  ) {
    classification = 'not-applicable';
  } else if (
    originalValue === null ||
    postRecoveryValue === null ||
    originalRange !== null ||
    postRecoveryRange !== null ||
    (component.coverage.state !== 'complete' && component.coverage.state !== 'not-applicable')
  ) {
    classification = 'insufficient-data';
  } else if (originalValue >= profile.approvalCutoff) {
    classification = 'approved-direct';
  } else if (postRecoveryValue >= profile.approvalCutoff) {
    classification = 'approved-after-recovery';
  } else {
    classification = 'not-approved';
  }

  const resolved =
    classification === 'approved-direct' ||
    classification === 'approved-after-recovery' ||
    classification === 'not-approved';
  let classificationReason;
  if (classification === 'approved-direct') {
    classificationReason = `original-total-at-or-above-cutoff:${profile.approvalCutoff}`;
  } else if (classification === 'approved-after-recovery') {
    classificationReason = `post-recovery-total-at-or-above-cutoff:${profile.approvalCutoff}`;
  } else if (classification === 'not-approved') {
    classificationReason = `post-recovery-total-below-cutoff:${profile.approvalCutoff}`;
  } else if (classification === 'not-applicable') {
    classificationReason = 'component-total-not-applicable';
  } else {
    classificationReason = 'component-outcome-unresolved';
  }

  return {
    componentKey: component.componentKey,
    originalTotal: component.originalTotal,
    postRecoveryTotal: component.postRecoveryTotal,
    classification,
    resolved,
    approved:
      classification === 'approved-direct' || classification === 'approved-after-recovery',
    countsAsNotApproved: classification === 'not-approved',
    coverage: component.coverage,
    reasons: Array.from(
      new Set([
        ...findings.map((finding) => finding.code),
        ...component.coverage.reasons.map((reason) => `source-coverage:${reason}`),
        classificationReason,
      ]),
    ),
    findings,
  };
}

function hasHardInsufficiency(components: readonly NativeAnnualComponentOutcomeV1[]): boolean {
  return components.some(
    (component) =>
      component.coverage.state === 'insufficient-data' ||
      component.originalTotal.state === 'insufficient-data' ||
      component.postRecoveryTotal.state === 'insufficient-data' ||
      component.findings.some((finding) => finding.code.includes('below-minimum')) ||
      component.findings.some((finding) => finding.code.includes('above-maximum')),
  );
}

function consolidateCoverage(
  components: readonly NativeAnnualComponentOutcomeV1[],
  findings: readonly NativeAnnualOutcomeFindingV1[],
): ResultCoverageV1 {
  const expectedItemCount = components.length;
  const resolvedItemCount = components.filter((component) => component.resolved).length;
  let state: ResultCoverageV1['state'];

  if (expectedItemCount === 0 || hasHardInsufficiency(components)) {
    state = 'insufficient-data';
  } else if (components.every((component) => component.classification === 'not-applicable')) {
    state = 'not-applicable';
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
    reasons: Array.from(
      new Set([
        ...findings.map((finding) => finding.code),
        ...components.flatMap((component) =>
          component.resolved
            ? []
            : component.reasons.map(
                (reason) => `component[${component.componentKey}]:${reason}`,
              ),
        ),
      ]),
    ),
  };
}

function resolveCouncilEligibility(
  coverage: ResultCoverageV1,
  components: readonly NativeAnnualComponentOutcomeV1[],
  notApprovedComponentCount: number,
): NativeCouncilEligibilityV1 {
  if (coverage.state !== 'complete') {
    return {
      state: 'insufficient-data',
      notApprovedComponentCount,
      maximumNotApprovedComponents: 2,
      reasons: Array.from(
        new Set([
          `annual-coverage:${coverage.state}`,
          ...components
            .filter((component) => !component.resolved)
            .map((component) => `unresolved-component:${component.componentKey}`),
        ]),
      ),
    };
  }
  if (notApprovedComponentCount === 0) {
    return {
      state: 'not-required',
      notApprovedComponentCount,
      maximumNotApprovedComponents: 2,
      reasons: ['no-not-approved-components'],
    };
  }
  if (notApprovedComponentCount <= 2) {
    return {
      state: 'eligible',
      notApprovedComponentCount,
      maximumNotApprovedComponents: 2,
      reasons: [
        `${notApprovedComponentCount}-not-approved-component${
          notApprovedComponentCount === 1 ? '' : 's'
        }-within-council-limit-2`,
      ],
    };
  }
  return {
    state: 'not-eligible',
    notApprovedComponentCount,
    maximumNotApprovedComponents: 2,
    reasons: [`${notApprovedComponentCount}-not-approved-components-exceed-council-limit-2`],
  };
}

function academicState(
  eligibility: NativeCouncilEligibilityV1,
  approvedAfterRecoveryComponentCount: number,
): AcademicResultStateV1 {
  switch (eligibility.state) {
    case 'not-required':
      return approvedAfterRecoveryComponentCount > 0
        ? 'approved-after-recovery'
        : 'approved-direct';
    case 'eligible':
      return 'eligible-for-council';
    case 'not-eligible':
      return 'not-eligible-for-council';
    case 'insufficient-data':
      return 'insufficient-data';
  }
}

export function resolveNativeAnnualOutcome(
  input: NativeAnnualOutcomeInputV1,
  profile: NativeAnnualOutcomeProfileV1,
): NativeAnnualOutcomeV1 {
  validateProfile(profile);
  validateComponentKeys(input.components);

  const components = input.components.map((component) => resolveComponent(component, profile));
  const findings: NativeAnnualOutcomeFindingV1[] =
    components.length === 0
      ? [
          {
            code: 'empty-component-set',
            input: 'components',
            message: 'annual outcome requires at least one component',
          },
        ]
      : components.flatMap((component) => component.findings);
  const count = (classification: NativeAnnualComponentClassificationV1): number =>
    components.filter((component) => component.classification === classification).length;
  const approvedDirectComponentCount = count('approved-direct');
  const approvedAfterRecoveryComponentCount = count('approved-after-recovery');
  const notApprovedComponentCount = count('not-approved');
  const coverage = consolidateCoverage(components, findings);
  const councilEligibility = resolveCouncilEligibility(
    coverage,
    components,
    notApprovedComponentCount,
  );
  const calculatedAcademicState = academicState(
    councilEligibility,
    approvedAfterRecoveryComponentCount,
  );
  const formalDecisionRecorded = input.finalDecision.status === 'recorded';

  return {
    profileVersion: profile.version,
    academicYearProfile: profile.academicYear,
    componentMinimum: profile.componentMinimum,
    componentMaximum: profile.componentMaximum,
    approvalCutoff: profile.approvalCutoff,
    councilEligibilityMaximumNotApprovedComponents:
      profile.councilEligibilityMaximumNotApprovedComponents,
    components,
    expectedComponentCount: components.length,
    resolvedComponentCount: components.filter((component) => component.resolved).length,
    approvedComponentCount:
      approvedDirectComponentCount + approvedAfterRecoveryComponentCount,
    approvedDirectComponentCount,
    approvedAfterRecoveryComponentCount,
    notApprovedComponentCount,
    notApplicableComponentCount: count('not-applicable'),
    insufficientDataComponentCount: count('insufficient-data'),
    unresolvedComponentCount: components.filter((component) => !component.resolved).length,
    calculatedAcademicState,
    councilEligibility,
    finalDecision: input.finalDecision,
    effectiveAcademicState: formalDecisionRecorded
      ? input.finalDecision.resultingState
      : calculatedAcademicState,
    effectiveStateSource: formalDecisionRecorded ? 'formal-decision' : 'calculated',
    coverage,
    findings,
  };
}
