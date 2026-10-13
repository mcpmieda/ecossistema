import {
  gradebookAfterCommitV1,
  type GradebookAfterCommitV1,
} from '../../../server/gradebook/http/live-after-commit-v1';
import type { RuntimeEnv } from '../../../server/env';
import { validateEnv } from '../../../server/env';
import { requireAuth, AuthenticationError } from '../../../server/auth/session';
import { AuthorizationError } from '../../../server/auth/roles';
import { authorizeGradebookRuntimeV1 } from '../../../server/gradebook/authorization-v1';
import type { GradebookPostgresWritePortV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { withOfficialGradebookDatabaseV1 } from '../../../server/gradebook/persistence/postgres/official-gradebook-database-v1';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import {
  createImportPerformanceObserverV1,
  emitImportPerformanceV1,
  type ImportPerformanceObserverV1,
} from '../../../server/gradebook/persistence/postgres/import-performance-observer-v1';
import {
  GRADEBOOK_IMPORT_PERSISTENCE_BODY_BYTES_V9,
  inspectGradebookImportPersistenceRequestV9,
  type GradebookImportPersistenceRequestV9,
  type GradebookImportPersistenceResponseV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import {
  IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1,
  serializeImportCommitDiagnosticsHeaderV1,
} from '../../../shared/gradebook-contracts/imports/import-commit-diagnostics-v1';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  withSecurityHeaders,
} from '../../../server/http/security';

type Context = EventContext<RuntimeEnv, string, unknown>;
type ImportObservationV1 = {
  observer: ImportPerformanceObserverV1 | null;
  operation: GradebookImportPersistenceRequestV9['operation'] | null;
  outcome: GradebookImportPersistenceResponseV9['state'] | null;
  handlerMs: number | null;
  payloadBytes: number | null;
  offerCount: number | null;
  lifecycleCompleted: boolean;
};

function commitDiagnostics(observation: ImportObservationV1) {
  try {
    return (
      observation.observer?.commitDiagnostics(
        observation.outcome,
        observation.lifecycleCompleted,
      ) ?? null
    );
  } catch {
    return null;
  }
}
function withCommitDiagnostics(value: Response, observation: ImportObservationV1): Response {
  try {
    const diagnostic = serializeImportCommitDiagnosticsHeaderV1(commitDiagnostics(observation));
    if (diagnostic === null) return value;
    const headers = new Headers(value.headers);
    headers.set(IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1, diagnostic);
    return new Response(value.body, {
      status: value.status,
      statusText: value.statusText,
      headers,
    });
  } catch {
    return value;
  }
}
function statusFor(value: GradebookImportPersistenceResponseV9): number {
  switch (value.state) {
    case 'applied':
    case 'no-changes':
    case 'review-required':
      return 200;
    case 'blocked':
    case 'conflict':
      return 409;
    case 'invalid-request':
      return 400;
    case 'not-authorized':
      return 403;
    case 'unavailable':
      return 503;
  }
}
function response(value: GradebookImportPersistenceResponseV9, serverMs: number): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Gradebook-Server-Ms': String(Math.round(serverMs * 10) / 10),
  });
  return Response.json(value, { status: statusFor(value), headers });
}
async function readPayload(request: Request): Promise<{ value: unknown; bytes: number }> {
  const text = await request.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > GRADEBOOK_IMPORT_PERSISTENCE_BODY_BYTES_V9)
    throw new HttpError(413, 'Payload too large');
  try {
    return { value: JSON.parse(text) as unknown, bytes };
  } catch {
    return { value: null, bytes };
  }
}
async function handle(
  request: Request,
  env: RuntimeEnv,
  afterCommit: GradebookAfterCommitV1,
  observation: ImportObservationV1,
): Promise<Response> {
  const started = performance.now();
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  enforceOfficialOrigin(request, env);
  enforceWriteOrigin(request, env);
  const session = await requireAuth(request, env);
  authorizeGradebookRuntimeV1(session);
  const { value: payload, bytes } = await readPayload(request);
  const inspection = inspectGradebookImportPersistenceRequestV9(payload);
  if (inspection !== 'ready') {
    return response(
      {
        transportVersion: 9,
        state: 'invalid-request',
        reason:
          inspection === 'payload-too-large'
            ? 'Pacote acadêmico excede o limite permitido.'
            : 'Pacote acadêmico canônico inválido.',
      },
      performance.now() - started,
    );
  }
  const database = env.GRADEBOOK_DATABASE as GradebookPostgresWritePortV1 | undefined;
  if (!database)
    return response({ transportVersion: 9, state: 'unavailable' }, performance.now() - started);
  const canonical = payload as GradebookImportPersistenceRequestV9;
  const observer = createImportPerformanceObserverV1();
  observation.observer = observer;
  observation.operation = canonical.operation;
  observation.payloadBytes = bytes;
  observation.offerCount = canonical.operation === 'persist-notas' ? canonical.ofertas.length : 0;
  // Diagnostics are replaced only by a complete diagnostic observation, including [].
  // Academic persistence must not clear another tab's newer evidence or erase it on failure.
  try {
    const result = await createGradebookRelationalImportServiceV11(
      observer.wrap(database),
      observer,
      session.oid,
    ).execute(canonical);
    observation.outcome = result.state;
    if (result.state === 'applied') afterCommit(session);
    return response(result, performance.now() - started);
  } finally {
    observation.handlerMs = performance.now() - started;
  }
}
export const onRequest: PagesFunction<RuntimeEnv> = async (context) => {
  const started = performance.now();
  const observation: ImportObservationV1 = {
    observer: null,
    operation: null,
    outcome: null,
    handlerMs: null,
    payloadBytes: null,
    offerCount: null,
    lifecycleCompleted: false,
  };
  try {
    const env = validateEnv((context as Context).env);
    const routed = await withOfficialGradebookDatabaseV1(env, (executionEnv) =>
      handle(
        (context as Context).request,
        executionEnv,
        gradebookAfterCommitV1(env, (work) => context.waitUntil(work)),
        observation,
      ),
    );
    // The official wrapper has now finished its close boundary as well as the outer commit.
    observation.lifecycleCompleted = true;
    return withSecurityHeaders(
      withCommitDiagnostics(
        routed ?? Response.json({ transportVersion: 9, state: 'unavailable' }, { status: 503 }),
        observation,
      ),
      true,
    );
  } catch (error) {
    if (observation.observer) observation.outcome = 'unavailable';
    const status =
      error instanceof HttpError ||
      error instanceof AuthenticationError ||
      error instanceof AuthorizationError
        ? error.status
        : 500;
    const value: GradebookImportPersistenceResponseV9 =
      status === 401 || status === 403
        ? { transportVersion: 9, state: 'not-authorized' }
        : status < 500
          ? {
              transportVersion: 9,
              state: 'invalid-request',
              reason: error instanceof Error ? error.message : 'Pedido inválido.',
            }
          : { transportVersion: 9, state: 'unavailable' };
    if (status >= 500)
      console.error(JSON.stringify({ message: 'gradebook_relational_import_failed' }));
    return withSecurityHeaders(
      withCommitDiagnostics(Response.json(value, { status }), observation),
      true,
    );
  } finally {
    if (observation.observer) {
      emitImportPerformanceV1({
        operation: observation.operation,
        outcome: observation.outcome ?? 'unavailable',
        handlerMs: observation.handlerMs,
        requestLifecycleMs: performance.now() - started,
        payloadBytes: observation.payloadBytes,
        offerCount: observation.offerCount,
        commitDiagnostics: commitDiagnostics(observation),
        ...observation.observer.snapshot(),
      });
    }
  }
};
