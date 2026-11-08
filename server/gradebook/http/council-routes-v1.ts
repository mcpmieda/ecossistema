import type { GradebookAfterCommitV1 } from './live-after-commit-v1';
import { AuthenticationError, requireAuth } from '../../auth/session';
import { AuthorizationError } from '../../auth/roles';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../../http/security';
import { authorizeGradebookRuntimeV1 } from '../authorization-v1';
import { retiredGradebookRequestV1 } from './retired-request-v1';
import { relationalCouncilRequestSchemaV3, type RelationalCouncilResponseV3 } from '../../../shared/gradebook-contracts/council/relational-council-v3';
import { createRelationalCouncilV3 } from '../application/council/relational-council-v3';
import type { GradebookPostgresWritePortV1 } from '../persistence/postgres/postgres-database-v1';

export const GRADEBOOK_COUNCIL_WORKSPACE_ROUTE_V1 = '/api/gradebook/council-workspace';

function noStoreResponse(body: BodyInit | null, status: number, contentType?: string): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Expires: '0',
    Pragma: 'no-cache',
  });
  if (contentType) headers.set('Content-Type', contentType);
  return new Response(body, { status, headers });
}

function noStoreJson(value: unknown, status = 200): Response {
  return noStoreResponse(JSON.stringify(value), status, 'application/json; charset=utf-8');
}

function accessDenied(status: 401 | 403): Response {
  return noStoreResponse(null, status);
}

function unavailable(status = 503): Response {
  return noStoreResponse(null, status);
}

type CouncilSessionV1 = Awaited<ReturnType<typeof requireAuth>>;

/** The signed-in reader allowed in the Banco de Notas, or the refusal to send back. */
async function councilSessionV1(request: Request, env: RuntimeEnv): Promise<CouncilSessionV1 | Response> {
  try {
    const session = await requireAuth(request, env);
    authorizeGradebookRuntimeV1(session);
    return session;
  } catch (cause) {
    if (cause instanceof AuthenticationError) return accessDenied(401);
    if (cause instanceof AuthorizationError) return accessDenied(403);
    return unavailable(500);
  }
}

/** The HTTP status of a V3 answer: ready, not found, invalid, unprocessable, unavailable or conflict. */
function councilStatusV3(state: RelationalCouncilResponseV3['state']): 200 | 404 | 400 | 422 | 503 | 409 {
  if (state === 'ready') return 200;
  if (state === 'not-found') return 404;
  if (state === 'invalid-request') return 400;
  if (state === 'scope-too-large' || state === 'closure-blocked' || state === 'student-not-eligible') return 422;
  return state === 'unavailable' ? 503 : 409;
}

/** The relational Conselho (V3): only on PostgreSQL, and in production only once enabled. */
async function serveRelationalCouncilV3(
  payload: unknown,
  env: RuntimeEnv,
  session: CouncilSessionV1,
  afterCommit: GradebookAfterCommitV1 | undefined,
): Promise<Response> {
  const parsed = relationalCouncilRequestSchemaV3.safeParse(payload);
  if (!parsed.success) return noStoreJson({ contractVersion: 3, state: 'invalid-request' }, 400);
  const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
  if (env.GRADEBOOK_STORAGE_PROVIDER !== 'postgres' ||
      !['production', 'local', 'preview'].includes(environment) ||
      (environment === 'production' && env.GRADEBOOK_PRODUCTION_ENABLED !== 'true') ||
      !env.GRADEBOOK_DATABASE) {
    return noStoreJson({ contractVersion: 3, state: 'unavailable' }, 503);
  }
  try {
    const response = await createRelationalCouncilV3(
      env.GRADEBOOK_DATABASE as GradebookPostgresWritePortV1,
      session.oid,
    ).execute(parsed.data);
    if (response.state === 'ready' && ['open', 'decision', 'vote', 'close', 'reopen'].includes(response.operation))
      afterCommit?.(session);
    return noStoreJson(response, councilStatusV3(response.state));
  } catch {
    return noStoreJson({ contractVersion: 3, state: 'unavailable' }, 503);
  }
}

export function createCouncilWorkspaceRequestHandlerV1(): (request: Request, env: RuntimeEnv, afterCommit?: GradebookAfterCommitV1) => Promise<Response | null> {
  return async (request, env, afterCommit) => {
    if (new URL(request.url).pathname !== GRADEBOOK_COUNCIL_WORKSPACE_ROUTE_V1) return null;

    enforceOfficialOrigin(request, env);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    enforceWriteOrigin(request, env);

    const session = await councilSessionV1(request, env);
    if (session instanceof Response) return session;

    let payload: unknown;
    try {
      payload = await readBoundedJson(request, 16_384);
    } catch (cause) {
      return unavailable(cause instanceof HttpError ? cause.status : 400);
    }

    if (payload !== null && typeof payload === 'object' && 'contractVersion' in payload && payload.contractVersion === 3)
      return serveRelationalCouncilV3(payload, env, session, afterCommit);
    return retiredGradebookRequestV1(payload);
  };
}

export const handleCouncilWorkspaceRequestV1 = createCouncilWorkspaceRequestHandlerV1();
