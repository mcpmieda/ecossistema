import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://aluno.escolaieda.com';
const tenant = 'f04e0fa3-b8dc-4f77-be3c-7dfda0635188';
const id = '11111111-1111-4111-8111-111111111111';
const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
let runtime: Miniflare;
// Construct incoming requests inside workerd: Miniflare's Node proxy overwrites Host with loopback.
async function workerForTest(name: string) {
  const caller = await runtime.getWorker('caller');
  return {
    fetch: (
      url: string,
      init: { method?: string; body?: string; headers?: Record<string, string> } = {},
    ) => {
      if (
        name === 'caller' &&
        ['/rpc', '/probe-self-admin', '/admin-http'].includes(new URL(url).pathname)
      )
        return caller.fetch(url, init);
      return caller.fetch('http://harness.invalid/dispatch', {
        method: 'POST',
        body: JSON.stringify({
          target:
            name === 'edge'
              ? 'EDGE'
              : name === 'edge-preview'
                ? 'EDGE_PREVIEW'
                : name === 'edge-echo'
                  ? 'EDGE_ECHO'
                  : name === 'caller'
                    ? 'SELF'
                    : name === 'portal'
                      ? 'DEFAULT'
                      : 'PREVIEW',
          url,
          init,
        }),
      });
    },
  };
}

beforeAll(async () => {
  for (const artifact of [
    'node_modules/.cache/student-portal-edge/_worker.js',
    'node_modules/.cache/student-portal/index.js',
  ]) {
    if (!existsSync(artifact))
      throw new Error(
        `student-portal-runtime-artifact-missing: ${artifact}; execute "npm run build:student-portal" before "npm run test:student-portal-runtime"`,
      );
  }
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        ...['edge', 'edge-preview', 'edge-echo'].map((name) => ({
          name,
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal-edge/_worker.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          bindings: name === 'edge-preview' ? config.env.preview.vars : config.env.production.vars,
          serviceBindings:
            name === 'edge-preview'
              ? undefined
              : {
                  PORTAL_SELF:
                    name === 'edge-echo'
                      ? 'echo'
                      : { name: 'portal', entrypoint: 'PortalSelfEntrypoint' },
                },
        })),
        {
          name: 'echo',
          modules: true,
          compatibilityDate: config.compatibility_date,
          script: `export default { async fetch(request) {
            return Response.json({url:request.url,cookie:request.headers.get('cookie'),origin:request.headers.get('origin'),body:await request.text()},
              {headers:[['Set-Cookie','synthetic_a=one; Secure; HttpOnly; SameSite=Strict'],['Set-Cookie','synthetic_b=two; Secure; HttpOnly; SameSite=Strict']]});
          } }`,
        },
        {
          name: 'portal',
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal/index.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          bindings: config.env.production.vars,
        },
        {
          name: 'preview',
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal/index.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          bindings: config.env.preview.vars,
        },
        {
          name: 'caller',
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: {
            EDGE: 'edge',
            EDGE_PREVIEW: 'edge-preview',
            EDGE_ECHO: 'edge-echo',
            DEFAULT: 'portal',
            PREVIEW: 'preview',
            SELF: { name: 'portal', entrypoint: 'PortalSelfEntrypoint' },
            ADMIN: { name: 'portal', entrypoint: 'PortalAdminEntrypoint' },
          },
          script: `export default { async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/dispatch') {
          const input = await request.json();
          const forwarded = new Request(input.url, { ...input.init, headers: {host:new URL(input.url).host, ...input.init.headers} });
          return env[input.target].fetch(forwarded);
        }
        if (url.pathname === '/probe-self-admin') {
          try { await env.SELF.query({}, {}); return new Response('exposed', {status:500}); }
          catch { return new Response('absent', {status:403}); }
        }
        if (url.pathname === '/rpc') {
          const body = await request.json();
          return Response.json(await env.ADMIN[body.method](body.context, body.request));
        }
        if (url.pathname === '/admin-http') return env.ADMIN.fetch(new Request('${origin}/healthz'));
        return env.SELF.fetch(request);
      } }`,
        },
      ],
    }),
  );
  await runtime.ready;
});
afterAll(async () => {
  await runtime?.dispose();
});

describe('bundled Worker foundation in actual workerd', () => {
  it('routes the bundled Pages edge only to the self entrypoint', async () => {
    const edge = await workerForTest('edge');
    expect((await edge.fetch(`${origin}/healthz`)).status).toBe(200);
    expect((await edge.fetch(`${origin}/api/student/session`)).status).toBe(401);
    expect(
      (
        await edge.fetch(`${origin}/api/student/session`, {
          headers: { cookie: '__Host-student_portal_session=' + 'a'.repeat(43) },
        })
      ).status,
    ).toBe(503);
    expect((await edge.fetch(`${origin}/api/student-portal/admin/query`)).status).toBe(404);
    expect((await edge.fetch('https://student-portal-edge.pages.dev/healthz')).status).toBe(403);
    expect(
      (await edge.fetch(`${origin}/healthz`, { headers: { host: 'evil.invalid' } })).status,
    ).toBe(403);
    const preview = await workerForTest('edge-preview');
    expect((await preview.fetch(`${origin}/healthz`)).status).toBe(403);
  });
  it('preserves original cookies, origin, body and separate Set-Cookie headers through Pages', async () => {
    const edge = await workerForTest('edge-echo');
    const url = `${origin}/api/student/auth/login`;
    const response = await edge.fetch(url, {
      method: 'POST',
      headers: { cookie: 'synthetic=request', origin, 'content-type': 'application/json' },
      body: '{"synthetic":true}',
    });
    expect(await response.json()).toEqual({
      url,
      cookie: 'synthetic=request',
      origin,
      body: '{"synthetic":true}',
    });
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(
      response.headers
        .getSetCookie()
        .every((cookie) => cookie.includes('Secure; HttpOnly; SameSite=Strict')),
    ).toBe(true);
  });
  it('reports liveness without database information or cookies through the self binding', async () => {
    const caller = await workerForTest('caller');
    const response = await caller.fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contractVersion: 1, state: 'ok' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it.each(['/api/student/me', '/api/student/session'])(
    'keeps %s unavailable with a plausible cookie when required dependencies are absent',
    async (path) => {
      const worker = await workerForTest('portal');
      const response = await worker.fetch(origin + path, {
        headers: { cookie: '__Host-student_portal_session=' + 'a'.repeat(43) },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ contractVersion: 1, state: 'unavailable' });
    },
  );
  it.each(['/api/student/me', '/api/student/session'])(
    'rejects absent or malformed session on %s before dependencies',
    async (path) => {
      const worker = await workerForTest('portal');
      for (const cookie of ['', 'synthetic=value', '__Host-student_portal_session=invalid']) {
        const response = await worker.fetch(origin + path, { headers: { cookie } });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          contractVersion: 1,
          state: 'unauthenticated',
        });
      }
    },
  );
  it.each([
    'https://student-portal.workers.dev',
    'https://preview.pages.dev',
    'https://admin.escolaieda.com',
    'http://aluno.escolaieda.com',
  ])('rejects alternate origin %s', async (host) => {
    const worker = await workerForTest('portal');
    expect((await worker.fetch(`${host}/healthz`)).status).toBe(403);
  });
  it.each<Record<string, string>>([
    { origin: 'https://evil.invalid' },
    { 'x-forwarded-host': 'aluno.escolaieda.com' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'evil.invalid' },
  ])('rejects forged/cross-site request %j', async (headers) => {
    const worker = await workerForTest('portal');
    expect((await worker.fetch(`${origin}/api/student/session`, { headers })).status).toBe(403);
  });
  it('never enables preview using a production URL', async () => {
    const preview = await workerForTest('preview');
    expect((await preview.fetch(`${origin}/healthz`)).status).toBe(403);
  });
  it('rejects credential query strings and unknown/admin routes', async () => {
    const worker = await workerForTest('portal');
    expect((await worker.fetch(`${origin}/api/student/me?token=synthetic`)).status).toBe(403);
    expect(
      (await worker.fetch(`${origin}/api/student-portal/admin/query`, { method: 'POST' })).status,
    ).toBe(404);
    const caller = await workerForTest('caller');
    expect((await caller.fetch(`${origin}/probe-self-admin`)).status).toBe(403);
    expect((await caller.fetch(`${origin}/admin-http`)).status).toBe(403);
  });
  it('bounds auth bodies and rejects malformed login before unavailable dependencies', async () => {
    const worker = await workerForTest('portal');
    const url = `${origin}/api/student/auth/login`;
    expect(
      (
        await worker.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'x'.repeat(8193),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await worker.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect((await worker.fetch(url, { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await worker.fetch(url)).status).toBe(400);
  });
  it('validates admin context on named RPC and never treats validation as authentication', async () => {
    const caller = await workerForTest('caller');
    const context = {
      actorId: id,
      tenantId: tenant,
      requestId: id,
      authenticatedAt: new Date().toISOString(),
      capability: 'platform.settings.read',
    };
    const query = {
      contractVersion: 1,
      operation: 'health',
      scope: { kind: 'school', academicYear: 2026 },
      page: { limit: 1 },
    };
    for (const [ctx, expected] of [
      [{}, 'forbidden'],
      [{ ...context, tenantId: id }, 'forbidden'],
      [context, 'unavailable'],
    ] as const) {
      const response = await caller.fetch(`${origin}/rpc`, {
        method: 'POST',
        body: JSON.stringify({ method: 'query', context: ctx, request: query }),
      });
      expect(await response.json()).toMatchObject({ state: expected });
    }
    const response = await caller.fetch(`${origin}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ method: 'command', context, request: {} }),
    });
    expect(await response.json()).toMatchObject({ state: 'forbidden' });
  });
});
