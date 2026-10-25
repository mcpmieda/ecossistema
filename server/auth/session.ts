import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { RuntimeEnv } from '../env';
import { readCookie } from './cookies';
import type { Role } from './roles';
import { unseal } from './sealed';
import {
  DEFAULT_SESSION_DURATION_HOURS,
  isSessionDurationHours,
  type SessionDurationHours,
} from './session-policy';

export const SESSION_COOKIE = '__Host-ecossistema_session';
export const AUTH_COOKIE = '__Host-ecossistema_auth';

export const sessionSchema = z.object({
  oid: z.string().uuid(),
  name: z.string().min(1).max(200),
  username: z.string().max(320).optional(),
  roles: z.array(z.enum(['ADMINISTRADOR', 'PROFESSOR', 'ALUNO', 'APOIO', 'VISITANTE'])),
  authenticatedAt: z.number().int().positive().optional(),
  durationHours: z.number().int().refine(isSessionDurationHours).optional(),
  exp: z.number().int().positive(),
});
export type Session = z.infer<typeof sessionSchema> & { roles: Role[] };

type SessionIdentity = Pick<Session, 'oid' | 'name' | 'username' | 'roles'>;

export function createApplicationSession(
  identity: SessionIdentity,
  durationHours: SessionDurationHours = DEFAULT_SESSION_DURATION_HOURS,
  authenticatedAt = Math.floor(Date.now() / 1000),
): Session {
  return {
    ...identity,
    authenticatedAt,
    durationHours,
    exp: authenticatedAt + durationHours * 60 * 60,
  };
}

export function reconfigureApplicationSession(
  session: Session,
  durationHours: SessionDurationHours,
  now = Math.floor(Date.now() / 1000),
): Session | null {
  const authenticatedAt = session.authenticatedAt ?? now;
  const updated = createApplicationSession(session, durationHours, authenticatedAt);
  return updated.exp > now ? updated : null;
}

// Pages clones Request between middleware and handlers. The async scope shares only this
// request's verification; standalone callers retain Request-object memoization.
type SessionVerification = { secret: string; token: string; session: Promise<Session | null> };
const verifiedSessions = new WeakMap<Request, SessionVerification>();
const requestSessionScope = new AsyncLocalStorage<{ verification?: SessionVerification }>();

export function withRequestSessionScopeV1<T>(run: () => Promise<T>): Promise<T> {
  return requestSessionScope.run({}, run);
}

async function verifySessionToken(token: string, secret: string): Promise<Session | null> {
  const value = await unseal<unknown>(token, secret);
  const parsed = sessionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function readSession(request: Request, env: RuntimeEnv): Promise<Session | null> {
  const header = request.headers.get('Cookie') ?? '';
  if (header.length > 8192 || new TextEncoder().encode(header).byteLength > 8192) return null;
  const cookies = header.split(';').filter((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length !== 1) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(token)) return null;
  const scope = requestSessionScope.getStore();
  let cached = scope?.verification ?? verifiedSessions.get(request);
  if (cached?.secret !== env.SESSION_SECRET || cached.token !== token) {
    cached = {
      secret: env.SESSION_SECRET,
      token,
      session: verifySessionToken(token, env.SESSION_SECRET),
    };
    verifiedSessions.set(request, cached);
  }
  if (scope) scope.verification = cached;
  const session = await cached.session;
  if (!session || session.exp <= Math.floor(Date.now() / 1000)) return null;
  // Do not expose the memoized roles object to a handler that could mutate it.
  return { ...session, roles: [...session.roles] };
}

export async function requireAuth(request: Request, env: RuntimeEnv): Promise<Session> {
  const session = await readSession(request, env);
  if (!session) throw new AuthenticationError();
  return session;
}

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor() {
    super('Unauthorized');
  }
}
