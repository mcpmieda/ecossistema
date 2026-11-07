import { compareCanonicalStringsV1 } from '../string-order-v1';
import type {
  AcademicYearId,
  ClassGroupId,
  StudentId,
  SubjectId,
  TeacherId,
} from '../entities';
import {
  GLOBAL_SEARCH_CONTRACT_V1,
  GLOBAL_SEARCH_RESULT_KINDS_V1,
  inspectGlobalSearchRequestV1,
  isGlobalSearchResultsPageValidV1,
  type GlobalSearchRequestV1,
  type GlobalSearchResponseV1,
  type GlobalSearchResultV1,
} from '../search/global-search-contract-v1';

export const OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1 = 1 as const;

export const OPERATIONAL_WORKSPACE_STATES_V1 = [
  'loading',
  'ready',
  'empty',
  'unavailable',
  'not-authorized',
] as const;

export const OPERATIONAL_WORKSPACE_NAVIGATION_KINDS_V1 = GLOBAL_SEARCH_RESULT_KINDS_V1;

export interface OperationalWorkspaceAcademicYearOptionV1 {
  readonly id: AcademicYearId;
  readonly label: string;
}

export interface OperationalWorkspaceAcademicYearContextV1 {
  readonly selectedAcademicYearId: AcademicYearId;
  readonly availableAcademicYears: readonly [
    OperationalWorkspaceAcademicYearOptionV1,
    ...OperationalWorkspaceAcademicYearOptionV1[],
  ];
}

export interface StudentOperationalWorkspaceNavigationIntentV1 {
  readonly kind: 'student';
  readonly id: StudentId;
}

export interface ClassGroupOperationalWorkspaceNavigationIntentV1 {
  readonly kind: 'class-group';
  readonly id: ClassGroupId;
}

export interface TeacherOperationalWorkspaceNavigationIntentV1 {
  readonly kind: 'teacher';
  readonly id: TeacherId;
}

export interface SubjectOperationalWorkspaceNavigationIntentV1 {
  readonly kind: 'subject';
  readonly id: SubjectId;
}

export type OperationalWorkspaceNavigationIntentV1 =
  | StudentOperationalWorkspaceNavigationIntentV1
  | ClassGroupOperationalWorkspaceNavigationIntentV1
  | TeacherOperationalWorkspaceNavigationIntentV1
  | SubjectOperationalWorkspaceNavigationIntentV1;

/** Direct aliases: the workspace does not define a second search contract. */
export type OperationalWorkspaceSearchRequestV1 = GlobalSearchRequestV1;
export type OperationalWorkspaceSearchResponseV1 = GlobalSearchResponseV1;
export type OperationalWorkspaceSearchResultV1 = GlobalSearchResultV1;

export interface OperationalWorkspaceLoadingV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'loading';
}

export interface OperationalWorkspaceUnavailableV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'unavailable';
}

export interface OperationalWorkspaceNotAuthorizedV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'not-authorized';
}

export interface OperationalWorkspaceEmptyV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'empty';
  readonly context: OperationalWorkspaceAcademicYearContextV1;
}

export interface OperationalWorkspaceReadyV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'ready';
  readonly context: OperationalWorkspaceAcademicYearContextV1;
}

export type OperationalWorkspaceAvailabilityV1 =
  | OperationalWorkspaceLoadingV1
  | OperationalWorkspaceReadyV1
  | OperationalWorkspaceEmptyV1
  | OperationalWorkspaceUnavailableV1
  | OperationalWorkspaceNotAuthorizedV1;

export const OPERATIONAL_WORKSPACE_FORBIDDEN_CLIENT_FIELDS_V1 = [
  'role',
  'roles',
  'token',
  'accessToken',
  'capability',
  'capabilities',
  'authorized',
  'href',
  'route',
  'url',
  'grade',
  'note',
  'result',
  'evidence',
  'sourceEvidence',
  'authorityMode',
] as const;

export const OPERATIONAL_WORKSPACE_CONTRACT_V1 = {
  version: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
  states: OPERATIONAL_WORKSPACE_STATES_V1,
  navigationKinds: OPERATIONAL_WORKSPACE_NAVIGATION_KINDS_V1,
  academicYear: {
    selection: 'explicit',
    selectedYearMustBeAvailable: true,
    clockFallback: 'forbidden',
  },
  navigation: {
    identity: 'opaque-id-and-kind-only',
    route: 'outside-contract',
  },
  search: GLOBAL_SEARCH_CONTRACT_V1,
  authorization: {
    enforcement: 'server',
    clientClaims: 'forbidden',
  },
  forbiddenClientFields: OPERATIONAL_WORKSPACE_FORBIDDEN_CLIENT_FIELDS_V1,
} as const;

function hasOwnKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStringsV1);
  const sortedExpected = [...expected].sort(compareCanonicalStringsV1);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasNonEmptyOpaqueId(value: string): boolean {
  return value.trim().length > 0;
}

export function isOperationalWorkspaceAcademicYearContextValidV1(
  context: OperationalWorkspaceAcademicYearContextV1,
): boolean {
  if (!hasNonEmptyOpaqueId(context.selectedAcademicYearId)) return false;
  if (context.availableAcademicYears.length === 0) return false;

  const uniqueIds = new Set<AcademicYearId>();
  let selectedOccurrences = 0;
  for (const option of context.availableAcademicYears) {
    if (!hasOwnKeys(option, ['id', 'label'])) return false;
    if (!hasNonEmptyOpaqueId(option.id) || option.label.trim().length === 0) return false;
    if (uniqueIds.has(option.id)) return false;
    uniqueIds.add(option.id);
    if (option.id === context.selectedAcademicYearId) selectedOccurrences += 1;
  }

  return selectedOccurrences === 1;
}

export function isOperationalWorkspaceNavigationIntentValidV1(
  intent: OperationalWorkspaceNavigationIntentV1,
): boolean {
  return (
    hasOwnKeys(intent, ['kind', 'id']) &&
    OPERATIONAL_WORKSPACE_NAVIGATION_KINDS_V1.includes(intent.kind) &&
    hasNonEmptyOpaqueId(intent.id)
  );
}

/** Converts an authorized search result to navigation identity without copying presentation data. */
export function navigationIntentFromGlobalSearchResultV1(
  result: GlobalSearchResultV1,
): OperationalWorkspaceNavigationIntentV1 {
  return { kind: result.kind, id: result.id } as OperationalWorkspaceNavigationIntentV1;
}

export function isOperationalWorkspaceSearchRequestForContextV1(
  request: OperationalWorkspaceSearchRequestV1,
  context: OperationalWorkspaceAcademicYearContextV1,
): boolean {
  return (
    isOperationalWorkspaceAcademicYearContextValidV1(context) &&
    request.academicYearId === context.selectedAcademicYearId &&
    inspectGlobalSearchRequestV1(request) === 'ready'
  );
}

export function isOperationalWorkspaceSearchResponseValidV1(
  response: OperationalWorkspaceSearchResponseV1,
): boolean {
  if (response.outcome === 'results') return isGlobalSearchResultsPageValidV1(response);
  return (
    response.contractVersion === GLOBAL_SEARCH_CONTRACT_V1.version &&
    response.items.length === 0 &&
    response.nextCursor === null
  );
}

export function isOperationalWorkspaceAvailabilityValidV1(
  availability: OperationalWorkspaceAvailabilityV1,
): boolean {
  if (availability.contractVersion !== OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1) return false;

  if (
    availability.state === 'loading' ||
    availability.state === 'unavailable' ||
    availability.state === 'not-authorized'
  ) {
    return hasOwnKeys(availability, ['contractVersion', 'state']);
  }

  return (
    hasOwnKeys(availability, ['contractVersion', 'state', 'context']) &&
    isOperationalWorkspaceAcademicYearContextValidV1(availability.context)
  );
}

export function containsOperationalWorkspaceForbiddenClientFieldV1(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsOperationalWorkspaceForbiddenClientFieldV1);
  }
  if (value === null || typeof value !== 'object') return false;

  const forbidden = new Set<string>(OPERATIONAL_WORKSPACE_FORBIDDEN_CLIENT_FIELDS_V1);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbidden.has(key)) return true;
    if (containsOperationalWorkspaceForbiddenClientFieldV1(nestedValue)) return true;
  }
  return false;
}
