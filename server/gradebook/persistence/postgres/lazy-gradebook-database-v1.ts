import type { GradebookPostgresDatabaseV1, GradebookPostgresScalarV1 } from './postgres-database-v1';

/** Request-local connection: constructing the native port performs no I/O.
 * Handlers keep ownership of authentication, input validation and response contracts.
 * Transactions still delegate to one physical PostgreSQL transaction, never a fake batch.
 */
export function lazyGradebookDatabaseV1(
  create: () => Promise<GradebookPostgresDatabaseV1>,
): GradebookPostgresDatabaseV1 {
  let pending: Promise<GradebookPostgresDatabaseV1> | undefined;
  let current: GradebookPostgresDatabaseV1 | undefined;
  let closed = false;
  const open = () => {
    if (closed) return Promise.reject(new Error('gradebook-request-database-closed'));
    pending ??= Promise.resolve().then(create).then((database) => {
      current = database;
      return database;
    });
    return pending;
  };
  return {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      parameters: readonly GradebookPostgresScalarV1[],
    ) => (await open()).query<Row>(text, parameters),
    executeNative: async (text, parameters) => (await open()).executeNative(text, parameters),
    transaction: async (operation) => (await open()).transaction(operation),
    lastFailure: () => current?.lastFailure() ?? null,
    async close() {
      closed = true;
      const database = await pending?.catch(() => undefined);
      await database?.close();
    },
  };
}
