import {
  portalFailureV1,
  portalJsonV1,
  portalDocumentNavigationAllowedV1,
  portalRequestOriginAllowedV1,
} from '../../../server/student-portal/runtime/http-v1';
import {
  emitPortalEdgeResultMetricV1,
  type PortalEdgeResultMetricV1,
} from '../../../server/student-portal/observability/metrics-v1';
import { FRONTEND_DIAGNOSTIC_ROUTE_V1 } from '../../../shared/frontend-diagnostic-v1';

interface PortalEdgeEnv {
  PORTAL_ENVIRONMENT: string;
  PORTAL_ORIGIN: string;
  PORTAL_SELF?: Fetcher;
  ASSETS?: Fetcher;
}

type EdgeResultV1 = PortalEdgeResultMetricV1['result'];
// Every extension Vite emits for the Portal must be listed here (cover art and logo are WebP).
const ASSET_PATH_V1 = /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|svg|webp)$/u;
const ICON_PROBES_V1 = new Set(['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']);

/** Fixed route family only; the pathname itself never reaches logs (#1207 L-05). */
function edgeFamilyV1(pathname: string): PortalEdgeResultMetricV1['family'] {
  if (pathname === '/' || pathname === '/access') return 'document';
  if (ASSET_PATH_V1.test(pathname)) return 'asset';
  if (ICON_PROBES_V1.has(pathname)) return 'icon-probe';
  if (pathname === '/healthz') return 'health';
  if (pathname === FRONTEND_DIAGNOSTIC_ROUTE_V1) return 'diagnostic';
  if (pathname.startsWith('/api/student/')) return 'api';
  return 'other';
}

export const onRequest: PagesFunction<PortalEdgeEnv> = async ({ request, env }) => {
  const family = edgeFamilyV1(new URL(request.url).pathname);
  const [response, result] = await routeEdgeV1(request, env);
  emitPortalEdgeResultMetricV1({ event: 'student-portal-edge-result-v1', family, result, status: response.status });
  return response;
};

async function routeEdgeV1(request: Request, env: PortalEdgeEnv): Promise<[Response, EdgeResultV1]> {
  const url = new URL(request.url);
  const page = request.method === 'GET' || request.method === 'HEAD';
  // A trailing slash (a link typed or shared as /access/) opens the access page; the hash stays.
  if (url.pathname === '/access/' && page)
    return [new Response(null, { status: 308, headers: { Location: '/access' + url.search } }), 'redirected'];
  const document = url.pathname === '/' || url.pathname === '/access';
  // A wrong address opened in the browser gets the app's "Página não encontrada", not raw JSON.
  const notFoundPage = !document && request.method === 'GET'
    && request.headers.get('sec-fetch-dest') === 'document' && edgeFamilyV1(url.pathname) === 'other';
  // The page itself opens from links in other sites/apps; everything else keeps the strict check.
  const allowed = document || notFoundPage
    ? portalDocumentNavigationAllowedV1(request, env.PORTAL_ENVIRONMENT, env.PORTAL_ORIGIN, notFoundPage)
    : portalRequestOriginAllowedV1(request, env.PORTAL_ENVIRONMENT, env.PORTAL_ORIGIN);
  if (!allowed) return [portalJsonV1(portalFailureV1('forbidden'), 403), 'origin-rejected'];
  if (notFoundPage) {
    const [response, result] = await serveStaticV1(request, env, url, true);
    if (result !== 'served') return [response, result];
    return [new Response(response.body, { status: 404, headers: response.headers }), 'route-miss'];
  }
  if (document || ASSET_PATH_V1.test(url.pathname)) return serveStaticV1(request, env, url, document);
  return forwardToSelfV1(request, env, url.pathname);
}

/** The page and its hashed assets, served from ASSETS with the Portal's security headers. */
async function serveStaticV1(
  request: Request,
  env: PortalEdgeEnv,
  url: URL,
  document: boolean,
): Promise<[Response, EdgeResultV1]> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return [portalJsonV1(portalFailureV1('invalid-request'), 400), 'method-rejected'];
  if (!env.ASSETS) return [portalJsonV1(portalFailureV1('unavailable'), 503), 'binding-missing'];
  try {
    if (document) {
      url.pathname = '/';
      url.search = ''; // tracking parameters never reach the static asset lookup
    }
    const upstream = await env.ASSETS.fetch(new Request(url, { method: request.method }));
    if (upstream.status !== 200 || (!document && upstream.headers.get('Content-Type')?.includes('text/html')))
      return [portalJsonV1(portalFailureV1('unavailable'), 404), document ? 'document-miss' : 'asset-miss'];
    const response = new Response(upstream.body, upstream);
    // style-src allows only React Aria's pressable rule by hash (see react-aria-style-csp test).
    response.headers.set('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; font-src 'self'; worker-src 'self' blob:");
    response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    response.headers.set('Cache-Control', document ? 'no-store' : 'public, max-age=31536000, immutable');
    return [response, 'served'];
  } catch { return [portalJsonV1(portalFailureV1('unavailable'), 503), 'upstream-error']; }
}

/** Health, diagnostics and the student API go to the self service untouched. */
async function forwardToSelfV1(
  request: Request,
  env: PortalEdgeEnv,
  pathname: string,
): Promise<[Response, EdgeResultV1]> {
  if (pathname !== '/healthz' && pathname !== FRONTEND_DIAGNOSTIC_ROUTE_V1 && !pathname.startsWith('/api/student/'))
    return [portalJsonV1(portalFailureV1('unavailable'), 404), 'route-miss'];
  if (!env.PORTAL_SELF) return [portalJsonV1(portalFailureV1('unavailable'), 503), 'binding-missing'];
  try {
    // Forward the original URL, headers, cookies and stream; never rewrite to the official host.
    return [await env.PORTAL_SELF.fetch(request), 'forwarded'];
  } catch { return [portalJsonV1(portalFailureV1('unavailable'), 503), 'upstream-error']; }
}
