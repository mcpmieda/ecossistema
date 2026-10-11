// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import { createGradebookPostgresDatabaseFromSqlV1, type GradebookPostgresDatabaseV1, type GradebookPostgresSqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import { createRelationalPerformanceV2 } from '../../../server/gradebook/application/read-models/performance/relational-performance-v2';
import { AcademicStudentReaderPostgresV1, academicToSelfV1 } from '../../../server/student-portal/academic/academic-reader-v1';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import type { GradebookImportTermV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { decimalGradeBatch837 } from '../import/decimal-grades-837-fixture';

let pg: PGlite, database: GradebookPostgresDatabaseV1;
const migration = (path: string) => readFileSync('migrations/' + path, 'utf8');
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(migration('gradebook-simplified/0001_current_schema.sql'));
  await pg.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  for (const file of ['0003_council_session_v3.sql', '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql', '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql', '0008_year_reset_acl_v1.sql', '0009_granular_observations_names_v1.sql'])
    await pg.exec(migration('gradebook-simplified/' + file));
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  for (const file of ['0008_atomic_publication_v2.sql', '0009_publication_cutover_guard_v2.sql',
    '0010_incremental_publication_v3.sql', '0011_live_event_outbox_v1.sql', '0012_granular_observations_names_v1.sql'])
    await pg.exec(migration('student-portal/' + file));
  const run = async (client: Pick<PGlite, 'query'>, sql: string, values: readonly unknown[] = []) => {
    const result = await client.query<Record<string, unknown>>(sql, [...values]);
    return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
  };
  const sql: GradebookPostgresSqlV1 = {
    unsafe: (q, v) => run(pg, q, v),
    begin: (operation) => pg.transaction((tx) => operation({ unsafe: (q, v) => run(tx, q, v) })),
    end: () => pg.close(),
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
  expect((await createGradebookRelationalImportServiceV11(database).execute({
    transportVersion: 9, operation: 'persist-relacao', ano: 2026,
    manifest: { fileName: 'SYNTHETIC ROSTER.xlsx', sha256: 'a'.repeat(64), parserVersion: 'synthetic' },
    turmas: [{ codigo: 'TEST', nome: 'SYNTHETIC CLASS', etapa: 6, turno: 'TESTE', alunos: [[1, 'SYNTHETIC STUDENT', 0]] }],
  })).state).toBe('applied');
}, 30_000);
afterAll(async () => { await database?.close(); });

it('reimports actual decimal evidence, preserves history/idempotence and exposes 0.1, zero and not-done to BN and Portal', async () => {
  const value = createGradebookCanonicalImportRequestV9(decimalGradeBatch837());
  if (value.operation !== 'persist-notas') throw new Error('notes expected');
  const service = createGradebookRelationalImportServiceV11(database);
  // Reproduce a prior import that irreversibly collapsed the decimal. Do not infer which
  // stored zeros were decimals; only the newly supplied source permits this correction.
  const oldTerm = (term: GradebookImportTermV9): GradebookImportTermV9 => ({
    ...term,
    alunos: term.alunos.map(([number, notes, am]) => [number, notes.map((n) => n === 100 ? 0 : n), am] as const),
  });
  const previous = {
    ...value,
    manifest: { ...value.manifest, parserVersion: 'synthetic:canonical-v9:observed-blanks-v1' },
    ofertas: value.ofertas.map((offer) => ({ ...offer,
      trimestres: [oldTerm(offer.trimestres[0]), oldTerm(offer.trimestres[1]), oldTerm(offer.trimestres[2])] as const,
    })),
  };
  expect((await service.execute(previous)).state).toBe('applied');
  expect((await service.execute(value)).state).toBe('applied');
  const rows = (await pg.query('SELECT i.slot,n.valor FROM gradebook.instrumento i JOIN gradebook.nota n ON n.instrumento_id=i.id WHERE i.trimestre=1 AND i.slot IN (1,2,11,12) ORDER BY i.slot')).rows;
  expect(rows).toEqual([{ slot: 1, valor: 100 }, { slot: 2, valor: 100 }, { slot: 11, valor: 0 }, { slot: 12, valor: null }]);
  expect(
    (await pg.query('SELECT * FROM gradebook.nota_historico ORDER BY importacao_id,instrumento_id,aluno_id')).rows,
  ).toEqual([]);
  expect((await service.execute(value)).state).toBe('no-changes');
  expect(
    (await pg.query('SELECT * FROM gradebook.nota_historico ORDER BY importacao_id,instrumento_id,aluno_id')).rows,
  ).toEqual([]);
  const pair = (await pg.query<{ classId: number; studentId: number; offerId: number }>(
    'SELECT v.turma_id AS "classId",v.aluno_id AS "studentId",o.id AS "offerId" FROM gradebook.vinculo v JOIN gradebook.oferta o ON o.turma_id=v.turma_id WHERE v.ano=2026',
  )).rows[0]!;
  const detail = await createRelationalPerformanceV2(database).execute({ transportVersion: 2, operation: 'cell-detail', year: 2026, period: 1, mode: 'regular', ...pair });
  if (detail.state !== 'ready' || detail.operation !== 'cell-detail') throw new Error('detail expected');
  expect(detail.terms[0].instruments).toEqual(expect.arrayContaining([
    expect.objectContaining({ slot: 1, valueMilli: 100 }),
    expect.objectContaining({ slot: 2, valueMilli: 100 }),
    expect.objectContaining({ slot: 11, valueMilli: 0 }),
    expect.objectContaining({ slot: 12, valueMilli: null, notDone: true }),
  ]));
  expect(detail.terms[0].quantitativeOriginalMilli).toBe(200);
  expect(detail.terms[0].regular.sourceReferenceMilli).toBe(100);
  const source = (await pg.query<{ payload_json: Record<string, unknown> }>('SELECT * FROM student_portal.publication_source_rows_v3(NULL)')).rows[0]!;
  const revision = (await pg.query<{ generation: string; data_counter: string }>(
    'SELECT academic_generation AS generation,academic_counter::text AS data_counter FROM student_portal.academic_revision WHERE academic_year=2026',
  )).rows[0]!;
  const version = revision.generation + ':' + revision.data_counter;
  const accountId = '83700000-0000-4000-8000-000000000001';
  const reader = new AcademicStudentReaderPostgresV1({ unsafe: async () => [] });
  const academic = reader.projectPreparedSourceV2({ academicYear: 2026, studentId: pair.studentId }, version,
    { ...source.payload_json, data_version: version, account_id: accountId });
  expect(academic).not.toBeNull();
  const self = academicToSelfV1(academic!.student, accountId);
  const partials = self.subjects[0]!.periods.find((period) => period.period === 'T1')!.partials!;
  expect(partials.slice(0, 2).map((partial) => partial.mark)).toEqual([
    expect.objectContaining({ kind: 'score', value: 0.1 }),
    expect.objectContaining({ kind: 'score', value: 0.1 }),
  ]);
  expect(partials).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: 'PART 1', mark: expect.objectContaining({ kind: 'score', value: 0 }) }),
    expect.objectContaining({ label: 'ATIVIDADE SINTETICA', notDone: true }),
  ]));
  // An unavailable fresh source cannot erase the last known decimal.
  const unavailable = createGradebookCanonicalImportRequestV9(decimalGradeBatch837({ R5: { f: '1/10' } }));
  await service.execute(unavailable);
  expect((await pg.query('SELECT n.valor FROM gradebook.nota n JOIN gradebook.instrumento i ON i.id=n.instrumento_id WHERE i.trimestre=1 AND i.slot=1')).rows).toEqual([{ valor: 100 }]);
}, 15_000);
