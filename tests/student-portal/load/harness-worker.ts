import { portalAuthBurstV1 } from '../../../server/student-portal/observability/auth-burst-v1';
import { withPortalSqlV1 } from '../../../server/student-portal/runtime/database-v1';
import { PortalAdminApiV1 } from '../../../server/student-portal/admin/api-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import { AuthServiceV1 } from '../../../server/student-portal/auth/auth-service-v1';
import { SessionServiceV1 } from '../../../server/student-portal/auth/session-service-v1';
import { TurnstileVerifierV1 } from '../../../server/student-portal/auth/turnstile-v1';
import { servePortalAuthV1, sessionCookieTokenV1 } from '../../../server/student-portal/http/auth/handler-v1';
import { SelfProjectionReaderV1 } from '../../../server/student-portal/publication/self-projection-reader-v1';
import { measurePortalSqlV1 } from '../../../server/student-portal/observability/metrics-v1';
import { portalJsonV1 } from '../../../server/student-portal/runtime/http-v1';
import { portalServingGateV1 } from '../../../server/student-portal/maintenance/serving-gate-v1';
import { scopedPublicationEnabledV2 } from '../../../server/student-portal/publication/scoped-source-v2';
import { prepareReconciliationCredentialsV1 } from '../../../server/student-portal/birth-year/reconciliation-credentials-v1';

// Local-only synthetic harness. Never deploy; no production resource or secret is referenced.
export default {
  async fetch(request: Request, env: { TEST_DATABASE_URL: string; SERVING_ENABLED?: string; AUTH_GLOBAL: RateLimit; AUTH_SUBJECT: RateLimit }) {
    const closed = portalServingGateV1(env.SERVING_ENABLED);
    if (closed) return closed;
    // Miniflare's Node proxy replaces Host with loopback. Reconstruct the synthetic incoming
    // request inside workerd; foundation.workerd.ts separately proves hostile Host rejection.
    const headers = new Headers(request.headers);
    headers.set('host', new URL(request.url).host);
    request = new Request(request, { headers });
    const target = new URL(env.TEST_DATABASE_URL);
    if (target.hostname !== '127.0.0.1' || target.pathname !== '/portal705_test' || target.username !== 'student_portal_app')
      return new Response(null, { status: 503 });
    try {
      return await withPortalSqlV1({ connectionString: target.toString() }, async (rawSql) => {
        const measured = measurePortalSqlV1(rawSql);
        const sql = measured.sql;
        const cryptography = new PortalCryptoV1(new Map([[1, new Uint8Array(32).fill(51)]]), new Map([[1, new Uint8Array(32).fill(52)]]));
        const path = new URL(request.url).pathname;
        let response: Response;
        if (path === '/harness/reconciliation/stage') {
          response = portalJsonV1(await prepareReconciliationCredentialsV1(sql, cryptography, 1,
            '11111111-1111-4111-8111-111111111111', await request.json()), 200);
        } else if (path === '/harness/admin/query' || path === '/harness/admin/command') {
          const api = new PortalAdminApiV1(sql, { tenantId: '22222222-2222-4222-8222-222222222222',
            cryptoPort: cryptography, qrKeyVersion: 1, pepperVersion: 1, cursorSecret: 'synthetic-local-harness-cursor-714-'.repeat(2),
            scopedPublication: await scopedPublicationEnabledV2(sql) });
          const context = { actorId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222',
            requestId: crypto.randomUUID(), authenticatedAt: new Date().toISOString(), capability: 'platform.settings.write', clientIp: '192.0.2.71' };
          const input = await request.json();
          response = portalJsonV1(await (path.endsWith('/query') ? api.query(context, input) : api.command(context, input)), 200);
        } else {
          const sessions = new SessionServiceV1(sql, cryptography, '192.0.2.71');
          if (path === '/api/student/me') {
            const value = await sessions.withAuthorized(sessionCookieTokenV1(request), (context, tx) =>
              new SelfProjectionReaderV1(sql).readInTransaction(tx, context.account.id, crypto.randomUUID()));
            response = portalJsonV1(value ?? { state: 'unauthenticated' }, value ? 200 : 401);
          } else {
            // Public testing secret; the real verifier still requires production hostname/action and rejects dummy proofs.
            const auth = new AuthServiceV1(sql, cryptography, 1, new TurnstileVerifierV1('1x0000000000000000000000000000000AA'), '192.0.2.71', portalAuthBurstV1(env.AUTH_GLOBAL, env.AUTH_SUBJECT));
            response = await servePortalAuthV1(request, 'production', 'https://aluno.escolaieda.com', auth, sessions);
          }
        }
        const metric = measured.snapshot(path.includes('/admin/') ? 'admin-command' : 'auth', response.ok ? 'ok' : 'denied');
        response.headers.set('x-harness-queries', String(metric.queries + 1));
        response.headers.set('x-harness-rows', String(metric.rows + 1));
        response.headers.set('x-harness-ms', String(metric.elapsedMs));
        response.headers.set('x-harness-lock-timeouts', String(metric.lockTimeouts));
        return response;
      });
    } catch { return portalJsonV1({ state: 'unavailable' }, 503); }
  },
};
