import type {
  AcademicYearId,
  ClassGroupId,
  EnrollmentId,
  EnrollmentPositionV1,
  EntityLifecycleStatusV1,
  StudentId,
  StudentStatusEventId,
  StudentStatusV1,
  SubjectId,
  TeacherId,
  TeachingAssignmentId,
} from '../entities';
import {
  GLOBAL_SEARCH_CONTRACT_VERSION_V1,
  GLOBAL_SEARCH_NON_DISCLOSURE_OUTCOMES_V1,
  GLOBAL_SEARCH_ORDER_V1,
  GLOBAL_SEARCH_RESULT_KINDS_V1,
  inspectGlobalSearchRequestV1,
  isGlobalSearchResultsPageValidV1,
  type GlobalSearchNonDisclosureV1,
  type GlobalSearchRequestV1,
  type GlobalSearchResponseV1,
  type GlobalSearchResultsPageV1,
} from '../search/global-search-contract-v1';
import {
  OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
  containsOperationalWorkspaceForbiddenClientFieldV1,
  isOperationalWorkspaceAcademicYearContextValidV1,
  isOperationalWorkspaceSearchResponseValidV1,
  type OperationalWorkspaceAcademicYearContextV1,
  type OperationalWorkspaceAcademicYearOptionV1,
  type OperationalWorkspaceNotAuthorizedV1,
  type OperationalWorkspaceUnavailableV1,
} from './operational-workspace-contract-v1';

export const OPERATIONAL_WORKSPACE_TRANSPORT_VERSION_V1 = 1 as const;

export const OPERATIONAL_WORKSPACE_TRANSPORT_OPERATIONS_V1 = [
  'bootstrap',
  'student',
  'class-group',
  'teacher',
  'subject',
  'search',
] as const;
export type OperationalWorkspaceTransportOperationV1 =
  (typeof OPERATIONAL_WORKSPACE_TRANSPORT_OPERATIONS_V1)[number];

export interface OperationalWorkspaceBootstrapRequestV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_TRANSPORT_VERSION_V1;
  readonly operation: 'bootstrap';
}

interface OperationalWorkspaceCenterRequestBaseV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_TRANSPORT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
}

export interface OperationalWorkspaceStudentRequestV1
  extends OperationalWorkspaceCenterRequestBaseV1 {
  readonly operation: 'student';
  readonly id: StudentId;
}

export interface OperationalWorkspaceClassGroupRequestV1
  extends OperationalWorkspaceCenterRequestBaseV1 {
  readonly operation: 'class-group';
  readonly id: ClassGroupId;
}

export interface OperationalWorkspaceTeacherRequestV1
  extends OperationalWorkspaceCenterRequestBaseV1 {
  readonly operation: 'teacher';
  readonly id: TeacherId;
}

export interface OperationalWorkspaceSubjectRequestV1
  extends OperationalWorkspaceCenterRequestBaseV1 {
  readonly operation: 'subject';
  readonly id: SubjectId;
}

export interface OperationalWorkspaceSearchTransportRequestV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_TRANSPORT_VERSION_V1;
  readonly operation: 'search';
  readonly request: GlobalSearchRequestV1;
}

export type OperationalWorkspaceTransportRequestV1 =
  | OperationalWorkspaceBootstrapRequestV1
  | OperationalWorkspaceStudentRequestV1
  | OperationalWorkspaceClassGroupRequestV1
  | OperationalWorkspaceTeacherRequestV1
  | OperationalWorkspaceSubjectRequestV1
  | OperationalWorkspaceSearchTransportRequestV1;

export interface OperationalWorkspaceStudentLinkV1 {
  readonly kind: 'student';
  readonly id: StudentId;
  readonly label: string;
}

export interface OperationalWorkspaceClassGroupLinkV1 {
  readonly kind: 'class-group';
  readonly id: ClassGroupId;
  readonly label: string;
}

export interface OperationalWorkspaceTeacherLinkV1 {
  readonly kind: 'teacher';
  readonly id: TeacherId;
  readonly label: string;
}

export interface OperationalWorkspaceSubjectLinkV1 {
  readonly kind: 'subject';
  readonly id: SubjectId;
  readonly label: string;
}

export type OperationalWorkspaceEntityLinkV1 =
  | OperationalWorkspaceStudentLinkV1
  | OperationalWorkspaceClassGroupLinkV1
  | OperationalWorkspaceTeacherLinkV1
  | OperationalWorkspaceSubjectLinkV1;

export interface OperationalWorkspaceStudentStatusV1 {
  readonly id: StudentStatusEventId;
  readonly status: StudentStatusV1;
  readonly occurredOn?: string;
}

export interface OperationalWorkspaceStudentEnrollmentV1 {
  readonly id: EnrollmentId;
  readonly position: EnrollmentPositionV1;
  readonly classGroup: OperationalWorkspaceClassGroupLinkV1 | null;
  readonly statusHistory: readonly OperationalWorkspaceStudentStatusV1[];
}

export interface OperationalWorkspaceStudentCenterViewV1 {
  readonly kind: 'student';
  readonly id: StudentId;
  readonly displayName: string;
  readonly enrollments: readonly OperationalWorkspaceStudentEnrollmentV1[];
}

export interface OperationalWorkspaceClassGroupStudentV1 {
  readonly id: EnrollmentId;
  readonly position: EnrollmentPositionV1;
  readonly student: OperationalWorkspaceStudentLinkV1 | null;
  readonly statusHistory: readonly OperationalWorkspaceStudentStatusV1[];
}

export interface OperationalWorkspaceTeachingAssignmentV1 {
  readonly id: TeachingAssignmentId;
  readonly classGroup?: OperationalWorkspaceClassGroupLinkV1 | null;
  readonly teacher?: OperationalWorkspaceTeacherLinkV1 | null;
  readonly subject?: OperationalWorkspaceSubjectLinkV1 | null;
}

export interface OperationalWorkspaceClassGroupCenterViewV1 {
  readonly kind: 'class-group';
  readonly id: ClassGroupId;
  readonly code: string;
  readonly schoolGrade: string;
  readonly section: string;
  readonly shift?: string;
  readonly students: readonly OperationalWorkspaceClassGroupStudentV1[];
  readonly assignments: readonly OperationalWorkspaceTeachingAssignmentV1[];
}

export interface OperationalWorkspaceTeacherCenterViewV1 {
  readonly kind: 'teacher';
  readonly id: TeacherId;
  readonly displayName: string;
  readonly status: EntityLifecycleStatusV1;
  readonly assignments: readonly OperationalWorkspaceTeachingAssignmentV1[];
}

export interface OperationalWorkspaceSubjectCenterViewV1 {
  readonly kind: 'subject';
  readonly id: SubjectId;
  readonly code: string;
  readonly displayName: string;
  readonly shortName: string;
  readonly status: EntityLifecycleStatusV1;
  readonly assignments: readonly OperationalWorkspaceTeachingAssignmentV1[];
}

export type OperationalWorkspaceCenterViewV1 =
  | OperationalWorkspaceStudentCenterViewV1
  | OperationalWorkspaceClassGroupCenterViewV1
  | OperationalWorkspaceTeacherCenterViewV1
  | OperationalWorkspaceSubjectCenterViewV1;

export interface OperationalWorkspaceBootstrapReadyV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'ready';
  readonly availableAcademicYears: readonly [
    OperationalWorkspaceAcademicYearOptionV1,
    ...OperationalWorkspaceAcademicYearOptionV1[],
  ];
}

export interface OperationalWorkspaceBootstrapEmptyV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'empty';
  readonly availableAcademicYears: readonly [];
}

export interface OperationalWorkspaceCenterReadyV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'ready';
  readonly context: OperationalWorkspaceAcademicYearContextV1;
  readonly view: OperationalWorkspaceCenterViewV1;
}

export interface OperationalWorkspaceCenterEmptyV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'empty';
  readonly context: OperationalWorkspaceAcademicYearContextV1;
}

export interface OperationalWorkspaceSearchReadyV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'ready';
  readonly context: OperationalWorkspaceAcademicYearContextV1;
  readonly search: GlobalSearchResultsPageV1;
}

export interface OperationalWorkspaceSearchEmptyV1 {
  readonly contractVersion: typeof OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1;
  readonly state: 'empty';
  readonly context: OperationalWorkspaceAcademicYearContextV1;
  readonly search: GlobalSearchNonDisclosureV1;
}

export type OperationalWorkspaceTransportResponseV1 =
  | OperationalWorkspaceBootstrapReadyV1
  | OperationalWorkspaceBootstrapEmptyV1
  | OperationalWorkspaceCenterReadyV1
  | OperationalWorkspaceCenterEmptyV1
  | OperationalWorkspaceSearchReadyV1
  | OperationalWorkspaceSearchEmptyV1
  | OperationalWorkspaceUnavailableV1
  | OperationalWorkspaceNotAuthorizedV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwnKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAcademicYearOption(value: unknown): value is OperationalWorkspaceAcademicYearOptionV1 {
  return (
    isRecord(value) &&
    hasOwnKeys(value, ['id', 'label']) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.label)
  );
}

function isAcademicYearOptions(value: unknown): value is readonly OperationalWorkspaceAcademicYearOptionV1[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const option of value) {
    if (!isAcademicYearOption(option) || ids.has(option.id)) return false;
    ids.add(option.id);
  }
  return true;
}

function isAcademicYearContext(value: unknown): value is OperationalWorkspaceAcademicYearContextV1 {
  return (
    isRecord(value) &&
    hasOwnKeys(value, ['selectedAcademicYearId', 'availableAcademicYears']) &&
    nonEmptyString(value.selectedAcademicYearId) &&
    isAcademicYearOptions(value.availableAcademicYears) &&
    value.availableAcademicYears.length > 0 &&
    isOperationalWorkspaceAcademicYearContextValidV1(
      value as unknown as OperationalWorkspaceAcademicYearContextV1,
    )
  );
}

function isGlobalSearchRequest(value: unknown): value is GlobalSearchRequestV1 {
  if (
    !isRecord(value) ||
    !hasOwnKeys(value, [
      'contractVersion',
      'academicYearId',
      'query',
      'scope',
      'page',
      'order',
    ]) ||
    value.contractVersion !== GLOBAL_SEARCH_CONTRACT_VERSION_V1 ||
    value.order !== GLOBAL_SEARCH_ORDER_V1 ||
    !nonEmptyString(value.academicYearId) ||
    typeof value.query !== 'string' ||
    !isRecord(value.scope) ||
    !hasOwnKeys(value.scope, ['kinds']) ||
    !Array.isArray(value.scope.kinds) ||
    !value.scope.kinds.every(
      (kind) =>
        typeof kind === 'string' &&
        (GLOBAL_SEARCH_RESULT_KINDS_V1 as readonly string[]).includes(kind),
    ) ||
    !isRecord(value.page) ||
    !hasOwnKeys(value.page, ['limit', 'cursor']) ||
    typeof value.page.limit !== 'number' ||
    (value.page.cursor !== null && typeof value.page.cursor !== 'string')
  ) {
    return false;
  }

  return inspectGlobalSearchRequestV1(value as unknown as GlobalSearchRequestV1) !== 'invalid-request';
}

export function isOperationalWorkspaceTransportRequestV1(
  value: unknown,
): value is OperationalWorkspaceTransportRequestV1 {
  if (
    !isRecord(value) ||
    containsOperationalWorkspaceForbiddenClientFieldV1(value) ||
    value.contractVersion !== OPERATIONAL_WORKSPACE_TRANSPORT_VERSION_V1 ||
    typeof value.operation !== 'string' ||
    !(OPERATIONAL_WORKSPACE_TRANSPORT_OPERATIONS_V1 as readonly string[]).includes(value.operation)
  ) {
    return false;
  }

  if (value.operation === 'bootstrap') {
    return hasOwnKeys(value, ['contractVersion', 'operation']);
  }

  if (value.operation === 'search') {
    return hasOwnKeys(value, ['contractVersion', 'operation', 'request']) && isGlobalSearchRequest(value.request);
  }

  return (
    hasOwnKeys(value, ['contractVersion', 'operation', 'academicYearId', 'id']) &&
    nonEmptyString(value.academicYearId) &&
    nonEmptyString(value.id)
  );
}

function isEntityLink(value: unknown, kind: OperationalWorkspaceEntityLinkV1['kind']): boolean {
  return (
    isRecord(value) &&
    hasOwnKeys(value, ['kind', 'id', 'label']) &&
    value.kind === kind &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.label)
  );
}

function isStatusHistory(value: unknown): value is readonly OperationalWorkspaceStudentStatusV1[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      isRecord(item) &&
      hasOwnKeys(item, ['id', 'status'], ['occurredOn']) &&
      nonEmptyString(item.id) &&
      ['active', 'transferred', 'withdrawn', 'deceased', 'other'].includes(String(item.status)) &&
      (item.occurredOn === undefined || nonEmptyString(item.occurredOn)),
  );
}

function isAssignment(value: unknown): value is OperationalWorkspaceTeachingAssignmentV1 {
  if (
    !isRecord(value) ||
    !hasOwnKeys(value, ['id'], ['classGroup', 'teacher', 'subject']) ||
    !nonEmptyString(value.id)
  ) {
    return false;
  }
  if (
    value.classGroup !== undefined &&
    value.classGroup !== null &&
    !isEntityLink(value.classGroup, 'class-group')
  ) {
    return false;
  }
  if (value.teacher !== undefined && value.teacher !== null && !isEntityLink(value.teacher, 'teacher')) {
    return false;
  }
  if (value.subject !== undefined && value.subject !== null && !isEntityLink(value.subject, 'subject')) {
    return false;
  }
  return true;
}

function isCenterView(value: unknown): value is OperationalWorkspaceCenterViewV1 {
  if (!isRecord(value) || typeof value.kind !== 'string' || !nonEmptyString(value.id)) return false;

  if (value.kind === 'student') {
    return (
      hasOwnKeys(value, ['kind', 'id', 'displayName', 'enrollments']) &&
      nonEmptyString(value.displayName) &&
      Array.isArray(value.enrollments) &&
      value.enrollments.every(
        (enrollment) =>
          isRecord(enrollment) &&
          hasOwnKeys(enrollment, ['id', 'position', 'classGroup', 'statusHistory']) &&
          nonEmptyString(enrollment.id) &&
          (enrollment.position === 'current' || enrollment.position === 'historical') &&
          (enrollment.classGroup === null || isEntityLink(enrollment.classGroup, 'class-group')) &&
          isStatusHistory(enrollment.statusHistory),
      )
    );
  }

  if (value.kind === 'class-group') {
    return (
      hasOwnKeys(
        value,
        ['kind', 'id', 'code', 'schoolGrade', 'section', 'students', 'assignments'],
        ['shift'],
      ) &&
      nonEmptyString(value.code) &&
      nonEmptyString(value.schoolGrade) &&
      nonEmptyString(value.section) &&
      (value.shift === undefined || nonEmptyString(value.shift)) &&
      Array.isArray(value.students) &&
      value.students.every(
        (student) =>
          isRecord(student) &&
          hasOwnKeys(student, ['id', 'position', 'student', 'statusHistory']) &&
          nonEmptyString(student.id) &&
          (student.position === 'current' || student.position === 'historical') &&
          (student.student === null || isEntityLink(student.student, 'student')) &&
          isStatusHistory(student.statusHistory),
      ) &&
      Array.isArray(value.assignments) &&
      value.assignments.every(isAssignment)
    );
  }

  if (value.kind === 'teacher') {
    return (
      hasOwnKeys(value, ['kind', 'id', 'displayName', 'status', 'assignments']) &&
      nonEmptyString(value.displayName) &&
      (value.status === 'active' || value.status === 'inactive') &&
      Array.isArray(value.assignments) &&
      value.assignments.every(isAssignment)
    );
  }

  if (value.kind === 'subject') {
    return (
      hasOwnKeys(value, ['kind', 'id', 'code', 'displayName', 'shortName', 'status', 'assignments']) &&
      nonEmptyString(value.code) &&
      nonEmptyString(value.displayName) &&
      nonEmptyString(value.shortName) &&
      (value.status === 'active' || value.status === 'inactive') &&
      Array.isArray(value.assignments) &&
      value.assignments.every(isAssignment)
    );
  }

  return false;
}

function isSearchResult(value: unknown): boolean {
  if (!isRecord(value) || !nonEmptyString(value.kind) || !nonEmptyString(value.id)) return false;
  if (!(GLOBAL_SEARCH_RESULT_KINDS_V1 as readonly string[]).includes(value.kind)) return false;
  return value.kind === 'class-group' ? nonEmptyString(value.code) : nonEmptyString(value.displayName);
}

function isGlobalSearchResponse(value: unknown): value is GlobalSearchResponseV1 {
  if (!isRecord(value) || typeof value.outcome !== 'string') return false;
  if (value.outcome === 'results') {
    if (
      !hasOwnKeys(value, [
        'contractVersion',
        'outcome',
        'academicYearId',
        'order',
        'limit',
        'items',
        'nextCursor',
      ]) ||
      value.contractVersion !== GLOBAL_SEARCH_CONTRACT_VERSION_V1 ||
      !nonEmptyString(value.academicYearId) ||
      value.order !== GLOBAL_SEARCH_ORDER_V1 ||
      typeof value.limit !== 'number' ||
      !Array.isArray(value.items) ||
      !value.items.every(isSearchResult) ||
      (value.nextCursor !== null && !nonEmptyString(value.nextCursor))
    ) {
      return false;
    }
  } else if (
    !hasOwnKeys(value, ['contractVersion', 'outcome', 'items', 'nextCursor']) ||
    value.contractVersion !== GLOBAL_SEARCH_CONTRACT_VERSION_V1 ||
    !(GLOBAL_SEARCH_NON_DISCLOSURE_OUTCOMES_V1 as readonly string[]).includes(value.outcome) ||
    !Array.isArray(value.items) ||
    value.items.length !== 0 ||
    value.nextCursor !== null
  ) {
    return false;
  }

  return isOperationalWorkspaceSearchResponseValidV1(value as unknown as GlobalSearchResponseV1);
}

function isSearchNonDisclosure(value: GlobalSearchResponseV1): value is GlobalSearchNonDisclosureV1 {
  return value.outcome !== 'results';
}

/** The year choice: exact keys, valid options, none when empty and some when ready. */
function isYearOptionsResponseV1(value: Record<string, unknown>) {
  if (!hasOwnKeys(value, ['contractVersion', 'state', 'availableAcademicYears'])) return false;
  if (!isAcademicYearOptions(value.availableAcademicYears)) return false;
  if (value.state === 'empty') return value.availableAcademicYears.length === 0;
  return value.state === 'ready' && value.availableAcademicYears.length > 0;
}

/** A search answer: a valid results page when ready; otherwise an empty query or no results. */
function isSearchStateResponseV1(value: Record<string, unknown>) {
  if (!isGlobalSearchResponse(value.search)) return false;
  if (value.state === 'ready') {
    return (
      hasOwnKeys(value, ['contractVersion', 'state', 'context', 'search']) &&
      isGlobalSearchResultsPageValidV1(value.search as GlobalSearchResultsPageV1)
    );
  }
  return (
    hasOwnKeys(value, ['contractVersion', 'state', 'context', 'search']) &&
    isSearchNonDisclosure(value.search) &&
    (value.search.outcome === 'empty-query' || value.search.outcome === 'no-results')
  );
}

export function isOperationalWorkspaceTransportResponseV1(
  value: unknown,
): value is OperationalWorkspaceTransportResponseV1 {
  if (
    !isRecord(value) ||
    containsOperationalWorkspaceForbiddenClientFieldV1(value) ||
    value.contractVersion !== OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1 ||
    typeof value.state !== 'string'
  ) {
    return false;
  }

  if (value.state === 'unavailable' || value.state === 'not-authorized') {
    return hasOwnKeys(value, ['contractVersion', 'state']);
  }

  if (Object.hasOwn(value, 'availableAcademicYears')) return isYearOptionsResponseV1(value);

  if ((value.state !== 'ready' && value.state !== 'empty') || !isAcademicYearContext(value.context)) {
    return false;
  }

  if (Object.hasOwn(value, 'search')) return isSearchStateResponseV1(value);

  if (value.state === 'empty') {
    return hasOwnKeys(value, ['contractVersion', 'state', 'context']);
  }

  return hasOwnKeys(value, ['contractVersion', 'state', 'context', 'view']) && isCenterView(value.view);
}
