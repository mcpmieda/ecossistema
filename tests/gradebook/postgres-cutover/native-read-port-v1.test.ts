// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
let transactionOpen = false;

beforeAll(async () => {
  pg = new PGlite();
  database = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe(sql: string, values: readonly unknown[] = []) {
      // PGlite has a single connection, so a pool query issued while a transaction is open
      // would wait on that transaction forever. Fail fast instead: an escaped query then
      // surfaces as an explicit error rather than a deadlock and a timeout.
      if (transactionOpen) throw new Error('native-query-escaped-transaction');
      const result = await pg.query<Record<string, unknown>>(sql, [...values]);
      return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
    },
    async begin(operation: (sql: unknown) => Promise<unknown>) {
      return pg.transaction(async (transaction) => {
        transactionOpen = true;
        try {
          return await operation({
            async unsafe(sql: string, values: readonly unknown[] = []) {
              const result = await transaction.query<Record<string, unknown>>(sql, [...values]);
              return Object.assign(result.rows, {
                count: result.affectedRows ?? result.rows.length,
              });
            },
          });
        } finally {
          transactionOpen = false;
        }
      });
    },
  } as never);
});

afterAll(async () => {
  await pg?.close();
});

const isolation = async (reader: Pick<GradebookPostgresDatabaseV1, 'query'>) =>
  (await reader.query<{ transaction_isolation: string }>('SHOW transaction_isolation', []))[0]
    ?.transaction_isolation;

describe('native PostgreSQL read port V1', () => {
  it('runs inside the transaction that handed it out, not on the pool', async () => {
    // Performance reads rely on one REPEATABLE READ snapshot across several queries. A native
    // query that escaped to the pool would silently read a different snapshot per statement.
    expect(await isolation(database)).toBe('read committed');
    const inside = await database.transaction(async (tx) => {
      await tx.executeNative('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
      return isolation(tx);
    });
    expect(inside).toBe('repeatable read');
  });

  it('records a sanitized failure diagnostic for native queries', async () => {
    await expect(
      database.query('SELECT 1 FROM gradebook.native_port_missing_relation', []),
    ).rejects.toThrow();
    expect(database.lastFailure()).toMatchObject({ category: 'relation-missing' });
  });
});
