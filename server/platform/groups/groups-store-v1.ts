import type {
  GroupChangeActionV1,
  GroupChangeOutcomeV1,
  GroupChangeV1,
} from '../../../shared/platform-groups-v1';
import type { RuntimeEnv } from '../../env';
import { createGradebookPostgresDatabaseV1 } from '../../gradebook/persistence/postgres/postgres-database-v1';

/** The groups the Centro created, and the history of every change made from it (#1513). */
export type ManagedGroupV1 = { id: string; name: string; createdBy: string; createdAt: string };

export type GroupChangeRecordV1 = {
  actorOid: string;
  actorName: string;
  action: GroupChangeActionV1;
  groupId: string | null;
  groupName: string | null;
  target: string | null;
  outcome: GroupChangeOutcomeV1;
  correlationId: string | null;
};

export type GroupsStorePortV1 = {
  managedGroups(): Promise<ManagedGroupV1[]>;
  addManagedGroup(group: { id: string; name: string; createdBy: string }): Promise<void>;
  removeManagedGroup(id: string): Promise<void>;
  record(change: GroupChangeRecordV1): Promise<void>;
  history(groupId: string | null, limit: number): Promise<GroupChangeV1[]>;
  /**
   * Runs one rule save at a time across every instance (a transaction-scoped advisory lock), so two
   * saves never both pass the duplicate check (#1530 S1). The lock ends with the transaction.
   */
  serializeRuleSaves<T>(run: () => Promise<T>): Promise<T>;
};

/** The database could not even be reached for the lock: nothing ran under it. */
export class RuleLockUnreachableV1 extends Error {
  constructor() {
    super('rule-lock-unreachable');
  }
}

type HyperdriveBindingV1 = { readonly connectionString: string };

const clip = (value: string | null, length: number) =>
  value === null ? null : value.slice(0, length);

function postgresGroupsStoreV1(connectionString: string): GroupsStorePortV1 {
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
    managedGroups: () =>
      withDatabase(async (db) => {
        const rows = await db.query<{
          group_id: string;
          name: string;
          created_by: string;
          created_at: Date | string;
        }>(
          'SELECT group_id::text AS group_id, name, created_by, created_at FROM admin_access.managed_group_v1 ORDER BY name',
          [],
        );
        return rows.map((row) => ({
          id: row.group_id,
          name: row.name,
          createdBy: row.created_by,
          createdAt: new Date(row.created_at).toISOString(),
        }));
      }),
    addManagedGroup: ({ id, name, createdBy }) =>
      withDatabase(async (db) => {
        await db.executeNative(
          `INSERT INTO admin_access.managed_group_v1 (group_id, name, created_by)
           VALUES ($1::uuid, $2, $3) ON CONFLICT (group_id) DO NOTHING`,
          [id, clip(name, 120), clip(createdBy, 200)],
        );
      }),
    removeManagedGroup: (id) =>
      withDatabase(async (db) => {
        await db.executeNative(
          'DELETE FROM admin_access.managed_group_v1 WHERE group_id = $1::uuid',
          [id],
        );
      }),
    record: (change) =>
      withDatabase(async (db) => {
        await db.executeNative(
          `INSERT INTO admin_access.group_change_v1
             (actor_oid, actor_name, action, group_id, group_name, target, outcome, correlation_id)
           VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8)`,
          [
            change.actorOid,
            clip(change.actorName, 200) || '—',
            change.action,
            change.groupId,
            clip(change.groupName, 120),
            clip(change.target, 320),
            change.outcome,
            clip(change.correlationId, 64),
          ],
        );
      }),
    serializeRuleSaves: async (run) => {
      let reached = false;
      try {
        return await withDatabase((db) =>
          db.transaction(async (transaction) => {
            reached = true;
            // Waiting for another save may take longer than one statement usually does.
            await transaction.executeNative("SET LOCAL statement_timeout = '15s'", []);
            await transaction.executeNative(
              "SELECT pg_advisory_xact_lock(hashtext('admin_access.group-rules'))",
              [],
            );
            return run();
          }),
        );
      } catch (error) {
        // Only a database that never answered lets the caller go on without the lock; a lock held
        // too long by another save, or any later failure, is a failure.
        if (!reached) throw new RuleLockUnreachableV1();
        throw error;
      }
    },
    history: (groupId, limit) =>
      withDatabase(async (db) => {
        const rows = await db.query<{
          at: Date | string;
          actor_name: string;
          action: GroupChangeActionV1;
          group_id: string | null;
          group_name: string | null;
          target: string | null;
          outcome: GroupChangeOutcomeV1;
        }>(
          `SELECT at, actor_name, action, group_id::text AS group_id, group_name, target, outcome
             FROM admin_access.group_change_v1
            WHERE $1::uuid IS NULL OR group_id = $1::uuid
            ORDER BY at DESC, id DESC
            LIMIT $2`,
          [groupId, limit],
        );
        return rows.map((row) => ({
          at: new Date(row.at).toISOString(),
          actor: row.actor_name,
          action: row.action,
          groupId: row.group_id,
          groupName: row.group_name,
          target: row.target,
          outcome: row.outcome,
        }));
      }),
  };
}

let overrideStoreV1: GroupsStorePortV1 | null | undefined;
/** Tests replace the database; `undefined` restores it. */
export function setGroupsStoreForTestsV1(port: GroupsStorePortV1 | null | undefined): void {
  overrideStoreV1 = port;
}

export function groupsStoreV1(env: RuntimeEnv): GroupsStorePortV1 | null {
  if (overrideStoreV1 !== undefined) return overrideStoreV1;
  const binding = env.PROD_DB as Partial<HyperdriveBindingV1> | undefined;
  if (!binding || typeof binding.connectionString !== 'string' || binding.connectionString === '')
    return null;
  return postgresGroupsStoreV1(binding.connectionString);
}
