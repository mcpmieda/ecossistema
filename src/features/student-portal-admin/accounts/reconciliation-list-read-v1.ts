import type {
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../../../shared/student-identity/reconciliation-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { ReconciliationClientV1 } from '../shared/reconciliation-client-v1';

/** Keep the server's situation and opaque cursor; skip pages with no pending records. */
export async function readReconciliationListV1(
  client: ReconciliationClientV1,
  request: Extract<ReconciliationRequestV1, { operation: 'list' }>,
  signal: AbortSignal,
  pendingOnly: boolean,
): Promise<ReconciliationResponseV1> {
  let cursor = request.cursor;
  const visited = new Set<string | null>();
  while (true) {
    signal.throwIfAborted();
    if (visited.has(cursor)) throw new PortalClientErrorV1('invalid-response');
    visited.add(cursor);
    const response = await client.request({ ...request, cursor }, signal);
    signal.throwIfAborted();
    if (!pendingOnly || response.state !== 'ready' || response.operation !== 'list')
      return response;
    const items = response.items.filter(
      (item) => item.kind === 'external' || item.reconciliation !== 'reconciled',
    );
    if (items.length > 0 || response.nextCursor === null) return { ...response, items };
    cursor = response.nextCursor;
  }
}
