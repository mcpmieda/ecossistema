import type { AcademicYearId, TeachingAssignmentId } from '../entities';
import {
  RESULTS_CONTRACT_V2,
  type AssessmentComponentSourceIdentityV2,
  type AssessmentComponentSourceStableKeyV2,
  type AssessmentComponentTypeV2,
  type ResolvedAssessmentApplicabilityV2,
} from './results-contract-v2';
import type { AcademicTermV1, AssessmentComponentId } from './results-contract-v1';

export const RESULTS_CONTRACT_VERSION_V3 = 3 as const;

export type AssessmentMaximumV3 =
  { readonly state: 'defined'; readonly value: number } | { readonly state: 'not-defined' };

/**
 * V3 makes an unknown activity maximum explicit without turning the component or its grades into
 * insufficient data. Identity deliberately remains the V2 stable source identity so a later import
 * can complete the maximum by appending a version of the same component.
 */
export interface AssessmentComponentV3 {
  readonly id: AssessmentComponentId;
  readonly academicYearId: AcademicYearId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly term: AcademicTermV1;
  readonly type: AssessmentComponentTypeV2;
  readonly name: string;
  readonly maximum: AssessmentMaximumV3;
  readonly order: number;
  readonly applicability: ResolvedAssessmentApplicabilityV2;
}

export type AssessmentComponentSourceIdentityV3 = AssessmentComponentSourceIdentityV2;
export type AssessmentComponentSourceStableKeyV3 = AssessmentComponentSourceStableKeyV2;

export { assessmentComponentSourceStableKeyV2 as assessmentComponentSourceStableKeyV3 } from './results-contract-v2';

export const RESULTS_CONTRACT_V3 = {
  version: RESULTS_CONTRACT_VERSION_V3,
  predecessorVersion: RESULTS_CONTRACT_V2.version,
  compatibility: {
    historicalV1AssessmentTypes: 'preserve-as-v1',
    historicalV2AssessmentTypes: 'preserve-as-v2',
    reinterpretHistoricalComponents: false,
  },
  academicTerms: RESULTS_CONTRACT_V2.academicTerms,
  assessmentComponentTypes: RESULTS_CONTRACT_V2.assessmentComponentTypes,
  authorityModes: RESULTS_CONTRACT_V2.authorityModes,
  gradeValueStates: RESULTS_CONTRACT_V2.gradeValueStates,
  applicabilityStates: RESULTS_CONTRACT_V2.applicabilityStates,
  coverageStates: RESULTS_CONTRACT_V2.coverageStates,
  academicResultStates: RESULTS_CONTRACT_V2.academicResultStates,
  annualFinalDecisionOutcomes: RESULTS_CONTRACT_V2.annualFinalDecisionOutcomes,
  annualFinalDecisionBases: RESULTS_CONTRACT_V2.annualFinalDecisionBases,
  assessmentMaximum: {
    defined: 'finite-positive-number',
    notDefined: 'component-and-grade-remain-materializable',
    inventFallbackMaximum: false,
    denominatorDependentIndicatorsWhenNotDefined: 'unavailable',
  },
  assessmentIdentity: {
    stableKey: 'assessment-component-source:v2',
    excludes: ['name', 'maximum'],
    completeMaximumByAppendingSameComponentIdentity: true,
  },
} as const;

export type ResultsContractV3 = typeof RESULTS_CONTRACT_V3;
