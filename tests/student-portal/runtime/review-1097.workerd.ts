import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
const tenant = '10970000-0000-4000-8000-000000000002';
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
          script: `export default { async fetch(request,env) { const input=await request.json();
        try { return Response.json(await env[input.binding].monitoringReview(input.context)); }
        catch { return new Response(null,{status:403}); } } }`,
        },
      ],
    }),
  );
  await runtime.ready;
});
afterAll(async () => runtime?.dispose());
const context = () => ({
  actorId: '10970000-0000-4000-8000-000000000001',
  tenantId: tenant,
  requestId: crypto.randomUUID(),
  authenticatedAt: new Date().toISOString(),
  capability: 'platform.settings.read',
});
it('keeps the summary absent on self/default and checks ADM authority before reporting missing storage', async () => {
  const caller = await runtime.getWorker('caller');
  const call = (binding: string, authority: unknown) =>
    caller.fetch('http://caller/', {
      method: 'POST',
      body: JSON.stringify({ binding, context: authority }),
    });
  for (const binding of ['SELF', 'DEFAULT'])
    expect((await call(binding, context())).status).toBe(403);
  expect((await call('ADMIN', {})).status).toBe(403);
  const good = await call('ADMIN', context());
  expect(good.status).toBe(200);
  expect(await good.json()).toMatchObject({
    state: 'unconfigured',
    coverage: 'partial',
    hours: [],
    operations: [],
  });
});
