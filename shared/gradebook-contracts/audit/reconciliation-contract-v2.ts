import type { ComparedGradeValueV1 } from '../results/results-contract-v1';
import {
  AUDIT_CONTRACT_V1,
  RECONCILIATION_STATUSES_V1,
  type ReconciliationResultId,
  type ReconciliationStatusV1,
  type ReconciliationTargetV1,
} from './audit-contract-v1';

export const RECONCILIATION_CONTRACT_VERSION_V2 = 2 as const;

interface ReconciliationResultBaseV2 {
  readonly id: ReconciliationResultId;
  readonly target: ReconciliationTargetV1;
  readonly value: ComparedGradeValueV1;
  readonly ruleVersion: string;
}

export type ReconciliationResultV2 =
  | (ReconciliationResultBaseV2 & {
      readonly status: Extract<ReconciliationStatusV1, 'match' | 'expected-difference' | 'mismatch'>;
      readonly difference: number;
      readonly explanation?: string;
    })
  | (ReconciliationResultBaseV2 & {
      readonly status: 'not-comparable';
      readonly difference: null;
      readonly explanation: string;
    });

const ACADEMIC_IMPACT_STATES_V2 = ['none', 'material', 'potentially-material'] as const;

export type AcademicImpactAssessmentV2 =
  | {
      readonly state: 'none' | 'material';
      readonly basis: 'official-domain-rule';
      readonly ruleVersion: string;
    }
  | {
      readonly state: 'potentially-material';
      readonly basis: 'fail-closed-unresolved';
      readonly reason: string;
    };

const RECONCILIATION_INVESTIGATION_STATES_V2 = [
  'not-required',
  'required',
  'in-progress',
  'reconciled',
  'accepted-with-reason',
] as const;

export type ReconciliationInvestigationV2 =
  | { readonly state: 'not-required' }
  | { readonly state: 'required'; readonly reason: string }
  | { readonly state: 'in-progress'; readonly investigationReference: string }
  | { readonly state: 'reconciled'; readonly resolutionReference: string }
  | {
      readonly state: 'accepted-with-reason';
      readonly resolutionReference: string;
      readonly justification: string;
    };

const DETERMINISTIC_CORRECTION_OPERATION_KINDS_V2 = [
  'renormalize-imported-record',
  'reprocess-derived-result',
  'reapply-official-reconciliation',
] as const;

export type DeterministicCorrectionPreconditionV2 =
  | {
      readonly kind: 'cas';
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'immutable-input-set';
      readonly inputVersionReferences: readonly [string, ...string[]];
    };

type GradeEntryReconciliationTargetV2 = Extract<
  ReconciliationTargetV1,
  { readonly kind: 'grade-entry' }
>;
type DerivedResultReconciliationTargetV2 = Extract<
  ReconciliationTargetV1,
  { readonly kind: 'term-result' | 'final-recovery' | 'annual-result' }
>;

export type DeterministicCorrectionOperationV2 =
  | {
      readonly kind: 'renormalize-imported-record';
      readonly target: GradeEntryReconciliationTargetV2;
      readonly deterministicOutputReference: string;
    }
  | {
      readonly kind: 'reprocess-derived-result';
      readonly target: DerivedResultReconciliationTargetV2;
      readonly profileId: string;
      readonly profileVersion: string;
      readonly deterministicOutputReference: string;
    }
  | {
      readonly kind: 'reapply-official-reconciliation';
      readonly target: ReconciliationTargetV1;
      readonly reconciliationRuleVersion: string;
      readonly deterministicOutputReference: string;
    };

export interface DeterministicCorrectionProofV2 {
  readonly rootCause: {
    readonly state: 'identified';
    readonly code: string;
  };
  readonly officialEvidenceReferences: readonly [string, ...string[]];
  readonly candidateOperationCount: 1;
  readonly requiresHumanJudgment: false;
  readonly destination: 'internal-versioned-state';
  readonly operation: DeterministicCorrectionOperationV2;
  readonly precondition: DeterministicCorrectionPreconditionV2;
}

export const AUTOMATIC_CORRECTION_NOT_ELIGIBLE_REASONS_V2 = [
  'root-cause-not-identified',
  'official-evidence-insufficient',
  'candidate-not-unique',
  'human-judgment-required',
  'destination-not-authorized',
  'precondition-missing',
  'source-document-correction-required',
  'software-change-required',
  'operation-not-supported',
  'correction-not-required',
] as const;
export type AutomaticCorrectionNotEligibleReasonV2 =
  (typeof AUTOMATIC_CORRECTION_NOT_ELIGIBLE_REASONS_V2)[number];

export type AutomaticCorrectionEligibilityV2 =
  | {
      readonly state: 'eligible';
      readonly proof: DeterministicCorrectionProofV2;
    }
  | {
      readonly state: 'not-eligible';
      readonly reason: AutomaticCorrectionNotEligibleReasonV2;
      readonly explanation: string;
    };

const DETERMINISTIC_CORRECTION_OUTCOME_STATES_V2 = [
  'not-run',
  'completed',
  'failed',
] as const;

export type DeterministicCorrectionOutcomeV2 =
  | {
      readonly state: 'not-run';
      readonly reason: 'not-required' | 'not-eligible' | 'blocked';
    }
  | {
      readonly state: 'completed';
      readonly previousVersionReference: string;
      readonly newVersionReference: string;
      readonly evidencePreserved: true;
    }
  | {
      readonly state: 'failed';
      readonly reason: string;
      readonly evidencePreserved: true;
    };

const INSTITUTIONAL_RELEASE_STATES_V2 = ['blocked', 'eligible', 'released'] as const;

export type InstitutionalReleaseV2 =
  | {
      readonly state: 'blocked';
      readonly reason:
        | 'investigation-required'
        | 'potential-academic-impact'
        | 'deterministic-correction-pending'
        | 'pilot-stop';
    }
  | { readonly state: 'eligible' }
  | { readonly state: 'released'; readonly releaseReference: string };

export type PilotFlowStateV2 =
  | {
      readonly state: 'continue';
      readonly authorityMode: 'imported-source';
      readonly basis: 'no-blocking-divergence' | 'reconciled-or-accepted';
    }
  | {
      readonly state: 'stop';
      readonly authorityMode: 'imported-source';
      readonly reason:
        | 'mismatch-with-academic-impact'
        | 'potential-academic-impact-unresolved'
        | 'investigation-required';
    };

export interface ReconciliationCaseV2 {
  readonly contractVersion: typeof RECONCILIATION_CONTRACT_VERSION_V2;
  readonly divergence: ReconciliationResultV2;
  readonly academicImpact: AcademicImpactAssessmentV2;
  readonly investigation: ReconciliationInvestigationV2;
  readonly automaticCorrection: AutomaticCorrectionEligibilityV2;
  readonly correctionOutcome: DeterministicCorrectionOutcomeV2;
  readonly institutionalRelease: InstitutionalReleaseV2;
  readonly pilotFlow: PilotFlowStateV2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTarget(value: unknown): value is ReconciliationTargetV1 {
  if (!isRecord(value) || !isNonEmptyString(value.kind) || !isNonEmptyString(value.id)) return false;
  return ['grade-entry', 'term-result', 'final-recovery', 'annual-result'].includes(value.kind);
}

function isPrecondition(value: unknown): value is DeterministicCorrectionPreconditionV2 {
  if (!isRecord(value)) return false;
  if (value.kind === 'cas') {
    return Number.isInteger(value.expectedVersion) && Number(value.expectedVersion) >= 0;
  }
  if (value.kind === 'immutable-input-set') {
    return (
      Array.isArray(value.inputVersionReferences) &&
      value.inputVersionReferences.length > 0 &&
      value.inputVersionReferences.every(isNonEmptyString)
    );
  }
  return false;
}

function isOperation(value: unknown): value is DeterministicCorrectionOperationV2 {
  if (!isRecord(value) || !isNonEmptyString(value.deterministicOutputReference)) return false;
  if (value.kind === 'renormalize-imported-record') {
    return isTarget(value.target) && value.target.kind === 'grade-entry';
  }
  if (value.kind === 'reprocess-derived-result') {
    return (
      isTarget(value.target) &&
      ['term-result', 'final-recovery', 'annual-result'].includes(value.target.kind) &&
      isNonEmptyString(value.profileId) &&
      isNonEmptyString(value.profileVersion)
    );
  }
  if (value.kind === 'reapply-official-reconciliation') {
    return isTarget(value.target) && isNonEmptyString(value.reconciliationRuleVersion);
  }
  return false;
}

/** Fail-closed proof validator. Unsupported or arbitrary mutation shapes never become eligible. */
export function isDeterministicCorrectionProofV2(
  value: unknown,
): value is DeterministicCorrectionProofV2 {
  if (!isRecord(value) || !isRecord(value.rootCause)) return false;
  if (
    value.rootCause.state !== 'identified' ||
    !isNonEmptyString(value.rootCause.code) ||
    !Array.isArray(value.officialEvidenceReferences) ||
    value.officialEvidenceReferences.length === 0 ||
    !value.officialEvidenceReferences.every(isNonEmptyString) ||
    value.candidateOperationCount !== 1 ||
    value.requiresHumanJudgment !== false ||
    value.destination !== 'internal-versioned-state'
  ) {
    return false;
  }
  return isOperation(value.operation) && isPrecondition(value.precondition);
}

/**
 * Pilot gate over already-classified official states. It does not invent numeric materiality.
 * Unknown impact remains potentially material and therefore stops the affected flow.
 */
export function resolvePilotFlowStateV2(input: {
  readonly divergence: ReconciliationResultV2;
  readonly academicImpact: AcademicImpactAssessmentV2;
  readonly investigation: ReconciliationInvestigationV2;
}): PilotFlowStateV2 {
  if (
    input.investigation.state === 'reconciled' ||
    input.investigation.state === 'accepted-with-reason'
  ) {
    return {
      state: 'continue',
      authorityMode: 'imported-source',
      basis: 'reconciled-or-accepted',
    };
  }

  if (input.academicImpact.state === 'potentially-material') {
    return {
      state: 'stop',
      authorityMode: 'imported-source',
      reason: 'potential-academic-impact-unresolved',
    };
  }

  if (input.divergence.status === 'mismatch' && input.academicImpact.state === 'material') {
    return {
      state: 'stop',
      authorityMode: 'imported-source',
      reason: 'mismatch-with-academic-impact',
    };
  }

  if (input.investigation.state === 'required' || input.investigation.state === 'in-progress') {
    return {
      state: 'stop',
      authorityMode: 'imported-source',
      reason: 'investigation-required',
    };
  }

  return {
    state: 'continue',
    authorityMode: 'imported-source',
    basis: 'no-blocking-divergence',
  };
}

export const RECONCILIATION_CONTRACT_V2 = {
  version: RECONCILIATION_CONTRACT_VERSION_V2,
  predecessorVersion: AUDIT_CONTRACT_V1.version,
  compatibility: {
    reconciliationStatuses: RECONCILIATION_STATUSES_V1,
    reinterpretHistoricalV1: false,
    historicalToleranceField: 'preserve-as-v1-only',
  },
  academicImpactStates: ACADEMIC_IMPACT_STATES_V2,
  investigationStates: RECONCILIATION_INVESTIGATION_STATES_V2,
  correctionOperationKinds: DETERMINISTIC_CORRECTION_OPERATION_KINDS_V2,
  correctionOutcomeStates: DETERMINISTIC_CORRECTION_OUTCOME_STATES_V2,
  institutionalReleaseStates: INSTITUTIONAL_RELEASE_STATES_V2,
  automaticCorrection: {
    rootCauseRequired: true,
    officialEvidenceRequired: true,
    candidateOperationCount: 1,
    humanJudgment: 'forbidden',
    destination: 'internal-versioned-state',
    writePrecondition: 'required-when-applicable',
    arbitraryMutation: 'forbidden',
    sourceDocumentMutation: 'forbidden',
    runtimeCodeMutation: 'forbidden',
    councilDecision: 'forbidden',
  },
  tolerance: 'forbidden-in-v2',
  numericMaterialityHeuristic: 'forbidden',
  pilotAuthorityMode: 'imported-source',
  history: 'append-only-versioned-evidence-preserved',
} as const;
