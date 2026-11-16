import { servePortalAdminV1 } from '../../../server/student-portal/http/admin/handler-v1';
import { createApplicationSession, SESSION_COOKIE } from '../../../server/auth/session';
import { seal } from '../../../server/auth/sealed';
import type { RuntimeEnv } from '../../../server/env';
import type { PortalAdminEntrypointV1 } from '../../../shared/student-portal-contracts/ports-v1';

/** Local test caller only: never deployed. Real seal verification and RPC, entirely synthetic identity. */
export default {
  async fetch(request: Request, env: { ADMIN: PortalAdminEntrypointV1; SELF: Fetcher }) {
    const input = (await request.json()) as {
      path: string;
      input?: unknown;
      cookie?: string;
      anonymous?: boolean;
      origin?: string;
    };
    const admin = input.path.startsWith('/api/student-portal/');
    const origin = admin ? 'https://admin.escolaieda.com' : 'https://aluno.escolaieda.com';
    const sessionSecret = 'synthetic-local-adm-session-715-'.repeat(2);
    const cookie =
      admin && !input.anonymous
        ? `${SESSION_COOKIE}=${await seal(
            createApplicationSession({
              oid: '11111111-1111-4111-8111-111111111111',
              name: 'SYNTHETIC OPERATOR',
              roles: ['ADMINISTRADOR'],
            }),
            sessionSecret,
            'admin-session',
          )}`
        : input.cookie;
    const forwarded = new Request(origin + input.path, {
      method: input.input === undefined ? 'GET' : 'POST',
      headers: {
        host: new URL(origin).host,
        origin: input.origin ?? origin,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(input.input === undefined ? {} : { body: JSON.stringify(input.input) }),
    });
    if (admin)
      return servePortalAdminV1(
        forwarded,
        {
          OFFICIAL_ORIGIN: origin,
          RUNTIME_ENVIRONMENT: 'production',
          TENANT_ID: '22222222-2222-4222-8222-222222222222',
          SESSION_SECRET: sessionSecret,
        } as unknown as RuntimeEnv,
        env.ADMIN,
      );
    return env.SELF.fetch(forwarded);
  },
};
