import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { localPortalDatabaseV1 } from '../frontend-foundation/harness-v1';

export interface IntegrationRequestV1 {
  surface: 'admin' | 'student';
  path: string;
  method?: string;
  body?: string;
  cookie?: string;
  anonymous?: boolean;
  role?: 'ADMINISTRADOR' | 'PROFESSOR';
  origin?: string;
  hostname?: string;
  upgrade?: boolean;
}
export async function createIntegrationHarnessV1(databaseUrl: string) {
  const portalDatabase = localPortalDatabaseV1(databaseUrl);
  const gradebookDatabase = new URL(portalDatabase);
  gradebookDatabase.username = 'gradebook_app';
  const directory = resolve('node_modules/.cache/student-portal-integration');
  mkdirSync(directory, { recursive: true });
  await promisify(execFile)(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--config',
      'tests/student-portal/frontend-integration/wrangler.harness.jsonc',
      '--dry-run',
      '--outdir',
      directory,
    ],
    {
      windowsHide: true,
      timeout: 120_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'security-test-entry', modules: true,
          routes: ['security-integration.invalid/*'],
          compatibilityDate: config.compatibility_date,
          script: `export default { fetch(request, env) {
            const url = new URL(request.url);
            const headers = new Headers(request.headers);
            headers.set('host', 'aluno.escolaieda.com');
            headers.set('origin', 'https://aluno.escolaieda.com');
            return env.EDGE.fetch(new Request('https://aluno.escolaieda.com' + url.pathname + url.search, { headers }));
          } };`,
          serviceBindings: { EDGE: 'edge' },
        },
        {
          name: 'portal',
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal/index.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          hyperdrives: { PORTAL_DB: portalDatabase },
          durableObjects: { PORTAL_LIVE: { className: 'PortalLiveUpdatesV1', useSQLite: true } },
          bindings: {
            ...config.env.production.vars,
            PORTAL_SERVING_ENABLED: 'true',
            TURNSTILE_SECRET_KEY: 'synthetic-757-never-sent-externally',
            PORTAL_ADMIN_TENANT_ID: '22222222-2222-4222-8222-222222222222',
            PASSWORD_PEPPER: JSON.stringify({ 1: Buffer.alloc(32, 71).toString('base64') }),
            QR_HMAC_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 72).toString('base64') }),
          },
          ratelimits: { ...Object.fromEntries(config.env.production.ratelimits.filter((binding: { name: string }) => !['PORTAL_AUTH_GLOBAL', 'PORTAL_AUTH_SUBJECT'].includes(binding.name)).map((binding: { name: string; namespace_id: string; simple: { limit: number; period: 60 } }) => [binding.name, { namespace_id: binding.namespace_id, simple: binding.simple }])),
            PORTAL_AUTH_GLOBAL: { namespace_id: '100757', simple: { limit: 600, period: 60 } },
            PORTAL_AUTH_SUBJECT: { namespace_id: '200757', simple: { limit: 30, period: 60 } },
          },
          outboundService: async () => new Response(null, { status: 503 }),
        },
        {
          name: 'edge',
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal-edge/_worker.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          bindings: config.env.production.vars,
          assets: {
            directory: 'node_modules/.cache/student-portal-ui',
            binding: 'ASSETS',
            run_worker_first: true,
            routerConfig: { has_user_worker: true },
          },
          serviceBindings: { PORTAL_SELF: { name: 'portal', entrypoint: 'PortalSelfEntrypoint' } },
          outboundService: async () => new Response(null, { status: 503 }),
        },
        {
          name: 'caller',
          modules: [
            { type: 'ESModule', path: resolve(directory, 'admin-worker.js') },
            ...readdirSync(directory)
              .filter((name) => name.endsWith('.sql'))
              .map((name) => ({
                type: 'Text' as const,
                path: resolve(directory, name),
              })),
          ],
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          hyperdrives: { PROD_DB: gradebookDatabase.toString() },
          serviceBindings: {
            EDGE: 'edge',
            PORTAL_SERVICE: { name: 'portal', entrypoint: 'PortalAdminEntrypoint' },
          },
          outboundService: async () => new Response(null, { status: 503 }),
        },
      ],
    }),
  );
  try {
    const caller = await runtime.getWorker('caller');
    return {
      fetch: (input: IntegrationRequestV1) =>
        caller.fetch('http://integration.invalid/', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      connectStudentSecurity: (accountId: string, cookie: string, connectionId?: string) => runtime.dispatchFetch('http://security-integration.invalid/api/student/live?purpose=security&accountId=' + accountId + (connectionId ? '&connectionId=' + connectionId : ''), { headers: { Upgrade: 'websocket', origin: 'https://aluno.escolaieda.com', cookie } }),
      scheduled: async () => (await runtime.getWorker('portal')).scheduled({ cron: '* * * * *', scheduledTime: new Date(Math.floor(Date.now() / 600_000) * 600_000) }),
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
