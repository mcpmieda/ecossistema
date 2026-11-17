import { ACCESS_AREA_IDS, type AccessArea } from '../../shared/platform-contract';
import type { RuntimeEnv } from '../env';
import { createGradebookPostgresDatabaseV1 } from '../gradebook/persistence/postgres/postgres-database-v1';

/**
 * Areas of the Centro opened to people outside the admin group (#1513), keyed by the sign-in
 * name (UPN) so an administrator can open an area before the person's first sign-in. Read on each
 * request of such a session, cached briefly, so a change takes effect within GRANT_CACHE_MS_V1.
 */
export const GRANT_CACHE_MS_V1 = 30_000;
const CACHE_LIMIT_V1 = 1000;
export const ACCESS_EMAIL_PATTERN_V1 = /^[^\s@]{1,64}@[^\s@]{1,255}$/u;

export type AccessGrantV1 = {
  email: string;
  areas: AccessArea[];
  updatedAt: string;
  updatedBy: string | null;
};

export type AccessGrantsPortV1 = {
  areasFor(email: string): Promise<AccessArea[]>;
  list(): Promise<AccessGrantV1[]>;
  save(email: string, areas: readonly AccessArea[], actor: { name: string }): Promise<void>;
};

export const normalizeAccessEmailV1 = (value: string): string => value.trim().toLowerCase();

const knownAreas = (values: unknown): AccessArea[] =>
  Array.isArray(values) ? ACCESS_AREA_IDS.filter((area) => values.includes(area)) : [];

type HyperdriveBindingV1 = { readonly connectionString: string };

function postgresGrantsV1(connectionString: string): AccessGrantsPortV1 {
  const withDatabase = async <T>(
    run: (db: Awaited<ReturnType<typeof createGradebookPostgresDatabaseV1>>) => Promise<T>,
  ) => {
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
    areasFor: (email) =>
      withDatabase(async (db) => {
        const rows = await db.query<{ areas: unknown }>(
          'SELECT areas FROM admin_access.area_grant_v1 WHERE email=$1',
          [email],
        );
        return knownAreas(rows[0]?.areas);
      }),
    list: () =>
      withDatabase(async (db) => {
        const rows = await db.query<{
          email: string;
          areas: unknown;
          updated_at: Date | string;
          updated_by: string | null;
        }>(
          'SELECT email, areas, updated_at, updated_by FROM admin_access.area_grant_v1 ORDER BY email',
          [],
        );
        return rows.map((row) => ({
          email: row.email,
          areas: knownAreas(row.areas),
          updatedAt: new Date(row.updated_at).toISOString(),
          updatedBy: row.updated_by,
        }));
      }),
    save: (email, areas, actor) =>
      withDatabase(async (db) => {
        if (areas.length === 0) {
          await db.executeNative('DELETE FROM admin_access.area_grant_v1 WHERE email=$1', [email]);
          return;
        }
        await db.executeNative(
          `INSERT INTO admin_access.area_grant_v1 (email, areas, updated_by, updated_at)
           VALUES ($1, ARRAY(SELECT jsonb_array_elements_text($2::text::jsonb)), $3, statement_timestamp())
           ON CONFLICT (email) DO UPDATE
             SET areas = excluded.areas, updated_by = excluded.updated_by,
                 updated_at = excluded.updated_at`,
          [email, JSON.stringify(areas), actor.name],
        );
      }),
  };
}

let overridePortV1: AccessGrantsPortV1 | null | undefined;
/** Tests replace the database; `undefined` restores it. */
export function setAccessGrantsPortForTestsV1(port: AccessGrantsPortV1 | null | undefined): void {
  overridePortV1 = port;
  cacheV1.clear();
}

export function accessGrantsPortV1(env: RuntimeEnv): AccessGrantsPortV1 | null {
  if (overridePortV1 !== undefined) return overridePortV1;
  const binding = env.PROD_DB as Partial<HyperdriveBindingV1> | undefined;
  if (!binding || typeof binding.connectionString !== 'string' || binding.connectionString === '')
    return null;
  return postgresGrantsV1(binding.connectionString);
}

type CacheEntryV1 = { readonly areas: Promise<AccessArea[]>; readonly until: number };
const cacheV1 = new Map<string, CacheEntryV1>();

/** A change made on this instance is seen at once; other instances see it within the cache. */
export function forgetAccessGrantV1(email: string): void {
  cacheV1.delete(normalizeAccessEmailV1(email));
}

/**
 * The areas opened to this sign-in name. Without a database nothing is opened, and a failed read
 * opens nothing (the person keeps only what the role gives) and is retried after a short while.
 */
export async function accessAreasForV1(
  env: RuntimeEnv,
  username: string | undefined,
  now = Date.now(),
): Promise<AccessArea[]> {
  if (!username) return [];
  const email = normalizeAccessEmailV1(username);
  if (!ACCESS_EMAIL_PATTERN_V1.test(email)) return [];
  const cached = cacheV1.get(email);
  if (cached && cached.until > now) return cached.areas;
  let port: AccessGrantsPortV1 | null;
  try {
    port = accessGrantsPortV1(env);
  } catch {
    return [];
  }
  if (!port) return [];
  const areas = port.areasFor(email).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'access_grants_read_failed',
        message: error instanceof Error ? error.name : 'unknown',
      }),
    );
    cacheV1.set(email, { areas: Promise.resolve([]), until: Date.now() + 5_000 });
    return [] as AccessArea[];
  });
  if (cacheV1.size >= CACHE_LIMIT_V1 && !cacheV1.has(email)) cacheV1.clear();
  cacheV1.set(email, { areas, until: now + GRANT_CACHE_MS_V1 });
  return areas;
}
