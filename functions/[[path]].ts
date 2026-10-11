import { gradebookAfterCommitV1, type GradebookAfterCommitV1 } from '../server/gradebook/http/live-after-commit-v1';
import type { RuntimeEnv } from '../server/env';
import { handleStudentReconciliationRequestV1 } from '../server/student-identity/reconciliation/http-v1';
import { validateEnv } from '../server/env';
import { handleSystemHealthRequestV1 } from '../server/platform/system-health-http-v1';
import { handlePublicDemoRequestV1 } from '../server/platform/public-demo-http-v1';
import { servePortalAdminV1 } from '../server/student-portal/http/admin/handler-v1';
import { portalJsonV1, portalFailureV1 } from '../server/student-portal/runtime/http-v1';
import type { PortalAdminServiceBindingV1 } from '../shared/student-portal-contracts/ports-v1';
import {
  AUTH_COOKIE,
  SESSION_COOKIE,
  requireAuth,
  AuthenticationError,
  createApplicationSession,
  reconfigureApplicationSession,
} from '../server/auth/session';
import {
  createSessionDurationPreferenceCookie,
  DEFAULT_SESSION_DURATION_HOURS,
  isSessionDurationHours,
  readSessionDurationPreference,
  SESSION_DURATION_OPTIONS_HOURS,
} from '../server/auth/session-policy';
import {
  authorizationUrl,
  exchangeCode,
  newAuthTransaction,
  verifyIdToken,
} from '../server/auth/oidc';
import { clearCookie, readCookie, secureCookie } from '../server/auth/cookies';
import { seal, unseal } from '../server/auth/sealed';
import { rolesForGroups, AuthorizationError } from '../server/auth/roles';
import { capabilitiesForRoles, requireCapability } from '../server/auth/capabilities';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  withSecurityHeaders,
} from '../server/http/security';
import { sharePointHealth } from '../server/graph/sharepoint';
import { handleBulletinRequestV1 } from '../server/gradebook/http/bulletin-routes-v1';
import { handleCouncilWorkspaceRequestV1 } from '../server/gradebook/http/council-routes-v1';
import { handleGradebookPersistenceAdminRequestV1 } from '../server/gradebook/http/persistence-admin-routes-v1';
import { handleRetiredGradebookReportsRequest } from '../server/gradebook/http/retired-reports-route';
import { handleOperationalWorkspaceRequestV1 } from '../server/gradebook/http/operational-workspace-routes-v1';
import { handlePerformanceRequestV1 } from '../server/gradebook/http/performance-routes-v1';
import { handleAssessmentNamesRequestV1 } from '../server/gradebook/http/assessment-names-routes-v1';
import { handleYearResetRequestV1 } from '../server/gradebook/http/year-reset-routes-v1';
import { withOfficialGradebookDatabaseV1 } from '../server/gradebook/persistence/postgres/official-gradebook-database-v1';
import { getPlatformSnapshot } from '../server/platform/snapshot';

type Context = EventContext<RuntimeEnv, string, unknown>;

type StoredAuthTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
};

type AuthTransactionEnvelope = {
  transactions: StoredAuthTransaction[];
};

type AuthFailureCategory =
  | 'provider_rejected'
  | 'invalid_transaction'
  | 'token_exchange_failed'
  | 'token_validation_failed'
  | 'institutional_role_missing';

const MAX_AUTH_TRANSACTIONS = 4;

function sessionPolicyPayload(
  session: Awaited<ReturnType<typeof requireAuth>>,
  now = Math.floor(Date.now() / 1000),
) {
  return {
    version: 1,
    policy: 'absolute' as const,
    defaultDurationHours: DEFAULT_SESSION_DURATION_HOURS,
    allowedDurationsHours: SESSION_DURATION_OPTIONS_HOURS,
    currentDurationHours: session.durationHours ?? DEFAULT_SESSION_DURATION_HOURS,
    configured: session.durationHours !== undefined,
    authenticatedAt: new Date((session.authenticatedAt ?? now) * 1000).toISOString(),
    expiresAt: new Date(session.exp * 1000).toISOString(),
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function method(request: Request, allowed: string[]): void {
  if (!allowed.includes(request.method)) throw new HttpError(405, 'Method not allowed');
}

function isStoredAuthTransaction(value: unknown): value is StoredAuthTransaction {
  if (!value || typeof value !== 'object') return false;
  const transaction = value as Record<string, unknown>;
  return (
    typeof transaction.state === 'string' &&
    typeof transaction.nonce === 'string' &&
    typeof transaction.verifier === 'string' &&
    typeof transaction.exp === 'number'
  );
}

async function readAuthTransactions(
  request: Request,
  secret: string,
): Promise<StoredAuthTransaction[]> {
  const authCookie = readCookie(request, AUTH_COOKIE);
  if (!authCookie) return [];
  const value = await unseal<unknown>(authCookie, secret);
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { transactions?: unknown };
  if (Array.isArray(candidate.transactions)) {
    return candidate.transactions.filter(isStoredAuthTransaction);
  }
  return isStoredAuthTransaction(value) ? [value] : [];
}

async function temporaryAuthCookie(
  transactions: StoredAuthTransaction[],
  secret: string,
): Promise<string> {
  const live = transactions
    .filter((transaction) => transaction.exp > Math.floor(Date.now() / 1000))
    .slice(-MAX_AUTH_TRANSACTIONS);
  if (live.length === 0) return clearCookie(AUTH_COOKIE);
  const value = await seal({ transactions: live } satisfies AuthTransactionEnvelope, secret);
  return secureCookie(AUTH_COOKIE, value, { maxAge: 600 });
}

function authFailureResponse({
  env,
  correlationId,
  category,
  stage,
  status,
  cause,
  authCookie,
}: {
  env: RuntimeEnv;
  correlationId: string;
  category: AuthFailureCategory;
  stage: string;
  status: number;
  cause: string;
  authCookie: string;
}): Response {
  const log = JSON.stringify({
    message: 'authentication_failed',
    category,
    stage,
    cause,
    status,
    correlationId,
  });
  if (status >= 500) console.error(log);
  else console.warn(log);

  const location = new URL(env.OFFICIAL_ORIGIN);
  location.searchParams.set('authError', '1');
  location.searchParams.set('correlationId', correlationId);
  const headers = new Headers({ Location: location.toString() });
  headers.append('Set-Cookie', authCookie);
  return new Response(null, { status: 303, headers });
}

async function routeOfficialGradebookRequestV1(
  request: Request,
  env: RuntimeEnv,
  afterCommit: GradebookAfterCommitV1,
): Promise<Response | null> {
  const assessmentNamesResponse = await handleAssessmentNamesRequestV1(request, env, afterCommit);
  if (assessmentNamesResponse) return assessmentNamesResponse;

  const yearResetResponse = await handleYearResetRequestV1(request, env, afterCommit);
  if (yearResetResponse) return yearResetResponse;

  const operationalWorkspaceResponse = await handleOperationalWorkspaceRequestV1(request, env);
  if (operationalWorkspaceResponse) return operationalWorkspaceResponse;

  const performanceResponse = await handlePerformanceRequestV1(request, env);
  if (performanceResponse) return performanceResponse;

  const bulletinResponse = await handleBulletinRequestV1(request, env, afterCommit);
  if (bulletinResponse) return bulletinResponse;

  const councilResponse = await handleCouncilWorkspaceRequestV1(request, env, afterCommit);
  if (councilResponse) return councilResponse;

  return null;
}

async function route(context: Context, correlationId: string): Promise<Response> {
  const env = validateEnv(context.env);
  const request = context.request;
  const url = new URL(request.url);
  enforceOfficialOrigin(request, env);

  const healthResponse = await handleSystemHealthRequestV1(request, env);
  if (healthResponse) return healthResponse;
  const demoResponse = await handlePublicDemoRequestV1(request, env);
  if (demoResponse) return demoResponse;

  if (url.pathname.startsWith('/api/student-portal/admin/')) {
    const binding = env.PORTAL_SERVICE as PortalAdminServiceBindingV1 | undefined;
    if (!binding || typeof binding.query !== 'function' || typeof binding.command !== 'function')
      return portalJsonV1(portalFailureV1('unavailable'), 503);
    return servePortalAdminV1(request, env, binding);
  }

  if (url.pathname === '/api/health') {
    method(request, ['GET']);
    return json({ status: 'ok', service: 'ecossistema-escola', version: '1.0.0' });
  }

  if (url.pathname === '/auth/login') {
    method(request, ['GET']);
    const transaction = await newAuthTransaction();
    const existing = await readAuthTransactions(request, env.SESSION_SECRET);
    const cookie = await seal(
      {
        transactions: [
          ...existing.filter((item) => item.exp > Math.floor(Date.now() / 1000)),
          {
            state: transaction.state,
            nonce: transaction.nonce,
            verifier: transaction.verifier,
            exp: transaction.exp,
          },
        ].slice(-MAX_AUTH_TRANSACTIONS),
      } satisfies AuthTransactionEnvelope,
      env.SESSION_SECRET,
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizationUrl(env, transaction),
        'Set-Cookie': secureCookie(AUTH_COOKIE, cookie, { maxAge: 600 }),
      },
    });
  }

  if (url.pathname === '/auth/callback') {
    method(request, ['GET']);
    const transactions = await readAuthTransactions(request, env.SESSION_SECRET);
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const now = Math.floor(Date.now() / 1000);
    const transaction = state ? transactions.find((item) => item.state === state) : undefined;
    const remainingTransactions = transactions.filter(
      (item) => item.state !== state && item.exp > now,
    );
    const remainingAuthCookie = await temporaryAuthCookie(
      remainingTransactions,
      env.SESSION_SECRET,
    );

    if (error) {
      return authFailureResponse({
        env,
        correlationId,
        category: 'provider_rejected',
        stage: 'authorization_callback',
        status: 401,
        cause: 'identity_provider_returned_error',
        authCookie: remainingAuthCookie,
      });
    }
    if (!code || !state || !transaction || transaction.exp <= now || state !== transaction.state) {
      return authFailureResponse({
        env,
        correlationId,
        category: 'invalid_transaction',
        stage: 'transaction_validation',
        status: 401,
        cause: 'missing_expired_or_mismatched_transaction',
        authCookie: remainingAuthCookie,
      });
    }

    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode(env, code, transaction.verifier);
    } catch {
      return authFailureResponse({
        env,
        correlationId,
        category: 'token_exchange_failed',
        stage: 'token_exchange',
        status: 502,
        cause: 'identity_provider_exchange_rejected',
        authCookie: remainingAuthCookie,
      });
    }

    let claims: Awaited<ReturnType<typeof verifyIdToken>>;
    try {
      claims = await verifyIdToken(tokens.id_token, env, transaction.nonce);
    } catch {
      return authFailureResponse({
        env,
        correlationId,
        category: 'token_validation_failed',
        stage: 'id_token_validation',
        status: 401,
        cause: 'id_token_failed_validation',
        authCookie: remainingAuthCookie,
      });
    }

    const mappedRoles = rolesForGroups(claims.groups, env);
    if (mappedRoles.length === 0) {
      return authFailureResponse({
        env,
        correlationId,
        category: 'institutional_role_missing',
        stage: 'role_resolution',
        status: 403,
        cause: 'no_recognized_institutional_role',
        authCookie: remainingAuthCookie,
      });
    }

    const authenticatedAt = Math.floor(Date.now() / 1000);
    const durationHours = await readSessionDurationPreference(
      request,
      env,
      claims.oid,
      authenticatedAt,
    );
    const applicationSession = createApplicationSession(
      {
        oid: claims.oid,
        name: claims.name,
        username: claims.preferred_username,
        roles: mappedRoles,
      },
      durationHours,
      authenticatedAt,
    );
    const session = await seal(applicationSession, env.SESSION_SECRET);
    const headers = new Headers({ Location: env.OFFICIAL_ORIGIN });
    headers.append(
      'Set-Cookie',
      secureCookie(SESSION_COOKIE, session, { maxAge: durationHours * 60 * 60 }),
    );
    headers.append('Set-Cookie', remainingAuthCookie);
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === '/auth/logout') {
    method(request, ['POST']);
    enforceWriteOrigin(request, env);
    const headers = new Headers({ Location: env.OFFICIAL_ORIGIN });
    headers.append('Set-Cookie', clearCookie(SESSION_COOKIE));
    headers.append('Set-Cookie', clearCookie(AUTH_COOKIE));
    return new Response(null, { status: 303, headers });
  }

  if (url.pathname === '/api/me') {
    method(request, ['GET']);
    const session = await requireAuth(request, env);
    return json({
      authenticated: true,
      identityKey: session.oid + ':' + (session.authenticatedAt ?? session.exp),
      expiresAt: new Date(session.exp * 1000).toISOString(),
      name: session.name,
      roles: session.roles,
      capabilities: capabilitiesForRoles(session.roles),
    });
  }

  if (url.pathname === '/api/platform/settings/session') {
    method(request, ['GET', 'POST']);
    const currentSession = await requireAuth(request, env);
    const capabilities = capabilitiesForRoles(currentSession.roles);

    if (request.method === 'GET') {
      requireCapability(capabilities, 'platform.settings.read');
      return json(sessionPolicyPayload(currentSession));
    }

    enforceWriteOrigin(request, env);
    requireCapability(capabilities, 'platform.settings.write');
    const input = (await request.json().catch(() => null)) as { durationHours?: unknown } | null;
    if (!isSessionDurationHours(input?.durationHours)) {
      throw new HttpError(400, 'Invalid session duration');
    }

    const now = Math.floor(Date.now() / 1000);
    const updatedSession = reconfigureApplicationSession(currentSession, input.durationHours, now);
    if (!updatedSession) throw new HttpError(409, 'Reauthentication required');

    const sessionToken = await seal(updatedSession, env.SESSION_SECRET);
    const headers = new Headers();
    headers.append(
      'Set-Cookie',
      secureCookie(SESSION_COOKIE, sessionToken, { maxAge: updatedSession.exp - now }),
    );
    headers.append(
      'Set-Cookie',
      await createSessionDurationPreferenceCookie(
        env,
        currentSession.oid,
        input.durationHours,
        now,
      ),
    );
    console.info(
      JSON.stringify({
        message: 'administrative_session_duration_updated',
        durationHours: input.durationHours,
        correlationId,
      }),
    );
    return Response.json(sessionPolicyPayload(updatedSession, now), { headers });
  }

  const gradebookPersistenceAdminResponse = await handleGradebookPersistenceAdminRequestV1(request, env);
  if (gradebookPersistenceAdminResponse) return gradebookPersistenceAdminResponse;

  const retiredReportsResponse = await handleRetiredGradebookReportsRequest(request, env);
  if (retiredReportsResponse) return retiredReportsResponse;

  if (url.pathname === '/api/student-reconciliation/v1') {
    const response = await withOfficialGradebookDatabaseV1(env, (executionEnv) => handleStudentReconciliationRequestV1(request, executionEnv));
    if (response) return response;
  }

  if (url.pathname.startsWith('/api/gradebook/')) {
    const gradebookResponse = await withOfficialGradebookDatabaseV1(env, (executionEnv) =>
      routeOfficialGradebookRequestV1(request, executionEnv, gradebookAfterCommitV1(env, (work) => context.waitUntil(work))),
    );
    if (gradebookResponse) return gradebookResponse;
  }

  if (url.pathname === '/api/sharepoint/health') {
    method(request, ['GET']);
    const session = await requireAuth(request, env);
    const capabilities = capabilitiesForRoles(session.roles);
    requireCapability(capabilities, 'platform.health.read');
    return json(await sharePointHealth(env));
  }

  if (url.pathname === '/api/platform/snapshot') {
    method(request, ['GET']);
    const session = await requireAuth(request, env);
    const capabilities = capabilitiesForRoles(session.roles);
    requireCapability(capabilities, 'platform.snapshot.read');
    return json(await getPlatformSnapshot(env, capabilities));
  }

  throw new HttpError(404, 'Not found');
}

export const onRequest: PagesFunction<RuntimeEnv> = async (context) => {
  const correlationId = crypto.randomUUID();
  try {
    const pathname = new URL(context.request.url).pathname;
    const noStore = pathname.startsWith('/api/') || pathname.startsWith('/auth/');
    return withSecurityHeaders(await route(context as Context, correlationId), noStore);
  } catch (error) {
    const status =
      error instanceof HttpError ||
      error instanceof AuthenticationError ||
      error instanceof AuthorizationError
        ? error.status
        : 500;
    if (status >= 500) {
      console.error(
        JSON.stringify({
          message: 'request_failed',
          correlationId,
          path: new URL(context.request.url).pathname,
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
    return withSecurityHeaders(
      json(
        {
          error:
            status === 500
              ? 'Internal server error'
              : error instanceof Error
                ? error.message
                : 'Request failed',
          correlationId,
        },
        status,
      ),
      true,
    );
  }
};
