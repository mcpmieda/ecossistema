// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createGradebookRelationalImportServiceV9 } from '../../../server/gradebook/application/import/import-relational-service-v9';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresWritePortV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import type { GradebookRelationImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

const relation: GradebookRelationImportRequestV9 = {
  transportVersion: 9,
  operation: 'persist-relacao',
  manifest: { fileName: 'RELACAO SINTETICA.xlsb', sha256: 'a'.repeat(64), parserVersion: 'native-test' },
  ano: 2026,
  turmas: [{ codigo: 'T26', nome: 'TURMA SINTETICA', etapa: 6, turno: 'MATUTINO', alunos: [[1, 'ALUNO SINTETICO', 0]] }],
};

function fixture(options: { existing?: boolean; failure?: Error } = {}) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const events: string[] = [];
  const database = createGradebookPostgresDatabaseFromSqlV1({
    unsafe: async () => { throw new Error('native-import-escaped-transaction'); },
    async begin(operation) {
      events.push('begin');
      try {
        const result = await operation({
          typed: (value, oid) => ({ value, oid }),
          async unsafe(text, values = []) {
            calls.push({ text, values });
            let rows: Record<string, unknown>[] = [];
            if (text.startsWith('INSERT INTO gradebook.vinculo') && options.failure) throw options.failure;
            if (text.startsWith('INSERT INTO gradebook.turma') || (options.existing && text.startsWith('SELECT id, codigo, nome'))) {
              rows = [{ id: 10, codigo: 'T26', nome: 'TURMA SINTETICA', etapa: 6, turno: 'MATUTINO' }];
            } else if (text.startsWith('INSERT INTO gradebook.aluno')) rows = [{ id: 20 }];
            else if (text.startsWith('SELECT reset_version')) rows = [{ reset_version: '2026:1' }];
            else if (text.includes('synchronize_gradebook_profiles_v1')) rows = [{ synchronized: 1 }];
            else if (options.existing && text.startsWith('SELECT ano FROM')) rows = [{ ano: 2026 }];
            else if (options.existing && text.startsWith('SELECT v.turma_id')) {
              rows = [{ turma_id: 10, numero: 1, aluno_id: 20, situacao: null, turma_relacionada_id: null, nome: 'ALUNO SINTETICO', student_uid: '11111111-1111-4111-8111-111111111111' }];
            } else if (options.existing && text.startsWith('SELECT nome FROM')) rows = [{ nome: 'ALUNO SINTETICO' }];
            return Object.assign(rows, { count: text.startsWith('INSERT') ? 1 : rows.length });
          },
        });
        events.push('commit');
        return result;
      } catch (error) { events.push('rollback'); throw error; }
    },
  });
  const native = {
    query: database.query.bind(database),
    executeNative: database.executeNative.bind(database),
    transaction<T>(operation: (transaction: GradebookPostgresWritePortV1) => Promise<T>) {
      return database.transaction(tx => operation({
        query: tx.query.bind(tx),
        executeNative: tx.executeNative.bind(tx),
      }));
    },
  };
  return { service: createGradebookRelationalImportServiceV9(native), database, native, calls, events };
}

describe('V9 native import port', () => {
  it('creates a relation with exact native SQL and preserves logical counts without an import ledger', async () => {
    const { service, calls, events } = fixture();
    const response = await service.execute(relation);
    expect(response).toMatchObject({
      transportVersion: 9,
      state: 'applied',
      summary: { committedWrites: { importBatchVersions: 0, academicRecordVersions: 4, total: 4 } },
    });
    expect(events).toEqual(['begin', 'commit']);
    expect(calls.slice(0, 4)).toEqual([
      { text: 'SELECT pg_advisory_xact_lock_shared(613,0)', values: [] },
      { text: 'SELECT pg_advisory_xact_lock(613,$1::integer)', values: [2026] },
      { text: 'SELECT student_portal.ensure_year_coordination_v1($1::smallint)', values: [2026] },
      { text: 'SELECT ano FROM gradebook.ano_letivo WHERE ano = $1', values: [2026] },
    ]);
    expect(calls.filter(({ text }) => text.startsWith('INSERT'))).toEqual([
      { text: 'INSERT INTO gradebook.ano_letivo (ano, minimo_aprovacao, max_componentes_conselho) VALUES ($1, 60000, 2)', values: [2026] },
      { text: 'INSERT INTO gradebook.turma (ano, codigo, nome, etapa, turno) VALUES ($1, $2, $3, $4, $5)\n         RETURNING id, codigo, nome, etapa, turno', values: [2026, 'T26', 'TURMA SINTETICA', 6, 'MATUTINO'] },
      { text: 'INSERT INTO gradebook.aluno (ano, nome) VALUES ($1, $2) RETURNING id', values: [2026, 'ALUNO SINTETICO'] },
      { text: 'INSERT INTO gradebook.vinculo (ano, turma_id, numero, aluno_id, situacao, turma_relacionada_id) VALUES ($1, $2, $3, $4, $5, $6)', values: [2026, 10, 1, 20, null, null] },
    ]);
    expect(calls.at(-2)?.values).toEqual([expect.any(String), 2026, 'relation', 1, { value: '[]', oid: 25 }]);
    expect(calls.at(-1)?.text).toBe('SELECT * FROM student_portal.synchronize_gradebook_profiles_v1()');
  });

  it('keeps an identical relation read-only with no revision or import ledger write', async () => {
    const { service, calls, events } = fixture({ existing: true });
    expect(await service.execute(relation)).toMatchObject({ state: 'no-changes', summary: { committedWrites: { total: 0 } } });
    expect(calls).toHaveLength(9);
    expect(calls.every(({ text }) => text.startsWith('SELECT'))).toBe(true);
    expect(calls.at(-1)).toEqual({ text: 'SELECT nome FROM gradebook.aluno WHERE id = $1 AND ano = $2', values: [20, 2026] });
    expect(events).toEqual(['begin', 'commit']);
  });

  it.each(['23505', '23503', '23514'])('preserves integrity conflict mapping and driver diagnostics: %s', async code => {
    const failure = Object.assign(new Error('synthetic integrity failure'), { code });
    const { service, database, calls, events } = fixture({ failure });
    expect(await service.execute(relation)).toMatchObject({ transportVersion: 9, state: 'conflict' });
    expect(events).toEqual(['begin', 'rollback']);
    expect(calls.at(-1)?.text).toMatch(/^INSERT INTO gradebook.vinculo/u);
    expect(database.lastFailure()).toEqual({ operation: 'INSERT', relation: 'vinculo', errorType: 'Error', sqlState: code, category: 'unknown' });
  });

  it('rethrows other SQL failures unchanged and rejects roots without transactions', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: '42501' });
    const { service, native } = fixture({ failure });
    await expect(service.execute(relation)).rejects.toBe(failure);
    await expect(createGradebookRelationalImportServiceV9({ query: native.query, executeNative: native.executeNative }).execute(relation))
      .rejects.toThrow('gradebook-relational-import-requires-postgres');
  });
});
