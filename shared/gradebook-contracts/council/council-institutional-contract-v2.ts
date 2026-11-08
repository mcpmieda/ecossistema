import { COUNCIL_DECISION_SELECTIONS_V1, type CouncilDecisionSelectionV1, type CouncilStudentReferenceV1 } from './council-workspace-contract-v1';

export const COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2 = 2 as const;

export const COUNCIL_INSTITUTIONAL_OPERATIONS_V2 = [
  'closure-review',
  'vote',
  'tie-break',
  'closure-close',
  'closure-history',
] as const;
export type CouncilInstitutionalOperationV2 =
  (typeof COUNCIL_INSTITUTIONAL_OPERATIONS_V2)[number];

export const COUNCIL_REVIEW_CONSISTENCY_STATES_V2 = [
  'ready',
  'decision-required',
  'decision-inconsistent',
] as const;
type CouncilReviewConsistencyV2 =
  (typeof COUNCIL_REVIEW_CONSISTENCY_STATES_V2)[number];

export const COUNCIL_INSTITUTIONAL_FAILURE_OUTCOMES_V2 = [
  'invalid-request',
  'not-authorized',
  'not-found',
  'unavailable',
  'insufficient-data',
  'version-conflict',
  'review-conflict',
  'closure-blocked',
  'already-closed',
  'meeting-closed',
  'tie-break-not-applicable',
  'tie-break-identity-unavailable',
] as const;
export type CouncilInstitutionalFailureOutcomeV2 =
  (typeof COUNCIL_INSTITUTIONAL_FAILURE_OUTCOMES_V2)[number];


export interface CouncilClosureBlockerV2 {
  readonly studentReference: CouncilStudentReferenceV1;
  readonly code: Exclude<CouncilReviewConsistencyV2, 'ready'>;
}

export interface CouncilInstitutionalFailureV2 {
  readonly contractVersion: typeof COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2;
  readonly outcome: CouncilInstitutionalFailureOutcomeV2;
  readonly currentVersion: number | null;
  readonly blockers?: readonly CouncilClosureBlockerV2[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isDecisionSelection(value: unknown): value is CouncilDecisionSelectionV1 {
  if (!isObject(value) || !hasOnlyKeys(value, ['outcome', 'resultingState'])) return false;
  return COUNCIL_DECISION_SELECTIONS_V1.some(
    (selection) =>
      selection.outcome === value.outcome && selection.resultingState === value.resultingState,
  );
}

function hasValidBase(value: Record<string, unknown>): boolean {
  return (
    value.contractVersion === COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2 &&
    nonEmptyString(value.academicYearId) &&
    nonEmptyString(value.classReference)
  );
}

type CouncilInstitutionalRequestReadinessV2 = 'ready' | 'invalid-request';

export function inspectCouncilInstitutionalRequestV2(
  value: unknown,
): CouncilInstitutionalRequestReadinessV2 {
  if (!isObject(value) || !hasValidBase(value)) return 'invalid-request';

  switch (value.operation) {
    case 'closure-review':
    case 'closure-history':
      return hasOnlyKeys(value, [
        'operation',
        'contractVersion',
        'academicYearId',
        'classReference',
      ])
        ? 'ready'
        : 'invalid-request';
    case 'vote':
      return hasOnlyKeys(value, [
        'operation',
        'contractVersion',
        'academicYearId',
        'classReference',
        'studentReference',
        'expectedVersion',
        'approvedVotes',
        'failedVotes',
      ]) &&
        nonEmptyString(value.studentReference) &&
        nonNegativeInteger(value.expectedVersion) &&
        nonNegativeInteger(value.approvedVotes) &&
        nonNegativeInteger(value.failedVotes)
        ? 'ready'
        : 'invalid-request';
    case 'tie-break':
      return hasOnlyKeys(value, [
        'operation',
        'contractVersion',
        'academicYearId',
        'classReference',
        'studentReference',
        'expectedVersion',
        'decision',
      ]) &&
        nonEmptyString(value.studentReference) &&
        nonNegativeInteger(value.expectedVersion) &&
        isDecisionSelection(value.decision)
        ? 'ready'
        : 'invalid-request';
    case 'closure-close':
      return hasOnlyKeys(value, [
        'operation',
        'contractVersion',
        'academicYearId',
        'classReference',
        'expectedVersion',
        'reviewReference',
      ]) &&
        nonNegativeInteger(value.expectedVersion) &&
        nonEmptyString(value.reviewReference)
        ? 'ready'
        : 'invalid-request';
    default:
      return 'invalid-request';
  }
}
