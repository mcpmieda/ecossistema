import type { GradebookAfterCommitV1 } from './live-after-commit-v1';
import {
  COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
  COUNCIL_INSTITUTIONAL_OPERATIONS_V2,
  inspectCouncilInstitutionalRequestV2,
  type CouncilInstitutionalFailureV2,
  type CouncilInstitutionalOperationV2,
} from '../../../shared/gradebook-contracts/council/council-institutional-contract-v2';
import {
  COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
  inspectCouncilDecisionRequestV1,
  inspectCouncilQueueRequestV1,
  inspectCouncilStudentRequestV1,
  type CouncilWorkspaceResponseV1,
} from '../../../shared/gradebook-contracts/council/council-workspace-contract-v1';
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
import { relationalCouncilRequestSchemaV3 } from '../../../shared/gradebook-contracts/council/relational-council-v3';
import { createRelationalCouncilV3 } from '../application/council/relational-council-v3';
import type { GradebookPostgresWritePortV1 } from '../persistence/postgres/postgres-database-v1';

export const GRADEBOOK_COUNCIL_WORKSPACE_ROUTE_V1 = '/api/gradebook/council-workspace';

type CouncilHttpOperationV1 =
  | 'queue'
  | 'student'
  | 'decision'
  | CouncilInstitutionalOperationV2;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function operationFromPayload(value: unknown): CouncilHttpOperationV1 | null {
  if (!isRecord(value)) return null;
  if (value.operation === 'queue' || value.operation === 'student' || value.operation === 'decision') {
    return value.operation;
  }
  return (
    COUNCIL_INSTITUTIONAL_OPERATIONS_V2.find((operation) => operation === value.operation) ?? null
  );
}

function isInstitutionalOperation(
  operation: CouncilHttpOperationV1,
): operation is CouncilInstitutionalOperationV2 {
  return COUNCIL_INSTITUTIONAL_OPERATIONS_V2.some((candidate) => candidate === operation);
}

function invalidQueue(outcome: 'invalid-request' | 'invalid-cursor'): Response {
  return noStoreJson(
    {
      contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
      outcome,
      items: [],
      nextCursor: null,
    },
    400,
  );
}

function invalidStudent(): Response {
  return noStoreJson(
    {
      contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
      outcome: 'invalid-request',
      detail: null,
    },
    400,
  );
}

function invalidDecision(): Response {
  return noStoreJson(
    {
      contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
      outcome: 'invalid-request',
      currentVersion: null,
    },
    400,
  );
}

function invalidInstitutional(): Response {
  return noStoreJson(
    {
      contractVersion: COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
      outcome: 'invalid-request',
      currentVersion: null,
    },
    400,
  );
}

export function createCouncilWorkspaceRequestHandlerV1(): (request: Request, env: RuntimeEnv, afterCommit?: GradebookAfterCommitV1) => Promise<Response | null> {
  return async (request, env, afterCommit) => {
    if (new URL(request.url).pathname !== GRADEBOOK_COUNCIL_WORKSPACE_ROUTE_V1) return null;

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
      payload = await readBoundedJson(request, 16_384);
    } catch (cause) {
      return unavailable(cause instanceof HttpError ? cause.status : 400);
    }

    if (isRecord(payload) && payload.contractVersion === 3) {
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
        const status = response.state === 'ready' ? 200
          : response.state === 'not-found' ? 404
            : response.state === 'invalid-request' ? 400
              : response.state === 'scope-too-large' || response.state === 'closure-blocked' || response.state === 'student-not-eligible' ? 422
                : response.state === 'unavailable' ? 503 : 409;
        return noStoreJson(response, status);
      } catch {
        return noStoreJson({ contractVersion: 3, state: 'unavailable' }, 503);
      }
    }

    const operation = operationFromPayload(payload);
    if (operation === null) return unavailable(400);

    if (operation === 'queue') {
      const readiness = inspectCouncilQueueRequestV1(payload);
      if (readiness !== 'ready') return invalidQueue(readiness);
    } else if (operation === 'student') {
      if (inspectCouncilStudentRequestV1(payload) !== 'ready') return invalidStudent();
    } else if (operation === 'decision') {
      if (inspectCouncilDecisionRequestV1(payload) !== 'ready') return invalidDecision();
    } else if (inspectCouncilInstitutionalRequestV2(payload) !== 'ready') {
      return invalidInstitutional();
    }

    if (operation === 'queue') return noStoreJson({
      contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
      outcome: 'unavailable', items: [], nextCursor: null,
    } satisfies CouncilWorkspaceResponseV1, 410);
    if (operation === 'student') return noStoreJson({
      contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
      outcome: 'unavailable', detail: null,
    } satisfies CouncilWorkspaceResponseV1, 410);
    return noStoreJson({
      contractVersion: isInstitutionalOperation(operation)
        ? COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2 : COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
      outcome: 'unavailable', currentVersion: null,
    } satisfies CouncilWorkspaceResponseV1 | CouncilInstitutionalFailureV2, 410);
  };
}

export const handleCouncilWorkspaceRequestV1 = createCouncilWorkspaceRequestHandlerV1();
