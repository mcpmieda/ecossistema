import { z } from 'zod';
import {
  reconciliationRequestV1,
  reconciliationResponseV1,
  RECONCILIATION_ROUTE_V1,
  REPORT_BODY_BYTES_V1,
  type ReconciliationResponseV1,
} from '../../../shared/student-identity/reconciliation-v1';
import type { TrustedAdminContextV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../../http/security';
import { verifiedPagesContextV1 } from '../../student-portal/admin-client/pages-context-v1';
import type { GradebookPostgresDatabaseV1 } from '../../gradebook/persistence/postgres/postgres-database-v1';
import { StudentReconciliationServiceV1 } from './service-v1';

interface CredentialBindingV1 {
  prepareReconciliationCredentials(
    context: TrustedAdminContextV1,
    input: unknown,
  ): Promise<unknown>;
}
const stageResultV1 = z
  .object({
    state: z.enum(['ready', 'preparing', 'conflict', 'expired']),
    remainingCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();
function responseV1(value: ReconciliationResponseV1, status?: number): Response {
  return Response.json(reconciliationResponseV1.parse(value), {
    status:
      status ??
      (['ready', 'committed', 'validation-failed'].includes(value.state)
        ? 200
        : value.state === 'invalid-request'
          ? 400
          : value.state === 'not-authorized'
            ? 403
            : value.state === 'unavailable'
              ? 503
              : 409),
    headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Expires: '0' },
  });
}
/** The browser can submit allowlisted observations, never prepared verifiers or a trusted actor. */
export async function handleStudentReconciliationRequestV1(
  request: Request,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== RECONCILIATION_ROUTE_V1) return null;
  enforceOfficialOrigin(request, env);
  if (request.method !== 'POST')
    return responseV1({ contractVersion: 1, state: 'invalid-request' }, 405);
  enforceWriteOrigin(request, env);
  try {
    // Authenticate before consuming a potentially large report. Reads use the same ADM audience.
    const readContext = await verifiedPagesContextV1(request, env, false, crypto.randomUUID());
    if (typeof readContext === 'string')
      return responseV1(
        { contractVersion: 1, state: 'not-authorized' },
        readContext === 'unauthenticated' ? 401 : 403,
      );
    const parsed = reconciliationRequestV1.safeParse(
      await readBoundedJson(request, REPORT_BODY_BYTES_V1),
    );
    if (!parsed.success) return responseV1({ contractVersion: 1, state: 'invalid-request' });
    const input = parsed.data;
    const write = !['catalog', 'list', 'detail'].includes(input.operation);
    const context = write
      ? await verifiedPagesContextV1(request, env, true, readContext.requestId)
      : readContext;
    if (typeof context === 'string')
      return responseV1({ contractVersion: 1, state: 'not-authorized' });
    const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
    if (
      env.GRADEBOOK_STORAGE_PROVIDER !== 'postgres' ||
      !['production', 'local', 'preview'].includes(environment) ||
      (environment === 'production' && env.GRADEBOOK_PRODUCTION_ENABLED !== 'true') ||
      !env.GRADEBOOK_DATABASE
    )
      return responseV1({ contractVersion: 1, state: 'unavailable' });
    const result = await new StudentReconciliationServiceV1(
      env.GRADEBOOK_DATABASE as GradebookPostgresDatabaseV1,
      context.actorId,
      env.SESSION_SECRET,
    ).execute(input);
    if (input.operation !== 'stage' || result.state !== 'ready') return responseV1(result);
    // KDF work happens after the core transaction ends. Final apply revalidates every CAS in one transaction.
    const binding = env.PORTAL_SERVICE as CredentialBindingV1 | undefined;
    if (!binding || typeof binding.prepareReconciliationCredentials !== 'function')
      return responseV1({ contractVersion: 1, state: 'unavailable' });
    const staged = stageResultV1.safeParse(
      await binding.prepareReconciliationCredentials(context, {
        contractVersion: 1,
        batchId: input.batchId,
        generation: input.generation,
        expectedScopeRevision: input.expectedRevision,
      }),
    );
    if (!staged.success) return responseV1({ contractVersion: 1, state: 'unavailable' });
    if (staged.data.state === 'expired' || staged.data.state === 'conflict')
      return responseV1({ contractVersion: 1, state: staged.data.state });
    return responseV1({
      contractVersion: 1,
      state: 'ready',
      operation: 'stage',
      ready: staged.data.state === 'ready',
      remaining: staged.data.remainingCount ?? 0,
    });
  } catch (error) {
    // Database diagnostics can contain supplied cells. The transport never logs error messages/payloads.
    return responseV1(
      { contractVersion: 1, state: error instanceof HttpError ? 'invalid-request' : 'unavailable' },
      error instanceof HttpError ? error.status : 503,
    );
  }
}
