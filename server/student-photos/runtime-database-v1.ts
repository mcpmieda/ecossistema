import type { RuntimeEnv } from '../env';
import { createGradebookPostgresDatabaseV1 } from '../gradebook/persistence/postgres/postgres-database-v1';
import type { GradebookPostgresValueV1 } from '../gradebook/persistence/postgres/postgres-values-v1';
import type { PhotoWriteDatabaseV1 } from './write-repository-v1';

/** Reuses the existing private Hyperdrive and runtime role; never reads credentials from a request. */
export async function openPhotoDatabaseV1(env: RuntimeEnv) {
  const binding = env.PROD_DB;
  if (
    env.GRADEBOOK_STORAGE_PROVIDER !== 'postgres' ||
    !binding ||
    typeof binding !== 'object' ||
    !('connectionString' in binding) ||
    typeof binding.connectionString !== 'string'
  )
    throw new Error('student-photo-database-unavailable');
  const native = await createGradebookPostgresDatabaseV1(binding.connectionString, {
    maximumConnections: 1,
  });
  const database: PhotoWriteDatabaseV1 = {
    transaction: (work) =>
      native.transaction((tx) =>
        work({
          query: async (text, parameters = []) =>
            (await tx.executeNative(text, parameters as readonly GradebookPostgresValueV1[])).rows,
        }),
      ),
  };
  return { database, close: () => native.close() };
}
