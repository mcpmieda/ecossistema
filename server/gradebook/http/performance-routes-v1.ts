import { performanceAnalyticsRequestSchemaV6 } from '../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import { createPerformanceAnalyticsV6 } from '../application/read-models/performance/performance-analytics-v6';
import { performanceAnalysisRequestSchemaV3 } from '../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import { createPerformanceAnalysisV3 } from '../application/read-models/performance/performance-analysis-v3';
import { performanceDashboardRequestSchemaV5 } from '../../../shared/gradebook-contracts/performance/performance-dashboard-v5';
import { createPerformanceDashboardV5 } from '../application/read-models/performance/performance-dashboard-v5';
import { performanceTermComparisonRequestSchemaV4 } from '../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';
import { createPerformanceTermComparisonV4 } from '../application/read-models/performance/performance-term-comparison-v4';
import { performanceRequestSchemaV2 } from '../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { createRelationalPerformanceV2 } from '../application/read-models/performance/relational-performance-v2';
import {
  decodeCellDetailRef,
  decodeStudentDetailRef,
  inspectPerformanceCursorsV1,
} from '../application/read-models/performance/class-performance-read-model-v1';
import type { GradebookPostgresWritePortV1 } from '../persistence/postgres/postgres-database-v1';
import {
  PERFORMANCE_TRANSPORT_VERSION_V1,
  isPerformanceTransportRequestV1,
  type PerformanceInvalidRequestReasonV1,
  type PerformanceTransportRequestV1,
} from '../../../shared/gradebook-contracts/performance/performance-transport-v1';
import type { PlatformCapability } from '../../../shared/platform-contract';
import { capabilitiesForRoles, requireCapability } from '../../auth/capabilities';
import { AuthenticationError, requireAuth } from '../../auth/session';
import { AuthorizationError } from '../../auth/roles';
import type { RuntimeEnv } from '../../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../../http/security';
import {
  authorizeGradebookRuntimeV1,
  type GradebookRuntimeAuthorizationV1,
} from '../authorization-v1';

export const GRADEBOOK_PERFORMANCE_ROUTE_V1 = '/api/gradebook/performance';

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

function notAuthorized(status: 401 | 403): Response {
  return noStoreJson(
    { transportVersion: PERFORMANCE_TRANSPORT_VERSION_V1, state: 'not-authorized' },
    status,
  );
}

function unavailable(status = 503): Response {
  return noStoreJson(
    { transportVersion: PERFORMANCE_TRANSPORT_VERSION_V1, state: 'unavailable' },
    status,
  );
}

function invalidRequest(reason: PerformanceInvalidRequestReasonV1): Response {
  return noStoreJson(
    { transportVersion: PERFORMANCE_TRANSPORT_VERSION_V1, state: 'invalid-request', reason },
    400,
  );
}

export interface PerformanceRequestHandlerDependenciesV1 {
  authorizeRequest(
    request: Request,
    env: RuntimeEnv,
  ): Promise<{
    readonly runtimeAuthorization: GradebookRuntimeAuthorizationV1;
    readonly capabilities: readonly PlatformCapability[];
  }>;
}

const defaultDependencies: PerformanceRequestHandlerDependenciesV1 = {
  async authorizeRequest(request, env) {
    const session = await requireAuth(request, env);
    const capabilities = capabilitiesForRoles(session.roles);
    requireCapability(capabilities, 'platform.settings.read');
    return {
      runtimeAuthorization: authorizeGradebookRuntimeV1(session),
      capabilities,
    };
  },
};

type CurrentPerformanceVersionV1 = 2 | 3 | 4 | 5 | 6;

interface CurrentPerformanceReadResponseV1 {
  readonly state: string;
}

type CurrentPerformanceHandlerV1 = (
  payload: unknown,
  env: RuntimeEnv,
) => Promise<Response | null>;

function hasCurrentPerformanceVersionV1(
  payload: unknown,
  version: CurrentPerformanceVersionV1,
): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'transportVersion' in payload &&
    payload.transportVersion === version
  );
}

function currentPerformanceFailureV1(
  version: CurrentPerformanceVersionV1,
  state: 'invalid-request' | 'unavailable',
  status: 400 | 503,
): Response {
  return noStoreJson({ transportVersion: version, state }, status);
}

function currentPerformanceDatabaseV1(env: RuntimeEnv): GradebookPostgresWritePortV1 | null {
  const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
  if (env.GRADEBOOK_STORAGE_PROVIDER !== 'postgres') return null;
  if (!['production', 'local', 'preview'].includes(environment)) return null;
  if (environment === 'production' && env.GRADEBOOK_PRODUCTION_ENABLED !== 'true') return null;
  if (!env.GRADEBOOK_DATABASE) return null;
  return env.GRADEBOOK_DATABASE as GradebookPostgresWritePortV1;
}

function currentPerformanceStatusV1(state: string): number {
  switch (state) {
    case 'ready':
      return 200;
    case 'not-found':
      return 404;
    case 'invalid-request':
      return 400;
    case 'ambiguous-offers':
      return 409;
    case 'scope-too-large':
      return 422;
    default:
      return 503;
  }
}

async function executeCurrentPerformanceReadV1(
  version: CurrentPerformanceVersionV1,
  env: RuntimeEnv,
  execute: (database: GradebookPostgresWritePortV1) => Promise<CurrentPerformanceReadResponseV1>,
): Promise<Response> {
  const database = currentPerformanceDatabaseV1(env);
  if (database === null) return currentPerformanceFailureV1(version, 'unavailable', 503);
  try {
    const response = await execute(database);
    return noStoreJson(response, currentPerformanceStatusV1(response.state));
  } catch {
    return currentPerformanceFailureV1(version, 'unavailable', 503);
  }
}

async function handlePerformanceAnalyticsV6(
  payload: unknown,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (!hasCurrentPerformanceVersionV1(payload, 6)) return null;
  const parsed = performanceAnalyticsRequestSchemaV6.safeParse(payload);
  if (!parsed.success) return currentPerformanceFailureV1(6, 'invalid-request', 400);
  return executeCurrentPerformanceReadV1(6, env, (database) =>
    createPerformanceAnalyticsV6(database).execute(parsed.data),
  );
}

async function handlePerformanceDashboardV5(
  payload: unknown,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (!hasCurrentPerformanceVersionV1(payload, 5)) return null;
  const parsed = performanceDashboardRequestSchemaV5.safeParse(payload);
  if (!parsed.success) return currentPerformanceFailureV1(5, 'invalid-request', 400);
  return executeCurrentPerformanceReadV1(5, env, (database) =>
    createPerformanceDashboardV5(database).execute(parsed.data),
  );
}

async function handlePerformanceTermComparisonV4(
  payload: unknown,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (!hasCurrentPerformanceVersionV1(payload, 4)) return null;
  const parsed = performanceTermComparisonRequestSchemaV4.safeParse(payload);
  if (!parsed.success) return currentPerformanceFailureV1(4, 'invalid-request', 400);
  return executeCurrentPerformanceReadV1(4, env, (database) =>
    createPerformanceTermComparisonV4(database).execute(parsed.data),
  );
}

async function handlePerformanceAnalysisV3(
  payload: unknown,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (!hasCurrentPerformanceVersionV1(payload, 3)) return null;
  const parsed = performanceAnalysisRequestSchemaV3.safeParse(payload);
  if (!parsed.success) return currentPerformanceFailureV1(3, 'invalid-request', 400);
  return executeCurrentPerformanceReadV1(3, env, (database) =>
    createPerformanceAnalysisV3(database).execute(parsed.data),
  );
}

async function handleRelationalPerformanceV2(
  payload: unknown,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (!hasCurrentPerformanceVersionV1(payload, 2)) return null;
  const parsed = performanceRequestSchemaV2.safeParse(payload);
  if (!parsed.success) return currentPerformanceFailureV1(2, 'invalid-request', 400);
  return executeCurrentPerformanceReadV1(2, env, (database) =>
    createRelationalPerformanceV2(database).execute(parsed.data),
  );
}

const CURRENT_PERFORMANCE_HANDLERS_V1: readonly CurrentPerformanceHandlerV1[] = [
  handlePerformanceAnalyticsV6,
  handlePerformanceDashboardV5,
  handlePerformanceTermComparisonV4,
  handlePerformanceAnalysisV3,
  handleRelationalPerformanceV2,
];

async function handleCurrentPerformanceRequestV1(
  payload: unknown,
  env: RuntimeEnv,
): Promise<Response | null> {
  for (const handler of CURRENT_PERFORMANCE_HANDLERS_V1) {
    const response = await handler(payload, env);
    if (response !== null) return response;
  }
  return null;
}

/** A detail request whose reference does not decode for its own kind. */
function invalidDetailRefV1(payload: PerformanceTransportRequestV1): boolean {
  return (payload.operation === 'student-detail' && decodeStudentDetailRef(payload.detailRef) === null)
    || (payload.operation === 'cell-detail' && decodeCellDetailRef(payload.detailRef) === null);
}

export function createPerformanceRequestHandlerV1(
  dependencies: PerformanceRequestHandlerDependenciesV1 = defaultDependencies,
): (request: Request, env: RuntimeEnv) => Promise<Response | null> {
  return async (request, env) => {
    if (new URL(request.url).pathname !== GRADEBOOK_PERFORMANCE_ROUTE_V1) return null;

    enforceOfficialOrigin(request, env);
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    enforceWriteOrigin(request, env);

    try {
      await dependencies.authorizeRequest(request, env);
    } catch (cause) {
      if (cause instanceof AuthenticationError) return notAuthorized(401);
      if (cause instanceof AuthorizationError) return notAuthorized(403);
      return unavailable(500);
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(request, 32_768);
    } catch {
      return invalidRequest('invalid-request');
    }
    const currentResponse = await handleCurrentPerformanceRequestV1(payload, env);
    if (currentResponse !== null) return currentResponse;

    if (!isPerformanceTransportRequestV1(payload)) return invalidRequest('invalid-request');
    if (payload.operation === 'matrix') {
      const cursorFailure = inspectPerformanceCursorsV1(payload.request);
      if (cursorFailure !== null) return invalidRequest(cursorFailure);
    }
    if (invalidDetailRefV1(payload)) return invalidRequest('invalid-detail-reference');
    return unavailable(410);
  };
}

export const handlePerformanceRequestV1 = createPerformanceRequestHandlerV1();
