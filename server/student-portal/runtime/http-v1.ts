import { ERROR_HTTP_V1, type FailureV1 } from '../../../shared/student-portal-contracts/core-v1';
import { STUDENT_PHOTO_CONTENT_PATH_V1, photoRevisionV1 } from '../../../shared/student-photos/portrait-v1';

export const PORTAL_AUTH_BODY_BYTES_V1 = 8192;
const paths = new Map([
  ['/api/student/auth/challenge', 'POST'],
  ['/api/student/auth/activate', 'POST'],
  ['/api/student/auth/login', 'POST'],
  ['/api/student/auth/logout', 'POST'],
  ['/api/student/session', 'GET'],
  ['/api/student/me', 'GET'],
]);
export function portalFailureV1(state: FailureV1['state']): FailureV1 {
  return { contractVersion: 1, requestId: crypto.randomUUID(), state };
}
export function portalJsonV1(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
}
function failure(state: FailureV1['state']): Response {
  return portalJsonV1(portalFailureV1(state), ERROR_HTTP_V1[state]);
}
function securityQueryAllowedV1(url: URL): boolean {
  if (!url.search) return true;
  if (url.pathname === '/api/student/frequency') {
    const entries = [...url.searchParams];
    return entries.length === 1 && entries[0]?.[0] === 'month'
      && /^2026-(0[1-9]|1[0-2])$/u.test(entries[0]?.[1] ?? '');
  }
  // This is only a freshness selector. The photo handler still authorizes the
  // session and binds the read to its own account; it never accepts a student ID.
  if (url.pathname === STUDENT_PHOTO_CONTENT_PATH_V1) {
    const entries = [...url.searchParams];
    return entries.length === 1 && entries[0]?.[0] === 'v'
      && photoRevisionV1.safeParse(entries[0]?.[1]).success;
  }
  const account = url.searchParams.get('accountId');
  if (!account || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(account)
    || url.searchParams.getAll('accountId').length !== 1) return false;
  const connection = url.searchParams.get('connectionId');
  if (connection !== null && (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(connection)
    || url.searchParams.getAll('connectionId').length !== 1)) return false;
  const keys = [...url.searchParams.keys()].filter(key => key !== 'connectionId');
  if (url.pathname === '/api/student/session') return keys.length === 1;
  return url.pathname === '/api/student/live' && keys.length === 2
    && url.searchParams.getAll('purpose').length === 1 && url.searchParams.get('purpose') === 'security';
}
export function portalRequestOriginAllowedV1(
  request: Request,
  environment: string,
  origin: string,
): boolean {
  const url = new URL(request.url);
  if (environment === 'production' && origin !== 'https://aluno.escolaieda.com') return false;
  if (environment === 'preview') return false; // No preview credentials or data before isolated provisioning.
  if (environment !== 'local' && environment !== 'production') return false;
  if (environment === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return false;
  if (url.origin !== origin || url.username || url.password || !securityQueryAllowedV1(url) || url.hash) return false;
  const host = request.headers.get('host');
  if (host !== null && host.toLowerCase() !== url.host.toLowerCase()) return false;
  if (request.headers.has('x-forwarded-host') || request.headers.has('x-original-url'))
    return false;
  const source = request.headers.get('origin');
  if (source !== null && source !== origin) return false;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}
/**
 * Opening the Portal page itself (`/` or `/access`; the edge accepts only GET/HEAD there) is a plain top-level navigation
 * with no side effects: students arrive from links in other sites and apps (Instagram, WhatsApp,
 * Google, the school site), which send `Sec-Fetch-Site: cross-site` and often add tracking
 * parameters such as `?fbclid=`. Those must open the page. The same host/forwarding checks still
 * apply, and framing stays refused (clickjacking). API routes keep portalRequestOriginAllowedV1.
 */
export function portalDocumentNavigationAllowedV1(
  request: Request,
  environment: string,
  origin: string,
): boolean {
  const url = new URL(request.url);
  if (url.pathname !== '/' && url.pathname !== '/access') return false;
  if (environment === 'production' && origin !== 'https://aluno.escolaieda.com') return false;
  if (environment !== 'local' && environment !== 'production') return false;
  if (environment === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return false;
  if (url.origin !== origin || url.username || url.password) return false;
  const host = request.headers.get('host');
  if (host !== null && host.toLowerCase() !== url.host.toLowerCase()) return false;
  if (request.headers.has('x-forwarded-host') || request.headers.has('x-original-url'))
    return false;
  const source = request.headers.get('origin');
  if (source !== null && source !== origin) return false;
  const destination = request.headers.get('sec-fetch-dest');
  return destination === null || destination === 'document';
}
async function bodyWithinLimit(request: Request): Promise<boolean> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > PORTAL_AUTH_BODY_BYTES_V1))
    return false;
  if (!request.body) return true;
  const reader = request.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return true;
      bytes += chunk.value.byteLength;
      if (bytes > PORTAL_AUTH_BODY_BYTES_V1) {
        await reader.cancel();
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Foundation only: liveness is available; every business route remains fail-closed. */
export async function servePortalFoundationV1(
  request: Request,
  environment: string,
  origin: string,
): Promise<Response> {
  if (!portalRequestOriginAllowedV1(request, environment, origin)) return failure('forbidden');
  const path = new URL(request.url).pathname;
  if (path === '/healthz' && request.method === 'GET')
    return portalJsonV1({ contractVersion: 1, state: 'ok' }, 200);
  const method = paths.get(path);
  if (!method) return portalJsonV1({ contractVersion: 1, state: 'unavailable' }, 404);
  if (request.method !== method) return failure('invalid-request');
  if (method === 'POST') {
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      return failure('invalid-request');
    try {
      if (!(await bodyWithinLimit(request))) return failure('body-too-large');
    } catch {
      return failure('invalid-request');
    }
  }
  return failure('unavailable');
}
