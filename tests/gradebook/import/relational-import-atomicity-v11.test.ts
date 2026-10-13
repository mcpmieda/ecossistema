// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresQuerySqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import {
  inspectGradebookImportPersistenceRequestV9,
  type GradebookImportOfferV9,
  type GradebookImportTermV9,
  type GradebookNotesImportRequestV9,
  type GradebookRelationImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

type Failure =
  'none' | 'typed-conflict' | 'sql-conflict' | 'unexpected' | 'group-count' | 'finalizer';
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
let initialState: Record<string, unknown>;
let failure: Failure = 'none';
let noteGroups = 0;
let finalizers = 0;
let commits = 0;
let rollbacks = 0;

const manifest = {
  fileName: 'SYNTHETIC ATOMICITY.xlsb',
  sha256: 'a'.repeat(64),
  parserVersion: 'synthetic-atomicity-v11',
};
const relation: GradebookRelationImportRequestV9 = {
  transportVersion: 9,
  operation: 'persist-relacao',
  ano: 2026,
  manifest,
  turmas: ['SYN-A', 'SYN-B'].map((codigo, index) => ({
    codigo,
    nome: codigo,
    etapa: 6,
    turno: 'MATUTINO',
    alunos: [[1, `SYNTHETIC STUDENT ${index + 1}`, 0]],
  })),
};

function offer(turmaCodigo = 'SYN-A', numero = 1): GradebookImportOfferV9 {
  const term = (trimestre: 1 | 2 | 3): GradebookImportTermV9 => ({
    trimestre,
    instrumentos: [[1, 10_000, 'SYNTHETIC AV1']],
    alunos: [[numero, [5_000], 5_000]],
  });
  return {
    turmaCodigo,
    disciplina: 'SYNTHETIC SUBJECT',
    trimestres: [term(1), term(2), term(3)],
    recuperacao: null,
  };
}

function notes(
  ofertas: readonly GradebookImportOfferV9[] = [offer()],
): GradebookNotesImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-notas',
    ano: 2026,
    manifest,
    professor: 'SYNTHETIC NEW TEACHER',
    ofertas,
  };
}

async function snapshot(): Promise<Record<string, unknown>> {
  const tables = (
    await pg.query<{ schema: string; name: string }>(`
    SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
    WHERE table_schema IN ('gradebook', 'student_portal') AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name`)
  ).rows;
  const state: Record<string, unknown> = {};
  for (const { schema, name } of tables) {
    if (!/^[a-z_][a-z_0-9]*$/u.test(schema) || !/^[a-z_][a-z_0-9]*$/u.test(name))
      throw new Error('unsafe-fixture-table');
    state[`${schema}.${name}`] = (
      await pg.query(
        `SELECT to_jsonb(t) AS row FROM ${schema}.${name} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
  }
  return state;
}

beforeEach(async () => {
  failure = 'none';
  noteGroups = 0;
  finalizers = 0;
  commits = 0;
  rollbacks = 0;
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  for (const name of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
  ]) {
    await pg.exec(readFileSync(`migrations/gradebook-simplified/${name}`, 'utf8'));
  }
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  async function execute(
    client: Pick<PGlite, 'query'>,
    query: string,
    values: readonly unknown[] = [],
  ) {
    const result = await client.query<Record<string, unknown>>(query, [...values]);
    const groupedNote =
      query.includes('INSERT INTO gradebook.nota (') && query.includes('jsonb_to_recordset');
    if (groupedNote) {
      noteGroups++;
      if (failure === 'typed-conflict')
        throw Object.assign(new Error('synthetic-typed-conflict'), { code: '23505' });
      if (failure === 'sql-conflict')
        await client.query('INSERT INTO gradebook.nota SELECT * FROM gradebook.nota LIMIT 1');
      if (failure === 'unexpected') throw new Error('synthetic-unexpected');
    }
    if (query.includes('record_gradebook_change_v1')) {
      finalizers++;
      if (failure === 'finalizer') throw new Error('synthetic-after-finalizer');
    }
    const count = result.affectedRows ?? result.rows.length;
    return Object.assign(result.rows, {
      count: groupedNote && failure === 'group-count' ? count + 1 : count,
    });
  }
  database = createGradebookPostgresDatabaseFromSqlV1({
    unsafe: (query, values) => execute(pg, query, values),
    async begin(operation) {
      try {
        const result = await pg.transaction((client) =>
          operation({
            unsafe: (query, values) => execute(client, query, values),
          } satisfies GradebookPostgresQuerySqlV1),
        );
        commits++;
        return result;
      } catch (cause) {
        rollbacks++;
        throw cause;
      }
    },
    end: () => pg.close(),
  });
  expect(inspectGradebookImportPersistenceRequestV9(relation)).toBe('ready');
  expect(await createGradebookRelationalImportServiceV11(database).execute(relation)).toMatchObject(
    { state: 'applied' },
  );
  initialState = await snapshot();
  noteGroups = 0;
  finalizers = 0;
  commits = 0;
  rollbacks = 0;
}, 30_000);

afterEach(async () => {
  await database?.close();
});

async function refused(request: GradebookNotesImportRequestV9, state: 'blocked' | 'conflict') {
  expect(inspectGradebookImportPersistenceRequestV9(request)).toBe('ready');
  expect(await createGradebookRelationalImportServiceV11(database).execute(request)).toMatchObject({
    transportVersion: 9,
    state,
    reason: expect.any(String),
  });
  expect(await snapshot()).toEqual(initialState);
  expect({ commits, rollbacks, finalizers }).toEqual({ commits: 0, rollbacks: 1, finalizers: 0 });
}

describe('V11/V10/V9 refusal atomicity on the real PostgreSQL facade', () => {
  it('rolls back a new professor before an absent class', async () => {
    await refused(notes([offer('SYN-MISSING')]), 'blocked');
  });

  it('rolls back earlier valid offers, including physically flushed notes', async () => {
    await refused(notes([offer(), offer('SYN-B', 99)]), 'blocked');
    expect(noteGroups).toBeGreaterThan(0);
  });

  it('rolls back a new instrument before an unbound student', async () => {
    await refused(notes([offer('SYN-A', 99)]), 'blocked');
  });

  it('rolls back a typed conflict returned by the core after a successful write', async () => {
    failure = 'typed-conflict';
    await refused(notes(), 'conflict');
    expect(noteGroups).toBe(1);
  });

  it('rolls back a real SQL integrity violation separately from logical refusal', async () => {
    failure = 'sql-conflict';
    await refused(notes(), 'conflict');
    expect(database.lastFailure()).toMatchObject({ sqlState: '23505' });
  });

  it.each([
    ['unexpected', 'synthetic-unexpected'],
    ['group-count', 'gradebook-import-buffer-write-count-mismatch:note-insert'],
    ['finalizer', 'synthetic-after-finalizer'],
  ] as const)('propagates and rolls back %s failure', async (mode, message) => {
    failure = mode;
    await expect(
      createGradebookRelationalImportServiceV11(database).execute(notes()),
    ).rejects.toThrow(message);
    expect(noteGroups).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(initialState);
    expect({ commits, rollbacks }).toEqual({ commits: 0, rollbacks: 1 });
    expect(finalizers).toBe(mode === 'finalizer' ? 1 : 0);
  });

  it('commits valid writes once and leaves an identical reimport unchanged', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    expect(await service.execute(notes())).toMatchObject({
      state: 'applied',
      summary: expect.any(Object),
    });
    expect({ commits, rollbacks, finalizers }).toEqual({ commits: 1, rollbacks: 0, finalizers: 1 });
    expect(noteGroups).toBeGreaterThan(0);
    const after = await snapshot();
    expect(await service.execute(notes())).toMatchObject({ state: 'no-changes' });
    expect(await snapshot()).toEqual(after);
    expect({ commits, rollbacks, finalizers }).toEqual({ commits: 2, rollbacks: 0, finalizers: 1 });
  });
});
