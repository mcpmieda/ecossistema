import { PortalRateLimitErrorV1, portalRateLimitResponseV1 } from '../../observability/operation-burst-v1';
import { ZodError } from 'zod';
import { ACCESS_CLOSED_ACCEPT_HEADER_V1, AUTH_BODY_BYTES_V1, SESSION_COOKIE_V1, logoutRequestV1, logoutResponseV1 } from '../../../../shared/student-portal-contracts/auth-v1';
import { ERROR_HTTP_V1, type FailureV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { portalJsonV1, portalRequestOriginAllowedV1 } from '../../runtime/http-v1';
import type { AuthServiceV1 } from '../../auth/auth-service-v1';
import type { SessionServiceV1 } from '../../auth/session-service-v1';

// Keep parsing bounded even when unrelated cookies are supplied. Valid token format is unchanged.
export const SESSION_COOKIE_HEADER_BYTES_V1 = 8192;
export const SESSION_COOKIE_PAIRS_V1 = 64;
const COOKIE = `${SESSION_COOKIE_V1.name}=`;
const FLAGS = '; Path=/; Secure; HttpOnly; SameSite=Strict';
const routes = new Map([['/api/student/auth/challenge', 'challenge'], ['/api/student/auth/activate', 'activate'],
  ['/api/student/auth/login', 'login'], ['/api/student/auth/logout', 'logout'], ['/api/student/session', 'session']] as const);

export function sessionCookieTokenV1(request: Request): string {
  const header = request.headers.get('cookie') ?? '';
  if (header.length > SESSION_COOKIE_HEADER_BYTES_V1
    || new TextEncoder().encode(header).byteLength > SESSION_COOKIE_HEADER_BYTES_V1) return '';
  const pairs = header.split(';');
  if (pairs.length > SESSION_COOKIE_PAIRS_V1) return '';
  const values = pairs.map((part) => part.trim()).filter((part) => part.startsWith(COOKIE));
  if (values.length !== 1) return '';
  const token = values[0]!.slice(COOKIE.length);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : '';
}
function cookie(token: string, expiresAt: string, persistent: boolean): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('student-portal-session-token-invalid');
  return `${COOKIE}${token}${FLAGS}${persistent ? '; Expires=' + new Date(expiresAt).toUTCString() : ''}`;
}
async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > AUTH_BODY_BYTES_V1)) throw new Error('body-too-large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid-request');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > AUTH_BODY_BYTES_V1) { await reader.cancel(); throw new Error('body-too-large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error('invalid-request'); }
}

type FailV1 = (state: FailureV1['state']) => Response;
type RequestIdV1 = ReturnType<typeof crypto.randomUUID>;

/** The session read: at most one well-formed expected account, and the session cookie. */
async function serveSessionReadV1(
  request: Request,
  sessions: Pick<SessionServiceV1, 'read'>,
  { requestId, acceptAccessClosed, fail }: { requestId: RequestIdV1; acceptAccessClosed: boolean; fail: FailV1 },
) {
  const search = new URL(request.url).searchParams;
  if (search.getAll('accountId').length > 1) return fail('invalid-request');
  const expected = search.get('accountId');
  if (expected !== null && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(expected)) return fail('invalid-request');
  const token = sessionCookieTokenV1(request);
  if (!token) return fail('unauthenticated');
  const result = await sessions.read(token, requestId, expected ?? undefined, acceptAccessClosed);
  if (result?.state === 'access-closed') return acceptAccessClosed ? portalJsonV1(result, 403) : fail('unauthenticated');
  return result ? portalJsonV1(result, 200) : fail('unauthenticated');
}

/** Logout: revokes the session it names, and always clears the cookie. */
async function serveLogoutV1(
  request: Request,
  sessions: Pick<SessionServiceV1, 'logout'>,
  input: unknown,
  requestId: RequestIdV1,
) {
  logoutRequestV1.parse(input);
  const token = sessionCookieTokenV1(request);
  // No plausible token means there is nothing to revoke; keep logout idempotent and clear it.
  if (token) await sessions.logout(token, requestId);
  const response = portalJsonV1(logoutResponseV1.parse({ contractVersion: 1, requestId, state: 'logged-out' }), 200);
  response.headers.set('Set-Cookie', `${COOKIE}${FLAGS}; Max-Age=0`);
  return response;
}

/** A sign-in step's answer: the session cookie when it ends signed in, a failure with its status. */
function authResponseV1(
  result: Awaited<ReturnType<AuthServiceV1['challenge' | 'activate' | 'login']>>,
  acceptAccessClosed: boolean,
  fail: FailV1,
) {
  if ('token' in result) {
    const response = portalJsonV1(result.body, 200);
    response.headers.set('Set-Cookie', cookie(result.token, result.body.expiresAt, result.body.persistent));
    return response;
  }
  if (result.state === 'access-closed' && !acceptAccessClosed) return fail('unauthenticated');
  if (result.state in ERROR_HTTP_V1) {
    const response = portalJsonV1(result, ERROR_HTTP_V1[result.state as FailureV1['state']]);
    if ('retryAfterSeconds' in result && result.retryAfterSeconds) response.headers.set('Retry-After', String(result.retryAfterSeconds));
    return response;
  }
  return portalJsonV1(result, 200);
}

function authFailureV1(error: unknown, requestId: RequestIdV1, fail: FailV1) {
  if (error instanceof PortalRateLimitErrorV1) return portalRateLimitResponseV1(error, requestId);
  if (error instanceof ZodError || (error instanceof Error && error.message === 'invalid-request')) return fail('invalid-request');
  if (error instanceof Error && error.message === 'body-too-large') return fail('body-too-large');
  return fail('unavailable'); // Never serialize provider errors, SQL, inputs or credentials.
}

/** Standalone handler for #715 composition. No entrypoint or production gate is changed here. */
export async function servePortalAuthV1(request: Request, environment: string, origin: string,
  auth: Pick<AuthServiceV1, 'challenge' | 'activate' | 'login'>, sessions: Pick<SessionServiceV1, 'read' | 'logout'>): Promise<Response> {
  const requestId = crypto.randomUUID();
  const fail = (state: FailureV1['state']) => portalJsonV1({ contractVersion: 1, requestId, state }, ERROR_HTTP_V1[state]);
  if (!portalRequestOriginAllowedV1(request, environment, origin)) return fail('forbidden');
  const route = routes.get(new URL(request.url).pathname as Parameters<typeof routes.get>[0]);
  if (!route) return portalJsonV1({ contractVersion: 1, requestId, state: 'unavailable' }, 404);
  if (request.method !== (route === 'session' ? 'GET' : 'POST')) return fail('invalid-request');
  const acceptAccessClosed = request.headers.get(ACCESS_CLOSED_ACCEPT_HEADER_V1) === 'v1';
  try {
    if (route === 'session') return await serveSessionReadV1(request, sessions, { requestId, acceptAccessClosed, fail });
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('invalid-request');
    const input = await readBody(request);
    if (route === 'logout') return await serveLogoutV1(request, sessions, input, requestId);
    return authResponseV1(await auth[route](input, requestId), acceptAccessClosed, fail);
  } catch (error) {
    return authFailureV1(error, requestId, fail);
  }
}
