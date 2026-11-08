import { type FailureV1 } from '../../../shared/student-portal-contracts/core-v1';
import { STUDENT_PHOTO_CONTENT_PATH_V1, photoRevisionV1 } from '../../../shared/student-photos/portrait-v1';
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
function securityQueryAllowedV1(url: URL): boolean {
  if (!url.search) return true;
  if (url.pathname === '/api/student/frequency') {
    const entries = [...url.searchParams];
    // One month, or the whole year so far (PR 1317).
    return entries.length === 1 && ((entries[0]?.[0] === 'month'
      && /^2026-(0[1-9]|1[0-2])$/u.test(entries[0]?.[1] ?? '')) || (entries[0]?.[0] === 'year' && entries[0]?.[1] === '2026'));
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
