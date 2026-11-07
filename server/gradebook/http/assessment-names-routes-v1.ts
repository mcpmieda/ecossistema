import type { GradebookAfterCommitV1 } from './live-after-commit-v1';
import { assessmentNamesRequestSchemaV1, type AssessmentNamesResponseV1 } from '../../../shared/gradebook-contracts/settings/assessment-names-v1';
import { AuthenticationError, requireAuth } from '../../auth/session';
import { AuthorizationError } from '../../auth/roles';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../../http/security';
import { createAssessmentNamesServiceV1 } from '../application/settings/assessment-names-v1';
import { authorizeGradebookRuntimeV1 } from '../authorization-v1';
import type { GradebookPostgresWritePortV1 } from '../persistence/postgres/postgres-database-v1';

const ASSESSMENT_NAMES_ROUTE_V1 = '/api/gradebook/assessment-names';

function response(value: AssessmentNamesResponseV1, status: number): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Expires: '0',
      Pragma: 'no-cache',
    },
  });
}

function failure(
  state: Exclude<AssessmentNamesResponseV1['state'], 'ready'>,
  status: number,
): Response {
  return response({ contractVersion: 1, state }, status);
}

function statusFor(value: AssessmentNamesResponseV1): number {
  if (value.state === 'ready') return 200;
  if (value.state === 'invalid-request') return 400;
  if (value.state === 'not-authorized') return 403;
  if (value.state === 'not-found') return 404;
  if (value.state === 'conflict') return 409;
  return 503;
}

export function createAssessmentNamesRequestHandlerV1() {
  return async (request: Request, env: RuntimeEnv, afterCommit?: GradebookAfterCommitV1): Promise<Response | null> => {
    if (new URL(request.url).pathname !== ASSESSMENT_NAMES_ROUTE_V1) return null;
    enforceOfficialOrigin(request, env);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    enforceWriteOrigin(request, env);

    let session: Awaited<ReturnType<typeof requireAuth>>;
    try {
      session = await requireAuth(request, env);
      authorizeGradebookRuntimeV1(session);
    } catch (cause) {
      if (cause instanceof AuthenticationError) return failure('not-authorized', 401);
      if (cause instanceof AuthorizationError) return failure('not-authorized', 403);
      return failure('unavailable', 503);
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(request, 8192);
    } catch (cause) {
      return failure('invalid-request', cause instanceof HttpError ? cause.status : 400);
    }

    const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
    if (
      env.GRADEBOOK_STORAGE_PROVIDER !== 'postgres' ||
      !['production', 'local', 'preview'].includes(environment) ||
      (environment === 'production' && env.GRADEBOOK_PRODUCTION_ENABLED !== 'true') ||
      !env.GRADEBOOK_DATABASE
    ) {
      return failure('unavailable', 503);
    }

    try {
      const value = await createAssessmentNamesServiceV1(
        env.GRADEBOOK_DATABASE as GradebookPostgresWritePortV1,
      ).execute(payload);
      const parsed = assessmentNamesRequestSchemaV1.safeParse(payload);
      if (value.state === 'ready' && parsed.success && parsed.data.operation === 'save'
        && value.version > parsed.data.expectedVersion) afterCommit?.(session);
      return response(value, statusFor(value));
    } catch {
      return failure('unavailable', 503);
    }
  };
}

export const handleAssessmentNamesRequestV1 = createAssessmentNamesRequestHandlerV1();
