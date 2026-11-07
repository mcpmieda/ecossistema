import type { GradebookAfterCommitV1 } from './live-after-commit-v1';
import {
  IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1,
  IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1,
  type ImportDiagnosticTreatmentFailureV1,
  type ImportDiagnosticTreatmentResponseV1,
} from '../../../shared/gradebook-contracts/audit/import-diagnostic-treatment-v1';
import { AuthenticationError, requireAuth } from '../../auth/session';
import { AuthorizationError } from '../../auth/roles';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../../http/security';
import { createImportDiagnosticTreatmentServiceV1 } from '../application/audit/import-diagnostic-treatment-v1';
import { authorizeGradebookRuntimeV1 } from '../authorization-v1';
import type { GradebookPostgresWritePortV1 } from '../persistence/postgres/postgres-database-v1';

const IMPORT_DIAGNOSTIC_TREATMENT_ROUTE_V1 = '/api/gradebook/audit-treatment';
const VERSION = IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1;

function response(value: ImportDiagnosticTreatmentResponseV1, status: number): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Expires: '0',
      Pragma: 'no-cache',
    },
  });
}

function failure(state: ImportDiagnosticTreatmentFailureV1, status: number): Response {
  return response(
    { contractVersion: VERSION, state } as ImportDiagnosticTreatmentResponseV1,
    status,
  );
}

function statusFor(value: ImportDiagnosticTreatmentResponseV1): number {
  if (value.state === 'ready') return 200;
  switch (value.state) {
    case 'invalid-request':
      return 400;
    case 'not-authorized':
      return 403;
    case 'not-found':
      return 404;
    case 'idempotency-conflict':
      return 409;
    case 'scope-too-large':
      return 422;
    case 'unavailable':
      return 503;
  }
}

export function createImportDiagnosticTreatmentRequestHandlerV1() {
  return async (request: Request, env: RuntimeEnv, afterCommit?: GradebookAfterCommitV1): Promise<Response | null> => {
    if (new URL(request.url).pathname !== IMPORT_DIAGNOSTIC_TREATMENT_ROUTE_V1) return null;
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
      payload = await readBoundedJson(request, IMPORT_DIAGNOSTIC_TREATMENT_LIMITS_V1.bodyBytes);
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
      const value = await createImportDiagnosticTreatmentServiceV1(
        env.GRADEBOOK_DATABASE as GradebookPostgresWritePortV1,
        session.oid,
      ).execute(payload);
      if (value.state === 'ready' && value.operation === 'record') afterCommit?.(session);
      return response(value, statusFor(value));
    } catch {
      return failure('unavailable', 503);
    }
  };
}
