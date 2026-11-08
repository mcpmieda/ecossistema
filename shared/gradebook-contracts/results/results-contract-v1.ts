import type {
  AcademicYearId,
  EnrollmentId,
  EntityIdV1,
  StudentId,
  TeachingAssignmentId,
} from '../entities';
import type { CompatibleSourceCellEvidenceV5 as SourceCellEvidenceV1 } from '../source/source-values-contract-v5';

export type AssessmentComponentId = EntityIdV1<'AssessmentComponentV1'>;
export type GradeEntryId = EntityIdV1<'GradeEntryV1'>;
export type TermResultId = EntityIdV1<'TermResultV1'>;
export type FinalRecoveryId = EntityIdV1<'FinalRecoveryV1'>;
export type AnnualResultId = EntityIdV1<'AnnualResultV1'>;

export const ACADEMIC_TERMS_V1 = [1, 2, 3] as const;
export type AcademicTermV1 = (typeof ACADEMIC_TERMS_V1)[number];

export const ASSESSMENT_COMPONENT_TYPES_V1 = [
  'written',
  'simulation',
  'qualitative-activity',
  'parallel-recovery',
] as const;
export type AssessmentComponentTypeV1 = (typeof ASSESSMENT_COMPONENT_TYPES_V1)[number];

export const AUTHORITY_MODES_V1 = ['imported-source', 'native-engine'] as const;
export type AuthorityModeV1 = (typeof AUTHORITY_MODES_V1)[number];

export const GRADE_VALUE_STATES_V1 = [
  'absent',
  'numeric',
  'official-zero',
  'legacy-zero',
  'not-applicable',
  'insufficient-data',
] as const;

export type AcademicGradeValueV1 =
  | {
      readonly state: 'absent';
    }
  | {
      readonly state: 'numeric';
      readonly value: number;
    }
  | {
      readonly state: 'official-zero';
      readonly value: 0;
      readonly sourceMarker: 0.1;
    }
  | {
      readonly state: 'legacy-zero';
      readonly value: 0;
    }
  | {
      readonly state: 'not-applicable';
      readonly reason?: string;
    }
  | {
      readonly state: 'insufficient-data';
      readonly reason: string;
    };

type SourceEvidenceSetV1 = readonly [SourceCellEvidenceV1, ...SourceCellEvidenceV1[]];

export interface ImportedGradeValueV1 {
  readonly value: AcademicGradeValueV1;
  readonly evidence: SourceEvidenceSetV1;
}

export interface NativeEngineGradeValueV1 {
  readonly value: AcademicGradeValueV1;
}

export interface ComparedGradeValueV1 {
  readonly imported: ImportedGradeValueV1;
  readonly calculated: NativeEngineGradeValueV1;
}

export type ApplicabilityV1 =
  | {
      readonly state: 'applicable';
    }
  | {
      readonly state: 'not-applicable';
      readonly reason?: string;
    }
  | {
      readonly state: 'insufficient-data';
      readonly reason: string;
    };

export interface ImportedApplicabilityV1 {
  readonly value: ApplicabilityV1;
  readonly evidence: SourceEvidenceSetV1;
}

export interface ComparedApplicabilityV1 {
  readonly imported: ImportedApplicabilityV1;
  readonly calculated: ApplicabilityV1;
}

export const RESULT_COVERAGE_STATES_V1 = [
  'complete',
  'partial',
  'insufficient-data',
  'not-applicable',
] as const;
export type ResultCoverageStateV1 = (typeof RESULT_COVERAGE_STATES_V1)[number];

export interface ResultCoverageV1 {
  readonly state: ResultCoverageStateV1;
  readonly expectedItemCount: number;
  readonly resolvedItemCount: number;
  readonly missingItemCount: number;
  readonly reasons: readonly string[];
}

export interface AssessmentComponentV1 {
  readonly id: AssessmentComponentId;
  readonly academicYearId: AcademicYearId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly term: AcademicTermV1;
  readonly type: AssessmentComponentTypeV1;
  readonly name: string;
  readonly maximum: number;
  readonly order: number;
  readonly applicability: ApplicabilityV1;
}

export interface GradeEntryV1 {
  readonly id: GradeEntryId;
  readonly academicYearId: AcademicYearId;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly assessmentComponentId: AssessmentComponentId;
  readonly value: ComparedGradeValueV1;
  readonly authorityMode: AuthorityModeV1;
  readonly ruleVersion: string;
  readonly version: number;
  readonly supersedesGradeEntryId?: GradeEntryId;
}

export interface TermQuantitativeResultV1 {
  readonly original: ComparedGradeValueV1;
  readonly parallelRecovery: ComparedGradeValueV1;
  readonly parallelRecoveryApplicability: ComparedApplicabilityV1;
  readonly considered: ComparedGradeValueV1;
}

export interface TermResultV1 {
  readonly id: TermResultId;
  readonly academicYearId: AcademicYearId;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly term: AcademicTermV1;
  readonly maximum: number;
  readonly quantitative: TermQuantitativeResultV1;
  readonly qualitativeOperational: ComparedGradeValueV1;
  readonly officialGrade: ComparedGradeValueV1;
  readonly percentage: ComparedGradeValueV1;
  readonly authorityMode: AuthorityModeV1;
  readonly coverage: ResultCoverageV1;
  readonly ruleVersion: string;
}

export interface FinalRecoveryV1 {
  readonly id: FinalRecoveryId;
  readonly academicYearId: AcademicYearId;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly recoveredTerm: AcademicTermV1;
  readonly originalTermGrade: ComparedGradeValueV1;
  readonly applicability: ComparedApplicabilityV1;
  readonly recoveryGrade: ComparedGradeValueV1;
  readonly replacementTermGrade: ComparedGradeValueV1;
  readonly authorityMode: AuthorityModeV1;
  readonly coverage: ResultCoverageV1;
  readonly ruleVersion: string;
}

export const ACADEMIC_RESULT_STATES_V1 = [
  'in-progress',
  'approved-direct',
  'approved-after-recovery',
  'eligible-for-council',
  'approved-by-council',
  'failed-after-council-vote',
  'failed-by-council-decision',
  'failed-by-attendance',
  'not-eligible-for-council',
  'special-status',
  'insufficient-data',
] as const;
export type AcademicResultStateV1 = (typeof ACADEMIC_RESULT_STATES_V1)[number];

export interface ComparedAcademicStateV1 {
  readonly imported: AcademicResultStateV1;
  readonly calculated: AcademicResultStateV1;
}

const ANNUAL_FINAL_DECISION_OUTCOMES_V1 = ['approved', 'failed', 'special-status'] as const;
export type AnnualFinalDecisionOutcomeV1 = (typeof ANNUAL_FINAL_DECISION_OUTCOMES_V1)[number];

const ANNUAL_FINAL_DECISION_BASES_V1 = [
  'academic-rule',
  'class-council',
  'attendance',
  'administrative',
] as const;
export type AnnualFinalDecisionBasisV1 = (typeof ANNUAL_FINAL_DECISION_BASES_V1)[number];

export type AnnualFinalDecisionV1 =
  | {
      readonly status: 'pending';
    }
  | {
      readonly status: 'recorded';
      readonly outcome: AnnualFinalDecisionOutcomeV1;
      readonly basis: AnnualFinalDecisionBasisV1;
      readonly resultingState: AcademicResultStateV1;
      readonly decidedAt?: string;
      readonly reference?: string;
    };

export interface AnnualResultV1 {
  readonly id: AnnualResultId;
  readonly academicYearId: AcademicYearId;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly originalTotal: ComparedGradeValueV1;
  readonly postRecoveryTotal: ComparedGradeValueV1;
  readonly academicState: ComparedAcademicStateV1;
  readonly finalDecision: AnnualFinalDecisionV1;
  readonly authorityMode: AuthorityModeV1;
  readonly coverage: ResultCoverageV1;
  readonly ruleVersion: string;
}
