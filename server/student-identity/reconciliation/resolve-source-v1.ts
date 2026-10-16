import type {
  ReconciliationSourceEvidenceV1,
  ReconciliationSourceResolutionV1,
} from '../../../shared/student-identity/reconciliation-v1';
import type { TxV1 } from './storage-v1';
import { resolveReconciledSourcesV2 } from './resolve-source-batch-v2';

/** Single-row compatibility entry point; central evidence rules live in the batched resolver. */
export async function resolveReconciledSourceV1(
  tx: TxV1,
  input: ReconciliationSourceEvidenceV1,
): Promise<ReconciliationSourceResolutionV1> {
  return (await resolveReconciledSourcesV2(tx, [input]))[0]!;
}
