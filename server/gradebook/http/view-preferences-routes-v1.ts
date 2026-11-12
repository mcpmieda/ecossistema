import type { ViewPreferencesResponseV1 } from '../../../shared/gradebook-contracts/settings/view-preferences-v1';
import { AuthenticationError, requireAuth } from '../../auth/session';
import { AuthorizationError } from '../../auth/roles';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../../http/security';
import { createViewPreferencesServiceV1 } from '../application/settings/view-preferences-v1';
import { authorizeGradebookRuntimeV1 } from '../authorization-v1';
import type { GradebookPostgresWritePortV1 } from '../persistence/postgres/postgres-database-v1';

export const VIEW_PREFERENCES_ROUTE_V1 = '/api/gradebook/view-preferences';

function response(value: ViewPreferencesResponseV1, status: number): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Expires: '0',
      Pragma: 'no-cache',
    },
  });
}

const failure = (state: Exclude<ViewPreferencesResponseV1['state'], 'ready'>, status: number) =>
  response({ contractVersion: 1, state }, status);

function statusFor(value: ViewPreferencesResponseV1): number {
  if (value.state === 'ready') return 200;
  if (value.state === 'invalid-request') return 400;
  if (value.state === 'not-authorized') return 403;
  return 503;
}

/** GET reads the signed-in account's last views; PUT merges the views that changed. */
export async function handleViewPreferencesRequestV1(
  request: Request,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== VIEW_PREFERENCES_ROUTE_V1) return null;
  enforceOfficialOrigin(request, env);
  if (request.method !== 'GET' && request.method !== 'PUT')
    throw new HttpError(405, 'Method not allowed');
  if (request.method === 'PUT') enforceWriteOrigin(request, env);

  let actorId: string;
  try {
    const session = await requireAuth(request, env);
    authorizeGradebookRuntimeV1(session);
    actorId = session.oid;
  } catch (cause) {
    if (cause instanceof AuthenticationError) return failure('not-authorized', 401);
    if (cause instanceof AuthorizationError) return failure('not-authorized', 403);
    return failure('unavailable', 503);
  }

  const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
  if (
    env.GRADEBOOK_STORAGE_PROVIDER !== 'postgres' ||
    !['production', 'local', 'preview'].includes(environment) ||
    (environment === 'production' && env.GRADEBOOK_PRODUCTION_ENABLED !== 'true') ||
    !env.GRADEBOOK_DATABASE
  )
    return failure('unavailable', 503);

  const service = createViewPreferencesServiceV1(env.GRADEBOOK_DATABASE as GradebookPostgresWritePortV1);
  if (request.method === 'GET') {
    const value = await service.read(actorId);
    return response(value, statusFor(value));
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(request, 65_536);
  } catch (cause) {
    return failure('invalid-request', cause instanceof HttpError ? cause.status : 400);
  }
  const value = await service.save(actorId, payload);
  return response(value, statusFor(value));
}
