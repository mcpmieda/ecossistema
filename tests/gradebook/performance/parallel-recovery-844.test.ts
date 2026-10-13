import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createRelationalPerformanceV2 } from '../../../server/gradebook/application/read-models/performance/relational-performance-v2';
import { createPerformanceAnalysisV3 } from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import {
  performanceRequestSchemaV2,
  performanceResponseSchemaV2,
} from '../../../shared/gradebook-contracts/performance/relational-performance-v2';

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
const queries: string[] = [];
const scope = { year: 2026, classId: 844001, period: 2, mode: 'regular' } as const;
const detail = { ...scope, transportVersion: 2, operation: 'cell-detail', studentId: 844001, offerId: 844001 } as const;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(readFileSync('tests/gradebook/fixtures/student-presentation-relation.sql', 'utf8'));
  // Local synthetic schema mirrors the nullable granular facts; no production SQL.
  await pg.exec(`
    ALTER TABLE gradebook.nota ALTER COLUMN valor DROP NOT NULL;
    ALTER TABLE gradebook.fechamento ADD COLUMN rec_rr_mask SMALLINT NOT NULL DEFAULT 0;
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
      VALUES (844001,2026,'A844','TURMA SINTETICA',6,'M');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (844001,2026,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (844001,2026,'COMPONENTE SINTETICO');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id)
      VALUES (844001,2026,844001,844001,844001);
    INSERT INTO gradebook.aluno (id,ano,nome)
      SELECT 844000+n,2026,'ESTUDANTE SINTETICO '||n FROM generate_series(1,3) n;
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id)
      SELECT 2026,844001,n,844000+n FROM generate_series(1,3) n;
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT 8440000+t*100+s,844001,t,s,
        CASE WHEN s=1 THEN CASE WHEN t=3 THEN 13000 ELSE 8500 END
          WHEN s=2 THEN 5000 WHEN s=11 THEN CASE WHEN t=3 THEN 22000 ELSE 16500 END ELSE NULL END,
        'AVALIACAO SINTETICA'
      FROM generate_series(1,3) t CROSS JOIN (VALUES (1),(2),(3),(11)) slots(s);
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT i.id,844000+n,CASE
        WHEN trimestre=2 AND n=1 AND slot=1 THEN 200
        WHEN trimestre=2 AND n IN (1,2) AND slot=3 THEN 7000
        WHEN trimestre=2 AND n=1 AND slot=11 THEN 12000 ELSE NULL END
      FROM gradebook.instrumento i CROSS JOIN generate_series(1,3) n;
    INSERT INTO gradebook.fechamento (oferta_id,aluno_id,am2_fonte)
      VALUES (844001,844001,29000);
  `);
  const sql: GradebookPostgresSqlV1 = {
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
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
}, 30000);
afterAll(async () => { await database?.close(); });
beforeEach(() => { queries.length = 0; });

it('returns the exact central sum on opt-in and retains rounded/source values separately', async () => {
  const response = await createRelationalPerformanceV2(database).execute({ ...detail, includeRawSum: true });
  if (response.state !== 'ready' || response.operation !== 'cell-detail') throw new Error('expected detail');
  expect(performanceResponseSchemaV2.safeParse(response).success).toBe(true);
  expect(response.terms[1]).toMatchObject({
    parallelApplicable: true,
    showParallel: true,
    quantitativeOriginalMilli: 200,
    quantitativeConsideredMilli: 7000,
    qualitativeMilli: 12000,
    parallelMilli: 7000,
    regular: { valueMilli: 19000, rawMilli: 19000, state: 'partial', sourceReferenceMilli: 29000 },
  });
  expect(response.terms[1].instruments.find((item) => item.slot === 2)).toMatchObject({ valueMilli: null, notDone: true });
  // An empty term reads as not done: zero, marked partial.
  expect(response.terms[0].regular).toMatchObject({ valueMilli: 0, state: 'partial' });
  expect(queries).toHaveLength(6);
  expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/u);
  expect((await pg.query('SELECT am2_fonte FROM gradebook.fechamento')).rows).toEqual([{ am2_fonte: 29000 }]);
  expect((await pg.query('SELECT valor FROM gradebook.nota WHERE instrumento_id=8440202 AND aluno_id=844001')).rows).toEqual([{ valor: null }]);
});

it('keeps the exact pre-extension response shape without opt-in', async () => {
  const response = await createRelationalPerformanceV2(database).execute(detail);
  if (response.state !== 'ready' || response.operation !== 'cell-detail') throw new Error('expected detail');
  expect(response.terms.every((term) => !('rawMilli' in term.regular))).toBe(true);
  expect(performanceRequestSchemaV2.safeParse({ ...detail, includeRawSum: false }).success).toBe(false);
});

it('shows an eligible parallel-only result and reads an empty period as not done', async () => {
  const response = await createRelationalPerformanceV2(database).execute({
    ...scope, transportVersion: 2, operation: 'matrix', statuses: [null],
  });
  if (response.state !== 'ready' || response.operation !== 'matrix') throw new Error('expected matrix');
  expect(response.rows[0]?.cells[0]).toMatchObject({ valueMilli: 19000, state: 'partial' });
  expect(response.rows[1]?.cells[0]).toMatchObject({ valueMilli: 7000, state: 'partial' });
  expect(response.rows[2]?.cells[0]).toMatchObject({ valueMilli: 0, state: 'partial' });
  expect(response.rows.every((row) => !('rawMilli' in row.cells[0]!))).toBe(true);
  const invalid = structuredClone(response);
  // A raw sum is only valid beside a numeric result.
  invalid.rows[2]!.cells[0] = { ...invalid.rows[2]!.cells[0]!, state: 'unavailable', valueMilli: null, level: 'not-classified', rawMilli: 0 };
  expect(performanceResponseSchemaV2.safeParse(invalid).success).toBe(false);
});

it('propagates the same quantitative gain through the existing composition lens', async () => {
  const response = await createPerformanceAnalysisV3(database).execute({
    ...scope, transportVersion: 3, operation: 'analysis', statuses: [null],
    lens: 'quantitative', offerId: null,
  });
  if (response.state !== 'ready') throw new Error('expected analysis');
  expect(response.rows[0]?.values[0]).toMatchObject({ valueMilli: 7000, state: 'partial' });
  expect(response.rows[1]?.values[0]).toMatchObject({ valueMilli: 7000, state: 'partial' });
  expect(response.rows[2]?.values[0]).toMatchObject({ valueMilli: 0, state: 'partial' });
  expect(queries).toHaveLength(6);
});
