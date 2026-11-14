import type { RuntimeEnv } from '../env';
import { createGradebookPostgresDatabaseV1 } from '../gradebook/persistence/postgres/postgres-database-v1';

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

/** Per instance: revoked ids stay revoked; "not revoked" is trusted for a short while. */
const cacheV1 = new Map<string, { revoked: boolean; until: number }>();
function remember(sid: string, revoked: boolean, until: number) {
  if (cacheV1.size >= CACHE_LIMIT_V1) cacheV1.clear();
  cacheV1.set(sid, { revoked, until });
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
  if (cached && (cached.revoked || cached.until > now)) return cached.revoked;
  const port = portV1(env);
  if (!port) return false;
  try {
    const revoked = await port.isRevoked(sid);
    remember(sid, revoked, revoked ? expiresAtSeconds * 1000 : now + NOT_REVOKED_CACHE_MS_V1);
    return revoked;
  } catch (cause) {
    console.warn(JSON.stringify({ event: 'admin-session-revocation-read-failure-v1', error: cause instanceof Error ? cause.message.slice(0, 200) : 'unknown' }));
    return false;
  }
}

/** Records the session as ended. Never throws: "Sair" always clears the cookie. */
export async function revokeSessionV1(env: RuntimeEnv, sid: string, expiresAtSeconds: number): Promise<boolean> {
  remember(sid, true, expiresAtSeconds * 1000);
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
