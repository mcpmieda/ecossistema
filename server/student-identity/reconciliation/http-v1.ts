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
const STATUS_BY_STATE_V1: Readonly<Record<string, number>> = {
  ready: 200,
  committed: 200,
  'validation-failed': 200,
  'invalid-request': 400,
  'not-authorized': 403,
  unavailable: 503,
};
function responseV1(value: ReconciliationResponseV1, status?: number): Response {
  return Response.json(reconciliationResponseV1.parse(value), {
    status: status ?? STATUS_BY_STATE_V1[value.state] ?? 409,
    headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Expires: '0' },
  });
}
function coreAvailableV1(env: RuntimeEnv): boolean {
  const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
  return (
    env.GRADEBOOK_STORAGE_PROVIDER === 'postgres' &&
    ['production', 'local', 'preview'].includes(environment) &&
    (environment !== 'production' || env.GRADEBOOK_PRODUCTION_ENABLED === 'true') &&
    Boolean(env.GRADEBOOK_DATABASE)
  );
}
export type StagedCredentialsV1 =
  | { state: 'ready' | 'preparing'; remaining: number }
  | { state: 'conflict' | 'expired' | 'unavailable' };
/**
 * Prepares up to four Portal credentials of a batch in the private Portal capability (the KDF runs
 * there, outside any database transaction). The ADM's import and the Coletor's automatic report call
 * the same step; the final apply revalidates every CAS in one transaction.
 */
export async function stageReconciliationCredentialsV1(
  env: RuntimeEnv,
  context: TrustedAdminContextV1,
  input: { batchId: string; generation: string; expectedRevision: number },
): Promise<StagedCredentialsV1> {
  const binding = env.PORTAL_SERVICE as CredentialBindingV1 | undefined;
  if (typeof binding?.prepareReconciliationCredentials !== 'function') return { state: 'unavailable' };
  const staged = stageResultV1.safeParse(
    await binding.prepareReconciliationCredentials(context, {
      contractVersion: 1,
      batchId: input.batchId,
      generation: input.generation,
      expectedScopeRevision: input.expectedRevision,
    }),
  );
  if (!staged.success) return { state: 'unavailable' };
  if (staged.data.state === 'expired' || staged.data.state === 'conflict')
    return { state: staged.data.state };
  return { state: staged.data.state, remaining: staged.data.remainingCount ?? 0 };
}
async function stageCredentialsV1(
  env: RuntimeEnv,
  context: TrustedAdminContextV1,
  input: { batchId: string; generation: string; expectedRevision: number },
): Promise<Response> {
  const staged = await stageReconciliationCredentialsV1(env, context, input);
  if (!('remaining' in staged)) return responseV1({ contractVersion: 1, state: staged.state });
  return responseV1({
    contractVersion: 1,
    state: 'ready',
    operation: 'stage',
    ready: staged.state === 'ready',
    remaining: staged.remaining,
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
    const write = !['catalog', 'pending-count', 'automatic-report', 'list', 'detail'].includes(input.operation);
    const context = write
      ? await verifiedPagesContextV1(request, env, true, readContext.requestId)
      : readContext;
    if (typeof context === 'string')
      return responseV1({ contractVersion: 1, state: 'not-authorized' });
    if (!coreAvailableV1(env)) return responseV1({ contractVersion: 1, state: 'unavailable' });
    const result = await new StudentReconciliationServiceV1(
      env.GRADEBOOK_DATABASE as GradebookPostgresDatabaseV1,
      context.actorId,
      env.SESSION_SECRET,
    ).execute(input);
    if (input.operation !== 'stage' || result.state !== 'ready') return responseV1(result);
    return await stageCredentialsV1(env, context, input);
  } catch (error) {
    // Database diagnostics can contain supplied cells. The transport never logs error messages/payloads.
    return responseV1(
      { contractVersion: 1, state: error instanceof HttpError ? 'invalid-request' : 'unavailable' },
      error instanceof HttpError ? error.status : 503,
    );
  }
}
