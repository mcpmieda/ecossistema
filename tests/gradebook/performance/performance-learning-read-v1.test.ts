// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createGradebookPostgresDatabaseFromSqlV1, type GradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createPerformanceAnalyticsV6 } from '../../../server/gradebook/application/read-models/performance/performance-analytics-v6';
import { performanceAnalyticsResponseSchemaV6 } from '../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import { createPerformanceAnalysisV3 } from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
const queries: string[] = [];
const request = { transportVersion: 6, operation: 'analytics', year: 2026, classId: 1, period: 2 } as const;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(readFileSync('tests/gradebook/fixtures/student-presentation-relation.sql', 'utf8'));
  // An isolated synthetic database, never production. Null represents an observed blank.
  await pg.exec(`
    ALTER TABLE gradebook.nota ALTER COLUMN valor DROP NOT NULL;
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES (1,2026,'SYN','TURMA SINTETICA',6,'M');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2026,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (1,2026,'COMPONENTE SINTETICO A'),(2,2026,'COMPONENTE SINTETICO B');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES (1,2026,1,1,1),(2,2026,1,1,2);
    INSERT INTO gradebook.aluno (id,ano,nome) SELECT n,2026,'ALUNO SINTETICO '||n FROM generate_series(1,3) n;
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao) SELECT 2026,1,n,n,CASE WHEN n=3 THEN 4 ELSE NULL END FROM generate_series(1,3) n;
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT o*100+t*20+s,o,t,s,
        CASE WHEN s<=2 THEN 6750 WHEN s=11 THEN 3000 WHEN s=12 THEN 6000 ELSE 7500 END,
        CASE WHEN s<=2 THEN 'PROVA SINTETICA '||s WHEN s=11 THEN 'PART I' WHEN s=12 THEN 'participação 2' ELSE 'EXPERIÊNCIA — texto livre' END
      FROM generate_series(1,2) a(o) CROSS JOIN generate_series(1,2) b(t) CROSS JOIN (VALUES(1),(2),(11),(12),(13)) c(s);
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT i.id,a.id,CASE
        WHEN a.id=3 THEN 0
        WHEN i.slot=11 THEN CASE WHEN a.id=1 THEN 0 ELSE 3000 END
        WHEN i.slot=12 THEN 6000
        WHEN i.slot=13 THEN CASE WHEN a.id=1 THEN 3000 ELSE 7000 END
        ELSE CASE WHEN a.id=1 THEN 2000 ELSE 6000 END END
      FROM gradebook.instrumento i CROSS JOIN gradebook.aluno a;
  `);
  database = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe() { throw new Error('read-outside-transaction'); },
    async begin(operation) {
      return pg.transaction(async (tx) => operation({
        async unsafe(sql, values = []) {
          queries.push(sql);
          const result = await tx.query<Record<string, unknown>>(sql, [...values]);
          if (sql.startsWith('SET TRANSACTION')) {
            const settings = await tx.query("SELECT current_setting('transaction_read_only') AS r, current_setting('transaction_isolation') AS i");
            expect(settings.rows).toEqual([{ r: 'on', i: 'repeatable read' }]);
          }
          return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
        },
      }));
    },
    async end() { await pg.close(); },
  });
}, 30_000);
afterAll(async () => { await database?.close(); });
beforeEach(() => { queries.length = 0; });
async function read(includeLearning = true, includeStudentDimensions = false) {
  const value = await createPerformanceAnalyticsV6(database).execute({ ...request,
    ...(includeLearning ? { includeLearning: true } : {}),
    ...(includeStudentDimensions ? { includeStudentDimensions: true } : {}),
  });
  if (value.state !== 'ready') throw new Error(JSON.stringify(value));
  expect(performanceAnalyticsResponseSchemaV6.safeParse(value).success).toBe(true);
  return value;
}
it('recognizes divided participation from real SQL source labels in the same six-query snapshot', async () => {
  const before = await pg.query('SELECT instrumento_id,aluno_id,valor FROM gradebook.nota ORDER BY instrumento_id,aluno_id');
  const value = await read();
  expect(queries).toHaveLength(6);
  expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/u);
  expect(value.learning!.students.map((item) => item.studentId)).toEqual([1, 2]);
  expect(value.learning!.participation.recorded).toBe(8);
  expect(value.learning!.participation.expected).toBe(8);
  expect(value.learning!.participation.percent).toBeCloseTo(250 / 3);
  expect(value.learning!.students[0]!.participation.percent).toBeCloseTo(200 / 3);
  expect(value.learning!.students[0]!.participation.comparedComponents).toBe(2);
  const labels = value.components[0]!.instruments.map((item) => item.label);
  expect(labels).toContain('PART I');
  expect(labels).toContain('participação 2');
  expect(labels).toContain('EXPERIÊNCIA — texto livre');
  // Only two eligible pupils: the third is transferred, not a third data point for ranking.
  expect(value.learning!.activitiesToReview).toHaveLength(0);
  expect((await pg.query('SELECT instrumento_id,aluno_id,valor FROM gradebook.nota ORDER BY instrumento_id,aluno_id')).rows).toEqual(before.rows);
});
it('keeps older analytics labels and response shape when the caller does not opt in', async () => {
  const legacy = await read(false);
  expect(queries).toHaveLength(6);
  expect(queries.some((sql) => sql.includes('NULL::text AS descricao'))).toBe(true);
  expect(Object.hasOwn(legacy, 'learning')).toBe(false);
  expect(legacy.components[0]!.instruments.find((item) => item.slot === 11)?.label).toBe('Atividade 1');
  const current = await read();
  expect(current.summary).toEqual(legacy.summary);
  expect(current.students).toEqual(legacy.students);
});
it('counts a missing part as not done in the average and in the period comparison', async () => {
  await pg.exec('UPDATE gradebook.nota SET valor=NULL WHERE instrumento_id=151 AND aluno_id=1');
  try {
    const value = await read();
    expect(value.learning!.participation.recorded).toBe(7);
    expect(value.learning!.participation.expected).toBe(8);
    expect(value.learning!.students[0]!.participation.comparedComponents).toBe(2);
    expect(value.learning!.students[0]!.participation.percent).toBeGreaterThan(0);
  } finally { await pg.exec('UPDATE gradebook.nota SET valor=0 WHERE instrumento_id=151 AND aluno_id=1'); }
});
it('does not truncate oversized compound text into a participation alias or mutate its source', async () => {
  const description = 'PART' + ' '.repeat(600) + '+ TRABALHO';
  await pg.query('UPDATE gradebook.instrumento SET descricao=$1 WHERE id=151', [description]);
  try {
    const value = await read();
    expect(value.components[0]!.instruments.find((item) => item.slot === 11)?.label).toBe('Atividade 1');
    expect(value.learning!.participation.expected).toBe(6);
    expect((await pg.query('SELECT descricao FROM gradebook.instrumento WHERE id=151')).rows).toEqual([{ descricao: description }]);
  } finally { await pg.exec("UPDATE gradebook.instrumento SET descricao='PART I' WHERE id=151"); }
});
it('preserves the existing single-offer description query and its bound parameter', async () => {
  const result = await createPerformanceAnalysisV3(database).execute({
    transportVersion: 3, operation: 'analysis', year: 2026, classId: 1,
    period: 2, mode: 'regular', statuses: [null, 7], lens: 'assessments', offerId: 1,
  });
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('analysis-not-ready');
  expect(result.columns.map((item) => item.label)).toContain('PART I');
  expect(queries).toHaveLength(6);
});
it('does not expose the internal description option as an uncontrolled public request field', async () => {
  expect(await createPerformanceAnalyticsV6(database).execute({ ...request, includeInstrumentDescriptions: true })).toEqual({ transportVersion: 6, state: 'invalid-request' });
  expect(queries).toHaveLength(0);
});
it('negotiates student dimensions through the real service without changing the legacy payload or the six read-only queries', async () => {
  const legacy = await read(true);
  expect(queries).toHaveLength(6);
  expect(legacy.learning!.students.every((student) => !Object.hasOwn(student, 'dimensions'))).toBe(true);
  queries.length = 0;
  const current = await read(true, true);
  expect(queries).toHaveLength(6);
  expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/u);
  expect(current.learning!.students.map((student) => student.studentId)).toEqual([1, 2]);
  const first = current.learning!.students[0]!.dimensions!;
  expect(first.components).toBe(2);
  expect(first.quantitativePercent).toBeCloseTo(4000 / 13500 * 100);
  expect(first.qualitativePercent).toBeCloseTo(9000 / 16500 * 100);
  expect(first.gapPP).toBe(first.qualitativePercent! - first.quantitativePercent!);
  const withoutExtension = structuredClone(current.learning!);
  for (const student of withoutExtension.students) delete student.dimensions;
  expect(withoutExtension).toEqual(legacy.learning);
  expect(current.students).toEqual(legacy.students);
  expect(current.summary).toEqual(legacy.summary);
});
it('rejects a dimensions request without learning before reading the database', async () => {
  expect(await createPerformanceAnalyticsV6(database).execute({ ...request, includeStudentDimensions: true }))
    .toEqual({ transportVersion: 6, state: 'invalid-request' });
  expect(queries).toHaveLength(0);
});
