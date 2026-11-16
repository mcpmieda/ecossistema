// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../../server/env';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import {
  GRADEBOOK_POSTGRES_FAILURE_HEADER_V1,
  withOfficialGradebookDatabaseV1,
} from '../../../server/gradebook/persistence/postgres/official-gradebook-database-v1';

function database() {
  const unsafe = vi.fn(async () => Object.assign([{ ok: 1 }], { count: 1 }));
  const value = createGradebookPostgresDatabaseFromSqlV1({
    unsafe,
    async begin(operation) {
      return operation({ unsafe });
    },
  });
  vi.spyOn(value, 'query');
  vi.spyOn(value, 'executeNative');
  vi.spyOn(value, 'transaction');
  vi.spyOn(value, 'lastFailure');
  vi.spyOn(value, 'close');
  return value;
}
const env = () =>
  ({
    GRADEBOOK_STORAGE_PROVIDER: 'postgres',
    PROD_DB: { connectionString: 'postgres://hyperdrive.invalid/gradebook' },
  }) as RuntimeEnv;
const injected = (execution: RuntimeEnv) =>
  execution.GRADEBOOK_DATABASE as GradebookPostgresDatabaseV1;

describe('official gradebook PostgreSQL authority #806', () => {
  it('uses only Postgres and opens at the first real operation, not during route construction', async () => {
    const postgres = database();
    const createPostgresDatabase = vi.fn(async () => postgres);
    const input = env();
    Object.defineProperty(input, 'GRADEBOOK_D1', {
      enumerable: true,
      get: () => {
        throw new Error('Legacy binding must not be read');
      },
    });
    const response = await withOfficialGradebookDatabaseV1(
      input,
      async (execution) => {
        expect(Reflect.get(execution, 'GRADEBOOK_D1')).toBeUndefined();
        const db = injected(execution);
        expect('prepare' in db).toBe(false);
        expect(createPostgresDatabase).not.toHaveBeenCalled();
        expect(await db.query('SELECT $1 AS ok', [1])).toEqual([{ ok: 1 }]);
        return Response.json({ ok: true });
      },
      { createPostgresDatabase },
    );
    expect(response?.headers.get('X-Gradebook-Storage-Provider')).toBe('postgres');
    expect(createPostgresDatabase).toHaveBeenCalledOnce();
    expect(postgres.close).toHaveBeenCalledOnce();
  });
  it('shares one request-local connection for concurrent reads and preserves native writes and transactions', async () => {
    const postgres = database();
    const createPostgresDatabase = vi.fn(async () => postgres);
    await withOfficialGradebookDatabaseV1(
      env(),
      async (execution) => {
        const db = injected(execution);
        expect(await Promise.all([db.query('SELECT $1', [1]), db.query('SELECT $1', [2])])).toEqual(
          [[{ ok: 1 }], [{ ok: 1 }]],
        );
        expect(await db.executeNative('SELECT $1', [3])).toEqual({ rows: [{ ok: 1 }], changes: 1 });
        expect(
          await db.transaction(async (tx) => {
            expect(tx).not.toBe(postgres);
            expect('prepare' in tx).toBe(false);
            return tx.executeNative('SELECT $1', [4]);
          }),
        ).toEqual({ rows: [{ ok: 1 }], changes: 1 });
        return new Response(null, { status: 204 });
      },
      { createPostgresDatabase },
    );
    expect(createPostgresDatabase).toHaveBeenCalledOnce();
    expect(postgres.query).toHaveBeenNthCalledWith(1, 'SELECT $1', [1]);
    expect(postgres.query).toHaveBeenNthCalledWith(2, 'SELECT $1', [2]);
    expect(postgres.executeNative).toHaveBeenCalledExactlyOnceWith('SELECT $1', [3]);
    expect(postgres.transaction).toHaveBeenCalledOnce();
    expect(postgres.close).toHaveBeenCalledOnce();
  });
  it('exposes only the closed Postgres diagnostic on failed official responses', async () => {
    const postgres = database();
    const diagnostic = {
      operation: 'SELECT',
      relation: 'nota',
      errorType: 'PostgresError',
      sqlState: '42883',
      category: 'unknown' as const,
    };
    vi.mocked(postgres.lastFailure).mockReturnValue(diagnostic);
    const response = await withOfficialGradebookDatabaseV1(
      env(),
      async (execution) => {
        await injected(execution).query('SELECT 1', []);
        return Response.json({ state: 'unavailable' }, { status: 503 });
      },
      { createPostgresDatabase: async () => postgres },
    );
    expect(JSON.parse(response!.headers.get(GRADEBOOK_POSTGRES_FAILURE_HEADER_V1)!)).toEqual(
      diagnostic,
    );
    expect(response!.headers.get(GRADEBOOK_POSTGRES_FAILURE_HEADER_V1)).not.toContain('hyperdrive');
    expect(postgres.close).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'd1'])(
    'never reads either store for invalid production provider %s',
    async (provider) => {
      const createPostgresDatabase = vi.fn();
      const legacy = { prepare: vi.fn(), exec: vi.fn() };
      const response = await withOfficialGradebookDatabaseV1(
        { GRADEBOOK_STORAGE_PROVIDER: provider, GRADEBOOK_D1: legacy } as RuntimeEnv,
        async (execution) => {
          expect(Reflect.get(execution, 'GRADEBOOK_D1')).toBeUndefined();
          expect(execution.GRADEBOOK_DATABASE).not.toBe(legacy);
          await expect(injected(execution).query('SELECT 1', [])).rejects.toThrow(
            'provider-required',
          );
          return Response.json({ contractVersion: 1, state: 'unavailable' }, { status: 503 });
        },
        { createPostgresDatabase },
      );
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ contractVersion: 1, state: 'unavailable' });
      expect(response?.headers.get('X-Gradebook-Storage-Provider')).toBe('unconfigured');
      expect(createPostgresDatabase).not.toHaveBeenCalled();
      expect(legacy.prepare).not.toHaveBeenCalled();
    },
  );
  it.each([400, 401, 403, 404])(
    'preserves route status %i before inspecting unconfigured storage',
    async (status) => {
      const createPostgresDatabase = vi.fn();
      const response = await withOfficialGradebookDatabaseV1(
        {} as RuntimeEnv,
        async () => Response.json({ contractVersion: 2, state: 'not-authorized' }, { status }),
        { createPostgresDatabase },
      );
      expect(response?.status).toBe(status);
      expect(createPostgresDatabase).not.toHaveBeenCalled();
    },
  );
  it('does not need a binding for a rejected or unmatched route', async () => {
    const input = { GRADEBOOK_STORAGE_PROVIDER: 'postgres' } as RuntimeEnv;
    const createPostgresDatabase = vi.fn();
    expect(
      (
        await withOfficialGradebookDatabaseV1(
          input,
          async () => new Response(null, { status: 401 }),
          { createPostgresDatabase },
        )
      )?.status,
    ).toBe(401);
    expect(
      await withOfficialGradebookDatabaseV1(input, async () => null, { createPostgresDatabase }),
    ).toBeNull();
    expect(createPostgresDatabase).not.toHaveBeenCalled();
  });
  it.each(['local', 'preview'] as const)(
    'rejects D1 without I/O in %s, after route guards',
    async (environment) => {
      const d1 = { prepare: vi.fn(), exec: vi.fn() };
      const createPostgresDatabase = vi.fn();
      const input = {
        RUNTIME_ENVIRONMENT: environment,
        GRADEBOOK_STORAGE_PROVIDER: 'd1',
        GRADEBOOK_D1: d1,
      } as RuntimeEnv;
      for (const status of [400, 401, 403, 404]) {
        const rejected = await withOfficialGradebookDatabaseV1(
          input,
          async () => new Response(null, { status }),
          { createPostgresDatabase },
        );
        expect(rejected?.status).toBe(status);
      }
      const response = await withOfficialGradebookDatabaseV1(
        input,
        async (execution) => {
          expect(Reflect.get(execution, 'GRADEBOOK_D1')).toBeUndefined();
          await expect(injected(execution).query('SELECT 1', [])).rejects.toThrow(
            'provider-required',
          );
          return Response.json({ state: 'unavailable' }, { status: 503 });
        },
        { createPostgresDatabase },
      );
      expect(response?.status).toBe(503);
      expect(response?.headers.get('X-Gradebook-Storage-Provider')).toBe('unconfigured');
      expect(createPostgresDatabase).not.toHaveBeenCalled();
      expect(d1.prepare).not.toHaveBeenCalled();
      expect(d1.exec).not.toHaveBeenCalled();
    },
  );
  it('fails closed when an authorized operation actually needs the missing selected binding', async () => {
    await expect(
      withOfficialGradebookDatabaseV1(
        { GRADEBOOK_STORAGE_PROVIDER: 'postgres', GRADEBOOK_D1: database() } as RuntimeEnv,
        async (execution) => {
          await injected(execution).query('SELECT 1', []);
          return null;
        },
      ),
    ).rejects.toThrow('gradebook-official-postgres-binding-missing');
  });
  it('closes an acquired Postgres connection even when the operation fails', async () => {
    const postgres = database();
    await expect(
      withOfficialGradebookDatabaseV1(
        env(),
        async (execution) => {
          await injected(execution).query('SELECT 1', []);
          throw new Error('synthetic-operation-failed');
        },
        { createPostgresDatabase: async () => postgres },
      ),
    ).rejects.toThrow('synthetic-operation-failed');
    expect(postgres.close).toHaveBeenCalledOnce();
  });
});
