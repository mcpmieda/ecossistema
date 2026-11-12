import {
  VIEW_PREFERENCE_MAX_KEYS_V1,
  viewPreferencesSaveSchemaV1,
  type ViewPreferencesResponseV1,
  type ViewPreferencesSaveV1,
} from '../../../../shared/gradebook-contracts/settings/view-preferences-v1';
import type {
  GradebookPostgresTransactionV1,
  GradebookPostgresWritePortV1,
} from '../../persistence/postgres/postgres-database-v1';
import { postgresJsonTextV1 } from '../../persistence/postgres/postgres-values-v1';

type Database = GradebookPostgresWritePortV1 & {
  transaction?<T>(run: (db: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};
type ViewsV1 = ViewPreferencesSaveV1['views'];

const ACTOR_PATTERN_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const failure = (
  state: Exclude<ViewPreferencesResponseV1['state'], 'ready'>,
): ViewPreferencesResponseV1 => ({ contractVersion: 1, state });

/** Each account reads and writes only its own rows; the actor comes from the session. */
export function createViewPreferencesServiceV1(database: Database) {
  async function readViews(db: GradebookPostgresWritePortV1, actorId: string): Promise<ViewsV1> {
    const rows = await db.query<{ view_key: unknown; view_value: unknown }>(
      `SELECT view_key, view_value::text AS view_value FROM admin_preferences.view_state_v1
        WHERE actor_id=$1::uuid ORDER BY updated_at DESC LIMIT $2`,
      [actorId, VIEW_PREFERENCE_MAX_KEYS_V1],
    );
    const views: ViewsV1 = {};
    for (const row of rows) {
      if (typeof row.view_key !== 'string' || typeof row.view_value !== 'string') continue;
      views[row.view_key] = JSON.parse(row.view_value) as ViewsV1[string];
    }
    return views;
  }

  return {
    async read(actorId: string): Promise<ViewPreferencesResponseV1> {
      if (!ACTOR_PATTERN_V1.test(actorId)) return failure('not-authorized');
      try {
        return { contractVersion: 1, state: 'ready', views: await readViews(database, actorId) };
      } catch {
        return failure('unavailable');
      }
    },

    async save(actorId: string, input: unknown): Promise<ViewPreferencesResponseV1> {
      if (!ACTOR_PATTERN_V1.test(actorId)) return failure('not-authorized');
      const parsed = viewPreferencesSaveSchemaV1.safeParse(input);
      if (!parsed.success) return failure('invalid-request');
      const entries = Object.entries(parsed.data.views);
      const write = async (db: GradebookPostgresWritePortV1) => {
        await db.executeNative(
          `INSERT INTO admin_preferences.view_state_v1 (actor_id, view_key, view_value)
           SELECT $1::uuid, entry.key, entry.value
             FROM jsonb_each($2::jsonb) AS entry
           ON CONFLICT (actor_id, view_key)
           DO UPDATE SET view_value=EXCLUDED.view_value, updated_at=statement_timestamp()`,
          [actorId, postgresJsonTextV1(JSON.stringify(Object.fromEntries(entries)))],
        );
        // Old choices that no screen asks for any more do not pile up.
        await db.executeNative(
          `DELETE FROM admin_preferences.view_state_v1 WHERE actor_id=$1::uuid AND view_key IN (
             SELECT view_key FROM admin_preferences.view_state_v1 WHERE actor_id=$1::uuid
              ORDER BY updated_at DESC OFFSET $2)`,
          [actorId, VIEW_PREFERENCE_MAX_KEYS_V1],
        );
        return readViews(db, actorId);
      };
      try {
        const views = typeof database.transaction === 'function'
          ? await database.transaction(write)
          : await write(database);
        return { contractVersion: 1, state: 'ready', views };
      } catch {
        return failure('unavailable');
      }
    },
  };
}
