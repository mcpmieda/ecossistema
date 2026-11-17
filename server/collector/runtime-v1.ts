import { z } from 'zod';
import type { RuntimeEnv } from '../env';
import { graphRequest } from '../graph/client';
import { CollectorAuthorizationStoreV1, type CollectorSqlV1 } from './authorization-store-v1';
import { CollectorPairingStoreV1 } from './pairing-store-v1';
import { CollectorAccessServiceV1 } from './access-service-v1';
import type { CollectorDirectoryDependenciesV1 } from './directory-v1';

export type CollectorDatabaseV1 = CollectorSqlV1 & { close: () => Promise<void> };
/** Built once, not on every collector request. */
const databaseBindingSchema = z.object({ connectionString: z.string().min(1) });
type CollectorRuntimeV1 = {
  access: CollectorAccessServiceV1;
  pairings: CollectorPairingStoreV1;
  directory: CollectorDirectoryDependenciesV1;
  close: () => Promise<void>;
};
export type CollectorRuntimeDependenciesV1 = {
  database?: (connectionString: string) => Promise<CollectorDatabaseV1>;
  now?: () => number;
  graph?: CollectorDirectoryDependenciesV1['graph'];
};
/** A directory read may not hold a collector request open: Graph answers these in under a second. */
const DIRECTORY_BUDGET_MS = 10_000;
async function database(connectionString: string): Promise<CollectorDatabaseV1> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, {
    max: 1,
    fetch_types: false,
    prepare: true,
    connect_timeout: 8,
    idle_timeout: 2,
    max_lifetime: 30,
    connection: {
      application_name: 'ecossistema-collector',
      statement_timeout: 10_000,
      lock_timeout: 3000,
      idle_in_transaction_session_timeout: 10_000,
    },
  });
  return {
    query: async <T extends Record<string, unknown>>(text: string, parameters: unknown[]) =>
      Array.from(await sql.unsafe(text, parameters as never[])) as T[],
    close: async () => {
      await sql.end({ timeout: 3 });
    },
  };
}

/** Names only the failed setup step, never a value, so ACCESS_NOT_CONFIGURED is traceable. */
function unavailable(stage: string): void {
  console.error(JSON.stringify({ message: 'collector_runtime_unavailable', stage }));
}

export async function createCollectorWithdrawalStoreV1(
  env: RuntimeEnv,
  dependencies: CollectorRuntimeDependenciesV1 = {},
) {
  let db: CollectorDatabaseV1 | undefined;
  try {
    if (env.OFFICIAL_ORIGIN !== 'https://admin.escolaieda.com') return null;
    const connection = databaseBindingSchema.parse(env.COLLECTOR_DB);
    db = await (dependencies.database ?? database)(connection.connectionString);
    return { store: new CollectorAuthorizationStoreV1(db), close: () => db!.close() };
  } catch {
    unavailable('withdrawal-storage');
    if (db) await db.close().catch(() => undefined);
    return null;
  }
}
/** Before every collector request, the storage check and the cleanups would cost 5 queries each,
 * ~31 thousand times a day for two computers. The grants do not change between requests: once
 * seen, they are not asked again in this isolate (if a migration took one away, the next real
 * query fails and the request answers unavailable). Retiring abandoned pairings stays on every
 * request (it revokes credentials). The retention cleanup runs only on the pairing pages: the
 * database job collector-frequency-retention-v2 (pg_cron, every 15 min) does the same everywhere
 * else. "At most once a minute" per isolate still meant ~12 runs a minute across the Pages
 * instances. */
let collectorStorageReadyV1 = false;
/** For tests: forget what this isolate already checked. */
export function resetCollectorRuntimeMemoryV1(): void {
  collectorStorageReadyV1 = false;
}
/** Dedicated optional database binding, with no fallback to PROD_DB. The person's standing in the
 * directory is read by the Graph Backend app (owner decision of 17/11/2026): no Microsoft
 * credential of the person is kept, so nothing the person consents to elsewhere can end a grant. */
export async function createCollectorRuntimeV1(
  env: RuntimeEnv,
  dependencies: CollectorRuntimeDependenciesV1 = {},
  options: { readonly pairingRoute?: boolean } = {},
): Promise<CollectorRuntimeV1 | null> {
  if (env.COLLECTOR_ENABLED !== 'true' || env.OFFICIAL_ORIGIN !== 'https://admin.escolaieda.com')
    return null;
  let db: CollectorDatabaseV1 | undefined;
  let stage = 'database-binding';
  try {
    const connection = databaseBindingSchema.parse(env.COLLECTOR_DB);
    stage = 'database-connection';
    db = await (dependencies.database ?? database)(connection.connectionString);
    stage = 'database-privileges';
    if (!collectorStorageReadyV1) {
      const ready = await db.query<{ ready: boolean }>(
        `SELECT count(*)=4 AND bool_and(has_schema_privilege(current_user,n.oid,'USAGE')
        AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
        AND has_table_privilege(current_user,c.oid,'UPDATE')) AS ready FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='collector_auth' AND c.relkind='r' AND c.relname IN ('pairings','challenges','devices','oauth_grants')`,
        [],
      );
      if (ready[0]?.ready !== true) throw new Error('storage-unavailable');
      collectorStorageReadyV1 = true;
    }
    stage = 'pairing-cleanup';
    const pairings = new CollectorPairingStoreV1(db);
    // Security first: an abandoned pairing loses its credentials on the very next request.
    await pairings.retireExpiredUnclaimed();
    if (options.pairingRoute === true) await pairings.purgeFinished();
    const directory: CollectorDirectoryDependenciesV1 = {
      now: dependencies.now ?? Date.now,
      graph:
        dependencies.graph ??
        (async (input) =>
          (await graphRequest<unknown>({ env, ...input, budgetMs: DIRECTORY_BUDGET_MS })).data),
    };
    const access = new CollectorAccessServiceV1(
      new CollectorAuthorizationStoreV1(db),
      { tenantId: env.TENANT_ID, clientId: env.WEB_CLIENT_ID, adminGroupId: env.GROUP_ADMIN_ID },
      directory,
    );
    return { access, pairings, directory, close: () => db!.close() };
  } catch {
    unavailable(stage);
    if (db) await db.close().catch(() => undefined);
    return null;
  }
}
