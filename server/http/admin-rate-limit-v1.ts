import type { RuntimeEnv } from '../env';
import { readSession } from '../auth/session';
import { capabilitiesForRoles } from '../auth/capabilities';
import { failureV1 } from '../../shared/student-portal-contracts/core-v1';
import { RECONCILIATION_ROUTE_V1 } from '../../shared/student-identity/reconciliation-v1';
import type {
  AdminOperationV1,
  PortalAdminServiceBindingV1,
  TrustedAdminContextV1,
} from '../../shared/student-portal-contracts/ports-v1';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  withSecurityHeaders,
} from './security';

type PayloadV1 = Record<string, unknown>;
type RouteV1 = {
  methods: readonly string[];
  operation: AdminOperationV1;
  bodyBytes?: number;
  /** The transport also carries an upload: a body above bodyBytes keeps the default family, unread. */
  upload?: true;
};
const routes: Readonly<Record<string, RouteV1>> = {
  '/api/me': { methods: ['GET'], operation: 'read' },
  '/api/platform/bootstrap': { methods: ['GET'], operation: 'read' },
  '/api/platform/snapshot': { methods: ['GET'], operation: 'read' },
  '/api/platform/snapshot-v2': { methods: ['GET'], operation: 'read' },
  '/api/sharepoint/health': { methods: ['GET'], operation: 'read' },
  '/api/platform/settings/session': { methods: ['GET', 'POST'], operation: 'write' },
  '/api/platform/system-health': { methods: ['POST'], operation: 'read' },
  '/api/platform/system-health/history': { methods: ['POST'], operation: 'read' },
  '/api/platform/system-health/signals': { methods: ['POST'], operation: 'read' },
  '/api/platform/system-health/capacity': { methods: ['POST'], operation: 'read' },
  '/api/platform/system-health/review': { methods: ['POST'], operation: 'read' },
  '/api/platform/system-health/providers': { methods: ['POST'], operation: 'read' },
  '/api/gradebook/import-persistence': { methods: ['POST'], operation: 'import' },
  '/api/gradebook/import-diagnostics': { methods: ['GET', 'POST'], operation: 'import' },
  '/api/gradebook/admin/persistence/status': { methods: ['GET'], operation: 'read' },
  '/api/gradebook/operational-workspace': {
    methods: ['POST'],
    operation: 'read',
    bodyBytes: 16384,
  },
  '/api/gradebook/performance': { methods: ['POST'], operation: 'read', bodyBytes: 32768 },
  '/api/gradebook/bulletins': { methods: ['POST'], operation: 'export', bodyBytes: 65536 },
  '/api/gradebook/council-workspace': { methods: ['POST'], operation: 'write', bodyBytes: 16384 },
  '/api/gradebook/assessment-names': { methods: ['POST'], operation: 'write', bodyBytes: 8192 },
  '/api/gradebook/year-reset': { methods: ['POST'], operation: 'write', bodyBytes: 2048 },
  '/api/gradebook/audit-treatment': { methods: ['POST'], operation: 'write', bodyBytes: 96000 },
  [RECONCILIATION_ROUTE_V1]: { methods: ['POST'], operation: 'write', bodyBytes: 65536, upload: true },
  '/api/student-photos/admin/state': { methods: ['POST'], operation: 'read' },
  '/api/student-photos/admin/avatars': { methods: ['POST'], operation: 'read' },
  '/api/student-photos/admin/image': { methods: ['GET'], operation: 'read' },
  '/api/student-photos/admin/open': { methods: ['POST'], operation: 'write' },
  '/api/student-photos/admin/recover': { methods: ['POST'], operation: 'write' },
  '/api/student-photos/admin/preview': { methods: ['POST'], operation: 'write' },
  '/api/student-photos/admin/save': { methods: ['POST'], operation: 'write' },
};

// Only small, mixed-operation transports are inspected. Import/image bodies remain untouched.
async function classificationPayload(request: Request, maximum: number): Promise<PayloadV1> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new HttpError(415, 'Expected application/json');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum))
    throw new HttpError(413, 'Request body too large');
  const reader = request.clone().body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing request body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk.value);
    }
  } catch (error) {
    // Awaiting only one branch of a tee's cancellation can wait forever for the other branch.
    void reader.cancel().catch(() => undefined);
    void request.body?.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('invalid');
    return payload as PayloadV1;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function inspectsBodyV1(route: RouteV1, request: Request): boolean {
  if (!route.bodyBytes) return false;
  if (!route.upload) return true;
  const length = request.headers.get('content-length');
  return length !== null && /^\d+$/u.test(length) && Number(length) <= route.bodyBytes;
}

export function classifyAdminOperationV1(
  path: string,
  method: string,
  payload: PayloadV1,
): AdminOperationV1 {
  if (method === 'GET') return 'read';
  const operation = payload.operation;
  if (
    path === '/api/gradebook/council-workspace' &&
    ['classes', 'workspace'].includes(String(operation))
  )
    return 'read';
  if (path === RECONCILIATION_ROUTE_V1 && ['catalog', 'list', 'detail'].includes(String(operation)))
    return 'read';
  if (path === '/api/gradebook/assessment-names' && operation === 'read') return 'read';
  if (path === '/api/gradebook/year-reset' && operation === 'preview') return 'read';
  if (
    path === '/api/gradebook/audit-treatment' &&
    ['context', 'history'].includes(String(operation))
  )
    return 'read';
  if (
    path === '/api/gradebook/bulletins' &&
    ['catalog', 'students', 'preview', 'history'].includes(String(operation))
  )
    return 'read';
  return routes[path]?.operation ?? 'write';
}

function failureBody(path: string, payload: PayloadV1, status: number) {
  let state: 'not-authorized' | 'unavailable' | 'invalid-request';
  if (status === 401 || status === 403) {
    state = 'not-authorized';
  } else if (status === 429 || status >= 500) {
    state = 'unavailable';
  } else {
    state = 'invalid-request';
  }
  if (path === RECONCILIATION_ROUTE_V1) return { contractVersion: 1, state };
  if (path === '/api/gradebook/import-persistence') return { transportVersion: 9, state };
  if (path === '/api/gradebook/import-diagnostics') return { version: 1, state };
  if (path === '/api/gradebook/performance') {
    const version = payload.transportVersion;
    return {
      transportVersion:
        typeof version === 'number' && [2, 3, 4, 5, 6].includes(version) ? version : 1,
      state,
    };
  }
  if (path === '/api/gradebook/operational-workspace')
    return { contractVersion: payload.contractVersion === 2 ? 2 : 1, state };
  if (path === '/api/gradebook/council-workspace')
    return payload.contractVersion === 3 ? { contractVersion: 3, state } : null;
  if (path === '/api/gradebook/bulletins') {
    if (payload.contractVersion === 2)
      return { contractVersion: 2, operation: payload.operation, state };
    return null;
  }
  if (path.startsWith('/api/gradebook/') && !path.includes('/admin/'))
    return { contractVersion: 1, state };
  if (path.startsWith('/api/student-photos/'))
    return {
      version: 1,
      state:
        status === 401
          ? 'unauthenticated'
          : status === 403
            ? 'forbidden'
            : status < 429
              ? 'invalid'
              : 'unavailable',
      traceId: crypto.randomUUID(),
    };
  if (path.startsWith('/api/platform/system-health'))
    return { state: status === 401 ? 'unauthenticated' : state };
  return {
    error:
      status === 429
        ? 'Muitas solicitações. Tente novamente em 60 segundos.'
        : status >= 500
          ? 'Service unavailable'
          : status === 401
            ? 'Unauthorized'
            : 'Invalid request',
    correlationId: crypto.randomUUID(),
  };
}

function denied(path: string, payload: PayloadV1, status: number): Response {
  const body = failureBody(path, payload, status);
  const response = body === null ? new Response(null, { status }) : Response.json(body, { status });
  if (status === 429 || status === 503) response.headers.set('Retry-After', '60');
  return withSecurityHeaders(response, true);
}

/** A Pages-only guard before any handler/provider. Public auth/logout and static assets are untouched.
 * Portal ADM query/command/live enforce their quota at the private Worker boundary instead.
 */
export async function guardAdminOperationV1(
  request: Request,
  env: RuntimeEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const route = routes[path];
  if (!route) return null;
  let payload: PayloadV1 = {};
  try {
    enforceOfficialOrigin(request, env);
    if (!route.methods.includes(request.method)) return denied(path, payload, 405);
    if (request.method !== 'GET') enforceWriteOrigin(request, env);
    const session = await readSession(request, env);
    if (!session) return denied(path, payload, 401);
    if (inspectsBodyV1(route, request))
      payload = await classificationPayload(request, route.bodyBytes!);
    // Retired transports perform no business work and retain their existing 410/validation responses.
    if (
      (path === '/api/gradebook/performance' && payload.transportVersion === 1) ||
      ([
        '/api/gradebook/operational-workspace',
        '/api/gradebook/bulletins',
      ].includes(path) &&
        payload.contractVersion === 1) ||
      (path === '/api/gradebook/council-workspace' &&
        [1, 2].includes(Number(payload.contractVersion)))
    )
      return null;
    const binding = env.PORTAL_SERVICE as PortalAdminServiceBindingV1 | undefined;
    if (typeof binding?.limitOperation !== 'function') return denied(path, payload, 503);
    const context: TrustedAdminContextV1 = {
      actorId: session.oid,
      tenantId: env.TENANT_ID,
      authenticatedAt: new Date().toISOString(),
      requestId: crypto.randomUUID(),
      capability: capabilitiesForRoles(session.roles).includes('platform.settings.write')
        ? 'platform.settings.write'
        : 'platform.settings.read',
    };
    const result = await binding.limitOperation(
      context,
      classifyAdminOperationV1(path, request.method, payload),
    );
    if (result === null) return null;
    const failure = failureV1.safeParse(result);
    return denied(
      path,
      payload,
      failure.success && failure.data.state === 'rate-limited' ? 429 : 503,
    );
  } catch (error) {
    return denied(path, payload, error instanceof HttpError ? error.status : 503);
  }
}
