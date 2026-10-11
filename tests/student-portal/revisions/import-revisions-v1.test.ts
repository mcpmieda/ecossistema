// @vitest-environment node
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../year-reset/schema-fixture';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import type {
  GradebookNotesImportRequestV9,
  GradebookRelationImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

type Row = Record<string, unknown>;
const migrations = 'migrations/gradebook-simplified/';
const manifest = (fileName: string, digit: string) => ({
  fileName,
  sha256: digit.repeat(64),
  parserVersion: 'synthetic-multiyear-rr-v1',
});

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
let failAfterSync = false;

async function execute(
  client: Pick<PGlite, 'query'>,
  query: string,
  values: readonly unknown[] = [],
) {
  const result = await client.query<Row>(query, [...values]);
  if (failAfterSync && query.includes('synchronize_gradebook_profiles_v1')) throw new Error('synthetic-after-lifecycle');
  return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(`${migrations}0001_current_schema.sql`, 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  for (const migration of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
  ]) await pg.exec(readFileSync(`${migrations}${migration}`, 'utf8'));
  const sql: GradebookPostgresSqlV1 = {
    unsafe: (query, values = []) => execute(pg, query, values),
    begin: (operation) => pg.transaction((client) => {
      const transaction: GradebookPostgresQuerySqlV1 = {
        unsafe: (query, values = []) => execute(client, query, values),
      };
      return operation(transaction);
    }),
    end: () => pg.close(),
  };
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
}, 30_000);

afterAll(async () => { await database?.close(); });

function relation(year: number, classCode: string, hashDigit: string): GradebookRelationImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-relacao',
    manifest: manifest(`RELACAO TESTE ${year}.xlsb`, hashDigit),
    ano: year,
    turmas: [{ codigo: classCode, nome: `TURMA TESTE ${year}`, etapa: 6, turno: 'MATUTINO', alunos: [[1, 'ALUNO HOMONIMO TESTE', 0]] }],
  };
}

function notes2026(): GradebookNotesImportRequestV9 {
  const term = (trimestre: 1 | 2 | 3) => ({
    trimestre,
    instrumentos: trimestre === 3
      ? [[1, 9_000, 'AV1 TESTE'], [2, 9_000, 'AV2 TESTE'], [11, 22_000, 'QUALITATIVA TESTE']] as const
      : [[1, 6_750, 'AV1 TESTE'], [2, 6_750, 'AV2 TESTE'], [11, 16_500, 'QUALITATIVA TESTE']] as const,
    alunos: [[1, [2_000, 2_000, 4_000], 8_000]] as const,
  });
  return {
    transportVersion: 9,
    operation: 'persist-notas',
    manifest: manifest('NOTAS TESTE 2025.xlsb', 'c'),
    ano: 2026,
    professor: 'DOCENTE TESTE',
    ofertas: [{
      turmaCodigo: 'T26',
      disciplina: 'COMPONENTE TESTE',
      trimestres: [term(1), term(2), term(3)],
      recuperacao: [[1, ['r'], null, null, null]],
    }],
  };
}


async function revision() {
  return (await pg.query<{ academic: number; reset: number }>(`SELECT academic_counter::integer AS academic,
    reset_counter::integer AS reset FROM student_portal.academic_revision WHERE academic_year=2026`)).rows[0]!;
}

describe('real V11 revision and lifecycle finalizer', () => {
  it('records one academic event after the physical relation flush and creates a profile when the local gate is enabled', async () => {
    await pg.exec('UPDATE student_portal.lifecycle_control SET population_enabled=true');
    const before = await revision();
    const service = createGradebookRelationalImportServiceV11(database);
    expect(await service.execute(relation(2026, 'T26', 'a'))).toMatchObject({ state: 'applied' });
    expect((await revision()).academic).toBe(before.academic + 1);
    expect((await pg.query('SELECT eligibility FROM student_portal.account')).rows).toEqual([{ eligibility: 'eligible' }]);
    const after = await revision();
    expect(await service.execute(relation(2026, 'T26', 'a'))).toMatchObject({ state: 'no-changes' });
    expect(await revision()).toEqual(after);
  });

  it('records marks once but excludes a professor-only metadata change from the academic revision', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    const before = await revision();
    expect(await service.execute(notes2026())).toMatchObject({ state: 'applied' });
    expect((await revision()).academic).toBe(before.academic + 1);
    const after = await revision();
    expect(await service.execute(notes2026())).toMatchObject({ state: 'no-changes' });
    expect(await revision()).toEqual(after);
    expect(await service.execute({ ...notes2026(), professor: 'Docente Teste' })).toMatchObject({ state: 'applied' });
    expect(await revision()).toEqual({ academic: after.academic, reset: after.reset + 1 });
  });

  it('rolls back a failure after event and lifecycle writes; a retry then revokes the session with the exit', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    await pg.exec(`INSERT INTO student_portal.session (id,account_id,token_hash,security_version,expires_at,persistent)
      SELECT gen_random_uuid(),id,'synthetic-import-session',security_version,now()+interval '1 day',false FROM student_portal.account`);
    const before = await revision();
    const relationExit = relation(2026, 'T26', 'b');
    const request: GradebookRelationImportRequestV9 = { ...relationExit,
      turmas: relationExit.turmas.map((t) => ({ ...t, alunos: [[1, 'ALUNO HOMONIMO TESTE', 3]] })) };
    failAfterSync = true;
    try { await expect(service.execute(request)).rejects.toThrow('synthetic-after-lifecycle'); }
    finally { failAfterSync = false; }
    expect(await revision()).toEqual(before);
    expect((await pg.query('SELECT situacao FROM gradebook.vinculo')).rows).toEqual([{ situacao: null }]);
    expect((await pg.query('SELECT revoked_at FROM student_portal.session')).rows).toEqual([{ revoked_at: null }]);
    expect(await service.execute(request)).toMatchObject({ state: 'applied' });
    expect((await revision()).academic).toBe(before.academic + 1);
    expect((await pg.query('SELECT eligibility FROM student_portal.account')).rows).toEqual([{ eligibility: 'exit' }]);
    expect((await pg.query('SELECT revoked_at IS NOT NULL AS revoked FROM student_portal.session')).rows).toEqual([{ revoked: true }]);
    const after = await revision();
    expect(await service.execute(request)).toMatchObject({ state: 'no-changes' });
    expect(await revision()).toEqual(after);
  });
});
