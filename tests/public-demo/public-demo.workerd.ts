import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseConfigFileTextToJson } from 'typescript';

const tenant = '11111111-1111-4111-8111-111111111111';
const parsed = parseConfigFileTextToJson(
  'wrangler.public-demo.jsonc',
  readFileSync('wrangler.public-demo.jsonc', 'utf8'),
);
if (parsed.error) throw new Error('Invalid public demo configuration');
const config = parsed.config;
let runtime: Miniflare;
let caller: Awaited<ReturnType<Miniflare['getWorker']>>;
const authority = (write = false) => ({
  actorId: tenant,
  tenantId: tenant,
  requestId: crypto.randomUUID(),
  authenticatedAt: new Date().toISOString(),
  capability: write ? 'platform.settings.write' : 'platform.settings.read',
});
const invoke = (method: string, input: Record<string, unknown> = {}) =>
  caller.fetch('http://test.invalid/', {
    method: 'POST',
    body: JSON.stringify({ method, authority: authority(), ...input }),
  });
const setEnabled = async (enabled: boolean) => {
  const state = (await (await invoke('getState')).json()) as { revision: number };
  return invoke('setEnabled', {
    authority: authority(true),
    command: { enabled, expectedRevision: state.revision },
  });
};
beforeAll(async () => {
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--config',
      'wrangler.public-demo.jsonc',
      '--dry-run',
      '--outdir',
      'node_modules/.cache/public-demo-worker',
    ],
    {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 90_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'demo',
          modules: true,
          scriptPath: 'node_modules/.cache/public-demo-worker/index.js',
          compatibilityDate: config.compatibility_date,
          bindings: { DEMO_ADMIN_TENANT_ID: tenant },
          durableObjects: { DEMO_STATE: { className: 'DemoState', useSQLite: true } },
          assets: {
            directory: config.assets.directory,
            binding: 'ASSETS',
            run_worker_first: config.assets.run_worker_first,
            routerConfig: { has_user_worker: true },
            assetConfig: {
              html_handling: config.assets.html_handling,
              not_found_handling: config.assets.not_found_handling,
            },
          },
          outboundService: async () => new Response(null, { status: 503 }),
        },
        {
          name: 'broken',
          modules: true,
          scriptPath: 'node_modules/.cache/public-demo-worker/index.js',
          compatibilityDate: config.compatibility_date,
          assets: {
            directory: config.assets.directory,
            binding: 'ASSETS',
            run_worker_first: true,
            routerConfig: { has_user_worker: true },
          },
          outboundService: async () => new Response(null, { status: 503 }),
        },
        {
          name: 'caller',
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: { CONTROL: { name: 'demo', entrypoint: 'DemoControl' }, PUBLIC: 'demo' },
          script:
            "export default {async fetch(request,env){const input=await request.json();try{return Response.json(await env[input.public?'PUBLIC':'CONTROL'][input.method](input.authority,input.command))}catch{return new Response(null,{status:403})}}}",
        },
      ],
    }),
  );
  await runtime.ready;
  caller = await runtime.getWorker('caller');
});
afterAll(async () => runtime?.dispose());

it('defaults closed before every path, asset, alias and HEAD, also without storage', async () => {
  expect(config.assets.run_worker_first).toBe(true);
  expect(config.preview_urls).toBe(false);
  expect(config.observability.enabled).toBe(false);
  expect(
    Object.keys(config).some((key) =>
      ['hyperdrive', 'services', 'kv_namespaces', 'd1_databases'].includes(key),
    ),
  ).toBe(false);
  for (const name of ['demo', 'broken']) {
    const worker = await runtime.getWorker(name);
    for (const path of [
      '/',
      '/index.html',
      '/portal-demo.html',
      '/anything',
      '/api/me',
      '/DemoControl',
      ...readdirSync(config.assets.directory + '/assets').map((file) => '/assets/' + file),
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await worker.fetch('https://demo.invalid' + path, { method });
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
  }
});
it('exposes only private authenticated control and enforces capability, tenant, freshness and CAS', async () => {
  for (const bad of [
    {},
    { ...authority(), tenantId: crypto.randomUUID() },
    { ...authority(), authenticatedAt: '2000-01-01T00:00:00.000Z' },
  ])
    expect((await invoke('getState', { authority: bad })).status).toBe(403);
  expect((await invoke('getState', { public: true })).status).toBe(403);
  for (const method of ['getAccesses', 'recordAccess'])
    expect((await invoke(method)).status).toBe(403);
  expect(
    (await invoke('setEnabled', { command: { enabled: true, expectedRevision: 0 } })).status,
  ).toBe(403);
  expect((await setEnabled(true)).status).toBe(200);
  expect(
    await (
      await invoke('setEnabled', {
        authority: authority(true),
        command: { enabled: false, expectedRevision: 0 },
      })
    ).json(),
  ).toMatchObject({ ok: false, state: { enabled: true } });
});
it('serves the real isolated package without visitor writes and blocks all saved URLs after disable', async () => {
  const worker = await runtime.getWorker('demo');
  await setEnabled(true);
  const before = await (await invoke('getState')).json();
  const html = await worker.fetch('https://demo.invalid/', {
    headers: { cookie: 'production=never-forward' },
  });
  expect(html.status).toBe(200);
  expect(await html.text()).toContain('Demonstração');
  expect(html.headers.get('cache-control')).toBe('no-store');
  expect(html.headers.get('set-cookie')).toBeNull();
  await worker.fetch('https://demo.invalid/', { method: 'HEAD' });
  for (const file of readdirSync(config.assets.directory + '/assets')) {
    const response = await worker.fetch('https://demo.invalid/assets/' + file);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(await (await invoke('getState')).json()).toEqual(before);
  for (const path of [
    '/api/me',
    '/api/attendance/v1',
    '/api/attendance/v1/',
    '/control',
    '/accesses',
    '/index',
    '/index.html/',
    '/assets/../control',
  ])
    expect((await worker.fetch('https://demo.invalid' + path)).status).toBe(404);
  await setEnabled(false);
  for (const path of [
    '/',
    '/index.html',
    ...readdirSync(config.assets.directory + '/assets').map((file) => '/assets/' + file),
  ])
    expect(
      (
        await worker.fetch('https://preview-alias.invalid' + path, {
          headers: { 'if-none-match': 'anything' },
        })
      ).status,
    ).toBe(503);
});
