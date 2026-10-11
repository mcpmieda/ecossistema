// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import type {
  GradebookImportTermV9,
  GradebookNotesImportRequestV9,
  GradebookRelationImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
const file = (name: string) => readFileSync('migrations/' + name, 'utf8');
const manifest = { fileName: 'SYNTHETIC 862.xlsb', sha256: 'a'.repeat(64), parserVersion: 'synthetic-862' };

const relation: GradebookRelationImportRequestV9 = {
  transportVersion: 9, operation: 'persist-relacao',
  manifest: { ...manifest, sha256: 'b'.repeat(64) }, ano: 2026,
  turmas: [{ codigo: 'TEST', nome: 'TURMA SINTETICA', etapa: 6, turno: 'M', alunos: [[1, 'ALUNO SINTETICO', 0]] }],
};

function term(
  trimestre: 1 | 2 | 3,
  qualitative: 'numeric' | 'blank' | 'deleted',
): GradebookImportTermV9 {
  const instrumentos = [
    [1, trimestre === 3 ? 9000 : 6750, 'AV1'],
    [2, trimestre === 3 ? 9000 : 6750, 'AV2'],
    [3, null, 'PARA'],
    ...(qualitative === 'deleted' ? [] : [[11, 5000, 'ATIVIDADE']]),
  ] as GradebookImportTermV9['instrumentos'];
  const values = qualitative === 'deleted'
    ? [2000, 3000, null]
    : [2000, 3000, null, qualitative === 'blank' ? null : 4000];
  return {
    trimestre, definitionSnapshotVersion: 1, instrumentos,
    alunos: [[1, values, null]],
  };
}

function notes(t1: 'numeric' | 'blank' | 'deleted'): GradebookNotesImportRequestV9 {
  return {
    transportVersion: 9, operation: 'persist-notas', granularObservationVersion: 1,
    manifest: { ...manifest, sha256: (t1 === 'numeric' ? 'c' : t1 === 'blank' ? 'd' : 'e').repeat(64) },
    ano: 2026, professor: 'DOCENTE SINTETICO',
    ofertas: [{
      turmaCodigo: 'TEST', disciplina: 'COMPONENTE SINTETICO',
      trimestres: [term(1, t1), term(2, 'blank'), term(3, 'deleted')],
      recuperacao: [],
    }],
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(file('gradebook-simplified/0001_current_schema.sql'));
  await pg.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  for (const n of [
    '0003_council_session_v3.sql','0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql','0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql','0008_year_reset_acl_v1.sql','0009_granular_observations_names_v1.sql',
  ]) await pg.exec(file('gradebook-simplified/' + n));
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  for (const n of [
    '0008_atomic_publication_v2.sql','0009_publication_cutover_guard_v2.sql',
    '0010_incremental_publication_v3.sql','0011_live_event_outbox_v1.sql',
    '0012_granular_observations_names_v1.sql',
  ]) await pg.exec(file('student-portal/' + n));
  const run = async (client: Pick<PGlite,'query'>, query: string, values: readonly unknown[] = []) => {
    const value = await client.query<Record<string,unknown>>(query,[...values]);
    return Object.assign(value.rows,{ count: value.affectedRows ?? value.rows.length });
  };
  const sql: GradebookPostgresSqlV1 = {
    unsafe: (q,v) => run(pg,q,v),
    begin: (cb) => pg.transaction((tx) => cb({ unsafe: (q,v) => run(tx,q,v) })),
    end: () => pg.close(),
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
  expect((await createGradebookRelationalImportServiceV11(database).execute(relation)).state).toBe('applied');
},30000);

afterAll(async () => database?.close());

it('uses the latest snapshot as current state without note/instrument delta history', async () => {
  const service = createGradebookRelationalImportServiceV11(database);
  const importsBefore = (await pg.query<{ n: number }>(
    'SELECT count(*)::integer AS n FROM gradebook.importacao',
  )).rows[0]!.n;
  expect((await service.execute(notes('numeric'))).state).toBe('applied');
  const importsAfterInitial = (await pg.query<{ n: number }>(
    'SELECT count(*)::integer AS n FROM gradebook.importacao',
  )).rows[0]!.n;
  // Current-state topology/marks do not create an import ledger row by themselves.
  expect(importsBefore).toBe(0);
  expect(importsAfterInitial).toBe(importsBefore);
  expect((await pg.query(`SELECT i.slot,i.maximo,n.valor FROM gradebook.instrumento i LEFT JOIN gradebook.nota n ON n.instrumento_id=i.id WHERE i.trimestre=1 AND i.slot=11`)).rows)
    .toEqual([{ slot: 11, maximo: 5000, valor: 4000 }]);

  // Direct numeric → deleted removes the old numeric fact instead of preserving it.
  expect((await service.execute(notes('deleted'))).state).toBe('applied');
  expect(
    (await pg.query<{ n: number }>('SELECT count(*)::integer AS n FROM gradebook.importacao')).rows[0]!.n,
  ).toBe(importsAfterInitial);
  expect((await pg.query(`SELECT count(*)::integer AS n FROM gradebook.instrumento i WHERE i.trimestre=1 AND i.slot=11`)).rows)
    .toEqual([{ n: 0 }]);

  // Recreate the current instrument and prove an observed blank is still a real
  // current fact while the instrument remains active.
  expect((await service.execute(notes('numeric'))).state).toBe('applied');
  expect((await service.execute(notes('blank'))).state).toBe('applied');
  expect(
    (await pg.query<{ n: number }>('SELECT count(*)::integer AS n FROM gradebook.importacao')).rows[0]!.n,
  ).toBe(importsAfterInitial);
  expect((await pg.query(`SELECT i.slot,i.maximo,n.valor FROM gradebook.instrumento i LEFT JOIN gradebook.nota n ON n.instrumento_id=i.id WHERE i.trimestre=1 AND i.slot=11`)).rows)
    .toEqual([{ slot: 11, maximo: 5000, valor: null }]);
  expect((await pg.query('SELECT count(*)::integer AS n FROM gradebook.nota_historico')).rows).toEqual([{ n: 0 }]);
  expect((await pg.query('SELECT count(*)::integer AS n FROM gradebook.instrumento_historico')).rows).toEqual([{ n: 0 }]);

  expect((await service.execute(notes('deleted'))).state).toBe('applied');
  expect((await pg.query(`SELECT count(*)::integer AS n FROM gradebook.instrumento i WHERE i.trimestre=1 AND i.slot=11`)).rows)
    .toEqual([{ n: 0 }]);
  expect((await pg.query(`SELECT count(*)::integer AS n FROM gradebook.nota n JOIN gradebook.instrumento i ON i.id=n.instrumento_id WHERE i.trimestre=1 AND i.slot=11`)).rows)
    .toEqual([{ n: 0 }]);
  expect((await pg.query('SELECT count(*)::integer AS n FROM gradebook.nota_historico')).rows).toEqual([{ n: 0 }]);
  expect((await pg.query('SELECT count(*)::integer AS n FROM gradebook.instrumento_historico')).rows).toEqual([{ n: 0 }]);
});

it('keeps observed blank only for an instrument that remains active', async () => {
  const rows = (await pg.query(`
    SELECT i.trimestre,i.slot,n.valor
    FROM gradebook.instrumento i
    JOIN gradebook.nota n ON n.instrumento_id=i.id
    WHERE i.slot=11 ORDER BY i.trimestre
  `)).rows;
  expect(rows).toEqual([{ trimestre: 2, slot: 11, valor: null }]);
});
