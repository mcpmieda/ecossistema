// @vitest-environment node
import { readFileSync } from 'node:fs';
import { parseConfigFileTextToJson } from 'typescript';
import { expect, it, vi } from 'vitest';
import { checkPublicDemoNameV1 } from '../../scripts/ci/public-demo-deploy-preflight-v1';

it('uses only the dedicated assets/state and a one-way private ADM binding', () => {
  const config = parseConfigFileTextToJson(
    'demo',
    readFileSync('wrangler.public-demo.jsonc', 'utf8'),
  ).config;
  const admin = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  expect(config.assets).toMatchObject({
    binding: 'ASSETS',
    run_worker_first: true,
    directory: 'node_modules/.cache/public-portal-demo',
    not_found_handling: 'none',
  });
  expect(config.services).toBeUndefined();
  expect(config.hyperdrive).toBeUndefined();
  expect(config.d1_databases).toBeUndefined();
  expect(config.kv_namespaces).toBeUndefined();
  expect(config.observability.enabled).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.workers_dev).toBe(true);
  expect(config.durable_objects.bindings).toEqual([
    { name: 'DEMO_STATE', class_name: 'DemoState' },
  ]);
  expect(
    admin.services.filter((s: { binding: string }) => s.binding === 'PUBLIC_DEMO_CONTROL'),
  ).toEqual([
    {
      binding: 'PUBLIC_DEMO_CONTROL',
      service: 'portal-aluno-demo-publica',
      entrypoint: 'DemoControl',
    },
  ]);
});
it('fails closed on an existing unrelated name or unreadable provider state, using GET only', async () => {
  const mock = vi.fn<typeof fetch>();
  const call = () => checkPublicDemoNameV1('a'.repeat(32), 'synthetic-token', mock);
  mock.mockResolvedValueOnce(Response.json({ success: true, result: [] }));
  await expect(call()).resolves.toBeUndefined();
  for (const status of [401, 403, 404, 500]) {
    mock.mockResolvedValueOnce(new Response(null, { status }));
    await expect(call()).rejects.toThrow();
  }
  const existing = () =>
    Response.json({ success: true, result: [{ id: 'portal-aluno-demo-publica' }] });
  mock
    .mockResolvedValueOnce(existing())
    .mockResolvedValueOnce(Response.json({ success: true, result: { bindings: [] } }));
  await expect(call()).rejects.toThrow('unrelated');
  const owner = {
    name: 'DEMO_DEPLOYMENT_OWNER',
    type: 'plain_text',
    text: 'mcpmieda/ecossistema-escola:public-demo-v1',
  };
  mock
    .mockResolvedValueOnce(existing())
    .mockResolvedValueOnce(
      Response.json({ success: true, result: { bindings: [owner, { name: 'PROD_DB' }] } }),
    );
  await expect(call()).rejects.toThrow('unrelated');
  mock.mockResolvedValueOnce(existing()).mockResolvedValueOnce(
    Response.json({
      success: true,
      result: { bindings: [owner, { name: 'ASSETS' }, { name: 'DEMO_STATE' }] },
    }),
  );
  await expect(call()).resolves.toBeUndefined();
  expect(
    mock.mock.calls.every(
      ([url, init]) =>
        /\/workers\/scripts(?:\/portal-aluno-demo-publica\/settings)?$/u.test(String(url)) &&
        init?.method === 'GET',
    ),
  ).toBe(true);
});
