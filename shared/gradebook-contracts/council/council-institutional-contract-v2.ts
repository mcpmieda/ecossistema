import type { AcademicYearId } from '../entities';
import {
  COUNCIL_DECISION_SELECTIONS_V1,
  COUNCIL_WORKSPACE_REQUIRED_CAPABILITY_V1,
  type CouncilActorReferenceV1,
  type CouncilCalculatedProjectionV1,
  type CouncilClassReferenceV1,
  type CouncilDecisionHistoryEntryV1,
  type CouncilDecisionSelectionV1,
  type CouncilStudentReferenceV1,
} from './council-workspace-contract-v1';

export const COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2 = 2 as const;
const COUNCIL_INSTITUTIONAL_REQUIRED_CAPABILITY_V2 =
  COUNCIL_WORKSPACE_REQUIRED_CAPABILITY_V1;

export const COUNCIL_INSTITUTIONAL_OPERATIONS_V2 = [
  'closure-review',
  'vote',
  'tie-break',
  'closure-close',
  'closure-history',
] as const;
export type CouncilInstitutionalOperationV2 =
  (typeof COUNCIL_INSTITUTIONAL_OPERATIONS_V2)[number];

export const COUNCIL_MEETING_STATES_V2 = ['open', 'closed'] as const;
export type CouncilMeetingStateV2 = (typeof COUNCIL_MEETING_STATES_V2)[number];

export const COUNCIL_REVIEW_CONSISTENCY_STATES_V2 = [
  'ready',
  'decision-required',
  'decision-inconsistent',
] as const;
export type CouncilReviewConsistencyV2 =
  (typeof COUNCIL_REVIEW_CONSISTENCY_STATES_V2)[number];

export const COUNCIL_VOTE_COMPARISONS_V2 = [
  'approved-leading',
  'failed-leading',
  'tie',
] as const;
export type CouncilVoteComparisonV2 = (typeof COUNCIL_VOTE_COMPARISONS_V2)[number];

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

declare const councilReviewReferenceBrand: unique symbol;
declare const councilClosureReferenceBrand: unique symbol;

/** Opaque concurrency fingerprint issued by the server after a pre-closure review. */
export type CouncilReviewReferenceV2 = string & {
  readonly [councilReviewReferenceBrand]: 'CouncilReviewReferenceV2';
};

/** Opaque immutable closure reference issued by the institutional session store. */
export type CouncilClosureReferenceV2 = string & {
  readonly [councilClosureReferenceBrand]: 'CouncilClosureReferenceV2';
};

export interface CouncilVoteTallyV2 {
  readonly studentReference: CouncilStudentReferenceV1;
  readonly approvedVotes: number;
  readonly failedVotes: number;
  /** Arithmetic comparison only. It never creates or changes the human Council decision. */
  readonly comparison: CouncilVoteComparisonV2;
  /** Class-session version produced by recording this optional tally. */
  readonly version: number;
  /** Audit actor who entered the numeric tally; this is not a participant roster. */
  readonly actorReference: CouncilActorReferenceV1;
  readonly recordedAt: string;
}

export interface CouncilClosureReviewItemV2 {
  readonly studentReference: CouncilStudentReferenceV1;
  readonly studentLabel: string;
  readonly calculated: CouncilCalculatedProjectionV1;
  readonly currentDecisionVersion: number;
  readonly currentDecision: CouncilDecisionHistoryEntryV1 | null;
  readonly vote: CouncilVoteTallyV2 | null;
  readonly consistency: CouncilReviewConsistencyV2;
}

export interface CouncilClosureBlockerV2 {
  readonly studentReference: CouncilStudentReferenceV1;
  readonly code: Exclude<CouncilReviewConsistencyV2, 'ready'>;
}

export interface CouncilMeetingSummaryV2 {
  readonly state: CouncilMeetingStateV2;
  readonly version: number;
  readonly closedAt: string | null;
  readonly closedBy: CouncilActorReferenceV1 | null;
}

export interface CouncilClosureSnapshotV2 {
  readonly closureReference: CouncilClosureReferenceV2;
  readonly version: number;
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
  readonly reviewReference: CouncilReviewReferenceV2;
  readonly items: readonly CouncilClosureReviewItemV2[];
  readonly closedBy: CouncilActorReferenceV1;
  readonly closedAt: string;
}

interface CouncilInstitutionalRequestBaseV2 {
  readonly contractVersion: typeof COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2;
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
}

export interface CouncilClosureReviewRequestV2 extends CouncilInstitutionalRequestBaseV2 {
  readonly operation: 'closure-review';
}

export interface CouncilVoteRequestV2 extends CouncilInstitutionalRequestBaseV2 {
  readonly operation: 'vote';
  readonly studentReference: CouncilStudentReferenceV1;
  readonly expectedVersion: number;
  readonly approvedVotes: number;
  readonly failedVotes: number;
}

export interface CouncilTieBreakRequestV2 extends CouncilInstitutionalRequestBaseV2 {
  readonly operation: 'tie-break';
  readonly studentReference: CouncilStudentReferenceV1;
  readonly expectedVersion: number;
  /** Carried only to make the requested action explicit; it is never applied without official identity semantics. */
  readonly decision: CouncilDecisionSelectionV1;
}

export interface CouncilClosureCloseRequestV2 extends CouncilInstitutionalRequestBaseV2 {
  readonly operation: 'closure-close';
  readonly expectedVersion: number;
  readonly reviewReference: CouncilReviewReferenceV2;
}

export interface CouncilClosureHistoryRequestV2 extends CouncilInstitutionalRequestBaseV2 {
  readonly operation: 'closure-history';
}

export interface CouncilClosureReviewReadyV2 {
  readonly contractVersion: typeof COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2;
  readonly outcome: 'review';
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
  readonly meeting: CouncilMeetingSummaryV2;
  readonly reviewReference: CouncilReviewReferenceV2;
  readonly items: readonly CouncilClosureReviewItemV2[];
  readonly blockers: readonly CouncilClosureBlockerV2[];
  readonly canClose: boolean;
}

export interface CouncilVoteAppliedV2 {
  readonly contractVersion: typeof COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2;
  readonly outcome: 'vote-applied';
  readonly version: number;
  readonly vote: CouncilVoteTallyV2;
}

export interface CouncilClosureAppliedV2 {
  readonly contractVersion: typeof COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2;
  readonly outcome: 'closed';
  readonly version: number;
  readonly snapshot: CouncilClosureSnapshotV2;
}

export interface CouncilClosureHistoryReadyV2 {
  readonly contractVersion: typeof COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2;
  readonly outcome: 'closure-history';
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
  readonly meeting: CouncilMeetingSummaryV2;
  readonly entries: readonly CouncilClosureSnapshotV2[];
}

export interface CouncilInstitutionalFailureV2 {
  readonly contractVersion: typeof COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2;
  readonly outcome: CouncilInstitutionalFailureOutcomeV2;
  readonly currentVersion: number | null;
  readonly blockers?: readonly CouncilClosureBlockerV2[];
}

export type CouncilClosureReviewResponseV2 =
  | CouncilClosureReviewReadyV2
  | CouncilInstitutionalFailureV2;
export type CouncilVoteResponseV2 = CouncilVoteAppliedV2 | CouncilInstitutionalFailureV2;
export type CouncilTieBreakResponseV2 = CouncilInstitutionalFailureV2;
export type CouncilClosureCloseResponseV2 = CouncilClosureAppliedV2 | CouncilInstitutionalFailureV2;
export type CouncilClosureHistoryResponseV2 =
  | CouncilClosureHistoryReadyV2
  | CouncilInstitutionalFailureV2;

export const COUNCIL_INSTITUTIONAL_POLICY_V2 = {
  officialProjectionSource: 'existing-council-workspace-source-v1',
  decisionSource: 'existing-explicit-human-council-decision-v1',
  closureSource: 'explicit-authorized-human-action',
  closureSnapshot: 'immutable-server-side-photo',
  postClosureDecisionMutation: 'forbidden',
  reopening: 'not-exposed-until-official-semantics-exist',
  vote: 'optional-numeric-tally',
  voteRequiredForDecision: false,
  voteCreatesDecision: false,
  tieResolution: 'never-automatic',
  directorIdentity: 'not-formalized-fail-closed',
  administratorIsDirector: false,
  nominalParticipants: 'not-represented',
  actorSource: 'server-authenticated-context',
  occurredAtSource: 'server',
  authorizationCapability: COUNCIL_INSTITUTIONAL_REQUIRED_CAPABILITY_V2,
  persistence: 'provider-independent-local-preview-disposable',
  physicalDurability: 'reserved-to-separate-issue',
} as const;

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
