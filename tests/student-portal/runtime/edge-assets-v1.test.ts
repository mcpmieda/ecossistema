// @vitest-environment node
import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../../workers/student-portal/edge/[[path]]';

const ORIGIN = 'https://aluno.escolaieda.com';

async function serve(pathname: string) {
  const env = {
    PORTAL_ENVIRONMENT: 'production',
    PORTAL_ORIGIN: ORIGIN,
    ASSETS: {
      fetch: async () =>
        new Response('bytes', { status: 200, headers: { 'Content-Type': 'image/webp' } }),
    },
  };
  const context = { request: new Request(ORIGIN + pathname), env } as unknown as Parameters<
    typeof onRequest
  >[0];
  return onRequest(context);
}

describe('student portal edge assets', () => {
  it('serves every image the Portal bundles (regression: WebP cover and logo returned 404)', async () => {
    const images = readdirSync('src/student-portal/assets').filter((name) =>
      /\.[a-z0-9]+$/u.test(name),
    );
    expect(images.length).toBeGreaterThan(0);
    for (const name of images) {
      const extension = name.split('.').at(-1);
      const response = await serve(`/assets/${name.replace(/\.[^.]+$/u, '')}-Ab12_cd.${extension}`);
      expect(response.status, name).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('immutable');
    }
  });

  it('still refuses unknown asset types', async () => {
    expect((await serve('/assets/payload-Ab12.exe')).status).toBe(404);
  });
});

describe('student portal edge result signal (#1207 L-05)', () => {
  type Env = Record<string, unknown>;
  const base: Env = { PORTAL_ENVIRONMENT: 'production', PORTAL_ORIGIN: ORIGIN };
  async function observe(pathname: string, env: Env, init: RequestInit = {}) {
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((value: unknown) => {
      logged.push(value);
    });
    try {
      const context = {
        request: new Request(ORIGIN + pathname, init),
        env,
      } as unknown as Parameters<typeof onRequest>[0];
      const response = await onRequest(context);
      return { response, logged };
    } finally {
      spy.mockRestore();
    }
  }
  const assets = (status = 200, type = 'image/webp') => ({
    fetch: async () => new Response('bytes', { status, headers: { 'Content-Type': type } }),
  });

  it.each([
    ['/assets/logo-Ab12.webp', { ...base, ASSETS: assets() }, {}, 'asset', 'served', 200],
    ['/', { ...base, ASSETS: assets(200, 'text/html') }, {}, 'document', 'served', 200],
    ['/assets/logo-Ab12.webp', { ...base, ASSETS: assets(404) }, {}, 'asset', 'asset-miss', 404],
    [
      '/assets/app-Ab12.js',
      { ...base, ASSETS: assets(200, 'text/html') },
      {},
      'asset',
      'asset-miss',
      404,
    ],
    [
      '/access',
      { ...base, ASSETS: assets(404, 'text/html') },
      {},
      'document',
      'document-miss',
      404,
    ],
    ['/assets/logo-Ab12.webp', base, {}, 'asset', 'binding-missing', 503],
    [
      '/assets/logo-Ab12.webp',
      { ...base, ASSETS: assets() },
      { method: 'POST' },
      'asset',
      'method-rejected',
      400,
    ],
    [
      '/assets/logo-Ab12.webp',
      { ...base, ASSETS: assets() },
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
      'asset',
      'origin-rejected',
      403,
    ],
    [
      '/api/student/unknown',
      { ...base, ASSETS: assets() },
      { headers: { Origin: 'https://example.invalid' } },
      'api',
      'origin-rejected',
      403,
    ],
    ['/apple-touch-icon-precomposed.png', base, {}, 'icon-probe', 'route-miss', 404],
    ['/favicon.ico', base, {}, 'icon-probe', 'route-miss', 404],
    ['/robots.txt', base, {}, 'other', 'route-miss', 404],
    ['/healthz', base, {}, 'health', 'binding-missing', 503],
    [
      '/api/student/me',
      {
        ...base,
        PORTAL_SELF: {
          fetch: async () => {
            throw new Error('SYNTHETIC_SECRET');
          },
        },
      },
      {},
      'api',
      'upstream-error',
      503,
    ],
    [
      '/assets/logo-Ab12.webp',
      {
        ...base,
        ASSETS: {
          fetch: async () => {
            throw new Error('SYNTHETIC_SECRET');
          },
        },
      },
      {},
      'asset',
      'upstream-error',
      503,
    ],
  ] as const)('%s → %s/%s', async (pathname, env, init, family, result, status) => {
    const { response, logged } = await observe(pathname, env, init);
    expect(response.status).toBe(status);
    expect(logged).toEqual([{ event: 'student-portal-edge-result-v1', family, result, status }]);
    expect(JSON.stringify(logged)).not.toContain(pathname === '/' ? '"/"' : pathname);
    expect(JSON.stringify(logged)).not.toContain('SYNTHETIC');
  });

  it('forwards the service response untouched and records its real status', async () => {
    const upstream = new Response('{"state":"unauthenticated"}', {
      status: 401,
      headers: { 'Cache-Control': 'private, no-store' },
    });
    const { response, logged } = await observe('/api/student/me', {
      ...base,
      PORTAL_SELF: { fetch: async () => upstream },
    });
    expect(response).toBe(upstream);
    expect(response.bodyUsed).toBe(false);
    expect(logged).toEqual([
      { event: 'student-portal-edge-result-v1', family: 'api', result: 'forwarded', status: 401 },
    ]);
  });

  it('returns a WebSocket upgrade and a streamed body as the same objects, unread', async () => {
    const upgrade = { status: 101, webSocket: {} } as unknown as Response;
    const ws = await observe('/api/student/live', {
      ...base,
      PORTAL_SELF: { fetch: async () => upgrade },
    });
    expect(ws.response).toBe(upgrade);
    expect(ws.logged).toEqual([
      { event: 'student-portal-edge-result-v1', family: 'api', result: 'forwarded', status: 101 },
    ]);
    let pulled = false;
    const body = new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const streamed = new Response(body, { status: 200 });
    const stream = await observe('/api/student/me', {
      ...base,
      PORTAL_SELF: { fetch: async () => streamed },
    });
    expect(stream.response).toBe(streamed);
    expect(stream.response.bodyUsed).toBe(false);
    expect(pulled).toBe(false);
  });

  it('keeps the response and its headers when logging fails', async () => {
    const env = { ...base, ASSETS: assets() };
    const quiet = await observe('/assets/logo-Ab12.webp', env);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('sink-unavailable');
    });
    try {
      const context = {
        request: new Request(ORIGIN + '/assets/logo-Ab12.webp'),
        env,
      } as unknown as Parameters<typeof onRequest>[0];
      const response = await onRequest(context);
      expect(response.status).toBe(200);
      expect([...response.headers]).toEqual([...quiet.response.headers]);
    } finally {
      spy.mockRestore();
    }
  });
});
