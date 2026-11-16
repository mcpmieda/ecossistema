import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
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
          bindings: config.env.production.vars,
          durableObjects: { PORTAL_LIVE: { className: 'PortalLiveUpdatesV1', useSQLite: true } },
        },
        {
          name: 'caller',
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: {
            SELF: { name: 'portal', entrypoint: 'PortalSelfEntrypoint' },
            ADMIN: { name: 'portal', entrypoint: 'PortalAdminEntrypoint' },
          },
          durableObjects: {
            LIVE: { className: 'PortalLiveUpdatesV1', scriptName: 'portal', useSQLite: true },
          },
          script: `export default { async fetch(request,env) {
        const path=new URL(request.url).pathname;
        const stub=env.LIVE.get(env.LIVE.idFromName('admin:2026'));
        if(path==='/record') return Response.json(await stub.recordOperationalSignal(await request.json()));
        if(path==='/read') return Response.json(await stub.operationalSignals());
        if(path==='/public') { try { await env.SELF.monitoringSignals({},null); return new Response(null,{status:500}); } catch { return new Response(null,{status:403}); } }
        if(path==='/denied') { try { await env.ADMIN.monitoringSignals({},null); return new Response(null,{status:500}); } catch { return new Response(null,{status:403}); } }
        return new Response(null,{status:404});
      } }`,
        },
      ],
    }),
  );
  await runtime.ready;
});
afterAll(async () => runtime?.dispose());
it('executes the real SQLite-backed accumulator without exposing a read RPC on the student capability', async () => {
  const caller = await runtime.getWorker('caller');
  const record = await caller.fetch('http://caller/record', {
    method: 'POST',
    body: JSON.stringify({ source: 'login', outcome: 'ok', elapsedMs: 12 }),
  });
  expect(await record.json()).toBe(true);
  const invalid = await caller.fetch('http://caller/record', {
    method: 'POST',
    body: JSON.stringify({ source: 'login', outcome: 'ok', elapsedMs: 12, private: 'synthetic' }),
  });
  expect(await invalid.json()).toBe(false);
  const data = (await (await caller.fetch('http://caller/read')).json()) as { points: unknown[] };
  expect(data.points).toHaveLength(1);
  expect(data.points[0]).toMatchObject({ source: 'login', samples: 1 });
  expect((await caller.fetch('http://caller/public')).status).toBe(403);
  expect((await caller.fetch('http://caller/denied')).status).toBe(403);
});
