import type { AcademicYearId } from '../entities';
import {
  AUDIT_OCCURRENCE_STATES_V1,
  AUDIT_SEVERITIES_V1,
  RECONCILIATION_STATUSES_V1,
  type AuditAcknowledgedTransitionV1,
  type AuditDismissedTransitionV1,
  type AuditOccurrenceId,
  type AuditOccurrenceStateV1,
  type AuditOccurrenceV1,
  type AuditResolvedTransitionV1,
  type AuditSeverityV1,
  type ReconciliationResultId,
  type ReconciliationResultV1,
  type ReconciliationStatusV1,
  type ReconciliationTargetV1,
} from '../audit/audit-contract-v1';
import {
  IMPORT_BATCH_STATUSES_V1,
  type ImportBatchResultV1,
  type ImportBatchStatusV1,
} from '../imports/import-contract-v1';
import type { ImportBatchId, ImportFileId } from '../imports/import-ids-v1';
import type { PlatformCapability } from '../../platform-contract';

export const AUDIT_WORKSPACE_CONTRACT_VERSION_V1 = 1 as const;
export const AUDIT_WORKSPACE_REQUIRED_CAPABILITY_V1 =
  'gradebook.persistence.admin' satisfies PlatformCapability;
export const AUDIT_WORKSPACE_MIN_LIMIT_V1 = 1 as const;
export const AUDIT_WORKSPACE_MAX_LIMIT_V1 = 100 as const;

export const AUDIT_WORKSPACE_COLLECTIONS_V1 = [
  'import-batches',
  'audit-occurrences',
  'reconciliations',
] as const;
export type AuditWorkspaceCollectionV1 = (typeof AUDIT_WORKSPACE_COLLECTIONS_V1)[number];

export const AUDIT_WORKSPACE_ORDERS_V1 = {
  'import-batches': 'updated-at-desc-id-asc',
  'audit-occurrences': 'created-at-desc-id-asc',
  reconciliations: 'recorded-at-desc-id-asc',
} as const;
export type AuditWorkspaceOrderV1 =
  (typeof AUDIT_WORKSPACE_ORDERS_V1)[AuditWorkspaceCollectionV1];

export const AUDIT_WORKSPACE_LIST_NON_DISCLOSURE_OUTCOMES_V1 = [
  'no-results',
  'invalid-request',
  'invalid-cursor',
  'not-authorized',
  'unavailable',
  'insufficient-data',
] as const;
export type AuditWorkspaceListNonDisclosureOutcomeV1 =
  (typeof AUDIT_WORKSPACE_LIST_NON_DISCLOSURE_OUTCOMES_V1)[number];

export const AUDIT_WORKSPACE_DETAIL_NON_DISCLOSURE_OUTCOMES_V1 = [
  'not-found',
  'invalid-request',
  'not-authorized',
  'unavailable',
  'insufficient-data',
] as const;
export type AuditWorkspaceDetailNonDisclosureOutcomeV1 =
  (typeof AUDIT_WORKSPACE_DETAIL_NON_DISCLOSURE_OUTCOMES_V1)[number];

export const AUDIT_WORKSPACE_RESOLUTION_FAILURE_OUTCOMES_V1 = [
  'version-conflict',
  'invalid-transition',
  'not-found',
  'invalid-request',
  'not-authorized',
  'unavailable',
] as const;
export type AuditWorkspaceResolutionFailureOutcomeV1 =
  (typeof AUDIT_WORKSPACE_RESOLUTION_FAILURE_OUTCOMES_V1)[number];

export const AUDIT_WORKSPACE_REQUEST_READINESS_V1 = [
  'ready',
  'invalid-request',
  'invalid-cursor',
] as const;
export type AuditWorkspaceRequestReadinessV1 =
  (typeof AUDIT_WORKSPACE_REQUEST_READINESS_V1)[number];

export const AUDIT_WORKSPACE_RESOLUTION_READINESS_V1 = [
  'ready',
  'invalid-request',
  'invalid-transition',
] as const;
export type AuditWorkspaceResolutionReadinessV1 =
  (typeof AUDIT_WORKSPACE_RESOLUTION_READINESS_V1)[number];

declare const auditWorkspaceCursorBrand: unique symbol;
/** Opaque continuation value issued and consumed only by a workspace implementation. */
export type AuditWorkspaceCursorV1 = string & {
  readonly [auditWorkspaceCursorBrand]: 'AuditWorkspaceCursorV1';
};

export interface AuditWorkspacePeriodFilterV1 {
  readonly fromInclusive: string | null;
  readonly toExclusive: string | null;
}

/** All populated filter dimensions are combined with logical AND. */
export interface AuditWorkspaceFiltersV1 {
  readonly importBatchId?: ImportBatchId;
  readonly importBatchStatuses?: readonly ImportBatchStatusV1[];
  readonly occurrenceStates?: readonly AuditOccurrenceStateV1[];
  readonly severities?: readonly AuditSeverityV1[];
  readonly categories?: readonly string[];
  readonly recordTypes?: readonly ReconciliationTargetV1['kind'][];
  readonly reconciliationStatuses?: readonly ReconciliationStatusV1[];
  readonly period?: AuditWorkspacePeriodFilterV1;
}

export interface AuditWorkspacePageRequestV1 {
  readonly limit: number;
  readonly cursor: AuditWorkspaceCursorV1 | null;
}

interface AuditWorkspaceListRequestBaseV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly filters: AuditWorkspaceFiltersV1;
  readonly page: AuditWorkspacePageRequestV1;
}

/** Authorization and actor claims are deliberately absent and enforced by the server. */
export type AuditWorkspaceListRequestV1 =
  | (AuditWorkspaceListRequestBaseV1 & {
      readonly collection: 'import-batches';
      readonly order: typeof AUDIT_WORKSPACE_ORDERS_V1['import-batches'];
    })
  | (AuditWorkspaceListRequestBaseV1 & {
      readonly collection: 'audit-occurrences';
      readonly order: typeof AUDIT_WORKSPACE_ORDERS_V1['audit-occurrences'];
    })
  | (AuditWorkspaceListRequestBaseV1 & {
      readonly collection: 'reconciliations';
      readonly order: typeof AUDIT_WORKSPACE_ORDERS_V1.reconciliations;
    });

export type AuditWorkspaceDetailReferenceV1 =
  | { readonly kind: 'import-batch'; readonly id: ImportBatchId }
  | { readonly kind: 'audit-occurrence'; readonly id: AuditOccurrenceId }
  | { readonly kind: 'reconciliation'; readonly id: ReconciliationResultId };

export interface AuditWorkspaceDetailRequestV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly reference: AuditWorkspaceDetailReferenceV1;
}

export interface AuditWorkspaceImportBatchListItemV1 {
  readonly kind: 'import-batch';
  readonly reference: Extract<AuditWorkspaceDetailReferenceV1, { readonly kind: 'import-batch' }>;
  readonly status: ImportBatchResultV1['status'];
  readonly receivedAt: ImportBatchResultV1['receivedAt'];
  readonly updatedAt: ImportBatchResultV1['updatedAt'];
}

export interface AuditWorkspaceOccurrenceListItemV1 {
  readonly kind: 'audit-occurrence';
  readonly reference: Extract<
    AuditWorkspaceDetailReferenceV1,
    { readonly kind: 'audit-occurrence' }
  >;
  readonly importBatchId?: ImportBatchId;
  readonly state: AuditOccurrenceV1['state'];
  readonly severity: AuditOccurrenceV1['severity'];
  readonly category: AuditOccurrenceV1['category'];
  readonly createdAt: AuditOccurrenceV1['createdAt'];
}

export interface AuditWorkspaceReconciliationListItemV1 {
  readonly kind: 'reconciliation';
  readonly reference: Extract<
    AuditWorkspaceDetailReferenceV1,
    { readonly kind: 'reconciliation' }
  >;
  readonly status: ReconciliationResultV1['status'];
  readonly target: ReconciliationResultV1['target'];
  readonly ruleVersion: ReconciliationResultV1['ruleVersion'];
  /** Projection timestamp supplied by the persisted version, not by a new reconciliation rule. */
  readonly recordedAt: string;
}

export type AuditWorkspaceListItemV1 =
  | AuditWorkspaceImportBatchListItemV1
  | AuditWorkspaceOccurrenceListItemV1
  | AuditWorkspaceReconciliationListItemV1;

interface AuditWorkspaceItemsPageBaseV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: 'items';
  readonly academicYearId: AcademicYearId;
  readonly limit: number;
  readonly nextCursor: AuditWorkspaceCursorV1 | null;
}

export type AuditWorkspaceItemsPageV1 =
  | (AuditWorkspaceItemsPageBaseV1 & {
      readonly collection: 'import-batches';
      readonly order: typeof AUDIT_WORKSPACE_ORDERS_V1['import-batches'];
      readonly items: readonly [
        AuditWorkspaceImportBatchListItemV1,
        ...AuditWorkspaceImportBatchListItemV1[],
      ];
    })
  | (AuditWorkspaceItemsPageBaseV1 & {
      readonly collection: 'audit-occurrences';
      readonly order: typeof AUDIT_WORKSPACE_ORDERS_V1['audit-occurrences'];
      readonly items: readonly [
        AuditWorkspaceOccurrenceListItemV1,
        ...AuditWorkspaceOccurrenceListItemV1[],
      ];
    })
  | (AuditWorkspaceItemsPageBaseV1 & {
      readonly collection: 'reconciliations';
      readonly order: typeof AUDIT_WORKSPACE_ORDERS_V1.reconciliations;
      readonly items: readonly [
        AuditWorkspaceReconciliationListItemV1,
        ...AuditWorkspaceReconciliationListItemV1[],
      ];
    });

/** No year, filters, reference, count or academic payload is returned on non-disclosure. */
export interface AuditWorkspaceListNonDisclosureV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: AuditWorkspaceListNonDisclosureOutcomeV1;
  readonly items: readonly [];
  readonly nextCursor: null;
}

export type AuditWorkspaceListResponseV1 =
  | AuditWorkspaceItemsPageV1
  | AuditWorkspaceListNonDisclosureV1;

export type AuditWorkspacePendingReferenceV1 =
  | {
      readonly kind: 'import-file-review';
      readonly importBatchId: ImportBatchId;
      readonly importFileId: ImportFileId;
    }
  | {
      readonly kind: 'audit-occurrence';
      readonly id: AuditOccurrenceId;
    }
  | {
      readonly kind: 'reconciliation';
      readonly id: ReconciliationResultId;
    };

export interface AuditWorkspacePromotionEligibilityV1 {
  /** This value is projected from the existing import change plan; the workspace does not derive it. */
  readonly source: 'existing-import-change-plan';
  readonly eligible: boolean | null;
  readonly informationalOnly: true;
}

interface AuditWorkspaceDetailBaseV1 {
  readonly version: number;
  readonly recordedAt: string;
  readonly pendingItems: readonly AuditWorkspacePendingReferenceV1[];
}

export type AuditWorkspaceDetailV1 =
  | (AuditWorkspaceDetailBaseV1 & {
      readonly kind: 'import-batch';
      readonly reference: Extract<
        AuditWorkspaceDetailReferenceV1,
        { readonly kind: 'import-batch' }
      >;
      readonly record: ImportBatchResultV1;
      readonly promotionEligibility: AuditWorkspacePromotionEligibilityV1;
    })
  | (AuditWorkspaceDetailBaseV1 & {
      readonly kind: 'audit-occurrence';
      readonly reference: Extract<
        AuditWorkspaceDetailReferenceV1,
        { readonly kind: 'audit-occurrence' }
      >;
      readonly record: AuditOccurrenceV1;
    })
  | (AuditWorkspaceDetailBaseV1 & {
      readonly kind: 'reconciliation';
      readonly reference: Extract<
        AuditWorkspaceDetailReferenceV1,
        { readonly kind: 'reconciliation' }
      >;
      readonly record: ReconciliationResultV1;
    });

export interface AuditWorkspaceDetailPresentV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: 'detail';
  readonly academicYearId: AcademicYearId;
  readonly detail: AuditWorkspaceDetailV1;
}

/** Absence and authorization failures intentionally use a payload-free shape. */
export interface AuditWorkspaceDetailNonDisclosureV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: AuditWorkspaceDetailNonDisclosureOutcomeV1;
  readonly detail: null;
}

export type AuditWorkspaceDetailResponseV1 =
  | AuditWorkspaceDetailPresentV1
  | AuditWorkspaceDetailNonDisclosureV1;

/**
 * Resolution intent is projected directly from the three existing Audit transitions while omitting
 * actorId and occurredAt. The authenticated server supplies those fields when creating the actual
 * AuditOccurrenceStateTransitionV1.
 */
export type AuditWorkspaceResolutionTransitionV1 =
  | Pick<AuditAcknowledgedTransitionV1, 'previousState' | 'nextState' | 'note'>
  | Pick<AuditResolvedTransitionV1, 'previousState' | 'nextState' | 'justification'>
  | Pick<AuditDismissedTransitionV1, 'previousState' | 'nextState' | 'justification'>;

export interface AuditWorkspaceResolutionRequestV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly occurrenceId: AuditOccurrenceId;
  readonly expectedVersion: number;
  readonly transition: AuditWorkspaceResolutionTransitionV1;
}

export interface AuditWorkspaceResolutionAppliedV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: 'applied';
  readonly reference: Extract<
    AuditWorkspaceDetailReferenceV1,
    { readonly kind: 'audit-occurrence' }
  >;
  readonly version: number;
  readonly state: AuditOccurrenceStateV1;
}

export interface AuditWorkspaceResolutionVersionConflictV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: 'version-conflict';
  readonly currentVersion: number | null;
}

export interface AuditWorkspaceResolutionNonDisclosureV1 {
  readonly contractVersion: typeof AUDIT_WORKSPACE_CONTRACT_VERSION_V1;
  readonly outcome: Exclude<AuditWorkspaceResolutionFailureOutcomeV1, 'version-conflict'>;
  readonly currentVersion: null;
}

export type AuditWorkspaceResolutionResponseV1 =
  | AuditWorkspaceResolutionAppliedV1
  | AuditWorkspaceResolutionVersionConflictV1
  | AuditWorkspaceResolutionNonDisclosureV1;

export const AUDIT_WORKSPACE_AUTHORIZATION_POLICY_V1 = {
  enforcement: 'server',
  requiredCapability: AUDIT_WORKSPACE_REQUIRED_CAPABILITY_V1,
  authorizationContext: 'server-issued-opaque',
  clientAuthorizationClaims: 'forbidden',
} as const;

export const AUDIT_WORKSPACE_RESOLUTION_POLICY_V1 = {
  transitionContract: 'AuditOccurrenceStateTransitionV1',
  actorSource: 'server-authenticated-context',
  occurredAtSource: 'server',
  clientActorClaims: 'forbidden',
  optimisticConcurrency: 'expected-version',
  rawExceptions: 'forbidden',
} as const;

export const AUDIT_WORKSPACE_PROMOTION_POLICY_V1 = {
  eligibilitySource: 'existing-import-change-plan',
  planner: 'planImportReconciliation',
  executor: 'executeImportChangePlan',
  workspacePromotionOperation: 'forbidden',
  promotionRequestPayload: 'forbidden',
} as const;

export const AUDIT_WORKSPACE_CONTRACT_V1 = {
  version: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
  collections: AUDIT_WORKSPACE_COLLECTIONS_V1,
  orders: AUDIT_WORKSPACE_ORDERS_V1,
  pagination: {
    minimumLimit: AUDIT_WORKSPACE_MIN_LIMIT_V1,
    maximumLimit: AUDIT_WORKSPACE_MAX_LIMIT_V1,
    cursor: 'opaque',
    totalCount: 'omitted',
  },
  filters: {
    combination: 'logical-and',
    semantics: 'projection-only-existing-contract-fields',
  },
  listing: {
    implicitPerItemDetailFetch: 'forbidden',
    detailFetch: 'explicit-only',
  },
  authorization: AUDIT_WORKSPACE_AUTHORIZATION_POLICY_V1,
  resolution: AUDIT_WORKSPACE_RESOLUTION_POLICY_V1,
  promotion: AUDIT_WORKSPACE_PROMOTION_POLICY_V1,
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function sameUniqueStrings(values: unknown): values is readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || !values.every(nonEmptyString)) return false;
  return new Set(values).size === values.length;
}

function isAllowedArray<T extends string>(values: unknown, allowed: readonly T[]): values is readonly T[] {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === 'string' && allowed.includes(value as T)) &&
    new Set(values).size === values.length
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPeriodFilter(value: unknown): value is AuditWorkspacePeriodFilterV1 {
  if (!isObject(value) || !hasOnlyKeys(value, ['fromInclusive', 'toExclusive'])) return false;
  const from = value.fromInclusive;
  const to = value.toExclusive;
  if (from !== null && !nonEmptyString(from)) return false;
  if (to !== null && !nonEmptyString(to)) return false;
  return from !== null || to !== null;
}

export function isAuditWorkspaceLimitV1(limit: number): boolean {
  return (
    Number.isInteger(limit) &&
    limit >= AUDIT_WORKSPACE_MIN_LIMIT_V1 &&
    limit <= AUDIT_WORKSPACE_MAX_LIMIT_V1
  );
}

export function isAuditWorkspaceFiltersValidV1(filters: AuditWorkspaceFiltersV1): boolean {
  const value = filters as Record<string, unknown>;
  if (
    !hasOnlyKeys(value, [
      'importBatchId',
      'importBatchStatuses',
      'occurrenceStates',
      'severities',
      'categories',
      'recordTypes',
      'reconciliationStatuses',
      'period',
    ]) ||
    (value.importBatchId !== undefined && !nonEmptyString(value.importBatchId)) ||
    (value.importBatchStatuses !== undefined &&
      !isAllowedArray(value.importBatchStatuses, IMPORT_BATCH_STATUSES_V1)) ||
    (value.occurrenceStates !== undefined &&
      !isAllowedArray(value.occurrenceStates, AUDIT_OCCURRENCE_STATES_V1)) ||
    (value.severities !== undefined && !isAllowedArray(value.severities, AUDIT_SEVERITIES_V1)) ||
    (value.categories !== undefined && !sameUniqueStrings(value.categories)) ||
    (value.recordTypes !== undefined && !sameUniqueStrings(value.recordTypes)) ||
    (value.reconciliationStatuses !== undefined &&
      !isAllowedArray(value.reconciliationStatuses, RECONCILIATION_STATUSES_V1)) ||
    (value.period !== undefined && !isPeriodFilter(value.period))
  ) {
    return false;
  }
  return true;
}

function expectedOrder(collection: AuditWorkspaceCollectionV1): AuditWorkspaceOrderV1 {
  return AUDIT_WORKSPACE_ORDERS_V1[collection];
}

export function inspectAuditWorkspaceListRequestV1(
  request: AuditWorkspaceListRequestV1,
): AuditWorkspaceRequestReadinessV1 {
  const value = request as unknown as Record<string, unknown>;
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      'contractVersion',
      'academicYearId',
      'collection',
      'filters',
      'page',
      'order',
    ]) ||
    value.contractVersion !== AUDIT_WORKSPACE_CONTRACT_VERSION_V1 ||
    !nonEmptyString(value.academicYearId) ||
    !AUDIT_WORKSPACE_COLLECTIONS_V1.includes(value.collection as AuditWorkspaceCollectionV1) ||
    !isObject(value.filters) ||
    !isAuditWorkspaceFiltersValidV1(value.filters as AuditWorkspaceFiltersV1) ||
    !isObject(value.page) ||
    !hasOnlyKeys(value.page, ['limit', 'cursor']) ||
    !positiveInteger(value.page.limit) ||
    !isAuditWorkspaceLimitV1(value.page.limit) ||
    value.order !== expectedOrder(value.collection as AuditWorkspaceCollectionV1)
  ) {
    return 'invalid-request';
  }
  if (value.page.cursor !== null && !nonEmptyString(value.page.cursor)) return 'invalid-cursor';
  return 'ready';
}

export function inspectAuditWorkspaceDetailRequestV1(
  request: AuditWorkspaceDetailRequestV1,
): Exclude<AuditWorkspaceRequestReadinessV1, 'invalid-cursor'> {
  const value = request as unknown as Record<string, unknown>;
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ['contractVersion', 'academicYearId', 'reference']) ||
    value.contractVersion !== AUDIT_WORKSPACE_CONTRACT_VERSION_V1 ||
    !nonEmptyString(value.academicYearId) ||
    !isObject(value.reference) ||
    !hasOnlyKeys(value.reference, ['kind', 'id']) ||
    !['import-batch', 'audit-occurrence', 'reconciliation'].includes(String(value.reference.kind)) ||
    !nonEmptyString(value.reference.id)
  ) {
    return 'invalid-request';
  }
  return 'ready';
}

function validResolutionTransition(value: unknown): boolean {
  if (!isObject(value)) return false;
  switch (value.nextState) {
    case 'acknowledged':
      return (
        hasOnlyKeys(value, ['previousState', 'nextState', 'note']) &&
        value.previousState === 'open' &&
        (value.note === undefined || typeof value.note === 'string')
      );
    case 'resolved':
    case 'dismissed-with-reason':
      return (
        hasOnlyKeys(value, ['previousState', 'nextState', 'justification']) &&
        (value.previousState === 'open' || value.previousState === 'acknowledged') &&
        nonEmptyString(value.justification)
      );
    default:
      return false;
  }
}

export function inspectAuditWorkspaceResolutionRequestV1(
  request: AuditWorkspaceResolutionRequestV1,
): AuditWorkspaceResolutionReadinessV1 {
  const value = request as unknown as Record<string, unknown>;
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      'contractVersion',
      'academicYearId',
      'occurrenceId',
      'expectedVersion',
      'transition',
    ]) ||
    value.contractVersion !== AUDIT_WORKSPACE_CONTRACT_VERSION_V1 ||
    !nonEmptyString(value.academicYearId) ||
    !nonEmptyString(value.occurrenceId) ||
    !positiveInteger(value.expectedVersion)
  ) {
    return 'invalid-request';
  }
  return validResolutionTransition(value.transition) ? 'ready' : 'invalid-transition';
}

function compareCodeUnitsAscending(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCodeUnitsDescending(left: string, right: string): number {
  return compareCodeUnitsAscending(right, left); // NOSONAR swapped on purpose: descending
}

function collectionForItem(item: AuditWorkspaceListItemV1): AuditWorkspaceCollectionV1 {
  switch (item.kind) {
    case 'import-batch':
      return 'import-batches';
    case 'audit-occurrence':
      return 'audit-occurrences';
    case 'reconciliation':
      return 'reconciliations';
  }
}

export function compareAuditWorkspaceListItemsV1(
  left: AuditWorkspaceListItemV1,
  right: AuditWorkspaceListItemV1,
): number {
  if (left.kind !== right.kind) {
    return (
      AUDIT_WORKSPACE_COLLECTIONS_V1.indexOf(collectionForItem(left)) -
      AUDIT_WORKSPACE_COLLECTIONS_V1.indexOf(collectionForItem(right))
    );
  }

  switch (left.kind) {
    case 'import-batch': {
      const other = right as AuditWorkspaceImportBatchListItemV1;
      return (
        compareCodeUnitsDescending(left.updatedAt, other.updatedAt) ||
        compareCodeUnitsAscending(left.reference.id, other.reference.id)
      );
    }
    case 'audit-occurrence': {
      const other = right as AuditWorkspaceOccurrenceListItemV1;
      return (
        compareCodeUnitsDescending(left.createdAt, other.createdAt) ||
        compareCodeUnitsAscending(left.reference.id, other.reference.id)
      );
    }
    case 'reconciliation': {
      const other = right as AuditWorkspaceReconciliationListItemV1;
      return (
        compareCodeUnitsDescending(left.recordedAt, other.recordedAt) ||
        compareCodeUnitsAscending(left.reference.id, other.reference.id)
      );
    }
  }
}

export function isAuditWorkspaceListItemOrderV1(items: readonly AuditWorkspaceListItemV1[]): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous === undefined || current === undefined) return false;
    if (compareAuditWorkspaceListItemsV1(previous, current) > 0) return false;
  }
  return true;
}

export function isAuditWorkspaceItemsPageValidV1(page: AuditWorkspaceItemsPageV1): boolean {
  if (
    page.contractVersion !== AUDIT_WORKSPACE_CONTRACT_VERSION_V1 ||
    page.outcome !== 'items' ||
    page.academicYearId.trim().length === 0 ||
    !isAuditWorkspaceLimitV1(page.limit) ||
    page.items.length === 0 ||
    page.items.length > page.limit ||
    (page.nextCursor !== null && page.nextCursor.trim().length === 0) ||
    page.order !== expectedOrder(page.collection) ||
    !isAuditWorkspaceListItemOrderV1(page.items)
  ) {
    return false;
  }
  return page.items.every((item) => {
    if (page.collection === 'import-batches') return item.kind === 'import-batch';
    if (page.collection === 'audit-occurrences') return item.kind === 'audit-occurrence';
    return item.kind === 'reconciliation';
  });
}

export function isAuditWorkspaceDetailConsistentV1(detail: AuditWorkspaceDetailV1): boolean {
  if (!positiveInteger(detail.version) || !nonEmptyString(detail.recordedAt)) return false;
  switch (detail.kind) {
    case 'import-batch':
    case 'audit-occurrence':
    case 'reconciliation':
      return detail.reference.id === detail.record.id;
  }
}
