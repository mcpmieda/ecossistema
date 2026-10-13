import {
  ADMIN_BODY_BYTES_V1,
  adminCommandV1,
  adminResponseV1,
  type AdminCommandV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import {
  adminQueryRequestV2,
  adminReadResponseV2,
} from '../../../../shared/student-portal-contracts/admin-read-v2';
import {
  ERROR_HTTP_V1,
  failureV1,
  type FailureV1,
} from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminServiceBindingV1 } from '../../../../shared/student-portal-contracts/ports-v1';
import type { RuntimeEnv } from '../../../env';
import { HttpError, readBoundedJson } from '../../../http/security';
import { portalJsonV1 } from '../../runtime/http-v1';
import { verifiedPagesContextV1 } from '../../admin-client/pages-context-v1';
import { readSession } from '../../../auth/session';

type AdminRequestKindV1 = 'query' | 'command';
type AdminBindingResultV1 = {
  result: unknown;
  expected: string;
  expectedVersion: number;
};

function allowed(request: Request, env: RuntimeEnv): boolean {
  const url = new URL(request.url);
  const environment = env.RUNTIME_ENVIRONMENT ?? 'production';
  if (environment === 'production' && env.OFFICIAL_ORIGIN !== 'https://admin.escolaieda.com')
    return false;
  if (
    environment !== 'production' &&
    (environment !== 'local' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    return false;
  if (url.origin !== env.OFFICIAL_ORIGIN || url.search || url.hash || url.username || url.password)
    return false;
  const host = request.headers.get('host');
  if (host && host.toLowerCase() !== url.host.toLowerCase()) return false;
  if (request.headers.has('x-forwarded-host') || request.headers.has('x-original-url'))
    return false;
  if (request.headers.get('origin') !== env.OFFICIAL_ORIGIN) return false;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

function commandState(command: AdminCommandV1): 'qr' | 'committed' {
  if (command.operation.startsWith('qr-')) return 'qr';
  return 'committed';
}

function failResponseV1(requestId: string, state: FailureV1['state']) {
  return portalJsonV1({ contractVersion: 1, requestId, state }, ERROR_HTTP_V1[state]);
}

function requestKindV1(path: string): AdminRequestKindV1 | null {
  if (path === '/api/student-portal/admin/query') return 'query';
  if (path === '/api/student-portal/admin/command') return 'command';
  return null;
}

async function serveLiveV1(
  request: Request,
  env: RuntimeEnv,
  binding: PortalAdminServiceBindingV1,
  requestId: string,
) {
  const fail = (state: FailureV1['state']) => failResponseV1(requestId, state);
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return fail('invalid-request');
  const context = await verifiedPagesContextV1(request, env, false, requestId);
  if (typeof context === 'string') return fail(context);
  const session = await readSession(request, env);
  if (
    !session ||
    session.oid.toLowerCase() !== context.actorId.toLowerCase() ||
    typeof binding.fetch !== 'function'
  )
    return fail('unauthenticated');
  return binding.fetch(
    new Request('https://portal-admin.internal/live', {
      headers: {
        Upgrade: 'websocket',
        'x-admin-actor-id': context.actorId,
        'x-admin-tenant-id': context.tenantId,
        'x-admin-capability': 'platform.settings.read',
        'x-admin-expires-at': new Date(session.exp * 1000).toISOString(),
      },
    }),
  );
}

async function queryBindingV1(
  request: Request,
  env: RuntimeEnv,
  binding: PortalAdminServiceBindingV1,
  requestId: string,
  body: unknown,
): Promise<AdminBindingResultV1 | FailureV1['state']> {
  const parsed = adminQueryRequestV2.safeParse(body);
  if (!parsed.success) return 'invalid-request';
  const query = parsed.data;
  const elevated = ['audit-detail', 'links-preview', 'bulk-preview'].includes(query.operation);
  const context = await verifiedPagesContextV1(request, env, elevated, requestId);
  if (typeof context === 'string') return context;
  return {
    result: await binding.query(context, query),
    expected: query.operation,
    expectedVersion: query.contractVersion,
  };
}

async function commandBindingV1(
  request: Request,
  env: RuntimeEnv,
  binding: PortalAdminServiceBindingV1,
  requestId: string,
  body: unknown,
): Promise<AdminBindingResultV1 | FailureV1['state']> {
  const parsed = adminCommandV1.safeParse(body);
  if (!parsed.success) return 'invalid-request';
  const context = await verifiedPagesContextV1(request, env, true, requestId);
  if (typeof context === 'string') return context;
  return {
    result: await binding.command(context, parsed.data),
    expected: commandState(parsed.data),
    expectedVersion: 1,
  };
}

async function invokeBindingV1(
  kind: AdminRequestKindV1,
  request: Request,
  env: RuntimeEnv,
  binding: PortalAdminServiceBindingV1,
  requestId: string,
  body: unknown,
) {
  return kind === 'query'
    ? queryBindingV1(request, env, binding, requestId, body)
    : commandBindingV1(request, env, binding, requestId, body);
}

function bindingResponseV1(
  call: AdminBindingResultV1,
  requestId: string,
): Response {
  const failure = failureV1.safeParse(call.result);
  if (failure.success) {
    const response = portalJsonV1(
      { ...failure.data, requestId },
      ERROR_HTTP_V1[failure.data.state],
    );
    if (failure.data.retryAfterSeconds)
      response.headers.set('Retry-After', String(failure.data.retryAfterSeconds));
    return response;
  }
  const parsed =
    call.expectedVersion === 2
      ? adminReadResponseV2.safeParse(call.result)
      : adminResponseV1.safeParse(call.result);
  if (
    !parsed.success ||
    parsed.data.state !== call.expected ||
    parsed.data.requestId !== requestId
  )
    return failResponseV1(requestId, 'unavailable');
  return portalJsonV1(parsed.data, 200);
}

/** Standalone ADM Pages adapter; #715 owns routing and the dedicated service binding. */
export async function servePortalAdminV1(
  request: Request,
  env: RuntimeEnv,
  binding: PortalAdminServiceBindingV1,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (!allowed(request, env)) return failResponseV1(requestId, 'forbidden');
  const path = new URL(request.url).pathname;
  if (path === '/api/student-portal/admin/live')
    return serveLiveV1(request, env, binding, requestId);

  const kind = requestKindV1(path);
  if (!kind)
    return portalJsonV1({ contractVersion: 1, requestId, state: 'unavailable' }, 404);
  if (request.method !== 'POST') return failResponseV1(requestId, 'invalid-request');

  try {
    // Check identity before consuming an untrusted stream or invoking the binding.
    const first = await verifiedPagesContextV1(request, env, kind === 'command', requestId);
    if (typeof first === 'string') return failResponseV1(requestId, first);
    const body = await readBoundedJson(request, ADMIN_BODY_BYTES_V1);
    const call = await invokeBindingV1(kind, request, env, binding, requestId, body);
    if (typeof call === 'string') return failResponseV1(requestId, call);
    return bindingResponseV1(call, requestId);
  } catch (error) {
    if (error instanceof HttpError)
      return failResponseV1(
        requestId,
        error.status === 413 ? 'body-too-large' : 'invalid-request',
      );
    return failResponseV1(requestId, 'unavailable');
  }
}
