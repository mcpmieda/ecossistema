import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPortalFrontendHarnessV1, localPortalDatabaseV1 } from './harness-v1';
let harness: Awaited<ReturnType<typeof createPortalFrontendHarnessV1>>;
const origin = 'https://aluno.escolaieda.com';
beforeAll(async () => {
  harness = await createPortalFrontendHarnessV1();
});
afterAll(async () => {
  await harness?.dispose();
});

it('serves real student HTML and hashed assets on root and access without exposing ADM', async () => {
  const response = await harness.fetch(origin);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('text/html');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const html = await response.text();
  expect(html).toContain('Portal do Aluno');
  const access = await harness.fetch(`${origin}/access`);
  expect(access.status).toBe(200);
  expect(await access.text()).toBe(html);
  const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)].map((m) => m[1]!);
  // Script, stylesheet, the crest favicon + home-screen icon (hashed PNGs), and the preloaded
  // library pieces kept apart from the Portal's own code (issue #1426, 39).
  expect(paths).toHaveLength(8);
  for (const piece of ['react-', 'ui-', 'zod-'])
    expect(paths.some((path) => path.startsWith(`/assets/${piece}`))).toBe(true);
  expect(paths.filter((path) => path.endsWith('.png'))).toHaveLength(2);
  for (const path of paths) {
    const asset = await harness.fetch(origin + path);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Cache-Control')).toContain('immutable');
    expect(asset.headers.get('Content-Type')).not.toContain('text/html');
    expect((await asset.text()).length).toBeGreaterThan(100);
  }
});

it('keeps document policy scoped, JSON closed, preview blocked and missing paths as 404', async () => {
  const document = await harness.fetch(origin);
  expect(document.headers.get('Permissions-Policy')).toContain('camera=(self)');
  expect(document.headers.get('Content-Security-Policy')).toContain(
    "script-src 'self' https://challenges.cloudflare.com",
  );
  expect(document.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
  const health = await harness.fetch(`${origin}/healthz`);
  expect(health.status).toBe(200);
  expect(health.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  for (const path of [
    '/unknown',
    '/api/student-portal/admin/query',
    '/assets/absent.js',
    '/_worker.js',
    '/wrangler.jsonc',
  ])
    expect((await harness.fetch(origin + path)).status, path).toBe(404);
  expect((await harness.fetch(origin, { method: 'POST' })).status).toBe(400);
  expect((await harness.fetch(origin, {}, true)).status).toBe(403);
  expect(
    (await harness.fetch(origin, { headers: { origin: 'https://invalid.example' } })).status,
  ).toBe(403);
});

it('refuses nonlocal PostgreSQL and forces the restricted role for optional composition', () => {
  for (const url of [
    'postgres://remote.invalid/portal705_test',
    'postgres://127.0.0.1/production',
    'https://127.0.0.1/portal705_test',
  ])
    expect(() => localPortalDatabaseV1(url)).toThrow('Disposable');
  const target = new URL(localPortalDatabaseV1('postgres://owner@127.0.0.1:5432/portal705_test'));
  expect(target.username).toBe('student_portal_app');
});

it('opens the page from links in other sites and apps, but never inside a frame', async () => {
  const plain = await (await harness.fetch(origin)).text();
  const fromLink = await harness.fetch(`${origin}/?fbclid=abc123&utm_source=whatsapp`, {
    headers: {
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    },
  });
  expect(fromLink.status).toBe(200);
  expect(await fromLink.text()).toBe(plain);
  const framed = await harness.fetch(origin, {
    headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' },
  });
  expect(framed.status).toBe(403);
  const api = await harness.fetch(`${origin}/api/student/me`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  expect(api.status).toBe(403);
});
