import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
const tenant = '10950000-0000-4000-8000-000000000001';
let runtime: Miniflare;
beforeAll(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'portal',
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal/index.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          bindings: { ...config.env.production.vars, PORTAL_ADMIN_TENANT_ID: tenant },
        },
        {
          name: 'caller',
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: {
            SELF: { name: 'portal', entrypoint: 'PortalSelfEntrypoint' },
            ADMIN: { name: 'portal', entrypoint: 'PortalAdminEntrypoint' },
            DEFAULT: 'portal',
          },
          script: `export default { async fetch(request,env) {
        const input=await request.json();
        try { return Response.json(await env[input.binding].monitoringCapacity(input.context)); }
        catch { return new Response(null,{status:403}); }
      } }`,
        },
      ],
    }),
  );
  await runtime.ready;
});
afterAll(async () => runtime?.dispose());
const authority = () => ({
  actorId: '10950000-0000-4000-8000-000000000002',
  tenantId: tenant,
  requestId: crypto.randomUUID(),
  authenticatedAt: new Date().toISOString(),
  capability: 'platform.settings.read',
});
it('exposes capacity only on named ADM RPC and checks authority before missing database configuration', async () => {
  const caller = await runtime.getWorker('caller');
  const invoke = (binding: string, context: unknown) =>
    caller.fetch('http://caller/', { method: 'POST', body: JSON.stringify({ binding, context }) });
  for (const binding of ['SELF', 'DEFAULT'])
    expect((await invoke(binding, authority())).status).toBe(403);
  for (const bad of [{}, { ...authority(), tenantId: crypto.randomUUID() }])
    expect((await invoke('ADMIN', bad)).status).toBe(403);
  const allowed = await invoke('ADMIN', authority());
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({
    version: 1,
    source: 'postgresql',
    state: 'unconfigured',
    metrics: null,
  });
});
