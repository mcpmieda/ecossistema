// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../../server/env';
import { createGradebookRelationalImportServiceV10 } from '../../../server/gradebook/application/import/import-relational-service-v10';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresWritePortV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import type { GradebookImportPersistenceRequestV9, GradebookImportTermV9, GradebookNotesImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

const mocks = vi.hoisted(() => ({
  database: null as GradebookPostgresDatabaseV1 | null,
  persist: vi.fn(),
}));
vi.mock('../../../server/auth/session', async (original) => ({
  ...await original<object>(),
  requireAuth: async () => ({ oid: 'synthetic', roles: ['ADMINISTRADOR'] }),
}));
vi.mock('../../../server/gradebook/authorization-v1', async (original) => ({
  ...await original<object>(), authorizeGradebookRuntimeV1: () => ({}),
}));
vi.mock('../../../server/gradebook/persistence/postgres/official-gradebook-database-v1', async (original) => {
  const actual = await original<typeof import('../../../server/gradebook/persistence/postgres/official-gradebook-database-v1')>();
  return {
    ...actual,
    withOfficialGradebookDatabaseV1: (env: RuntimeEnv, operation: (env: RuntimeEnv) => Promise<Response | null>) =>
      actual.withOfficialGradebookDatabaseV1(env, operation, { createPostgresDatabase: async () => mocks.database! }),
  };
});
vi.mock('../../../server/gradebook/application/import/import-relational-service-v9', () => ({
  createGradebookRelationalImportServiceV9: (database: GradebookPostgresWritePortV1) => ({
    execute: (request: GradebookImportPersistenceRequestV9) => mocks.persist(database, request),
  }),
}));
afterEach(() => { vi.restoreAllMocks(); mocks.persist.mockReset(); });

type Row = Record<string, unknown>;
function fixture(read: (sql: string) => Row[]) {
  const calls: { channel: string; sql: string; values: readonly unknown[] }[] = [];
  let transaction: GradebookPostgresWritePortV1 | null = null;
  let inside = false;
  const client = (channel: string): GradebookPostgresQuerySqlV1 => ({
    typed: (value, oid) => ({ __typed: value, oid }),
    async unsafe(sql, values = []) {
      if (channel === 'pool' && inside) throw new Error('native-read-escaped-transaction');
      calls.push({ channel, sql, values });
      if (sql.includes('pg_advisory') || sql.includes('ensure_year_coordination')) return [];
      return read(sql);
    },
  });
  const database = createGradebookPostgresDatabaseFromSqlV1({
    ...client('pool'),
    async begin(operation) {
      inside = true;
      try { return await operation(client('tx')); } finally { inside = false; }
    },
  });
  const transact = database.transaction.bind(database);
  expect('prepare' in database).toBe(false);
  database.transaction = (operation) => transact((tx) => {
    transaction = tx;
    expect('prepare' in tx).toBe(false);
    return operation(tx);
  });
  mocks.database = database;
  return { database, calls, transaction: () => transaction };
}
function notes(): GradebookNotesImportRequestV9 {
  const term = (trimestre: 1 | 2 | 3): GradebookImportTermV9 => ({
    definitionSnapshotVersion: 1 as const, trimestre, instrumentos: [[1, 6750]], alunos: [[1, [1000], null], [2, [2000], null]],
  });
  return {
    transportVersion: 9, operation: 'persist-notas', granularObservationVersion: 1 as const, ano: 2090, professor: 'SYNTHETIC',
    manifest: { fileName: 'synthetic.xlsx', sha256: 'a'.repeat(64), parserVersion: 'synthetic' },
    ofertas: [{ turmaCodigo: '6a', disciplina: 'MATEMATICA', trimestres: [term(1), term(2), term(3)], recuperacao: [[1, null, null, null, null], [2, null, null, null, null]] }],
  };
}

describe('native miscellaneous reads for B-15 slice 4', () => {
  it('reads historical bindings after the year locks and passes filtered facts to V9 in the same transaction', async () => {
    const { database, calls, transaction } = fixture(() => [{ turma_codigo: ' 6A ', numero: 1 }]);
    mocks.persist.mockResolvedValue({ transportVersion: 9, state: 'no-changes', summary: {} });
    const source = notes();
    await createGradebookRelationalImportServiceV10(database).execute(source);
    expect(calls).toEqual([
      { channel: 'tx', sql: 'SELECT pg_advisory_xact_lock_shared(613,0)', values: [] },
      { channel: 'tx', sql: 'SELECT pg_advisory_xact_lock(613,$1::integer)', values: [2090] },
      { channel: 'tx', sql: 'SELECT student_portal.ensure_year_coordination_v1($1::smallint)', values: [2090] },
      { channel: 'tx', sql: 'SELECT t.codigo AS turma_codigo, v.numero\n     FROM gradebook.vinculo v\n     JOIN gradebook.turma t ON t.id = v.turma_id\n     WHERE v.ano = $1 AND v.situacao = 6', values: [2090] },
    ]);
    expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(transaction(), expect.anything());
    const filtered = mocks.persist.mock.calls[0]![1] as GradebookNotesImportRequestV9;
    expect(filtered.ofertas[0]!.trimestres.map((term) => term.alunos.map(([number]) => number))).toEqual([[2], [2], [2]]);
    expect(filtered.ofertas[0]!.recuperacao?.map(([number]) => number)).toEqual([2]);
    expect(source.ofertas[0]!.trimestres[0].alunos).toHaveLength(2);
  });

  it('preserves an empty historical selection and the unchanged input', async () => {
    const { database } = fixture(() => []);
    const source = notes();
    const response = { transportVersion: 9, state: 'no-changes', summary: {} };
    mocks.persist.mockResolvedValue(response);
    expect(await createGradebookRelationalImportServiceV10(database).execute(source)).toBe(response);
    expect(mocks.persist.mock.calls[0]![1]).toBe(source);
  });

  it('retains lastFailure and prevents persistence when the native binding read fails', async () => {
    const { database } = fixture(() => { throw Object.assign(new Error('relation "gradebook.vinculo" does not exist'), { code: '42P01' }); });
    await expect(createGradebookRelationalImportServiceV10(database).execute(notes())).rejects.toThrow('relation "gradebook.vinculo" does not exist');
    expect(database.lastFailure()).toMatchObject({ operation: 'SELECT', relation: 'vinculo', category: 'relation-missing', sqlState: '42P01' });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
