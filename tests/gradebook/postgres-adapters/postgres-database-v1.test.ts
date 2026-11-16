// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { postgresJsonTextV1 } from '../../../server/gradebook/persistence/postgres/postgres-values-v1';

type Row = Record<string, unknown>;
type Channel = 'pool' | 'tx';

class SyntheticPostgresSqlV1 implements GradebookPostgresSqlV1 {
  readonly calls: { channel: Channel; query: string; parameters: readonly unknown[] }[] = [];
  readonly events: string[] = [];
  readonly typedCalls: { channel: Channel; value: string; oid: number }[] = [];
  closed = false;
  private inside = false;
  private readonly responses: { rows: readonly Row[]; count: number }[] = [];
  private failure: unknown;

  respond(rows: readonly Row[], count = rows.length): void {
    this.responses.push({ rows, count });
  }

  failNext(cause: unknown): void {
    this.failure = cause;
  }

  private async execute(channel: Channel, query: string, parameters: readonly unknown[]) {
    if (channel === 'pool' && this.inside) throw new Error('native-query-escaped-transaction');
    this.calls.push({ channel, query, parameters });
    if (this.failure !== undefined) {
      const cause = this.failure;
      this.failure = undefined;
      throw cause;
    }
    const response = this.responses.shift() ?? { rows: [], count: 0 };
    return Object.assign([...response.rows], { count: response.count });
  }

  unsafe(query: string, parameters: readonly unknown[] = []) {
    return this.execute('pool', query, parameters);
  }

  private typedOn(channel: Channel, value: string, oid: number): unknown {
    this.typedCalls.push({ channel, value, oid });
    return { value, oid };
  }

  typed(value: string, oid: number): unknown {
    return this.typedOn('pool', value, oid);
  }

  async begin<T>(operation: (sql: GradebookPostgresQuerySqlV1) => Promise<T>): Promise<T> {
    this.events.push('begin');
    this.inside = true;
    try {
      const value = await operation({
        unsafe: (query, parameters = []) => this.execute('tx', query, parameters),
        typed: (value, oid) => this.typedOn('tx', value, oid),
      });
      this.events.push('commit');
      return value;
    } catch (cause) {
      this.events.push('rollback');
      throw cause;
    } finally {
      this.inside = false;
    }
  }

  async end(): Promise<void> {
    this.closed = true;
  }
}

describe('gradebook native PostgreSQL database adapter', () => {
  it('exposes only native ports on the database and transaction', async () => {
    const database = createGradebookPostgresDatabaseFromSqlV1(new SyntheticPostgresSqlV1());
    for (const target of [database, await database.transaction(async (tx) => tx)]) {
      for (const retired of ['prepare', 'bind', 'exec', 'batch']) {
        expect(retired in target).toBe(false);
      }
      expect(typeof target.query).toBe('function');
      expect(typeof target.executeNative).toBe('function');
    }
  });

  it('passes SQL byte for byte without rewriting literals, whitespace or bound values', async () => {
    const sql = new SyntheticPostgresSqlV1();
    const database = createGradebookPostgresDatabaseFromSqlV1(sql);
    const text = "\n SELECT '?' AS literal, $1 AS value, $2 AS nullable; \n";
    await database.query(text, ["'; DROP TABLE gradebook.example; --", null]);
    expect(sql.calls).toEqual([
      {
        channel: 'pool',
        query: text,
        parameters: ["'; DROP TABLE gradebook.example; --", null],
      },
    ]);
  });

  it('sends explicitly marked serialized JSON as text OID 25 without rewriting SQL', async () => {
    const sql = new SyntheticPostgresSqlV1();
    const database = createGradebookPostgresDatabaseFromSqlV1(sql);
    const payload = JSON.stringify([{ kind: 'student', id: 'student:synthetic' }]);
    const text =
      "SELECT value FROM jsonb_array_elements($1::jsonb) AS j(value) WHERE value->>'kind' = $2";
    await database.executeNative(text, [postgresJsonTextV1(payload), 'student']);
    expect(sql.typedCalls).toEqual([{ channel: 'pool', value: payload, oid: 25 }]);
    expect(sql.calls).toEqual([
      {
        channel: 'pool',
        query: text,
        parameters: [{ value: payload, oid: 25 }, 'student'],
      },
    ]);
  });

  it('never infers JSON typing from text contents, a column name or an SQL cast', async () => {
    const sql = new SyntheticPostgresSqlV1();
    const database = createGradebookPostgresDatabaseFromSqlV1(sql);
    const text = '{"looks":"json"}';
    const payload = '{"actual":"json"}';
    const query =
      'INSERT INTO gradebook.example (payload_json, presentation) VALUES ($1::jsonb, $2::jsonb)';
    await database.executeNative(query, [text, postgresJsonTextV1(payload)]);
    expect(sql.calls).toEqual([
      {
        channel: 'pool',
        query,
        parameters: [text, { value: payload, oid: 25 }],
      },
    ]);
    expect(sql.typedCalls).toEqual([{ channel: 'pool', value: payload, oid: 25 }]);
  });

  it('leaves validation of explicitly marked malformed JSON to PostgreSQL', async () => {
    const sql = new SyntheticPostgresSqlV1();
    const database = createGradebookPostgresDatabaseFromSqlV1(sql);
    const query = 'INSERT INTO gradebook.example (payload_json) VALUES ($1::jsonb)';
    await database.executeNative(query, [postgresJsonTextV1('{not-json')]);
    expect(sql.calls).toEqual([
      {
        channel: 'pool',
        query,
        parameters: [{ value: '{not-json', oid: 25 }],
      },
    ]);
  });

  it('retains only sanitized physical failure diagnostics after repository masking', async () => {
    const sql = new SyntheticPostgresSqlV1();
    const error = Object.assign(
      new Error('column payload_json is of type jsonb but value is text'),
      { code: '42804' },
    );
    sql.failNext(error);
    const database = createGradebookPostgresDatabaseFromSqlV1(sql);
    await expect(
      database.executeNative('INSERT INTO gradebook.example (payload_json) VALUES ($1::jsonb)', [
        postgresJsonTextV1(JSON.stringify({ secret: 'never-diagnosed' })),
      ]),
    ).rejects.toBe(error);
    expect(database.lastFailure()).toEqual({
      operation: 'INSERT',
      relation: 'example',
      errorType: 'Error',
      sqlState: '42804',
      category: 'jsonb-cast',
    });
    expect(JSON.stringify(database.lastFailure())).not.toContain('secret');
  });

  it.each(['query', 'executeNative'] as const)(
    'normalizes PostgreSQL rows through %s',
    async (operation) => {
      const sql = new SyntheticPostgresSqlV1();
      sql.respond([
        {
          payload_json: { kind: 'student', value: { id: 'student:synthetic' } },
          recorded_at: new Date('2026-09-08T12:00:00Z'),
          current_version: '2',
          available: true,
        },
      ]);
      const database = createGradebookPostgresDatabaseFromSqlV1(sql);
      const result = await database[operation]<Row>('SELECT * FROM gradebook.example', []);
      const rows = 'rows' in result ? result.rows : result;
      expect(rows).toEqual([
        {
          payload_json: '{"kind":"student","value":{"id":"student:synthetic"}}',
          recorded_at: '2026-09-08T12:00:00.000Z',
          current_version: 2,
          available: 1,
        },
      ]);
      await database.close();
      expect(sql.closed).toBe(true);
    },
  );

  it('preserves physical affected counts and propagates a failed native CAS transaction', async () => {
    const sql = new SyntheticPostgresSqlV1();
    const database = createGradebookPostgresDatabaseFromSqlV1(sql);
    const query = 'UPDATE gradebook.example SET payload=$1::jsonb, version=$2 WHERE version=$3';
    const mutate = () =>
      database.transaction(async (tx) => {
        const result = await tx.executeNative(query, [postgresJsonTextV1('{}'), 2, 1]);
        if (result.changes !== 1) throw new Error('synthetic-native-cas-conflict');
        return { result, read: await tx.query('SELECT version FROM gradebook.example', []) };
      });
    sql.respond([], 1);
    sql.respond([{ version: '2' }]);
    expect(await mutate()).toEqual({ result: { rows: [], changes: 1 }, read: [{ version: 2 }] });
    expect(sql.events).toEqual(['begin', 'commit']);
    expect(sql.calls).toEqual([
      { channel: 'tx', query, parameters: [{ value: '{}', oid: 25 }, 2, 1] },
      { channel: 'tx', query: 'SELECT version FROM gradebook.example', parameters: [] },
    ]);
    expect(sql.typedCalls).toEqual([{ channel: 'tx', value: '{}', oid: 25 }]);
    sql.respond([], 0);
    await expect(mutate()).rejects.toThrow('synthetic-native-cas-conflict');
    expect(sql.events).toEqual(['begin', 'commit', 'begin', 'rollback']);
    expect(sql.calls).toHaveLength(3);
    expect(sql.calls[2]?.channel).toBe('tx');
  });
});
