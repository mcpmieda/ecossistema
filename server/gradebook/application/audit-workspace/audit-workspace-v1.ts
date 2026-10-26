import {
  AUDIT_WORKSPACE_AUTHORIZATION_POLICY_V1,
  AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
  inspectAuditWorkspaceDetailRequestV1,
  inspectAuditWorkspaceListRequestV1,
  inspectAuditWorkspaceResolutionRequestV1,
  type AuditWorkspaceDetailRequestV1,
  type AuditWorkspaceDetailResponseV1,
  type AuditWorkspaceListRequestV1,
  type AuditWorkspaceListResponseV1,
  type AuditWorkspacePromotionEligibilityV1,
  type AuditWorkspaceResolutionRequestV1,
  type AuditWorkspaceResolutionResponseV1,
} from '../../../../shared/gradebook-contracts/audit-workspace/audit-workspace-contract-v1';
import type {
  AuditOccurrenceStateTransitionV1,
  AuditOccurrenceV1,
} from '../../../../shared/gradebook-contracts/audit/audit-contract-v1';
import type { ImportBatchId } from '../../../../shared/gradebook-contracts/imports/import-ids-v1';
import type {
  AuditPersistenceRepositoryV1,
  ImportPersistenceRepositoryV1,
} from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';
import type { ImportChangePlanV1 } from '../import/import-reconciliation-v1';
import {
  AuditWorkspaceSourceErrorV1,
  type AuditWorkspaceSourceV1,
} from './audit-workspace-source-v1';

export interface AuditWorkspaceServerContextV1 {
  /** Server authorization result; requests never carry roles or capabilities. */
  isAuthorized(): boolean;
  /** Effective identity and time used only for a validated resolution. */
  resolutionIdentity(): { readonly actorId: string; readonly occurredAt: string };
}

export interface ExistingImportChangePlanSourceV1 {
  getExistingImportChangePlan(
    academicYearId: AuditWorkspaceDetailRequestV1['academicYearId'],
    importBatchId: ImportBatchId,
  ): Promise<ImportChangePlanV1 | null>;
}

export interface AuditWorkspaceDependenciesV1 {
  readonly source: AuditWorkspaceSourceV1;
  readonly imports: Pick<ImportPersistenceRepositoryV1, 'getImportBatch'>;
  readonly audit: Pick<AuditPersistenceRepositoryV1, 'getCurrent' | 'appendVersion'>;
  readonly server: AuditWorkspaceServerContextV1;
  readonly existingPlans?: ExistingImportChangePlanSourceV1;
}

export interface AuditWorkspaceV1 {
  readonly authorizationPolicy: typeof AUDIT_WORKSPACE_AUTHORIZATION_POLICY_V1;
  list(request: AuditWorkspaceListRequestV1): Promise<AuditWorkspaceListResponseV1>;
  detail(request: AuditWorkspaceDetailRequestV1): Promise<AuditWorkspaceDetailResponseV1>;
  resolve(request: AuditWorkspaceResolutionRequestV1): Promise<AuditWorkspaceResolutionResponseV1>;
}

function listNonDisclosure(
  outcome: Exclude<AuditWorkspaceListResponseV1, { readonly outcome: 'items' }>['outcome'],
): AuditWorkspaceListResponseV1 {
  return {
    contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
    outcome,
    items: [],
    nextCursor: null,
  };
}

function detailNonDisclosure(
  outcome: Exclude<AuditWorkspaceDetailResponseV1, { readonly outcome: 'detail' }>['outcome'],
): AuditWorkspaceDetailResponseV1 {
  return { contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1, outcome, detail: null };
}

function resolutionNonDisclosure(
  outcome:
    'invalid-transition' | 'not-found' | 'invalid-request' | 'not-authorized' | 'unavailable',
): AuditWorkspaceResolutionResponseV1 {
  return {
    contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
    outcome,
    currentVersion: null,
  };
}

function mapListFailure(error: unknown): AuditWorkspaceListResponseV1 {
  if (error instanceof AuditWorkspaceSourceErrorV1) return listNonDisclosure(error.code);
  return listNonDisclosure('unavailable');
}

function promotionEligibility(eligible: boolean | null): AuditWorkspacePromotionEligibilityV1 {
  return { source: 'existing-import-change-plan', eligible, informationalOnly: true };
}

function transitionWithServerIdentity(
  request: AuditWorkspaceResolutionRequestV1,
  identity: ReturnType<AuditWorkspaceServerContextV1['resolutionIdentity']>,
): AuditOccurrenceStateTransitionV1 {
  return { ...request.transition, actorId: identity.actorId, occurredAt: identity.occurredAt };
}

function occurrenceAfterTransition(
  current: AuditOccurrenceV1,
  transition: AuditOccurrenceStateTransitionV1,
): AuditOccurrenceV1 {
  const history = [...current.stateHistory, transition];
  switch (transition.nextState) {
    case 'acknowledged':
      return {
        ...current,
        state: 'acknowledged',
        stateHistory: history as [...AuditOccurrenceStateTransitionV1[], typeof transition],
      };
    case 'resolved':
      return {
        ...current,
        state: 'resolved',
        stateHistory: history as [...AuditOccurrenceStateTransitionV1[], typeof transition],
      };
    case 'dismissed-with-reason':
      return {
        ...current,
        state: 'dismissed-with-reason',
        stateHistory: history as [...AuditOccurrenceStateTransitionV1[], typeof transition],
      };
  }
}

export function createAuditWorkspaceV1(
  dependencies: AuditWorkspaceDependenciesV1,
): AuditWorkspaceV1 {
  /** An import batch: its files under review, its open audit items and, when a plan exists for it,
   * whether any file can be promoted. */
  async function importBatchDetail(
    academicYearId: AuditWorkspaceDetailRequestV1['academicYearId'],
    reference: Extract<AuditWorkspaceDetailRequestV1['reference'], { kind: 'import-batch' }>,
    context: { academicYearId: AuditWorkspaceDetailRequestV1['academicYearId'] },
  ): Promise<AuditWorkspaceDetailResponseV1> {
    const batch = await dependencies.imports.getImportBatch(context, reference.id);
    if (batch === null) return detailNonDisclosure('not-found');
    const occurrenceIds = await dependencies.source.listPendingOccurrenceIdsForImportBatch(
      context,
      reference.id,
    );
    const filePending = batch.value.files
      .filter((file) => file.status === 'review-required')
      .map((file) => ({
        kind: 'import-file-review' as const,
        importBatchId: batch.value.id,
        importFileId: file.id,
      }));
    const auditPending = occurrenceIds.map((id) => ({
      kind: 'audit-occurrence' as const,
      id,
    }));

    let eligible: boolean | null = null;
    if (dependencies.existingPlans !== undefined) {
      const plan = await dependencies.existingPlans.getExistingImportChangePlan(
        academicYearId,
        reference.id,
      );
      if (plan !== null) {
        if (plan.academicYearId !== academicYearId || plan.importBatchId !== reference.id) {
          return detailNonDisclosure('insufficient-data');
        }
        eligible = plan.promotionRequest.approvedImportFileIds.length > 0;
      }
    }

    return {
      contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
      outcome: 'detail',
      academicYearId: academicYearId,
      detail: {
        kind: 'import-batch',
        reference: reference,
        record: batch.value,
        version: batch.version,
        recordedAt: batch.recordedAt,
        pendingItems: [...filePending, ...auditPending],
        promotionEligibility: promotionEligibility(eligible),
      },
    };
  }

  return {
    authorizationPolicy: AUDIT_WORKSPACE_AUTHORIZATION_POLICY_V1,

    async list(request) {
      const readiness = inspectAuditWorkspaceListRequestV1(request);
      if (readiness !== 'ready') return listNonDisclosure(readiness);
      if (!dependencies.server.isAuthorized()) return listNonDisclosure('not-authorized');

      try {
        const page = await dependencies.source.list(request);
        if (page.collection !== request.collection) return listNonDisclosure('insufficient-data');
        if (page.items.length === 0) return listNonDisclosure('no-results');

        return {
          contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
          outcome: 'items',
          academicYearId: request.academicYearId,
          collection: request.collection,
          order: request.order,
          limit: request.page.limit,
          items: page.items,
          nextCursor: page.nextCursor,
        } as AuditWorkspaceListResponseV1;
      } catch (error) {
        return mapListFailure(error);
      }
    },

    async detail(request) {
      if (inspectAuditWorkspaceDetailRequestV1(request) !== 'ready') {
        return detailNonDisclosure('invalid-request');
      }
      if (!dependencies.server.isAuthorized()) return detailNonDisclosure('not-authorized');
      const context = { academicYearId: request.academicYearId };

      try {
        switch (request.reference.kind) {
          case 'import-batch':
            return await importBatchDetail(request.academicYearId, request.reference, context);
          case 'audit-occurrence': {
            const result = await dependencies.audit.getCurrent(context, {
              kind: 'occurrence',
              id: request.reference.id,
            });
            if (result?.value.kind !== 'occurrence') {
              return detailNonDisclosure('not-found');
            }
            const pendingItems =
              result.value.value.state === 'open' || result.value.value.state === 'acknowledged'
                ? [{ kind: 'audit-occurrence' as const, id: result.value.value.id }]
                : [];
            return {
              contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
              outcome: 'detail',
              academicYearId: request.academicYearId,
              detail: {
                kind: 'audit-occurrence',
                reference: request.reference,
                record: result.value.value,
                version: result.version,
                recordedAt: result.recordedAt,
                pendingItems,
              },
            };
          }
          case 'reconciliation': {
            const result = await dependencies.audit.getCurrent(context, {
              kind: 'reconciliation',
              id: request.reference.id,
            });
            if (result?.value.kind !== 'reconciliation') {
              return detailNonDisclosure('not-found');
            }
            const pendingItems =
              result.value.value.status === 'mismatch' ||
              result.value.value.status === 'not-comparable'
                ? [{ kind: 'reconciliation' as const, id: result.value.value.id }]
                : [];
            return {
              contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
              outcome: 'detail',
              academicYearId: request.academicYearId,
              detail: {
                kind: 'reconciliation',
                reference: request.reference,
                record: result.value.value,
                version: result.version,
                recordedAt: result.recordedAt,
                pendingItems,
              },
            };
          }
        }
      } catch (error) {
        if (error instanceof AuditWorkspaceSourceErrorV1 && error.code === 'insufficient-data') {
          return detailNonDisclosure('insufficient-data');
        }
        return detailNonDisclosure('unavailable');
      }
    },

    async resolve(request) {
      const readiness = inspectAuditWorkspaceResolutionRequestV1(request);
      if (readiness !== 'ready') return resolutionNonDisclosure(readiness);
      if (!dependencies.server.isAuthorized()) return resolutionNonDisclosure('not-authorized');
      const context = { academicYearId: request.academicYearId };

      try {
        const current = await dependencies.audit.getCurrent(context, {
          kind: 'occurrence',
          id: request.occurrenceId,
        });
        if (current?.value.kind !== 'occurrence') {
          return resolutionNonDisclosure('not-found');
        }
        if (current.version !== request.expectedVersion) {
          return {
            contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
            outcome: 'version-conflict',
            currentVersion: current.version,
          };
        }
        if (current.value.value.state !== request.transition.previousState) {
          return resolutionNonDisclosure('invalid-transition');
        }

        const identity = dependencies.server.resolutionIdentity();
        if (identity.actorId.trim().length === 0 || identity.occurredAt.trim().length === 0) {
          return resolutionNonDisclosure('unavailable');
        }
        const transition = transitionWithServerIdentity(request, identity);
        const occurrence = occurrenceAfterTransition(current.value.value, transition);
        const result = await dependencies.audit.appendVersion(
          context,
          { kind: 'occurrence', id: request.occurrenceId },
          { kind: 'occurrence', value: occurrence },
          { expectedVersion: request.expectedVersion },
        );
        if (result.status === 'version-conflict') {
          return {
            contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
            outcome: 'version-conflict',
            currentVersion: result.currentVersion,
          };
        }
        return {
          contractVersion: AUDIT_WORKSPACE_CONTRACT_VERSION_V1,
          outcome: 'applied',
          reference: { kind: 'audit-occurrence', id: request.occurrenceId },
          version: result.record.version,
          state: occurrence.state,
        };
      } catch {
        return resolutionNonDisclosure('unavailable');
      }
    },
  };
}
