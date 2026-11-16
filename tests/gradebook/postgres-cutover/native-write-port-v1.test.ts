// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createGradebookPostgresDatabaseFromSqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { lazyGradebookDatabaseV1 } from '../../../server/gradebook/persistence/postgres/lazy-gradebook-database-v1';
import { postgresJsonTextV1 } from '../../../server/gradebook/persistence/postgres/postgres-values-v1';

describe('native PostgreSQL writes', () => {
  it('preserves exact SQL, explicit JSON text typing and affected rows on the transaction connection', async () => {
    const calls: unknown[] = [];
    const database = createGradebookPostgresDatabaseFromSqlV1({
      async unsafe() {
        throw new Error('native-write-escaped-transaction');
      },
      async begin(operation) {
        return operation({
          typed: (value, oid) => ({ value, oid }),
          async unsafe(sql, parameters) {
            calls.push({ sql, parameters });
            return Object.assign([], { count: 3 });
          },
        });
      },
    });
    const text = 'UPDATE gradebook.example SET payload=$1::jsonb, label=$2 WHERE version=$3';
    const result = await database.transaction((tx) =>
      tx.executeNative(text, [postgresJsonTextV1('{"fixture":true}'), '{"literal":true}', 7]),
    );
    expect(result).toEqual({ rows: [], changes: 3 });
    expect(calls).toEqual([
      { sql: text, parameters: [{ value: '{"fixture":true}', oid: 25 }, '{"literal":true}', 7] },
    ]);
  });

  it('retains sanitized failure diagnostics through the lazy connection', async () => {
    const cause = Object.assign(new Error('permission denied for table example'), {
      code: '42501',
    });
    let opens = 0;
    const database = lazyGradebookDatabaseV1(async () => {
      opens++;
      return createGradebookPostgresDatabaseFromSqlV1({
        async unsafe() {
          throw cause;
        },
        async begin() {
          throw new Error('unexpected-transaction');
        },
      });
    });
    expect(opens).toBe(0);
    await expect(
      database.executeNative('DELETE FROM gradebook.example WHERE version=$1', [4]),
    ).rejects.toBe(cause);
    expect(opens).toBe(1);
    expect(database.lastFailure()).toEqual({
      operation: 'DELETE',
      relation: 'example',
      errorType: 'Error',
      sqlState: '42501',
      category: 'permission',
    });
    await database.close();
    await expect(database.executeNative('SELECT 1', [])).rejects.toThrow(
      'gradebook-request-database-closed',
    );
  });
});
