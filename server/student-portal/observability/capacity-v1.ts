import {
  isPortalCapacitySampleV1,
  type PortalCapacitySampleV1,
} from '../../../shared/portal-capacity-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';

/** Catalogs only. The size is the current database, not disk capacity or a plan quota.
 * Normal client connections span databases, matching rolconnlimit, and include this reader.
 * Activity and waits overlap; they must not be added to the total. */
export async function readPortalCapacityV1(
  sql: StudentPortalPostgresSqlV1,
): Promise<PortalCapacitySampleV1> {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await tx.unsafe("SET LOCAL statement_timeout = '1500ms'");
    await tx.unsafe("SET LOCAL lock_timeout = '250ms'");
    const rows = await tx.unsafe(`WITH connections AS (
      SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE state='active')::integer AS active,
        count(*) FILTER (WHERE wait_event_type='Lock')::integer AS waiting,
        count(*) FILTER (WHERE state IS NULL OR state='disabled')::integer AS untracked
      FROM pg_stat_activity WHERE usename=current_user AND backend_type='client backend'
    ) SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
      pg_database_size(current_database())::text AS database_bytes,
      total AS portal_connections, active AS portal_active, waiting AS portal_waiting,
      current_setting('track_activities')::boolean AND untracked=0 AS activity_visible,
      (SELECT NULLIF(rolconnlimit,-1) FROM pg_roles WHERE rolname=current_user) AS portal_connection_limit,
      current_setting('max_connections')::integer AS server_max_connections,
      (current_setting('reserved_connections')::integer + current_setting('superuser_reserved_connections')::integer) AS server_reserved_connections
      FROM connections`);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row?.activity_visible !== true ||
      typeof row.database_bytes !== 'string' ||
      !/^\d{1,16}$/u.test(row.database_bytes)
    )
      throw new Error('capacity-invalid-sample');
    const sample = {
      version: 1,
      source: 'postgresql',
      state: 'ok',
      observedAt: row.observed_at,
      metrics: {
        databaseBytes: Number(row.database_bytes),
        portalConnections: row.portal_connections,
        portalActive: row.portal_active,
        portalWaiting: row.portal_waiting,
        portalConnectionLimit: row.portal_connection_limit,
        serverMaxConnections: row.server_max_connections,
        serverReservedConnections: row.server_reserved_connections,
      },
    };
    if (!isPortalCapacitySampleV1(sample)) throw new Error('capacity-invalid-sample');
    return sample;
  });
}
