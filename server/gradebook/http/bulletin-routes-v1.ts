import type { GradebookAfterCommitV1 } from './live-after-commit-v1';
import {
  BULLETIN_CONTRACT_VERSION_V1,
} from '../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';
import {
  inspectBulletinWorkspaceTransportRequestV1,
  type BulletinWorkspaceTransportRequestV1,
  type BulletinWorkspaceTransportResponseV1,
} from '../../../shared/gradebook-contracts/bulletins/bulletin-transport-v1';
import {
  RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
  relationalBulletinRequestSchemaV2,
  type RelationalBulletinRequestV2,
  type RelationalBulletinResponseV2,
} from '../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import { AuthenticationError, requireAuth } from '../../auth/session';
import { AuthorizationError } from '../../auth/roles';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../../http/security';
import { createRelationalBulletinServiceV2 } from '../application/bulletins/relational-bulletin-v2';
import { authorizeGradebookRuntimeV1 } from '../authorization-v1';
import type { GradebookPostgresWritePortV1 } from '../persistence/postgres/postgres-database-v1';
import { createRelationalBulletinSnapshotRepositoryV2 } from '../persistence/postgres/relational-bulletin-snapshot-v2';

export const GRADEBOOK_BULLETIN_ROUTE_V1 = '/api/gradebook/bulletins';

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

function relationalFailure(
  request: RelationalBulletinRequestV2 | null,
  state: Extract<RelationalBulletinResponseV2, { readonly state: string }>['state'],
  status: number,
): Response {
  return noStoreJson(
    {
      contractVersion: RELATIONAL_BULLETIN_CONTRACT_VERSION_V2,
      operation: request?.operation ?? 'catalog',
      state,
    },
    status,
  );
}

function relationalStatus(response: RelationalBulletinResponseV2): number {
  if (response.state === 'invalid-request') return 400;
  if (response.state === 'not-authorized') return 403;
  if (response.state === 'not-found') return 404;
  if (response.state === 'scope-too-large') return 413;
  if (response.state === 'version-conflict') return 409;
  if (response.state === 'unavailable') return 503;
  return 200;
}

/** The relational storage serves bulletins only on Postgres, in a known environment, and in
 * production only once enabled. */
function relationalStorageReadyV2(env: RuntimeEnv) {
  const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
  return (
    env.GRADEBOOK_STORAGE_PROVIDER === 'postgres' &&
    ['production', 'local', 'preview'].includes(environment) &&
    (environment !== 'production' || env.GRADEBOOK_PRODUCTION_ENABLED === 'true') &&
    Boolean(env.GRADEBOOK_DATABASE)
  );
}

/** Only an emission that produced at least one bulletin notifies live screens. */
function emittedV2(response: RelationalBulletinResponseV2) {
  return response.state === 'ready' && (response.operation === 'emit'
    || (response.operation === 'emit-batch' && response.ready.length > 0));
}

async function handleRelationalBulletinV2(
  payload: unknown,
  env: RuntimeEnv,
  session: Awaited<ReturnType<typeof requireAuth>>,
  afterCommit: GradebookAfterCommitV1 | undefined,
): Promise<Response> {
  const parsed = relationalBulletinRequestSchemaV2.safeParse(payload);
  if (!parsed.success) return relationalFailure(null, 'invalid-request', 400);
  if (!relationalStorageReadyV2(env)) return relationalFailure(parsed.data, 'unavailable', 503);
  try {
    const database = env.GRADEBOOK_DATABASE as GradebookPostgresWritePortV1;
    const service = createRelationalBulletinServiceV2({
      database,
      snapshots: createRelationalBulletinSnapshotRepositoryV2(database),
    });
    const response = await service.execute(parsed.data, { issuerOid: session.oid });
    if (emittedV2(response)) afterCommit?.(session);
    return noStoreJson(response, relationalStatus(response));
  } catch {
    return relationalFailure(parsed.data, 'unavailable', 503);
  }
}

export async function handleBulletinRequestV1(
  request: Request,
  env: RuntimeEnv,
  afterCommit?: GradebookAfterCommitV1,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== GRADEBOOK_BULLETIN_ROUTE_V1) return null;

  enforceOfficialOrigin(request, env);
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  enforceWriteOrigin(request, env);

  let session: Awaited<ReturnType<typeof requireAuth>>;
  try {
    session = await requireAuth(request, env);
    authorizeGradebookRuntimeV1(session);
  } catch (cause) {
    if (cause instanceof AuthenticationError) return accessDenied(401);
    if (cause instanceof AuthorizationError) return accessDenied(403);
    return unavailable(500);
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(request, 65_536);
  } catch (cause) {
    return unavailable(cause instanceof HttpError ? cause.status : 400);
  }

  if (
    payload !== null &&
    typeof payload === 'object' &&
    'contractVersion' in payload &&
    payload.contractVersion === RELATIONAL_BULLETIN_CONTRACT_VERSION_V2
  ) {
    return handleRelationalBulletinV2(payload, env, session, afterCommit);
  }

  const readiness = inspectBulletinWorkspaceTransportRequestV1(payload);
  if (readiness !== 'ready') {
    return noStoreJson(
      {
        contractVersion: BULLETIN_CONTRACT_VERSION_V1,
        state: 'unavailable',
        reason: readiness,
      },
      400,
    );
  }

  return noStoreJson({
    contractVersion: BULLETIN_CONTRACT_VERSION_V1,
    operation: (payload as BulletinWorkspaceTransportRequestV1).operation,
    state: 'unavailable',
  } satisfies BulletinWorkspaceTransportResponseV1, 410);
}
