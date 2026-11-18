import { ACCESS_AREA_IDS, type AccessArea } from '../../shared/platform-contract';
import type { AccessGrantChangeViewV1 } from '../../shared/platform-access-v1';
import type { RuntimeEnv } from '../env';
import { createGradebookPostgresDatabaseV1 } from '../gradebook/persistence/postgres/postgres-database-v1';
import { joinFlightV1 } from '../http/shared-flight-v1';

/**
 * Areas of the Centro opened to people outside the admin group (#1513), kept by the person's Entra
 * id (oid), which a renamed or reused sign-in name never carries to someone else (#1530 A3). Read on
 * each request of such a session, cached briefly, so a change takes effect within GRANT_CACHE_MS_V1.
 */
export const GRANT_CACHE_MS_V1 = 30_000;
const CACHE_LIMIT_V1 = 1000;
/** A read in flight is shared only this long (a little over the connection timeout). */
const PENDING_SHARE_MS_V1 = 4_000;
const FAILURE_CACHE_MS_V1 = 5_000;
export const ACCESS_EMAIL_PATTERN_V1 = /^[^\s@]{1,64}@[^\s@]{1,255}$/u;
const OID_PATTERN_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type AccessGrantV1 = {
  oid: string;
  email: string;
  areas: AccessArea[];
  updatedAt: string;
  updatedBy: string | null;
};

export type AccessGrantsPortV1 = {
  areasFor(oid: string): Promise<AccessArea[]>;
  list(): Promise<AccessGrantV1[]>;
  /**
   * Writes the person's areas (none removes the grant) and its history line in one transaction.
   * With the sign-in name, a new grant (`changed` when the person already has one). Without it, an
   * edit of the grant read before: `changed` when it is gone or `expectedUpdatedAt` is no longer
   * its version.
   */
  change(
    person: { oid: string; email?: string },
    areas: readonly AccessArea[],
    actor: { oid: string; name: string },
    expectedUpdatedAt?: string,
  ): Promise<'saved' | 'changed'>;
  history(limit: number): Promise<AccessGrantChangeViewV1[]>;
};

export const normalizeAccessEmailV1 = (value: string): string => value.trim().toLowerCase();

/**
 * The areas of a row. The query hands them over as plain text ("saude,importacao"): the driver
 * returns a Postgres array as its literal, never as a list.
 */
export function areasFromDatabaseV1(value: unknown): AccessArea[] {
  const values: unknown[] =
    typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return ACCESS_AREA_IDS.filter((area) => values.includes(area));
}

type HyperdriveBindingV1 = { readonly connectionString: string };
const clip = (value: string, length: number) => value.slice(0, length) || '—';

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
    areasFor: (oid) =>
      withDatabase(async (db) => {
        const rows = await db.query<{ areas: unknown }>(
          "SELECT array_to_string(areas, ',') AS areas FROM admin_access.area_grant_v1 WHERE oid=$1::uuid",
          [oid],
        );
        return areasFromDatabaseV1(rows[0]?.areas);
      }),
    list: () =>
      withDatabase(async (db) => {
        const rows = await db.query<{
          oid: string;
          email: string;
          areas: unknown;
          updated_at: Date | string;
          updated_by: string | null;
        }>(
          "SELECT oid::text AS oid, email, array_to_string(areas, ',') AS areas, updated_at, updated_by FROM admin_access.area_grant_v1 ORDER BY email, oid",
          [],
        );
        return rows.map((row) => ({
          oid: row.oid,
          email: row.email,
          areas: areasFromDatabaseV1(row.areas),
          updatedAt: new Date(row.updated_at).toISOString(),
          updatedBy: row.updated_by,
        }));
      }),
    change: (person, areas, actor, expectedUpdatedAt) =>
      withDatabase((db) =>
        db.transaction(async (transaction) => {
          // One change per person at a time, even before the person has a row to lock; then the
          // row is read locked, so "before" in the history is what this change replaced.
          await transaction.executeNative(
            "SELECT pg_advisory_xact_lock(hashtext('admin_access.area-grant:' || $1))",
            [person.oid],
          );
          const rows = await transaction.query<{
            email: string;
            areas: unknown;
            updated_at: Date | string;
          }>(
            `SELECT email, array_to_string(areas, ',') AS areas, updated_at
               FROM admin_access.area_grant_v1 WHERE oid = $1::uuid FOR UPDATE`,
            [person.oid],
          );
          const current = rows[0];
          // A new grant for someone who already has one (a list read before it existed) does not
          // overwrite it: the list is read again and the grant edited.
          if (person.email && current) return 'changed';
          if (!person.email) {
            if (!current) return 'changed';
            if (
              expectedUpdatedAt &&
              new Date(current.updated_at).toISOString() !==
                new Date(expectedUpdatedAt).toISOString()
            )
              return 'changed';
          }
          const email = person.email ?? current!.email;
          if (areas.length === 0) {
            if (!current) return 'saved';
            await transaction.executeNative(
              'DELETE FROM admin_access.area_grant_v1 WHERE oid = $1::uuid',
              [person.oid],
            );
          } else
            await transaction.executeNative(
              `INSERT INTO admin_access.area_grant_v1 (oid, email, areas, updated_by, updated_at)
               VALUES ($1::uuid, $2, ARRAY(SELECT jsonb_array_elements_text($3::text::jsonb)), $4,
                       statement_timestamp())
               ON CONFLICT (oid) DO UPDATE
                 SET email = excluded.email, areas = excluded.areas,
                     updated_by = excluded.updated_by,
                     -- Each version differs at the millisecond the screen compares.
                     updated_at = greatest(
                       excluded.updated_at,
                       date_trunc('milliseconds', admin_access.area_grant_v1.updated_at)
                         + interval '1 millisecond'
                     )`,
              [person.oid, email, JSON.stringify(areas), clip(actor.name, 200)],
            );
          await transaction.executeNative(
            `INSERT INTO admin_access.area_grant_change_v1
               (actor_oid, actor_name, target_oid, target_email, before_areas, after_areas)
             VALUES ($1::uuid, $2, $3::uuid, $4,
                     coalesce(string_to_array(nullif($5, ''), ','), '{}'::text[]),
                     ARRAY(SELECT jsonb_array_elements_text($6::text::jsonb)))`,
            [
              actor.oid,
              clip(actor.name, 200),
              person.oid,
              email,
              areasFromDatabaseV1(current?.areas).join(','),
              JSON.stringify(areas),
            ],
          );
          return 'saved';
        }),
      ),
    history: (limit) =>
      withDatabase(async (db) => {
        const rows = await db.query<{
          at: Date | string;
          actor_name: string;
          target_email: string;
          before_areas: unknown;
          after_areas: unknown;
        }>(
          `SELECT at, actor_name, target_email,
                  array_to_string(before_areas, ',') AS before_areas,
                  array_to_string(after_areas, ',') AS after_areas
             FROM admin_access.area_grant_change_v1
            ORDER BY at DESC, id DESC
            LIMIT $1`,
          [limit],
        );
        return rows.map((row) => ({
          at: new Date(row.at).toISOString(),
          actor: row.actor_name,
          email: row.target_email,
          before: areasFromDatabaseV1(row.before_areas),
          after: areasFromDatabaseV1(row.after_areas),
        }));
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

type CacheEntryV1 = {
  readonly areas: Promise<AccessArea[]>;
  readonly until: number;
  readonly settled: boolean;
  readonly startedAt: number;
};
const cacheV1 = new Map<string, CacheEntryV1>();
function rememberV1(oid: string, entry: CacheEntryV1) {
  if (cacheV1.size >= CACHE_LIMIT_V1 && !cacheV1.has(oid)) cacheV1.clear();
  cacheV1.set(oid, entry);
}

/** A change made on this instance is seen at once; other instances see it within the cache. */
export function forgetAccessGrantV1(oid: string): void {
  cacheV1.delete(oid.toLowerCase());
}

/**
 * The areas opened to this person. Without a database nothing is opened, and a failed read opens
 * nothing (the person keeps only what the role gives) and is retried after a short while.
 *
 * A read in flight is shared with the other requests of this isolate only briefly: its I/O belongs
 * to the request that started it, and if that one is cancelled the answer never comes (#1530 A1).
 */
export async function accessAreasForV1(
  env: RuntimeEnv,
  personOid: string | undefined,
  now = Date.now(),
): Promise<AccessArea[]> {
  if (!personOid) return [];
  const oid = personOid.toLowerCase();
  if (!OID_PATTERN_V1.test(oid)) return [];
  const cached = cacheV1.get(oid);
  if (cached?.settled && cached.until > now) return cached.areas;
  let port: AccessGrantsPortV1 | null;
  try {
    port = accessGrantsPortV1(env);
  } catch {
    return [];
  }
  if (!port) return [];
  const ownRead = () =>
    port.areasFor(oid).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: 'access_grants_read_failed',
          message: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return [] as AccessArea[];
    });
  if (cached && !cached.settled && now - cached.startedAt < PENDING_SHARE_MS_V1)
    return joinFlightV1(cached.areas, PENDING_SHARE_MS_V1 - (now - cached.startedAt), ownRead);

  const read: Promise<AccessArea[]> = port.areasFor(oid).then(
    (areas) => {
      // A change saved during the read (forgetAccessGrantV1) is never overwritten by it.
      if (cacheV1.get(oid)?.areas === read)
        rememberV1(oid, {
          areas: Promise.resolve(areas),
          until: Date.now() + GRANT_CACHE_MS_V1,
          settled: true,
          startedAt: 0,
        });
      return areas;
    },
    (error: unknown) => {
      console.error(
        JSON.stringify({
          event: 'access_grants_read_failed',
          message: error instanceof Error ? error.name : 'unknown',
        }),
      );
      if (cacheV1.get(oid)?.areas === read)
        rememberV1(oid, {
          areas: Promise.resolve([]),
          until: Date.now() + FAILURE_CACHE_MS_V1,
          settled: true,
          startedAt: 0,
        });
      return [] as AccessArea[];
    },
  );
  rememberV1(oid, { areas: read, until: now + GRANT_CACHE_MS_V1, settled: false, startedAt: now });
  return read;
}
