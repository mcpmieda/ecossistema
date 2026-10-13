import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createRelationalPerformanceV2 } from '../../../server/gradebook/application/read-models/performance/relational-performance-v2';
import { createPerformanceAnalysisV3 } from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import { createRelationalBulletinServiceV2 } from '../../../server/gradebook/application/bulletins/relational-bulletin-v2';

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
const queries: string[] = [];
const scope = { year: 2026, classId: 848001, period: 2, mode: 'regular' } as const;
const forbiddenSnapshot = async () => { throw new Error('unexpected-snapshot-operation'); };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(readFileSync('tests/gradebook/fixtures/student-presentation-relation.sql', 'utf8'));
  // Disposable roles and the canonical migration chain, never a production connection.
  await pg.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  for (const file of [
    '0003_council_session_v3.sql', '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql', '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql', '0008_year_reset_acl_v1.sql',
    '0009_granular_observations_names_v1.sql',
  ]) await pg.exec(readFileSync(`migrations/gradebook-simplified/${file}`, 'utf8'));
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
      VALUES (848001,2026,'A848','TURMA SINTETICA',6,'M');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (848001,2026,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (848001,2026,'COMPONENTE SINTETICO');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id)
      VALUES (848001,2026,848001,848001,848001);
    INSERT INTO gradebook.aluno (id,ano,nome)
      SELECT 848000+n,2026,'ESTUDANTE SINTETICO '||n FROM generate_series(1,6) n;
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id)
      SELECT 2026,848001,n,848000+n FROM generate_series(1,6) n;
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT 8480000+t*100+s,848001,t,s,
        CASE WHEN s IN (1,2) THEN CASE WHEN t=3 THEN 9000 ELSE 6750 END
          WHEN s=11 THEN CASE WHEN t=3 THEN 22000 ELSE 16500 END ELSE NULL END,
        CASE WHEN s=3 THEN 'PARA' ELSE 'AVALIACAO SINTETICA '||s END
      FROM generate_series(1,3) t CROSS JOIN (VALUES (1),(2),(3),(11)) slots(s);
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT i.id,848000+n,CASE
        WHEN trimestre<>2 THEN i.maximo
        WHEN n=5 THEN NULL
        WHEN slot IN(1,2) THEN 2000
        WHEN slot=11 THEN CASE WHEN n IN(3,4) THEN 14000 ELSE 10000 END
        WHEN slot=3 AND n=2 THEN 0
        WHEN slot=3 AND n IN(4,6) THEN 5000 ELSE NULL END
      FROM gradebook.instrumento i CROSS JOIN generate_series(1,6) n;
    INSERT INTO gradebook.fechamento (oferta_id,aluno_id,am1_fonte,am2_fonte,am3_fonte)
      SELECT 848001,848000+n,30000,CASE WHEN n=5 THEN NULL ELSE 26000 END,40000
      FROM generate_series(1,6) n;
  `);
  database = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe() { throw new Error('read-outside-transaction'); },
    async begin(operation) {
      return pg.transaction(async (tx) => operation({
        async unsafe(query, values = []) {
          queries.push(query);
          const result = await tx.query<Record<string, unknown>>(query, [...values]);
          return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
        },
      }));
    },
    async end() { await pg.close(); },
  });
}, 30000);
afterAll(async () => { await database?.close(); });
beforeEach(() => { queries.length = 0; });

it('uses one bounded snapshot for complete, partial, zero and empty results', async () => {
  const response = await createRelationalPerformanceV2(database).execute({
    ...scope, transportVersion: 2, operation: 'matrix', statuses: [null],
  });
  if (response.state !== 'ready' || response.operation !== 'matrix') throw new Error('expected-matrix');
  expect(response.rows.map((row) => [row.cells[0]!.state, row.cells[0]!.valueMilli])).toEqual([
    ['partial',14000], ['complete',14000], ['complete',18000], ['complete',19000],
    ['partial',0], ['complete',15000],
  ]);
  expect(queries).toHaveLength(6);
  expect(queries[0]).toContain('READ ONLY');
  expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/u);
});

it.each([1,2,3,4,6])('supplies visibility and granular observation from the same snapshot for synthetic student %s', async (n) => {
  const response = await createRelationalPerformanceV2(database).execute({
    ...scope, transportVersion: 2, operation: 'cell-detail', studentId: 848000+n, offerId: 848001,
  });
  if (response.state !== 'ready' || response.operation !== 'cell-detail') throw new Error('expected-detail');
  const term = response.terms[1];
  expect(term.showParallel).toBe(n!==3);
  expect(term.regular.state).toBe(n===1 ? 'partial' : 'complete');
  const parallel = term.instruments.find((item) => item.slot===3)!;
  expect(parallel.valueMilli).toBe(n===2 ? 0 : n===4 || n===6 ? 5000 : null);
  expect(parallel.notDone).toBe(n===1 || n===3 ? true : undefined);
  if (n===4 || n===6) expect(term.quantitativeConsideredMilli).toBe(5000);
  expect(queries).toHaveLength(6);
});

it('keeps unrecorded dispensed cells neutral and exposes a numeric exception without changing storage', async () => {
  const response = await createPerformanceAnalysisV3(database).execute({
    ...scope, transportVersion: 3, operation: 'analysis', lens: 'assessments', offerId: 848001, statuses: [null],
  });
  if (response.state !== 'ready') throw new Error('expected-analysis');
  const index = response.columns.findIndex((item) => item.slot===3);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(response.rows[0]!.values[index]).toMatchObject({ notDone: true, state: 'not-recorded' });
  expect(response.rows[1]!.values[index]).toMatchObject({ valueMilli: 0, state: 'complete' });
  expect(response.rows[2]!.values[index]).toMatchObject({ valueMilli: null, recordedMilli: null, state: 'not-applicable' });
  expect(response.rows[2]!.values[index]).not.toHaveProperty('notDone');
  expect(response.rows[3]!.values[index]).toMatchObject({ valueMilli: 5000, recordedMilli: 5000, state: 'complete' });
  expect(response.rows[3]!.values[index]).not.toHaveProperty('notDone');
  expect(queries).toHaveLength(6);
  expect((await pg.query('SELECT valor FROM gradebook.nota WHERE instrumento_id=8480203 AND aluno_id=848004')).rows)
    .toEqual([{ valor: 5000 }]);
});

it.each([1,2,3,4])('filters only a new bulletin projection, retaining official AM and coverage for student %s', async (n) => {
  const service = createRelationalBulletinServiceV2({ database,
    snapshots: { get: forbiddenSnapshot, getLatest: forbiddenSnapshot, history: forbiddenSnapshot, append: forbiddenSnapshot },
  });
  const response = await service.execute({ contractVersion: 2, operation: 'preview', selection: {
    year: 2026, classId: 848001, studentId: 848000+n, period: { kind: 'term', term: 2 },
    detail: 'detailed', presentation: { locale: 'pt-BR', dateStyle: 'long' },
  } }, { issuerOid: '84800000-0000-4000-8000-000000000002' });
  if (response.state !== 'ready' || response.operation !== 'preview') throw new Error('expected-preview');
  const term = response.model.subjects[0]!.terms[0]!;
  expect(term.sourceAmMilli).toBe(26000);
  expect(term.coverage.complete).toBe(true);
  expect(term.instruments.some((item) => item.slot===3)).toBe(n!==3);
  expect(term.coverage.missingSlots).toEqual(n===1 ? [3] : []);
  if (n===1) expect(term.instruments.find((item) => item.slot===3)).toMatchObject({ valueMilli: null, notDone: true });
  if (n===2) expect(term.instruments.find((item) => item.slot===3)).toMatchObject({ valueMilli: 0 });
  if (n===4) expect(term.instruments.find((item) => item.slot===3)).toMatchObject({ valueMilli: 5000 });
  expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/u);
  expect(queries.length).toBeLessThanOrEqual(8);
});
