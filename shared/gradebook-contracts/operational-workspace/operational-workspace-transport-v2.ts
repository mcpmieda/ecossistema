import { isGradebookAcademicYearV2 } from '../academic-year-v2';

/** Relational, read-only workspace. V1 consumers keep their original contract. Refs #639. */
export const OPERATIONAL_WORKSPACE_VERSION_V2 = 2 as const;
export const WORKSPACE_KINDS_V2 = ['student', 'class-group', 'teacher', 'subject'] as const;
export type WorkspaceKindV2 = (typeof WORKSPACE_KINDS_V2)[number];
export type WorkspaceStatusV2 = null | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const WORKSPACE_PAGE_LIMIT_V2 = 200;
export const WORKSPACE_MAX_OFFSET_V2 = 100_000;
export const WORKSPACE_MAX_YEARS_V2 = 200;

export interface WorkspaceYearV2 {
  readonly year: number;
  readonly minimumApprovalMilli: number;
  readonly maxCouncilComponents: number;
}
export interface WorkspaceLinkV2 {
  readonly kind: WorkspaceKindV2;
  readonly id: number;
  readonly label: string;
}
export interface WorkspaceBindingV2 {
  readonly student: WorkspaceLinkV2;
  readonly classGroup: WorkspaceLinkV2;
  readonly number: number;
  readonly status: WorkspaceStatusV2;
  readonly position: 'current' | 'historical';
  readonly relatedClass: WorkspaceLinkV2 | null;
}
export interface WorkspaceOfferV2 {
  readonly id: number;
  readonly classGroup: WorkspaceLinkV2;
  readonly teacher: WorkspaceLinkV2;
  readonly subject: WorkspaceLinkV2;
}
export interface WorkspaceCountsV2 {
  readonly students: number;
  readonly classes: number;
  readonly teachers: number;
  readonly subjects: number;
  readonly offers: number;
  readonly currentBindings: number;
  readonly historicalBindings: number;
}
export interface WorkspaceSearchItemV2 {
  readonly entity: WorkspaceLinkV2;
  readonly description: string | null;
}
export interface WorkspaceCenterV2 {
  readonly entity: WorkspaceLinkV2;
  readonly classInfo: { readonly code: string; readonly stage: number; readonly shift: string } | null;
  readonly bindings: readonly WorkspaceBindingV2[];
  readonly offers: readonly WorkspaceOfferV2[];
  /** Shared offset advances both independently ordered lists; no list is silently truncated. */
  readonly nextOffset: number | null;
}
interface PageV2 { readonly offset: number; readonly limit: number }
export type OperationalWorkspaceRequestV2 =
  | { readonly contractVersion: 2; readonly operation: 'bootstrap' }
  | { readonly contractVersion: 2; readonly operation: 'context'; readonly year: number }
  | ({ readonly contractVersion: 2; readonly operation: 'search'; readonly year: number; readonly kind: WorkspaceKindV2 | 'all'; readonly query: string } & PageV2)
  | ({ readonly contractVersion: 2; readonly operation: 'center'; readonly year: number; readonly kind: WorkspaceKindV2; readonly id: number } & PageV2);
export type WorkspaceFailureStateV2 = 'not-found' | 'invalid-request' | 'unavailable' | 'not-authorized';
export type OperationalWorkspaceResponseV2 =
  | { readonly contractVersion: 2; readonly state: WorkspaceFailureStateV2 }
  | { readonly contractVersion: 2; readonly state: 'ready'; readonly operation: 'bootstrap'; readonly years: readonly WorkspaceYearV2[] }
  | { readonly contractVersion: 2; readonly state: 'ready'; readonly operation: 'context'; readonly context: WorkspaceYearV2; readonly counts: WorkspaceCountsV2 }
  | { readonly contractVersion: 2; readonly state: 'ready'; readonly operation: 'search'; readonly context: WorkspaceYearV2; readonly items: readonly WorkspaceSearchItemV2[]; readonly nextOffset: number | null }
  | { readonly contractVersion: 2; readonly state: 'ready'; readonly operation: 'center'; readonly context: WorkspaceYearV2; readonly center: WorkspaceCenterV2 };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min: number, max = 2_147_483_647): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function text(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
}
function kind(value: unknown): value is WorkspaceKindV2 {
  return WORKSPACE_KINDS_V2.some((item) => item === value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function year(value: unknown): value is WorkspaceYearV2 {
  return object(value) && isGradebookAcademicYearV2(value.year) &&
    integer(value.minimumApprovalMilli, 0) && integer(value.maxCouncilComponents, 0, 32767);
}
function link(value: unknown, expected?: WorkspaceKindV2): value is WorkspaceLinkV2 {
  return object(value) && kind(value.kind) && (expected === undefined || value.kind === expected) &&
    integer(value.id, 1) && text(value.label);
}
function offset(value: unknown): value is number | null {
  return value === null || integer(value, 1, WORKSPACE_MAX_OFFSET_V2);
}
function list<T>(value: unknown, check: (item: unknown) => item is T, maximum = WORKSPACE_PAGE_LIMIT_V2): value is T[] {
  return Array.isArray(value) && value.length <= maximum && value.every(check);
}
function binding(value: unknown): value is WorkspaceBindingV2 {
  if (!object(value) || !link(value.student, 'student') || !link(value.classGroup, 'class-group') ||
      !integer(value.number, 1, 32767) || !(value.status === null || integer(value.status, 1, 7))) return false;
  if (value.position !== (value.status === 6 ? 'historical' : 'current')) return false;
  return value.status === 6 || value.status === 7
    ? link(value.relatedClass, 'class-group')
    : value.relatedClass === null;
}
function offer(value: unknown): value is WorkspaceOfferV2 {
  return object(value) && integer(value.id, 1) && link(value.classGroup, 'class-group') &&
    link(value.teacher, 'teacher') && link(value.subject, 'subject');
}
function counts(value: unknown): value is WorkspaceCountsV2 {
  return object(value) && ['students', 'classes', 'teachers', 'subjects', 'offers', 'currentBindings', 'historicalBindings']
    .every((key) => integer(value[key], 0));
}
function center(value: unknown): value is WorkspaceCenterV2 {
  if (!object(value) || !link(value.entity) || !list(value.bindings, binding) ||
      !list(value.offers, offer) || !offset(value.nextOffset)) return false;
  if (value.entity.kind === 'class-group') {
    if (!object(value.classInfo) || !text(value.classInfo.code, 100) ||
        !integer(value.classInfo.stage, 1, 32767) || !text(value.classInfo.shift, 100)) return false;
  } else if (value.classInfo !== null) return false;
  return true;
}

export function isOperationalWorkspaceRequestV2(value: unknown): value is OperationalWorkspaceRequestV2 {
  if (!object(value) || value.contractVersion !== 2) return false;
  const base = ['contractVersion', 'operation'];
  if (value.operation === 'bootstrap') return keys(value, base);
  if (!isGradebookAcademicYearV2(value.year)) return false;
  if (value.operation === 'context') return keys(value, [...base, 'year']);
  if (!integer(value.limit, 1, WORKSPACE_PAGE_LIMIT_V2) || !integer(value.offset, 0, WORKSPACE_MAX_OFFSET_V2)) return false;
  if (value.operation === 'search') {
    return keys(value, [...base, 'year', 'kind', 'query', 'offset', 'limit']) &&
      (kind(value.kind) || value.kind === 'all') && typeof value.query === 'string' &&
      value.query.length <= 80 && !value.query.includes('\0');
  }
  return value.operation === 'center' && keys(value, [...base, 'year', 'kind', 'id', 'offset', 'limit']) &&
    kind(value.kind) && integer(value.id, 1);
}

export function isOperationalWorkspaceResponseV2(value: unknown): value is OperationalWorkspaceResponseV2 {
  if (!object(value) || value.contractVersion !== 2) return false;
  if (value.state !== 'ready') return ['not-found', 'invalid-request', 'unavailable', 'not-authorized'].includes(String(value.state));
  if (value.operation === 'bootstrap') {
    return list(value.years, year, WORKSPACE_MAX_YEARS_V2) &&
      value.years.every((item, index, years) => index === 0 || years[index - 1]!.year > item.year);
  }
  if (!year(value.context)) return false;
  if (value.operation === 'context') return counts(value.counts);
  if (value.operation === 'center') return center(value.center);
  if (value.operation === 'search') {
    return offset(value.nextOffset) && list(value.items, (item): item is WorkspaceSearchItemV2 =>
      object(item) && link(item.entity) && (item.description === null || text(item.description)));
  }
  return false;
}

/** A valid response to a different context is not a valid response to this request. */
export function workspaceResponseMatchesRequestV2(request: OperationalWorkspaceRequestV2, response: OperationalWorkspaceResponseV2): boolean {
  if (response.state !== 'ready') return true;
  if (response.operation !== request.operation) return false;
  if (request.operation === 'bootstrap') return response.operation === 'bootstrap';
  if (!('context' in response) || response.context.year !== request.year) return false;
  if (request.operation === 'center') {
    return response.operation === 'center' && response.center.entity.kind === request.kind &&
      response.center.entity.id === request.id && response.center.bindings.length <= request.limit &&
      response.center.offers.length <= request.limit &&
      (response.center.nextOffset === null || response.center.nextOffset === request.offset + request.limit);
  }
  if (request.operation === 'search') {
    return response.operation === 'search' && response.items.length <= request.limit &&
      response.items.every((item) => request.kind === 'all' || item.entity.kind === request.kind) &&
      (response.nextOffset === null || response.nextOffset === request.offset + request.limit);
  }
  return true;
}
