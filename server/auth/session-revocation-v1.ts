import type { RuntimeEnv } from '../env';
import { createGradebookPostgresDatabaseV1 } from '../gradebook/persistence/postgres/postgres-database-v1';
import { joinFlightV1 } from '../http/shared-flight-v1';

/**
 * "Sair" ends the ADM session on the server too (owner decision 13/11/2026): the sealed cookie
 * carries a session id (`sid`), and "Sair" records it in admin_session.revoked_v1 until the cookie
 * would expire. A copy of the cookie kept on a shared computer stops working within
 * NOT_REVOKED_CACHE_MS on every server instance.
 */
export const SESSION_ID_PATTERN_V1 = /^[A-Za-z0-9_-]{22}$/u;
/** How long an instance trusts "not revoked" before asking the database again. */
export const NOT_REVOKED_CACHE_MS_V1 = 30_000;
const CACHE_LIMIT_V1 = 1000;

export type SessionRevocationPortV1 = {
  isRevoked(sid: string): Promise<boolean>;
  revoke(sid: string, expiresAtSeconds: number): Promise<void>;
};

/** A new random session id: 128 bits, base64url (22 characters). */
export function newSessionIdV1(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Base64 padding ("=") only ever appears at the end.
  return btoa(String.fromCodePoint(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

type HyperdriveBindingV1 = { readonly connectionString: string };

function postgresRevocationV1(connectionString: string): SessionRevocationPortV1 {
  const withDatabase = async <T>(run: (db: Awaited<ReturnType<typeof createGradebookPostgresDatabaseV1>>) => Promise<T>) => {
    const db = await createGradebookPostgresDatabaseV1(connectionString, {
      maximumConnections: 1,
      connectTimeoutSeconds: 3,
      statementTimeoutMilliseconds: 3000,
    });
    try {
      return await run(db);
    } finally {
      await db.close().catch(() => undefined);
    }
  };
  return {
    isRevoked: (sid) =>
      withDatabase(async (db) => {
        const rows = await db.query<{ revoked: unknown }>(
          'SELECT EXISTS (SELECT 1 FROM admin_session.revoked_v1 WHERE sid=$1) AS revoked',
          [sid],
        );
        return rows[0]?.revoked === true;
      }),
    revoke: (sid, expiresAtSeconds) =>
      withDatabase(async (db) => {
        await db.executeNative(
          `INSERT INTO admin_session.revoked_v1 (sid, expires_at) VALUES ($1, to_timestamp($2))
           ON CONFLICT (sid) DO NOTHING`,
          [sid, expiresAtSeconds],
        );
        // Ids whose cookie has expired anyway do not pile up.
        await db.executeNative('DELETE FROM admin_session.revoked_v1 WHERE expires_at < statement_timestamp()', []);
      }),
  };
}

let overridePortV1: SessionRevocationPortV1 | null | undefined;
/** Tests replace the database; `undefined` restores it. */
export function setSessionRevocationPortForTestsV1(port: SessionRevocationPortV1 | null | undefined): void {
  overridePortV1 = port;
  cacheV1.clear();
}

function portV1(env: RuntimeEnv): SessionRevocationPortV1 | null {
  if (overridePortV1 !== undefined) return overridePortV1;
  const binding = env.PROD_DB as Partial<HyperdriveBindingV1> | undefined;
  if (!binding || typeof binding.connectionString !== 'string' || binding.connectionString === '') return null;
  return postgresRevocationV1(binding.connectionString);
}

/** After a failed read, the session is let through without asking again for this long. */
export const FAILURE_CACHE_MS_V1 = 15_000;

/**
 * Per instance: revoked ids stay revoked; "not revoked" is trusted for a short while. The entry
 * holds the read itself while it runs, so the ADM's simultaneous requests of one session share a
 * single database question (issue #1426, 3), and a failed read is remembered briefly, so a
 * database outage does not slow every request by the connection timeout.
 */
type CacheEntryV1 = {
  readonly revoked: Promise<boolean>; readonly until: number; readonly settled: boolean; readonly startedAt?: number;
};
/** A read in flight is shared only this long (a little over the connection timeout, issue #1450, 2). */
export const PENDING_SHARE_MS_V1 = 4_000;
const cacheV1 = new Map<string, CacheEntryV1>();
function remember(sid: string, entry: CacheEntryV1) {
  if (cacheV1.size >= CACHE_LIMIT_V1 && !cacheV1.has(sid)) cacheV1.clear();
  cacheV1.set(sid, entry);
}

/**
 * Whether "Sair" ended this session. Without a database (tests, local) nothing is revoked. A
 * failed read lets the session through (a database outage must not sign everyone out) and is logged.
 */
export async function isSessionRevokedV1(
  env: RuntimeEnv,
  sid: string,
  expiresAtSeconds: number,
  now = Date.now(),
): Promise<boolean> {
  const cached = cacheV1.get(sid);
  if (cached?.settled && cached.until > now) return cached.revoked;
  const port = portV1(env);
  if (!port) return false;
  // Another request of this instance is asking already: wait for it, but only briefly. Its I/O
  // belongs to that request, and if that one is cancelled the answer never comes (issue #1450, 2).
  const startedAt = cached?.startedAt ?? 0;
  if (cached && !cached.settled && now - startedAt < PENDING_SHARE_MS_V1)
    return joinFlightV1(cached.revoked, PENDING_SHARE_MS_V1 - (now - startedAt), () =>
      port.isRevoked(sid).catch(() => false));
  const read = port.isRevoked(sid).then(
    (revoked) => {
      // "Sair" during the read already stored the revocation: it is never overwritten.
      if (cacheV1.get(sid)?.revoked === read)
        remember(sid, { revoked: Promise.resolve(revoked), settled: true,
          until: revoked ? expiresAtSeconds * 1000 : Date.now() + NOT_REVOKED_CACHE_MS_V1 });
      return revoked;
    },
    (cause: unknown) => {
      console.warn(JSON.stringify({ event: 'admin-session-revocation-read-failure-v1', error: cause instanceof Error ? cause.message.slice(0, 200) : 'unknown' }));
      if (cacheV1.get(sid)?.revoked === read)
        remember(sid, { revoked: Promise.resolve(false), settled: true, until: Date.now() + FAILURE_CACHE_MS_V1 });
      return false;
    },
  );
  remember(sid, { revoked: read, settled: false, until: now + PENDING_SHARE_MS_V1, startedAt: now });
  return read;
}

/** Records the session as ended. Never throws: "Sair" always clears the cookie. */
export async function revokeSessionV1(env: RuntimeEnv, sid: string, expiresAtSeconds: number): Promise<boolean> {
  remember(sid, { revoked: Promise.resolve(true), settled: true, until: expiresAtSeconds * 1000 });
  const port = portV1(env);
  if (!port) return false;
  try {
    await port.revoke(sid, expiresAtSeconds);
    return true;
  } catch (cause) {
    console.warn(JSON.stringify({ event: 'admin-session-revocation-write-failure-v1', error: cause instanceof Error ? cause.message.slice(0, 200) : 'unknown' }));
    return false;
  }
}
