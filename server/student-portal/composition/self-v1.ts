import { z } from 'zod';
import { servePortalFrequencyV2 } from './frequency-v2';
import { servePortalScheduleV1 } from './schedule-v1';
import { servePortalIncidentsV1 } from './incidents-v1';
import {
  activateRequestV1,
  challengeRequestV1,
  loginRequestV1,
} from '../../../shared/student-portal-contracts/auth-v1';
import type { FailureV1 } from '../../../shared/student-portal-contracts/core-v1';
import { AuthServiceV1, parseQrV1 } from '../auth/auth-service-v1';
import { deviceFamilyV1 } from '../auth/device-v1';
import { SessionServiceV1 } from '../auth/session-service-v1';
import { TurnstileVerifierV1 } from '../auth/turnstile-v1';
import { servePortalAuthV1, sessionCookieTokenV1 } from '../http/auth/handler-v1';
import { portalServingGateV1 } from '../maintenance/serving-gate-v1';
import { cloudflareClientIpV1 } from '../observability/audit-context-v1';
import { checkPortalOperationV1, PortalRateLimitErrorV1, portalRateLimitResponseV1 } from '../observability/operation-burst-v1';
import { portalAuthBurstV1 } from '../observability/auth-burst-v1';
import { SelfProjectionReaderV1 } from '../publication/self-projection-reader-v1';
import { scopedPublicationEnabledV2 } from '../publication/scoped-source-v2';
import { portalFailureV1, portalJsonV1, portalRequestOriginAllowedV1 } from '../runtime/http-v1';
import { portalKeysV1, type PortalCompositionEnvV1 } from './config-v1';
import { portalStatusResponseV1 } from '../../../shared/student-portal-contracts/notices-v1';
import { PolicyServiceV1 } from '../policies/policy-service-v1';
import { portalNoticesForPolicyV1 } from '../policies/calendar-v1';
import { accountScopeV1, authNowV1 } from '../auth/transaction-v1';
import { portalDatabaseV1 } from './database-v1';
import { connectPortalLiveV1, portalLiveStubV1, type SecurityRenewalV1 } from '../live/live-connect-v1';
import { servePortalPhotoV1 } from '../photos/http-v1';
import {
  STUDENT_PHOTO_META_PATH_V1,
  STUDENT_PHOTO_CONTENT_PATH_V1,
} from '../../../shared/student-photos/portrait-v1';

const paths = new Set([
  '/api/student/auth/challenge',
  '/api/student/auth/activate',
  '/api/student/auth/login',
  '/api/student/auth/logout',
  '/api/student/session',
  '/api/student/me',
  '/api/student/live',
  '/api/student/status',
]);

type SelfContextV1 = {
  request: Request;
  env: PortalCompositionEnvV1;
  clientIp: ReturnType<typeof cloudflareClientIpV1>;
  snapshotReads: boolean;
  connectionId: string | null;
};

/** A connection id is only for the session read or the security channel, with one account. */
function invalidConnectionV1(url: URL, path: string, connectionId: string) {
  return (
    !['/api/student/session', '/api/student/live'].includes(path) ||
    url.searchParams.getAll('connectionId').length !== 1 ||
    !z.uuid().safeParse(connectionId).success ||
    !z.uuid().safeParse(url.searchParams.get('accountId')).success ||
    url.searchParams.getAll('accountId').length !== 1 ||
    (path === '/api/student/live' && url.searchParams.get('purpose') !== 'security')
  );
}

/** Lazy adapters enforce method, bytes, JSON and schema BEFORE connection/KDF. */
async function invokeAuthV1<T>(
  self: SelfContextV1,
  subject: string,
  requestId: string,
  run: (auth: AuthServiceV1) => Promise<T>,
  hasQr = false,
): Promise<T | FailureV1> {
  const { request, env, clientIp } = self;
  if (portalServingGateV1(env.PORTAL_SERVING_ENABLED))
    return { contractVersion: 1, requestId, state: 'unavailable' } satisfies FailureV1;
  if (!env.PORTAL_AUTH_GLOBAL || !env.PORTAL_AUTH_SUBJECT)
    throw new Error('student-portal-rate-limit-unavailable');
  // Anonymous input has its own budget; invalid signatures cannot spend the proven QR budget.
  await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL, 'auth-entry', 'public');
  const keys = portalKeysV1(env);
  let verifiedSubject = subject;
  if (hasQr) {
    const qr = parseQrV1(subject);
    if (!(await keys.cryptoPort.verifyQr(qr.credentialId, qr.keyVersion, qr.signature)))
      return { contractVersion: 1, requestId, state: 'unauthenticated' };
    verifiedSubject = `qr:${qr.keyVersion}:${qr.credentialId}`;
  }
  if (!hasQr) {
    // A challenge is opaque until its existing database preflight verifies it. Keep its
    // budget separate from signed QRs; the durable account counter remains authoritative.
    await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL, 'activation', 'public');
    await checkPortalOperationV1(env.PORTAL_AUTH_SUBJECT, 'activation', subject);
  }
  if (hasQr && !(await portalAuthBurstV1(env.PORTAL_AUTH_GLOBAL, env.PORTAL_AUTH_SUBJECT)(verifiedSubject)))
    return {
      contractVersion: 1,
      requestId,
      state: 'rate-limited',
      retryAfterSeconds: 60,
    } satisfies FailureV1;
  if (!env.TURNSTILE_SECRET_KEY) throw new Error('student-portal-turnstile-unavailable');
  return portalDatabaseV1(env, 'auth', (sql) =>
    run(
      new AuthServiceV1(
        sql,
        keys.cryptoPort,
        keys.pepperVersion,
        new TurnstileVerifierV1(env.TURNSTILE_SECRET_KEY!),
        clientIp,
        undefined,
        deviceFamilyV1(request.headers.get('user-agent')),
      ),
    ),
  );
}

/** The session read, renewing the live security channel when a connection asks for it. */
function readSessionV1(self: SelfContextV1): SessionServiceV1['read'] {
  const { env, clientIp, snapshotReads, connectionId } = self;
  return async (token, requestId, expectedAccountId, includeClosed) => {
    if (portalServingGateV1(env.PORTAL_SERVING_ENABLED))
      throw new Error('student-portal-maintenance');
    await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL, 'session-entry', 'public');
    const keys = portalKeysV1(env);
    const verifiedAt = Date.now();
    let renewal: SecurityRenewalV1 | undefined;
    const result = await portalDatabaseV1(env, 'self', (sql) =>
      new SessionServiceV1(sql, keys.cryptoPort, clientIp, snapshotReads,
        accountId => checkPortalOperationV1(env.PORTAL_SESSION_ACCOUNT, 'session', accountId)).read(
        token,
        requestId,
        expectedAccountId,
        includeClosed,
        connectionId === null ? undefined : async (context, tx, session) => {
          if (!context.account.link) return;
          const classes = await tx.unsafe(
            `SELECT class_id FROM student_portal.academic_binding_v1
             WHERE academic_year=2026 AND student_id=$1 AND status IS DISTINCT FROM 6
             ORDER BY class_id LIMIT 2`, [context.account.link.studentId]);
          if (classes.length > 1) throw new Error('student-portal-live-class-ambiguous');
          renewal = { connectionId, sessionId: session.id, accountId: context.account.id,
            studentId: context.account.link.studentId,
            classId: classes[0]?.class_id === undefined ? null : Number(classes[0].class_id),
            verifiedAt, expiresAt: session.expiresAt };
        },
      ),
    );
    if (connectionId !== null && result?.state === 'authenticated') {
      // The snapshot has ended; RPC never holds a database transaction open.
      const liveRenewed = renewal ? await portalLiveStubV1(env, 'student').renewSecurity(renewal) : false;
      return { ...result, liveRenewed };
    }
    return result;
  };
}

/** The live channel: a WebSocket for the signed-in student (security purpose or academic). */
async function serveLiveV1(self: SelfContextV1): Promise<Response> {
  const { request, env, connectionId } = self;
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return portalJsonV1(portalFailureV1('invalid-request'), 400);
  if (portalServingGateV1(env.PORTAL_SERVING_ENABLED))
    return portalJsonV1(portalFailureV1('unavailable'), 503);
  const purpose = new URL(request.url).searchParams.get('purpose');
  const expectedAccount = new URL(request.url).searchParams.get('accountId');
  if (purpose !== null && purpose !== 'security')
    return portalJsonV1(portalFailureV1('invalid-request'), 400);
  const token = sessionCookieTokenV1(request);
  if (!token) return portalJsonV1(portalFailureV1('unauthenticated'), 401);
  const keys = portalKeysV1(env);
  await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL, 'live-entry', 'public');
  const identity = await portalDatabaseV1(env, 'live', (sql) =>
    new SessionServiceV1(sql, keys.cryptoPort, undefined, true,
      accountId => checkPortalOperationV1(env.PORTAL_LIVE_ACCOUNT, 'live', accountId)).withAuthorized(
      token,
      async (context, tx, session) => {
        if (
          !context.account.link ||
          (expectedAccount !== null && context.account.id !== expectedAccount.toLowerCase())
        )
          return null;
        const classes = await tx.unsafe(
          `SELECT class_id FROM student_portal.academic_binding_v1
          WHERE academic_year=2026 AND student_id=$1 AND status IS DISTINCT FROM 6
          ORDER BY class_id LIMIT 2`,
          [context.account.link.studentId],
        );
        if (classes.length > 1) throw new Error('student-portal-live-class-ambiguous');
        return {
          audience: 'student' as const,
          ...(connectionId === null ? {} : { connectionId, sessionId: session.id }),
          purpose: purpose === 'security' ? ('security' as const) : ('academic' as const),
          expiresAt:
            purpose === 'security'
              ? new Date(
                  Math.min(Date.parse(session.expiresAt), Date.now() + 60_000),
                ).toISOString()
              : session.expiresAt,
          effectiveExpiresAt: purpose === 'security' ? session.expiresAt : undefined,
          accountId: context.account.id,
          studentId: context.account.link.studentId,
          classId: classes[0]?.class_id === undefined ? null : Number(classes[0].class_id),
        };
      },
    ),
  );
  if (!identity) return portalJsonV1(portalFailureV1('unauthenticated'), 401);
  return connectPortalLiveV1(env, request, identity);
}

function logoutV1(self: SelfContextV1): SessionServiceV1['logout'] {
  const { env, clientIp } = self;
  return async (token, requestId) => {
    if (portalServingGateV1(env.PORTAL_SERVING_ENABLED))
      throw new Error('student-portal-maintenance');
    const keys = portalKeysV1(env);
    await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL, 'logout-entry', 'public');
    return portalDatabaseV1(env, 'auth', (sql) =>
      new SessionServiceV1(sql, keys.cryptoPort, clientIp).logout(token, requestId,
        accountId => checkPortalOperationV1(env.PORTAL_AUTH_SUBJECT, 'logout', accountId)),
    );
  };
}

/** Public and read-only: before sign-in it answers with the school policy; with a valid
 * session, with that student's policy. It carries dates and switches, never grades. */
async function serveStatusV1(self: SelfContextV1): Promise<Response> {
  const { request, env, clientIp, snapshotReads } = self;
  // Public and read-only: before sign-in it answers with the school policy; with a valid
  // session, with that student's policy. It carries dates and switches, never grades.
  if (request.method !== 'GET') return portalJsonV1(portalFailureV1('invalid-request'), 400);
  const closed = portalServingGateV1(env.PORTAL_SERVING_ENABLED);
  if (closed) return closed;
  const keys = portalKeysV1(env);
  const token = sessionCookieTokenV1(request);
  await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL, 'status-entry', 'public');
  const status = await portalDatabaseV1(env, 'self', async (sql) => {
    const policies = new PolicyServiceV1(sql);
    const now = new Date();
    const student = token
      ? await new SessionServiceV1(sql, keys.cryptoPort, clientIp, snapshotReads,
          accountId => checkPortalOperationV1(env.PORTAL_STATUS_ACCOUNT, 'status', accountId))
          .withAuthorized(token, async (context, tx) =>
            portalNoticesForPolicyV1(
              (await policies.readSnapshotInTransaction(tx, accountScopeV1(context.account.id)))
                .enforcedValue,
              await authNowV1(tx),
            ),
          )
          .catch(error => {
            if (error instanceof PortalRateLimitErrorV1) throw error;
            return null;
          })
      : null;
    if (student) return { scope: 'student' as const, notices: student, now };
    const school = await policies.readSnapshot({ kind: 'school', academicYear: 2026 });
    return {
      scope: 'school' as const,
      notices: portalNoticesForPolicyV1(school.enforcedValue, now),
      now,
    };
  });
  return portalJsonV1(
    portalStatusResponseV1.parse({
      contractVersion: 1,
      requestId: crypto.randomUUID(),
      state: 'status',
      scope: status.scope,
      notices: status.notices,
      serverNow: status.now.toISOString(),
    }),
    200,
  );
}

/** The signed-in student's own projection, from the scoped V2 publication only. */
async function serveMeV1(self: SelfContextV1): Promise<Response> {
  const { request, env, clientIp, snapshotReads } = self;
  if (request.method !== 'GET') return portalJsonV1(portalFailureV1('invalid-request'), 400);
  const closed = portalServingGateV1(env.PORTAL_SERVING_ENABLED);
  if (closed) return closed;
  const token = sessionCookieTokenV1(request);
  if (!token) return portalJsonV1(portalFailureV1('unauthenticated'), 401);
  const keys = portalKeysV1(env);
  await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL, 'read-entry', 'public');
  const result = await portalDatabaseV1(env, 'self', (sql) =>
    new SessionServiceV1(sql, keys.cryptoPort, clientIp, snapshotReads,
      accountId => checkPortalOperationV1(env.PORTAL_READ_ACCOUNT, 'read', accountId)).withAuthorized(
      token,
      async (context, tx) => {
        // Scoped V2 editions are the only published source; without them Self fails closed.
        if (
          env.PORTAL_PUBLICATION_MODE !== 'scoped-v2' ||
          !(await scopedPublicationEnabledV2(tx))
        )
          throw new Error('student-portal-scoped-publication-unavailable');
        return new SelfProjectionReaderV1(sql).readInTransaction(
          tx,
          context.account.id,
          crypto.randomUUID(),
          snapshotReads,
        );
      },
    ),
  );
  return result
    ? portalJsonV1(result, 200)
    : portalJsonV1(portalFailureV1('unauthenticated'), 401);
}

/** Frequência, Horário and Ocorrências: each checks its own method, query and policy. */
const attendanceRoutesV1 = new Map<string, (request: Request, env: PortalCompositionEnvV1) => Promise<Response>>([
  ['/api/student/frequency', servePortalFrequencyV2],
  ['/api/student/schedule', servePortalScheduleV1],
  ['/api/student/incidents', servePortalIncidentsV1],
  ['/api/student/incidents/acknowledge', servePortalIncidentsV1],
]);

export async function servePortalSelfV1(
  request: Request,
  env: PortalCompositionEnvV1,
): Promise<Response> {
  if (!portalRequestOriginAllowedV1(request, env.PORTAL_ENVIRONMENT, env.PORTAL_ORIGIN))
    return portalJsonV1(portalFailureV1('forbidden'), 403);
  const url = new URL(request.url);
  const path = url.pathname;
  const attendance = attendanceRoutesV1.get(path);
  if (attendance) return attendance(request, env);
  const connectionId = url.searchParams.get('connectionId');
  if (connectionId !== null && invalidConnectionV1(url, path, connectionId))
    return portalJsonV1(portalFailureV1('invalid-request'), 400);
  if (path === STUDENT_PHOTO_META_PATH_V1 || path === STUDENT_PHOTO_CONTENT_PATH_V1)
    return servePortalPhotoV1(request, env);
  if (path === '/healthz' && request.method === 'GET')
    return portalJsonV1({ contractVersion: 1, state: 'ok' }, 200);
  if (!paths.has(path)) return portalJsonV1(portalFailureV1('unavailable'), 404);
  try {
    const clientIp = cloudflareClientIpV1(request);
    const snapshotReads = env.PORTAL_PUBLICATION_MODE === 'scoped-v2';
    // Lazy adapters enforce method, bytes, JSON and schema BEFORE connection/KDF.
    const self: SelfContextV1 = { request, env, clientIp, snapshotReads, connectionId };
    if (path === '/api/student/live') return await serveLiveV1(self);
    if (path === '/api/student/status') return await serveStatusV1(self);
    if (path === '/api/student/me') return await serveMeV1(self);
    return servePortalAuthV1(
      request,
      env.PORTAL_ENVIRONMENT,
      env.PORTAL_ORIGIN,
      {
        challenge: async (input, id) => {
          const parsed = challengeRequestV1.parse(input);
          return invokeAuthV1(self, parsed.qr, id, (auth) => auth.challenge(parsed, id), true);
        },
        activate: async (input, id) => {
          const parsed = activateRequestV1.parse(input);
          return invokeAuthV1(self, parsed.challenge, id, (auth) => auth.activate(parsed, id));
        },
        login: async (input, id) => {
          const parsed = loginRequestV1.parse(input);
          return invokeAuthV1(self, parsed.qr, id, (auth) => auth.login(parsed, id), true);
        },
      },
      { read: readSessionV1(self), logout: logoutV1(self) },
    );
  } catch (error) {
    if (error instanceof PortalRateLimitErrorV1) return portalRateLimitResponseV1(error);
    return portalJsonV1(portalFailureV1('unavailable'), 503);
  }
}
