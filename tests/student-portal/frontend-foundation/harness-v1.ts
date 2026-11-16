import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export function localPortalDatabaseV1(value: string): string {
  const target = new URL(value);
  if (
    target.protocol !== 'postgres:' ||
    target.hostname !== '127.0.0.1' ||
    target.pathname !== '/portal705_test' ||
    target.search ||
    target.hash
  )
    throw new Error('Disposable loopback portal705_test database required');
  target.username = 'student_portal_app';
  target.password = 'synthetic-local-trust-only';
  return target.toString();
}

/** Test-only workerd composition: real bundles/assets, optional restricted disposable PostgreSQL. */
export async function createPortalFrontendHarnessV1(databaseUrl?: string) {
  const database = databaseUrl === undefined ? undefined : localPortalDatabaseV1(databaseUrl);
  const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        ...['edge', 'preview'].map((name) => ({
          name,
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal-edge/_worker.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          bindings: name === 'preview' ? config.env.preview.vars : config.env.production.vars,
          assets: {
            directory: 'node_modules/.cache/student-portal-ui',
            binding: 'ASSETS',
            run_worker_first: true,
            routerConfig: { has_user_worker: true },
          },
          serviceBindings:
            name === 'preview'
              ? undefined
              : { PORTAL_SELF: { name: 'portal', entrypoint: 'PortalSelfEntrypoint' } },
          outboundService: async () => new Response(null, { status: 503 }),
        })),
        {
          name: 'portal',
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal/index.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          ...(database ? { hyperdrives: { PORTAL_DB: database } } : {}),
          bindings: {
            ...config.env.production.vars,
            PORTAL_ADMIN_TENANT_ID: '22222222-2222-4222-8222-222222222222',
            PORTAL_SERVING_ENABLED: 'true',
            PASSWORD_PEPPER: JSON.stringify({ 1: Buffer.alloc(32, 71).toString('base64') }),
            QR_HMAC_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 72).toString('base64') }),
          },
          ratelimits: {
            ...Object.fromEntries(
              config.env.production.ratelimits
                .filter(
                  (binding: { name: string }) =>
                    !['PORTAL_AUTH_GLOBAL', 'PORTAL_AUTH_SUBJECT'].includes(binding.name),
                )
                .map(
                  (binding: {
                    name: string;
                    namespace_id: string;
                    simple: { limit: number; period: 60 };
                  }) => [
                    binding.name,
                    { namespace_id: binding.namespace_id, simple: binding.simple },
                  ],
                ),
            ),
            PORTAL_AUTH_GLOBAL: { namespace_id: '100744', simple: { limit: 600, period: 60 } },
            PORTAL_AUTH_SUBJECT: { namespace_id: '200744', simple: { limit: 30, period: 60 } },
          },
          outboundService: async () => new Response(null, { status: 503 }),
        },
        {
          name: 'caller',
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: { EDGE: 'edge', PREVIEW: 'preview' },
          // Construct Host inside workerd: Node dispatch otherwise replaces it with loopback.
          script: `export default { async fetch(request, env) {
        const input = await request.json();
        const url = new URL(input.url);
        const forwarded = new Request(url, { ...input.init, headers: { host: url.host, ...input.init?.headers } });
        return env[input.preview ? 'PREVIEW' : 'EDGE'].fetch(forwarded);
      } }`,
        },
      ],
    }),
  );
  try {
    const caller = await runtime.getWorker('caller');
    return {
      runtime,
      fetch: (
        url: string,
        init: { method?: string; body?: string; headers?: Record<string, string> } = {},
        preview = false,
      ) =>
        caller.fetch('http://harness.invalid/', {
          method: 'POST',
          body: JSON.stringify({ url, init, preview }),
        }),
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
