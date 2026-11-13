import {
  ONEDRIVE_SYNC_BODY_BYTES_V1,
  ONEDRIVE_SYNC_CONTRACT_VERSION_V1,
  oneDriveSyncRequestSchemaV1,
  oneDriveSyncResponseSchemaV1,
  type OneDriveSyncActorV1,
  type OneDriveSyncResponseV1,
} from '../../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';
import { AuthenticationError, requireAuth } from '../../auth/session';
import { AuthorizationError } from '../../auth/roles';
import type { RuntimeEnv } from '../../env';
import { enforceOfficialOrigin, enforceWriteOrigin, HttpError, readBoundedJson } from '../../http/security';
import { authorizeGradebookRuntimeV1 } from '../authorization-v1';

const ONEDRIVE_SYNC_ROUTE_V1 = '/api/gradebook/onedrive-sync';

/** The Pages → notas-onedrive-sync Worker binding (entrypoint `NotasSyncAdminV1`). */
export type OneDriveSyncServiceBindingV1 = {
  handle(actor: OneDriveSyncActorV1, request: unknown): Promise<unknown>;
};

function response(value: OneDriveSyncResponseV1, status: number): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store, private' } });
}

function failure(state: 'invalid-request' | 'not-authorized' | 'unavailable', status: number): Response {
  return response({ contractVersion: ONEDRIVE_SYNC_CONTRACT_VERSION_V1, state }, status);
}

function statusFor(value: OneDriveSyncResponseV1): number {
  if (value.state === 'invalid-request') return 400;
  if (value.state === 'not-authorized') return 403;
  if (value.state === 'unavailable') return 503;
  return 200;
}

/** Admin panel of the OneDrive sync: admin session here, then the Worker does the work. */
export async function handleOneDriveSyncRequestV1(request: Request, env: RuntimeEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== ONEDRIVE_SYNC_ROUTE_V1) return null;
  enforceOfficialOrigin(request, env);
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  enforceWriteOrigin(request, env);

  let actor: OneDriveSyncActorV1;
  try {
    const session = await requireAuth(request, env);
    authorizeGradebookRuntimeV1(session);
    actor = { id: session.oid, name: session.name || session.username || session.oid };
  } catch (cause) {
    if (cause instanceof AuthenticationError) return failure('not-authorized', 401);
    if (cause instanceof AuthorizationError) return failure('not-authorized', 403);
    return failure('unavailable', 503);
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(request, ONEDRIVE_SYNC_BODY_BYTES_V1);
  } catch (cause) {
    return failure('invalid-request', cause instanceof HttpError ? cause.status : 400);
  }
  const parsed = oneDriveSyncRequestSchemaV1.safeParse(payload);
  if (!parsed.success) return failure('invalid-request', 400);

  const service = env.NOTAS_SYNC_SERVICE as OneDriveSyncServiceBindingV1 | undefined;
  if (!service) return failure('unavailable', 503);
  try {
    const answer = oneDriveSyncResponseSchemaV1.safeParse(await service.handle(actor, parsed.data));
    if (!answer.success) return failure('unavailable', 503);
    return response(answer.data, statusFor(answer.data));
  } catch {
    return failure('unavailable', 503);
  }
}
