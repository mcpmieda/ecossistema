import { onRequest } from '../../../functions/[[path]]';
import { createApplicationSession, SESSION_COOKIE } from '../../../server/auth/session';
import { seal } from '../../../server/auth/sealed';
import { coreModules } from '../../../server/platform/manifest';
import type { RuntimeEnv } from '../../../server/env';
import type { PlatformSnapshotContract } from '../../../shared/platform-contract';

/** Disposable-only wrapper: real Pages handler, seal, authorization, RPC and PostgreSQL.
 * Only the unrelated SharePoint bootstrap snapshot is an invented fixture.
 * This file is never referenced by a production entrypoint or deployment config.
 */
export default {
  async fetch(
    request: Request,
    bindings: { PORTAL_SERVICE: unknown; PROD_DB: unknown; EDGE: Fetcher },
  ) {
    const input = (await request.json()) as {
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
    };
    if (!input.path.startsWith('/') || input.path.startsWith('//'))
      return new Response(null, { status: 400 });
    const origin =
      input.surface === 'admin' ? 'https://admin.escolaieda.com' : 'https://aluno.escolaieda.com';
    const secret = 'synthetic-disposable-757-session-secret-'.repeat(2);
    const cookie =
      input.surface === 'admin' && !input.anonymous
        ? SESSION_COOKIE +
          '=' +
          (await seal(
            createApplicationSession({
              oid: '75700000-0000-4000-8000-000000000001',
              name: 'SYNTHETIC INTEGRATION OPERATOR',
              roles: [input.role ?? 'ADMINISTRADOR'],
            }),
            secret,
          ))
        : input.cookie;
    const forwarded = new Request(origin + input.path, {
      method: input.method ?? (input.body === undefined ? 'GET' : 'POST'),
      headers: {
        host: input.hostname ?? new URL(origin).host,
        origin: input.origin ?? origin,
        'Content-Type': 'application/json',
        ...(input.upgrade ? { Upgrade: 'websocket' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    if (input.surface === 'student') return bindings.EDGE.fetch(forwarded);
    const id = '22222222-2222-4222-8222-222222222222';
    const env = {
      RUNTIME_ENVIRONMENT: 'production',
      OFFICIAL_ORIGIN: origin,
      TENANT_ID: id,
      WEB_CLIENT_ID: id,
      GRAPH_CLIENT_ID: id,
      SHAREPOINT_SITE_ID: 'synthetic-local-sharepoint-757',
      GROUP_ADMIN_ID: id,
      GROUP_PROFESSOR_ID: id,
      GROUP_ALUNO_ID: id,
      GROUP_APOIO_ID: id,
      GROUP_VISITANTE_ID: id,
      SESSION_SECRET: secret,
      WEB_CREDENTIAL_A: 'x'.repeat(300),
      GRAPH_CREDENTIAL_A: 'x'.repeat(300),
      GRADEBOOK_PRODUCTION_ENABLED: 'true',
      GRADEBOOK_STORAGE_PROVIDER: 'postgres',
      PORTAL_SERVICE: bindings.PORTAL_SERVICE,
      PROD_DB: bindings.PROD_DB,
    } as unknown as RuntimeEnv; // Generated production literal types; validateEnv still validates this synthetic runtime.
    if (
      ['/api/platform/bootstrap', '/api/platform/snapshot-v2'].includes(input.path) &&
      !input.anonymous &&
      (input.role ?? 'ADMINISTRADOR') === 'ADMINISTRADOR'
    ) {
      const snapshot: PlatformSnapshotContract = {
        version: '1.0.0',
        releaseState: 'production',
        generatedAt: new Date().toISOString(),
        correlationId: 'synthetic-bootstrap-757',
        foundation: {
          status: 'ok',
          sharePointListCount: 4,
          expectedPlatformListsPresent: true,
          missingPlatformLists: [],
        },
        operational: null,
        coreModules,
        registeredModules: [],
        configurations: [],
        recentAudit: [],
        migrations: [],
      };
      return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
    }
    return onRequest({
      request: forwarded,
      env,
      params: {},
      data: {},
      functionPath: input.path,
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null, { status: 404 }),
    } as unknown as Parameters<typeof onRequest>[0]);
  },
};
