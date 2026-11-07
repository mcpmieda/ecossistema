import type {
  AcademicYearId,
  ClassGroupId,
  StudentId,
  SubjectId,
  TeacherId,
} from '../entities';
import type { PlatformCapability } from '../../platform-contract';

export const GLOBAL_SEARCH_CONTRACT_VERSION_V1 = 1 as const;

export const GLOBAL_SEARCH_REQUIRED_CAPABILITY_V1 =
  'gradebook.persistence.admin' satisfies PlatformCapability;

export const GLOBAL_SEARCH_RESULT_KINDS_V1 = [
  'student',
  'class-group',
  'teacher',
  'subject',
] as const;
export type GlobalSearchResultKindV1 = (typeof GLOBAL_SEARCH_RESULT_KINDS_V1)[number];

export const GLOBAL_SEARCH_RESULT_KIND_ORDER_V1 = GLOBAL_SEARCH_RESULT_KINDS_V1;
export const GLOBAL_SEARCH_ORDER_V1 =
  'kind-presentation-id-ascending-code-unit' as const;
const GLOBAL_SEARCH_MIN_LIMIT_V1 = 1 as const;
export const GLOBAL_SEARCH_MAX_LIMIT_V1 = 100 as const;

export const GLOBAL_SEARCH_NON_DISCLOSURE_OUTCOMES_V1 = [
  'empty-query',
  'no-results',
  'insufficient-data',
  'insufficient-scope',
  'invalid-request',
  'not-authorized',
] as const;
export type GlobalSearchNonDisclosureOutcomeV1 =
  (typeof GLOBAL_SEARCH_NON_DISCLOSURE_OUTCOMES_V1)[number];

export const GLOBAL_SEARCH_REQUEST_READINESS_V1 = [
  'ready',
  'empty-query',
  'insufficient-scope',
  'invalid-request',
] as const;
type GlobalSearchRequestReadinessV1 =
  (typeof GLOBAL_SEARCH_REQUEST_READINESS_V1)[number];

declare const globalSearchCursorBrand: unique symbol;

/** Opaque continuation value issued and consumed only by the search implementation. */
export type GlobalSearchCursorV1 = string & {
  readonly [globalSearchCursorBrand]: 'GlobalSearchCursorV1';
};

export interface GlobalSearchScopeV1 {
  readonly kinds: readonly GlobalSearchResultKindV1[];
}

export interface GlobalSearchPageRequestV1 {
  readonly limit: number;
  readonly cursor: GlobalSearchCursorV1 | null;
}

/**
 * Provider-independent academic search request.
 *
 * Authorization is deliberately absent: the server authenticates the session and reuses the
 * existing capability before this request may reach an academic search implementation.
 */
export interface GlobalSearchRequestV1 {
  readonly contractVersion: typeof GLOBAL_SEARCH_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly query: string;
  readonly scope: GlobalSearchScopeV1;
  readonly page: GlobalSearchPageRequestV1;
  readonly order: typeof GLOBAL_SEARCH_ORDER_V1;
}

export interface StudentGlobalSearchResultV1 {
  readonly kind: 'student';
  readonly id: StudentId;
  readonly displayName: string;
}

export interface ClassGroupGlobalSearchResultV1 {
  readonly kind: 'class-group';
  readonly id: ClassGroupId;
  readonly code: string;
}

export interface TeacherGlobalSearchResultV1 {
  readonly kind: 'teacher';
  readonly id: TeacherId;
  readonly displayName: string;
}

export interface SubjectGlobalSearchResultV1 {
  readonly kind: 'subject';
  readonly id: SubjectId;
  readonly displayName: string;
}

export type GlobalSearchResultV1 =
  | StudentGlobalSearchResultV1
  | ClassGroupGlobalSearchResultV1
  | TeacherGlobalSearchResultV1
  | SubjectGlobalSearchResultV1;

const GLOBAL_SEARCH_RESULT_FIELDS_V1 = {
  student: ['kind', 'id', 'displayName'],
  'class-group': ['kind', 'id', 'code'],
  teacher: ['kind', 'id', 'displayName'],
  subject: ['kind', 'id', 'displayName'],
} as const satisfies Record<GlobalSearchResultKindV1, readonly string[]>;

export interface GlobalSearchResultsPageV1 {
  readonly contractVersion: typeof GLOBAL_SEARCH_CONTRACT_VERSION_V1;
  readonly outcome: 'results';
  readonly academicYearId: AcademicYearId;
  readonly order: typeof GLOBAL_SEARCH_ORDER_V1;
  readonly limit: number;
  readonly items: readonly [GlobalSearchResultV1, ...GlobalSearchResultV1[]];
  readonly nextCursor: GlobalSearchCursorV1 | null;
}

/**
 * Every non-disclosure condition has the same data-bearing shape: no entity, total, query, year or
 * continuation hint is returned.
 */
export interface GlobalSearchNonDisclosureV1 {
  readonly contractVersion: typeof GLOBAL_SEARCH_CONTRACT_VERSION_V1;
  readonly outcome: GlobalSearchNonDisclosureOutcomeV1;
  readonly items: readonly [];
  readonly nextCursor: null;
}

export type GlobalSearchResponseV1 = GlobalSearchResultsPageV1 | GlobalSearchNonDisclosureV1;

export const GLOBAL_SEARCH_AUTHORIZATION_POLICY_V1 = {
  enforcement: 'server',
  requiredCapability: GLOBAL_SEARCH_REQUIRED_CAPABILITY_V1,
  authorizationContext: 'server-issued-opaque',
  clientAuthorizationClaims: 'forbidden',
} as const;

export const GLOBAL_SEARCH_CONTRACT_V1 = {
  version: GLOBAL_SEARCH_CONTRACT_VERSION_V1,
  resultKinds: GLOBAL_SEARCH_RESULT_KINDS_V1,
  resultKindOrder: GLOBAL_SEARCH_RESULT_KIND_ORDER_V1,
  resultFields: GLOBAL_SEARCH_RESULT_FIELDS_V1,
  order: GLOBAL_SEARCH_ORDER_V1,
  pagination: {
    minimumLimit: GLOBAL_SEARCH_MIN_LIMIT_V1,
    maximumLimit: GLOBAL_SEARCH_MAX_LIMIT_V1,
    cursor: 'opaque',
    totalCount: 'omitted',
  },
  authorization: GLOBAL_SEARCH_AUTHORIZATION_POLICY_V1,
  nonDisclosureOutcomes: GLOBAL_SEARCH_NON_DISCLOSURE_OUTCOMES_V1,
  querySemantics: {
    matching: 'outside-contract',
    fuzzyMatching: 'forbidden',
    identityHeuristics: 'forbidden',
    academicRules: 'forbidden',
  },
} as const;

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function presentationValue(result: GlobalSearchResultV1): string {
  return result.kind === 'class-group' ? result.code : result.displayName;
}

function kindPosition(kind: GlobalSearchResultKindV1): number {
  return GLOBAL_SEARCH_RESULT_KIND_ORDER_V1.indexOf(kind);
}

/** Deterministic ordering without locale, fuzzy matching or query normalization. */
export function compareGlobalSearchResultsV1(
  left: GlobalSearchResultV1,
  right: GlobalSearchResultV1,
): number {
  return (
    kindPosition(left.kind) - kindPosition(right.kind) ||
    compareCodeUnits(presentationValue(left), presentationValue(right)) ||
    compareCodeUnits(left.id, right.id)
  );
}

export function isGlobalSearchResultPresentableV1(result: GlobalSearchResultV1): boolean {
  return result.id.trim().length > 0 && presentationValue(result).trim().length > 0;
}

export function isGlobalSearchResultOrderV1(
  items: readonly GlobalSearchResultV1[],
): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous === undefined || current === undefined) return false;
    if (compareGlobalSearchResultsV1(previous, current) > 0) return false;
  }
  return true;
}

export function isGlobalSearchLimitV1(limit: number): boolean {
  return (
    Number.isInteger(limit) &&
    limit >= GLOBAL_SEARCH_MIN_LIMIT_V1 &&
    limit <= GLOBAL_SEARCH_MAX_LIMIT_V1
  );
}

export function isGlobalSearchQueryEmptyV1(query: string): boolean {
  return query.trim().length === 0;
}

export function isGlobalSearchScopeSufficientV1(scope: GlobalSearchScopeV1): boolean {
  if (scope.kinds.length === 0) return false;
  const allowed = new Set<GlobalSearchResultKindV1>(GLOBAL_SEARCH_RESULT_KINDS_V1);
  const unique = new Set<GlobalSearchResultKindV1>();
  for (const kind of scope.kinds) {
    if (!allowed.has(kind) || unique.has(kind)) return false;
    unique.add(kind);
  }
  return true;
}

export function inspectGlobalSearchRequestV1(
  request: GlobalSearchRequestV1,
): GlobalSearchRequestReadinessV1 {
  if (
    request.contractVersion !== GLOBAL_SEARCH_CONTRACT_VERSION_V1 ||
    request.order !== GLOBAL_SEARCH_ORDER_V1 ||
    request.academicYearId.trim().length === 0 ||
    !isGlobalSearchLimitV1(request.page.limit) ||
    (request.page.cursor !== null && request.page.cursor.trim().length === 0)
  ) {
    return 'invalid-request';
  }
  if (isGlobalSearchQueryEmptyV1(request.query)) return 'empty-query';
  if (!isGlobalSearchScopeSufficientV1(request.scope)) return 'insufficient-scope';
  return 'ready';
}

export function isGlobalSearchResultsPageValidV1(page: GlobalSearchResultsPageV1): boolean {
  return (
    page.contractVersion === GLOBAL_SEARCH_CONTRACT_VERSION_V1 &&
    page.outcome === 'results' &&
    page.academicYearId.trim().length > 0 &&
    page.order === GLOBAL_SEARCH_ORDER_V1 &&
    isGlobalSearchLimitV1(page.limit) &&
    page.items.length > 0 &&
    page.items.length <= page.limit &&
    page.items.every(isGlobalSearchResultPresentableV1) &&
    isGlobalSearchResultOrderV1(page.items) &&
    (page.nextCursor === null || page.nextCursor.trim().length > 0)
  );
}
