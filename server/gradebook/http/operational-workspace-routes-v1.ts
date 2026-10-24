import {
  OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
  type OperationalWorkspaceNotAuthorizedV1,
  type OperationalWorkspaceUnavailableV1,
} from '../../../shared/gradebook-contracts/operational-workspace/operational-workspace-contract-v1';
import {
  isOperationalWorkspaceTransportRequestV1,
} from '../../../shared/gradebook-contracts/operational-workspace/operational-workspace-transport-v1';
import { isOperationalWorkspaceRequestV2 } from '../../../shared/gradebook-contracts/operational-workspace/operational-workspace-transport-v2';
import { AuthenticationError, requireAuth } from '../../auth/session';
import { AuthorizationError } from '../../auth/roles';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../../http/security';
import { createRelationalWorkspaceV2 } from '../application/operational-workspace/relational-workspace-v2';
import { authorizeGradebookRuntimeV1 } from '../authorization-v1';
import type { GradebookPostgresWritePortV1 } from '../persistence/postgres/postgres-database-v1';

function httpStatusOf(state: string) {
  if (state === 'not-found') return 404;
  return state === 'invalid-request' ? 400 : 200;
}

export const GRADEBOOK_OPERATIONAL_WORKSPACE_ROUTE_V1 = '/api/gradebook/operational-workspace';

function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Expires: '0',
      Pragma: 'no-cache',
    },
  });
}
function unavailable(status = 503): Response {
  const response: OperationalWorkspaceUnavailableV1 = {contractVersion:OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,state:'unavailable'};
  return noStoreJson(response, status);
}
function notAuthorized(status: 401 | 403): Response {
  const response: OperationalWorkspaceNotAuthorizedV1 = {contractVersion:OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,state:'not-authorized'};
  return noStoreJson(response, status);
}
export async function handleOperationalWorkspaceRequestV1(request: Request, env: RuntimeEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== GRADEBOOK_OPERATIONAL_WORKSPACE_ROUTE_V1) return null;
  enforceOfficialOrigin(request, env);
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  enforceWriteOrigin(request, env);

  try {
    const session = await requireAuth(request, env);
    authorizeGradebookRuntimeV1(session);
  } catch (cause) {
    if (cause instanceof AuthenticationError) return notAuthorized(401);
    if (cause instanceof AuthorizationError) return notAuthorized(403);
    return unavailable(500);
  }
  let payload: unknown;
  try { payload = await readBoundedJson(request, 16_384); }
  catch (cause) { return unavailable(cause instanceof HttpError ? cause.status : 400); }

  // V2 never instantiates the legacy entity/version runtime. Same authorization and origin boundary.
  if (payload !== null && typeof payload === 'object' && 'contractVersion' in payload && payload.contractVersion === 2) {
    if (!isOperationalWorkspaceRequestV2(payload)) return noStoreJson({contractVersion:2,state:'invalid-request'},400);
    const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
    if (env.GRADEBOOK_STORAGE_PROVIDER !== 'postgres' ||
        !['production','local','preview'].includes(environment) ||
        (environment === 'production' && env.GRADEBOOK_PRODUCTION_ENABLED !== 'true') ||
        !env.GRADEBOOK_DATABASE) return noStoreJson({contractVersion:2,state:'unavailable'},503);
    try {
      const response = await createRelationalWorkspaceV2(env.GRADEBOOK_DATABASE as GradebookPostgresWritePortV1).execute(payload);
      return noStoreJson(response, httpStatusOf(response.state));
    } catch { return noStoreJson({contractVersion:2,state:'unavailable'},503); }
  }

  // The simplified relational model is sourced by the annual imports. The former
  // maintenanceVersion write transport targeted entities/versions that do not
  // exist in that model and is deliberately rejected before the legacy runtime.
  if (!isOperationalWorkspaceTransportRequestV1(payload)) return unavailable(400);

  return unavailable(410);
}
