import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { seal } from '../../../server/auth/sealed';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { testEnv } from '../../fixtures';

// Compile real Pages middleware + representative real handlers; no photo codec or database fixture.
const directory = resolve('node_modules/.cache/admin-rate-limit-pages-1249');
const limitedActor = '11111111-1111-4111-8111-111111111111';
const allowedActor = '33333333-3333-4333-8333-333333333333';
let runtime: Miniflare;
let caller: Awaited<ReturnType<Miniflare['getWorker']>>;
function fixture(path: string, target: string, instrument = false) {
  const filename = resolve(directory, 'functions', path);
  const source = relative(dirname(filename), resolve(target)).replaceAll('\\', '/').replace(/\.ts$/u, '');
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(
    filename,
    instrument
      ? `import {onRequest as original} from '${source}';
    let decrypts=0;const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);
    crypto.subtle.decrypt=(...args)=>{decrypts++;return decrypt(...args)};
    export const onRequest=async context=>{const response=await original(context);
      response.headers.set('X-Synthetic-Decrypt-Count',String(decrypts));return response;};`
      : `export {onRequest} from '${source}';`,
  );
}
beforeAll(async () => {
  fixture('_middleware.ts', 'functions/_middleware.ts', true);
  fixture('api/me.ts', 'functions/[[path]].ts');
  fixture('api/gradebook/import-persistence.ts', 'functions/api/gradebook/import-persistence.ts');
  fixture('auth/logout.ts', 'functions/[[path]].ts');
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'pages',
      'functions',
      'build',
      resolve(directory, 'functions'),
      '--outdir',
      resolve(directory, 'built'),
      '--compatibility-date',
      '2026-08-24',
      '--compatibility-flags',
      'nodejs_compat',
    ],
    {
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        XDG_CONFIG_HOME: directory,
        WRANGLER_LOG_PATH: resolve(directory, 'logs'),
      },
      stdio: 'pipe',
      timeout: 25000,
    },
  );
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'pages',
          modules: true,
          scriptPath: resolve(directory, 'built/index.js'),
          compatibilityDate: '2026-08-24',
          compatibilityFlags: ['nodejs_compat'],
          bindings: testEnv,
          serviceBindings: { PORTAL_SERVICE: { name: 'limiter', entrypoint: 'Limiter' } },
        },
        {
          name: 'caller',
          modules: true,
          compatibilityDate: '2026-08-24',
          serviceBindings: { PAGES: 'pages' },
          script: `export default {async fetch(request,env){const {url,init}=await request.json();return env.PAGES.fetch(new Request(url,init));}}`,
        },
        {
          name: 'limiter',
          modules: true,
          compatibilityDate: '2026-08-24',
          script: `import {WorkerEntrypoint} from 'cloudflare:workers'; export class Limiter extends WorkerEntrypoint {
        async limitOperation(context,operation){if(context.actorId==='${limitedActor}')return {contractVersion:1,state:'rate-limited',requestId:context.requestId,retryAfterSeconds:60};return null;}}
        export default {fetch(){return new Response(null,{status:404})}}`,
        },
      ],
    }),
  );
  await runtime.ready;
  caller = await runtime.getWorker('caller');
});
afterAll(async () => {
  await runtime?.dispose();
});
async function cookie(actor: string) {
  return `${SESSION_COOKIE}=${await seal(
    {
      oid: actor,
      name: 'Synthetic',
      roles: ['ADMINISTRADOR'],
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    testEnv.SESSION_SECRET,
  )}`;
}
function fetchPages(path: string, init: RequestInit = {}) {
  return caller.fetch('http://synthetic.invalid/', {
    method: 'POST',
    redirect: 'manual',
    body: JSON.stringify({ url: testEnv.OFFICIAL_ORIGIN + path, init }),
  });
}
it('runs before the real import handler/provider, rejects fake identity and keeps cookie-only logout independent', async () => {
  const headers = {
    cookie: await cookie(limitedActor),
    origin: testEnv.OFFICIAL_ORIGIN,
    'Content-Type': 'application/json',
  };
  const blocked = await fetchPages('/api/gradebook/import-persistence', {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('Retry-After')).toBe('60');
  expect(await blocked.json()).toEqual({ transportVersion: 9, state: 'unavailable' });
  const invalid = await fetchPages('/api/gradebook/import-persistence', {
    method: 'POST',
    headers: { ...headers, cookie: `${SESSION_COOKIE}=!invalid` },
    body: '{}',
  });
  expect(invalid.status).toBe(401);
  expect(
    (await fetchPages('/api/me', { headers: { 'x-admin-actor-id': allowedActor } })).status,
  ).toBe(401);
  const logout = await fetchPages('/auth/logout', { method: 'POST', headers, redirect: 'manual' });
  expect(logout.status).toBe(303);
  expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
});
it('verifies one seal despite Pages clones and isolates simultaneous identities and later requests', async () => {
  const before = await fetchPages('/api/me');
  const initial = Number(before.headers.get('X-Synthetic-Decrypt-Count'));
  const identities = [allowedActor, '44444444-4444-4444-8444-444444444444'];
  const cookies = await Promise.all(identities.map(cookie));
  const results = await Promise.all(
    cookies.map((value) => fetchPages('/api/me', { headers: { cookie: value } })),
  );
  const total = Math.max(
    ...results.map((response) => Number(response.headers.get('X-Synthetic-Decrypt-Count'))),
  );
  expect(total - initial).toBe(2);
  for (const [index, response] of results.entries()) {
    expect(response.status).toBe(200);
    expect(((await response.json()) as { identityKey: string }).identityKey).toContain(
      identities[index],
    );
  }
  const later = await fetchPages('/api/me', { headers: { cookie: cookies[0]! } });
  expect(later.status).toBe(200);
  expect(Number(later.headers.get('X-Synthetic-Decrypt-Count')) - total).toBe(1);
});
