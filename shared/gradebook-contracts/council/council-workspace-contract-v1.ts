import type { PlatformCapability } from '../../platform-contract';
import type { AcademicYearId } from '../entities';
import type {
  AcademicGradeValueV1,
  AcademicResultStateV1,
  AnnualFinalDecisionV1,
  ResultCoverageV1,
} from '../results/results-contract-v1';

export const COUNCIL_WORKSPACE_CONTRACT_VERSION_V1 = 1 as const;
export const COUNCIL_WORKSPACE_REQUIRED_CAPABILITY_V1 =
  'gradebook.persistence.admin' satisfies PlatformCapability;
const COUNCIL_WORKSPACE_MIN_LIMIT_V1 = 1 as const;
export const COUNCIL_WORKSPACE_MAX_LIMIT_V1 = 100 as const;
const COUNCIL_WORKSPACE_MAX_JUSTIFICATION_LENGTH_V1 = 4_000 as const;

export const COUNCIL_QUEUE_STATES_V1 = [
  'follows-official-annual-result',
  'eligible-for-council',
  'not-eligible-for-council',
  'insufficient-data',
] as const;
export type CouncilQueueStateV1 = (typeof COUNCIL_QUEUE_STATES_V1)[number];

export const COUNCIL_ANNUAL_PERIODS_V1 = ['T1', 'T2', 'T3', 'REC'] as const;
export type CouncilAnnualPeriodV1 = (typeof COUNCIL_ANNUAL_PERIODS_V1)[number];

export const COUNCIL_DECISION_SELECTIONS_V1 = [
  { outcome: 'approved', resultingState: 'approved-by-council' },
  { outcome: 'failed', resultingState: 'failed-by-council-decision' },
] as const;
export type CouncilDecisionSelectionV1 = (typeof COUNCIL_DECISION_SELECTIONS_V1)[number];

export const COUNCIL_LIST_NON_DISCLOSURE_OUTCOMES_V1 = [
  'no-results',
  'invalid-request',
  'invalid-cursor',
  'not-authorized',
  'unavailable',
  'insufficient-data',
] as const;
type CouncilListNonDisclosureOutcomeV1 =
  (typeof COUNCIL_LIST_NON_DISCLOSURE_OUTCOMES_V1)[number];

export const COUNCIL_DETAIL_NON_DISCLOSURE_OUTCOMES_V1 = [
  'not-found',
  'invalid-request',
  'not-authorized',
  'unavailable',
  'insufficient-data',
] as const;
type CouncilDetailNonDisclosureOutcomeV1 =
  (typeof COUNCIL_DETAIL_NON_DISCLOSURE_OUTCOMES_V1)[number];

export const COUNCIL_DECISION_FAILURE_OUTCOMES_V1 = [
  'version-conflict',
  'decision-unavailable',
  'invalid-request',
  'not-found',
  'not-authorized',
  'unavailable',
  'insufficient-data',
] as const;
type CouncilDecisionFailureOutcomeV1 =
  (typeof COUNCIL_DECISION_FAILURE_OUTCOMES_V1)[number];

declare const councilClassReferenceBrand: unique symbol;
declare const councilStudentReferenceBrand: unique symbol;
declare const councilComponentReferenceBrand: unique symbol;
declare const councilDecisionReferenceBrand: unique symbol;
declare const councilActorReferenceBrand: unique symbol;
declare const councilCursorBrand: unique symbol;

/** Opaque references are issued by server-side Council sources and never interpreted by the browser. */
export type CouncilClassReferenceV1 = string & {
  readonly [councilClassReferenceBrand]: 'CouncilClassReferenceV1';
};
export type CouncilStudentReferenceV1 = string & {
  readonly [councilStudentReferenceBrand]: 'CouncilStudentReferenceV1';
};
export type CouncilComponentReferenceV1 = string & {
  readonly [councilComponentReferenceBrand]: 'CouncilComponentReferenceV1';
};
export type CouncilDecisionReferenceV1 = string & {
  readonly [councilDecisionReferenceBrand]: 'CouncilDecisionReferenceV1';
};
export type CouncilActorReferenceV1 = string & {
  readonly [councilActorReferenceBrand]: 'CouncilActorReferenceV1';
};
export type CouncilCursorV1 = string & {
  readonly [councilCursorBrand]: 'CouncilCursorV1';
};

export interface CouncilOfficialEvidenceV1 {
  /** User-facing description of already resolved official evidence. */
  readonly label: string;
  /** Opaque reference only; raw source coordinates are intentionally not part of this transport. */
  readonly reference: string;
}

export interface CouncilOfficialPeriodResultV1 {
  readonly period: CouncilAnnualPeriodV1;
  readonly value: AcademicGradeValueV1;
  readonly coverage: ResultCoverageV1;
  readonly evidence: readonly CouncilOfficialEvidenceV1[];
}

export interface CouncilAnnualComponentViewV1 {
  readonly componentReference: CouncilComponentReferenceV1;
  readonly componentLabel: string;
  /** Always ordered T1, T2, T3, REC. Values are projected, never recalculated by Council. */
  readonly periods: readonly [
    CouncilOfficialPeriodResultV1,
    CouncilOfficialPeriodResultV1,
    CouncilOfficialPeriodResultV1,
    CouncilOfficialPeriodResultV1,
  ];
  readonly annualState: AcademicResultStateV1;
  readonly annualCoverage: ResultCoverageV1;
}

export interface CouncilCalculatedProjectionV1 {
  /** Classification supplied by the official read source; Council does not derive it from the count. */
  readonly queueState: CouncilQueueStateV1;
  readonly officialAnnualState: AcademicResultStateV1;
  readonly failedComponentCount: number | null;
  readonly coverage: ResultCoverageV1;
  readonly reason: string;
}

interface CouncilQueueItemV1 {
  readonly studentReference: CouncilStudentReferenceV1;
  readonly studentLabel: string;
  readonly calculated: CouncilCalculatedProjectionV1;
  readonly currentDecisionVersion: number;
}

export interface CouncilQueuePageRequestV1 {
  readonly limit: number;
  readonly cursor: CouncilCursorV1 | null;
}

export interface CouncilQueueRequestV1 {
  readonly operation: 'queue';
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
  readonly page: CouncilQueuePageRequestV1;
}

export interface CouncilStudentRequestV1 {
  readonly operation: 'student';
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
  readonly studentReference: CouncilStudentReferenceV1;
}

export interface CouncilDecisionRequestV1 {
  readonly operation: 'decision';
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
  readonly studentReference: CouncilStudentReferenceV1;
  readonly expectedVersion: number;
  readonly decision: CouncilDecisionSelectionV1;
  readonly justification: string;
}

export interface CouncilDecisionHistoryEntryV1 {
  readonly decisionReference: CouncilDecisionReferenceV1;
  readonly version: number;
  readonly decision: CouncilDecisionSelectionV1;
  readonly annualFinalDecision: Extract<AnnualFinalDecisionV1, { readonly status: 'recorded' }>;
  readonly justification: string;
  readonly actorReference: CouncilActorReferenceV1;
  readonly decidedAt: string;
}

interface CouncilStudentDetailV1 {
  readonly studentReference: CouncilStudentReferenceV1;
  readonly studentLabel: string;
  readonly classReference: CouncilClassReferenceV1;
  readonly classLabel: string;
  readonly calculated: CouncilCalculatedProjectionV1;
  /** Summary comes before component detail in the UI; the source supplies all period values. */
  readonly annualView: readonly CouncilAnnualComponentViewV1[];
  readonly currentDecision: CouncilDecisionHistoryEntryV1 | null;
  readonly history: readonly CouncilDecisionHistoryEntryV1[];
  readonly version: number;
}

export interface CouncilQueueItemsV1 {
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: 'items';
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
  readonly items: readonly CouncilQueueItemV1[];
  readonly nextCursor: CouncilCursorV1 | null;
}

export interface CouncilListNonDisclosureV1 {
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: CouncilListNonDisclosureOutcomeV1;
  readonly items: readonly [];
  readonly nextCursor: null;
}

export type CouncilQueueResponseV1 = CouncilQueueItemsV1 | CouncilListNonDisclosureV1;

export interface CouncilStudentDetailPresentV1 {
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: 'detail';
  readonly academicYearId: AcademicYearId;
  readonly detail: CouncilStudentDetailV1;
}

export interface CouncilDetailNonDisclosureV1 {
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: CouncilDetailNonDisclosureOutcomeV1;
  readonly detail: null;
}

export type CouncilStudentResponseV1 = CouncilStudentDetailPresentV1 | CouncilDetailNonDisclosureV1;

export interface CouncilDecisionAppliedV1 {
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: 'applied';
  readonly studentReference: CouncilStudentReferenceV1;
  readonly version: number;
  readonly record: CouncilDecisionHistoryEntryV1;
}

export interface CouncilDecisionVersionConflictV1 {
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: 'version-conflict';
  readonly currentVersion: number | null;
}

export interface CouncilDecisionNonDisclosureV1 {
  readonly contractVersion: typeof COUNCIL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: Exclude<CouncilDecisionFailureOutcomeV1, 'version-conflict'>;
  readonly currentVersion: null;
}

export type CouncilDecisionResponseV1 =
  | CouncilDecisionAppliedV1
  | CouncilDecisionVersionConflictV1
  | CouncilDecisionNonDisclosureV1;
export type CouncilWorkspaceResponseV1 =
  | CouncilQueueResponseV1
  | CouncilStudentResponseV1
  | CouncilDecisionResponseV1;

export const COUNCIL_WORKSPACE_AUTHORIZATION_POLICY_V1 = {
  enforcement: 'server',
  requiredCapability: COUNCIL_WORKSPACE_REQUIRED_CAPABILITY_V1,
  authorizationContext: 'server-issued-opaque',
  clientAuthorizationClaims: 'forbidden',
} as const;

export const COUNCIL_UNSUPPORTED_SEMANTICS_V1 = [
  'ballot-or-vote-count',
  'tie-break',
  'abstention',
  'named-participant-or-participant-role',
  'attendance-as-automatic-rule',
  'attendance-failure-inference',
  'undocumented-individual-exception',
  'consecutive-history-rule',
  'new-cut-tolerance-or-rounding',
] as const;

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

type CouncilQueueRequestReadinessV1 = 'ready' | 'invalid-request' | 'invalid-cursor';
type CouncilStudentRequestReadinessV1 = 'ready' | 'invalid-request';
type CouncilDecisionRequestReadinessV1 = 'ready' | 'invalid-request';

export function inspectCouncilQueueRequestV1(value: unknown): CouncilQueueRequestReadinessV1 {
  if (!isObject(value)) return 'invalid-request';
  if (
    !hasOnlyKeys(value, [
      'operation',
      'contractVersion',
      'academicYearId',
      'classReference',
      'page',
    ]) ||
    value.operation !== 'queue' ||
    value.contractVersion !== COUNCIL_WORKSPACE_CONTRACT_VERSION_V1 ||
    !nonEmptyString(value.academicYearId) ||
    !nonEmptyString(value.classReference) ||
    !isObject(value.page) ||
    !hasOnlyKeys(value.page, ['limit', 'cursor']) ||
    !Number.isInteger(value.page.limit) ||
    Number(value.page.limit) < COUNCIL_WORKSPACE_MIN_LIMIT_V1 ||
    Number(value.page.limit) > COUNCIL_WORKSPACE_MAX_LIMIT_V1
  ) {
    return 'invalid-request';
  }
  return value.page.cursor === null || nonEmptyString(value.page.cursor) ? 'ready' : 'invalid-cursor';
}

export function inspectCouncilStudentRequestV1(value: unknown): CouncilStudentRequestReadinessV1 {
  if (!isObject(value)) return 'invalid-request';
  return hasOnlyKeys(value, [
    'operation',
    'contractVersion',
    'academicYearId',
    'classReference',
    'studentReference',
  ]) &&
    value.operation === 'student' &&
    value.contractVersion === COUNCIL_WORKSPACE_CONTRACT_VERSION_V1 &&
    nonEmptyString(value.academicYearId) &&
    nonEmptyString(value.classReference) &&
    nonEmptyString(value.studentReference)
    ? 'ready'
    : 'invalid-request';
}

export function inspectCouncilDecisionRequestV1(value: unknown): CouncilDecisionRequestReadinessV1 {
  if (!isObject(value)) return 'invalid-request';
  return hasOnlyKeys(value, [
    'operation',
    'contractVersion',
    'academicYearId',
    'classReference',
    'studentReference',
    'expectedVersion',
    'decision',
    'justification',
  ]) &&
    value.operation === 'decision' &&
    value.contractVersion === COUNCIL_WORKSPACE_CONTRACT_VERSION_V1 &&
    nonEmptyString(value.academicYearId) &&
    nonEmptyString(value.classReference) &&
    nonEmptyString(value.studentReference) &&
    nonNegativeInteger(value.expectedVersion) &&
    isDecisionSelection(value.decision) &&
    nonEmptyString(value.justification) &&
    String(value.justification).trim().length <= COUNCIL_WORKSPACE_MAX_JUSTIFICATION_LENGTH_V1
    ? 'ready'
    : 'invalid-request';
}
