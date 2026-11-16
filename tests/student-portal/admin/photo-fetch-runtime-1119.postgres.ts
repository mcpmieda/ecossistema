import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Runs in the existing serial native runtime gate. No PostgreSQL or tenant access.
// This specifically verifies the review claim about RequestInit.credentials;
// complete SharePoint protocol tests remain separate and synthetic.
let runtime: Miniflare;
let worker: Awaited<ReturnType<Miniflare['getWorker']>>;
const observations: {
  method: string;
  authorization: string | null;
  cookie: string | null;
  referrer: string | null;
}[] = [];

beforeAll(async () => {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: 'photo-fetch-compatibility',
          modules: true,
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          script: `export default { async fetch(request) {
        const input = await request.json();
        const headers = input.method === 'PUT'
          ? { 'Content-Type': 'image/webp', 'Content-Length': '4', 'Content-Range': 'bytes 0-3/4' }
          : { Accept: 'image/webp, application/octet-stream' };
        const init = { method: input.method, headers, redirect: 'manual', signal: request.signal,
          ...(input.method === 'PUT' ? { body: new Uint8Array([1, 2, 3, 4]).buffer } : {}),
          ...(input.credentials ? { credentials: 'omit' } : {}) };
        try {
          const result = await fetch('https://synthetic.sharepoint.com/private-transfer', init);
          await result.body?.cancel();
          return Response.json({ status: result.status });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      } }`,
          outboundService: (request) => {
            expect(new URL(request.url).hostname).toBe('synthetic.sharepoint.com');
            observations.push({
              method: request.method,
              authorization: request.headers.get('Authorization'),
              cookie: request.headers.get('Cookie'),
              referrer: request.headers.get('Referer'),
            });
            return new Response(null, { status: 201 });
          },
        },
      ],
    }),
  );
  worker = await runtime.getWorker('photo-fetch-compatibility');
});
afterAll(async () => {
  await runtime?.dispose();
});

it.each(['GET', 'PUT'])(
  'supports the photo %s initializer in pinned Workerd without forwarding ambient authority',
  async (method) => {
    for (const credentials of [false, true]) {
      const before = observations.length;
      const response = await worker.fetch('http://photo-fetch.test/', {
        method: 'POST',
        body: JSON.stringify({ method, credentials }),
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result).toEqual({ status: 201 });
      expect(observations.slice(before)).toEqual([
        { method, authorization: null, cookie: null, referrer: null },
      ]);
    }
  },
);
