import { gradebookAfterCommitV1 } from '../../../server/gradebook/http/live-after-commit-v1';
import type { RuntimeEnv } from '../../../server/env';
import { validateEnv } from '../../../server/env';
import { withOfficialGradebookDatabaseV1 } from '../../../server/gradebook/persistence/postgres/official-gradebook-database-v1';
import { createImportDiagnosticTreatmentRequestHandlerV1 } from '../../../server/gradebook/http/import-diagnostic-treatment-routes-v1';
import { HttpError, withSecurityHeaders } from '../../../server/http/security';
import { AuthenticationError } from '../../../server/auth/session';
import { AuthorizationError } from '../../../server/auth/roles';
import {
  IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1,
  type ImportDiagnosticTreatmentResponseV1,
} from '../../../shared/gradebook-contracts/audit/import-diagnostic-treatment-v1';

type Context = EventContext<RuntimeEnv, string, unknown>;
const handler = createImportDiagnosticTreatmentRequestHandlerV1();

function failureStateOf(status: number) {
  if (status === 401 || status === 403) return 'not-authorized';
  return status < 500 ? 'invalid-request' : 'unavailable';
}

function failure(status = 503): Response {
  const value: ImportDiagnosticTreatmentResponseV1 = {
    contractVersion: IMPORT_DIAGNOSTIC_TREATMENT_CONTRACT_VERSION_V1,
    state: failureStateOf(status),
  };
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' },
  });
}

export const onRequest: PagesFunction<RuntimeEnv> = async (context) => {
  try {
    const env = validateEnv((context as Context).env);
    const routed = await withOfficialGradebookDatabaseV1(env, (executionEnv) =>
      handler((context as Context).request, executionEnv, gradebookAfterCommitV1(env, (work) => context.waitUntil(work))),
    );
    return withSecurityHeaders(routed ?? failure(), true);
  } catch (cause) {
    const status =
      cause instanceof HttpError ||
      cause instanceof AuthenticationError ||
      cause instanceof AuthorizationError
        ? cause.status
        : 503;
    if (status >= 500) {
      console.error(JSON.stringify({ message: 'gradebook_audit_treatment_failed' }));
    }
    return withSecurityHeaders(failure(status), true);
  }
};
