import type { AcademicYearId, TeachingAssignmentId } from '../entities';
import type { SourceAssessmentSlotV2 } from '../source/source-contract-v2';
import {
  RESULTS_CONTRACT_V1,
  type AcademicTermV1,
  type ApplicabilityV1,
  type AssessmentComponentId,
} from './results-contract-v1';

const RESULTS_CONTRACT_VERSION_V2 = 2 as const;

export const ASSESSMENT_COMPONENT_TYPES_V2 = [
  'quantitative-assessment',
  'qualitative-activity',
  'parallel-recovery',
] as const;
export type AssessmentComponentTypeV2 = (typeof ASSESSMENT_COMPONENT_TYPES_V2)[number];

export type ResolvedAssessmentApplicabilityV2 = Exclude<
  ApplicabilityV1,
  { readonly state: 'insufficient-data' }
>;

export interface AssessmentComponentSourceIdentityV2 {
  readonly logicalSourceReference: string;
  readonly academicYearId: AcademicYearId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly term: AcademicTermV1;
  readonly sourceSlot: SourceAssessmentSlotV2;
}

export type AssessmentComponentSourceStableKeyV2 = `assessment-component-source:v2:${string}`;

export function assessmentComponentSourceStableKeyV2(
  identity: AssessmentComponentSourceIdentityV2,
): AssessmentComponentSourceStableKeyV2 {
  return `assessment-component-source:v2:${JSON.stringify([
    identity.logicalSourceReference,
    identity.academicYearId,
    identity.teachingAssignmentId,
    identity.term,
    identity.sourceSlot,
  ])}` as AssessmentComponentSourceStableKeyV2;
}

export interface AssessmentComponentV2 {
  readonly id: AssessmentComponentId;
  readonly academicYearId: AcademicYearId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly term: AcademicTermV1;
  readonly type: AssessmentComponentTypeV2;
  readonly name: string;
  readonly maximum: number;
  readonly order: number;
  readonly applicability: ResolvedAssessmentApplicabilityV2;
}

export const RESULTS_CONTRACT_V2 = {
  version: RESULTS_CONTRACT_VERSION_V2,
  predecessorVersion: RESULTS_CONTRACT_V1.version,
  compatibility: {
    historicalV1AssessmentTypes: 'preserve-as-v1',
    reinterpretHistoricalV1: false,
  },
  academicTerms: RESULTS_CONTRACT_V1.academicTerms,
  assessmentComponentTypes: ASSESSMENT_COMPONENT_TYPES_V2,
  authorityModes: RESULTS_CONTRACT_V1.authorityModes,
  gradeValueStates: RESULTS_CONTRACT_V1.gradeValueStates,
  applicabilityStates: RESULTS_CONTRACT_V1.applicabilityStates,
  coverageStates: RESULTS_CONTRACT_V1.coverageStates,
  academicResultStates: RESULTS_CONTRACT_V1.academicResultStates,
  annualFinalDecisionOutcomes: RESULTS_CONTRACT_V1.annualFinalDecisionOutcomes,
  annualFinalDecisionBases: RESULTS_CONTRACT_V1.annualFinalDecisionBases,
  assessmentMaterialization: {
    incompleteDefinition: 'source-evidence-only',
    academicComponentRequiresResolvedDefinition: true,
  },
  assessmentIdentity: {
    externalIdentity: 'opaque-assessment-component-id',
    stableSourceKeyFields: [
      'logicalSourceReference',
      'academicYearId',
      'teachingAssignmentId',
      'term',
      'sourceSlot',
    ],
    excludes: ['name', 'maximum'],
  },
} as const;
