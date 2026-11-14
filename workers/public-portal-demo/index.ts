import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import {
  publicDemoChangeSchemaV1,
  publicDemoStateSchemaV1,
  type PublicDemoStateV1,
} from '../../shared/public-demo-control-v1';

interface DemoEnv {
  ASSETS: Fetcher;
  DEMO_STATE: DurableObjectNamespace<DemoState>;
  DEMO_ADMIN_TENANT_ID: string;
}
const authoritySchema = z
  .object({
    actorId: z.uuid(),
    tenantId: z.uuid(),
    requestId: z.uuid(),
    authenticatedAt: z.iso.datetime({ offset: true }),
    capability: z.enum(['platform.settings.read', 'platform.settings.write']),
  })
  .strict();
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  for (const name of [
    'Set-Cookie',
    'ETag',
    'Last-Modified',
    'Expires',
    'Access-Control-Allow-Origin',
  ])
    headers.delete(name);
  return new Response(response.body, { status: response.status, headers });
}
const unavailable = () => secured(new Response('Demonstração indisponível.', { status: 503 }));
const stateOf = (env: DemoEnv) => env.DEMO_STATE.get(env.DEMO_STATE.idFromName('public-demo'));

/**
 * The gate's answer, kept 30 s per isolate (issue #1426, 23c): a visit asks for ~10 files and the
 * single Durable Object sits in one place in the world. A change made through this isolate applies
 * at once; elsewhere it takes up to 30 s, like a page already open in a visitor's browser.
 */
const DEMO_STATE_TTL_MS = 30_000;
let cachedEnabled: { enabled: boolean; until: number } | null = null;
async function demoEnabledV1(env: DemoEnv): Promise<boolean> {
  const now = Date.now();
  if (cachedEnabled && cachedEnabled.until > now) return cachedEnabled.enabled;
  const { enabled } = await stateOf(env).getState();
  cachedEnabled = { enabled, until: now + DEMO_STATE_TTL_MS };
  return enabled;
}

/** Stores only the enabled flag and its concurrency revision. No visitor data. */
export class DemoState extends DurableObject<DemoEnv> {
  async getState(): Promise<PublicDemoStateV1> {
    return publicDemoStateSchemaV1.parse(
      (await this.ctx.storage.get('state')) ?? { enabled: false, revision: 0 },
    );
  }
  async setEnabled(command: unknown): Promise<{ ok: boolean; state: PublicDemoStateV1 }> {
    const input = publicDemoChangeSchemaV1.parse(command);
    return this.ctx.storage.transaction(async (tx) => {
      const state = publicDemoStateSchemaV1.parse(
        (await tx.get('state')) ?? { enabled: false, revision: 0 },
      );
      if (state.revision !== input.expectedRevision) return { ok: false, state };
      const next = { enabled: input.enabled, revision: state.revision + 1 };
      await tx.put('state', next);
      return { ok: true, state: next };
    });
  }
}

/** Context validation supplements the private binding; it is not public authentication. */
export class DemoControl extends WorkerEntrypoint<DemoEnv> {
  private authorize(authority: unknown, write = false): void {
    const parsed = authoritySchema.safeParse(authority);
    if (
      !parsed.success ||
      !this.env.DEMO_ADMIN_TENANT_ID ||
      parsed.data.tenantId !== this.env.DEMO_ADMIN_TENANT_ID
    )
      throw new Error('forbidden');
    const age = Date.now() - Date.parse(parsed.data.authenticatedAt);
    if (age < 0 || age > 300_000 || (write && parsed.data.capability !== 'platform.settings.write'))
      throw new Error('forbidden');
  }
  override fetch(): Response {
    return secured(new Response(null, { status: 404 }));
  }
  async getState(authority: unknown) {
    this.authorize(authority);
    return stateOf(this.env).getState();
  }
  async setEnabled(authority: unknown, command: unknown) {
    this.authorize(authority, true);
    const result = await stateOf(this.env).setEnabled(command);
    cachedEnabled = null;
    return result;
  }
}

export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    try {
      // Every path/asset/alias/HEAD passes this same fail-closed gate.
      if (!(await demoEnabledV1(env))) return unavailable();
      const url = new URL(request.url);
      const html = url.pathname === '/' || url.pathname === '/index.html';
      if (
        !['GET', 'HEAD'].includes(request.method) ||
        (!html && !/^\/assets\/[\w.-]+$/u.test(url.pathname))
      )
        return secured(new Response(null, { status: 404 }));
      url.search = '';
      if (url.pathname === '/') url.pathname = '/index.html';
      return secured(
        await env.ASSETS.fetch(new Request(url.toString(), { method: request.method })),
      );
    } catch {
      return unavailable();
    }
  },
} satisfies ExportedHandler<DemoEnv>;
