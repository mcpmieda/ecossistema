import type {
  AuditWorkspaceCursorV1,
  AuditWorkspaceImportBatchListItemV1,
  AuditWorkspaceListRequestV1,
  AuditWorkspaceOccurrenceListItemV1,
  AuditWorkspaceReconciliationListItemV1,
} from '../../../../shared/gradebook-contracts/audit-workspace/audit-workspace-contract-v1';
import type { AuditOccurrenceId } from '../../../../shared/gradebook-contracts/audit/audit-contract-v1';
import type { ImportBatchId } from '../../../../shared/gradebook-contracts/imports/import-ids-v1';
import type { AcademicPersistenceContextV1 } from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';

type AuditWorkspaceSourceFailureV1 = 'invalid-cursor' | 'unavailable' | 'insufficient-data';

export class AuditWorkspaceSourceErrorV1 extends Error {
  override readonly name = 'AuditWorkspaceSourceErrorV1';

  constructor(readonly code: AuditWorkspaceSourceFailureV1) {
    super(code);
  }
}

export type AuditWorkspaceSourcePageV1 =
  | {
      readonly collection: 'import-batches';
      readonly items: readonly AuditWorkspaceImportBatchListItemV1[];
      readonly nextCursor: AuditWorkspaceCursorV1 | null;
    }
  | {
      readonly collection: 'audit-occurrences';
      readonly items: readonly AuditWorkspaceOccurrenceListItemV1[];
      readonly nextCursor: AuditWorkspaceCursorV1 | null;
    }
  | {
      readonly collection: 'reconciliations';
      readonly items: readonly AuditWorkspaceReconciliationListItemV1[];
      readonly nextCursor: AuditWorkspaceCursorV1 | null;
    };

/**
 * Workspace-specific CQRS read boundary. Physical cursor and provider details stay behind this port.
 */
export interface AuditWorkspaceSourceV1 {
  list(request: AuditWorkspaceListRequestV1): Promise<AuditWorkspaceSourcePageV1>;

  listPendingOccurrenceIdsForImportBatch(
    context: AcademicPersistenceContextV1,
    importBatchId: ImportBatchId,
  ): Promise<readonly AuditOccurrenceId[]>;
}
