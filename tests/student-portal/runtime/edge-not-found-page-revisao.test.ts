// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../../workers/student-portal/edge/[[path]]';

const ORIGIN = 'https://aluno.escolaieda.com';
const html = '<!doctype html><title>Portal</title>';

async function open(pathname: string, init: RequestInit = {}) {
  const seen: string[] = [];
  const env = {
    PORTAL_ENVIRONMENT: 'production',
    PORTAL_ORIGIN: ORIGIN,
    ASSETS: { fetch: async (request: Request) => {
      seen.push(new URL(request.url).pathname);
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
    } },
  };
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const context = { request: new Request(ORIGIN + pathname, init), env } as unknown as Parameters<typeof onRequest>[0];
  return { response: await onRequest(context), seen };
}
const navigation = (site = 'none') => ({ headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': site } });

afterEach(() => vi.restoreAllMocks());

describe('A21: a wrong address opens the app page "Página não encontrada"', () => {
  it.each(['/acesso', '/Access', '/aluno/notas'])('serves the app document with 404 for %s', async (pathname) => {
    const { response, seen } = await open(pathname, navigation());
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe(html);
    expect(seen).toEqual(['/']);
  });

  it('also works from a link in another app (cross-site navigation)', async () => {
    const { response } = await open('/acesso', navigation('cross-site'));
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('text/html');
  });

  it('sends /access/ to /access, keeping the query (the browser keeps the hash)', async () => {
    const { response } = await open('/access/?from=whatsapp', navigation('cross-site'));
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('/access?from=whatsapp');
  });

  it('keeps API, assets and non-navigation misses as before', async () => {
    expect((await open('/robots.txt')).response.headers.get('Content-Type')).toContain('application/json');
    expect((await open('/api/student/nada', navigation())).response.status).not.toBe(200);
    const asset = await open('/assets/nada-Ab12.js', navigation());
    expect(asset.response.headers.get('Content-Type')).toContain('application/json');
    const post = await open('/acesso', { method: 'POST', headers: { 'Sec-Fetch-Dest': 'document' } });
    expect(post.response.headers.get('Content-Type')).toContain('application/json');
  });
});
