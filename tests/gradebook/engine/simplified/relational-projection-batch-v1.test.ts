import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresSqlV1,
} from '../../../../server/gradebook/persistence/postgres/postgres-database-v1';
import {
  createRelationalAcademicProjectionServiceV1,
  RELATIONAL_PROJECTION_BATCH_LIMIT_V1,
} from '../../../../server/gradebook/application/results/relational-academic-projection-v1';

// Entirely synthetic, in-memory SQL fixtures. No production connection or source files.
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
const queries: string[] = [];
const parameters: (readonly unknown[])[] = [];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA gradebook;
    CREATE TABLE gradebook.ano_letivo (ano integer PRIMARY KEY, minimo_aprovacao integer, max_componentes_conselho integer);
    CREATE TABLE gradebook.turma (id integer PRIMARY KEY, ano integer, codigo text, nome text);
    CREATE TABLE gradebook.aluno (id integer PRIMARY KEY, ano integer, nome text, conselho_anterior boolean);
    CREATE TABLE gradebook.vinculo (ano integer, turma_id integer, numero integer, aluno_id integer, situacao integer);
    CREATE TABLE gradebook.professor (id integer PRIMARY KEY, ano integer, nome text);
    CREATE TABLE gradebook.disciplina (id integer PRIMARY KEY, ano integer, nome text);
    CREATE TABLE gradebook.oferta (id integer PRIMARY KEY, ano integer, turma_id integer, professor_id integer, disciplina_id integer);
    CREATE TABLE gradebook.instrumento (id integer PRIMARY KEY, oferta_id integer, trimestre integer, slot integer, maximo integer, descricao text);
    CREATE TABLE gradebook.nota (instrumento_id integer, aluno_id integer, valor integer, PRIMARY KEY (instrumento_id, aluno_id));
    CREATE TABLE gradebook.fechamento (oferta_id integer, aluno_id integer, am1_fonte integer, am2_fonte integer, am3_fonte integer, rec1 integer, rec2 integer, rec3 integer, rec_nc_mask integer, u_fonte integer, rec_rr_mask integer NOT NULL DEFAULT 0, PRIMARY KEY (oferta_id, aluno_id));
    CREATE TABLE gradebook.conselho_decisao (aluno_id integer PRIMARY KEY, decisao integer);
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2),(2027,60000,2);
    INSERT INTO gradebook.turma VALUES (1,2026,'A','TURMA SINTETICA A'),(2,2026,'B','TURMA SINTETICA B'),(99,2027,'A','TURMA SINTETICA OUTRO ANO');
    INSERT INTO gradebook.aluno VALUES (1,2026,'ALUNO SINTETICO 1',false),(2,2026,'ALUNO SINTETICO 2',false),(3,2026,'ALUNO SINTETICO 3',null),(4,2026,'ALUNO SINTETICO 4',false),(5,2026,'ALUNO SINTETICO 5',false),(99,2027,'ALUNO SINTETICO 99',false);
    INSERT INTO gradebook.vinculo VALUES (2026,1,1,1,null),(2026,1,2,2,6),(2026,2,1,2,7),(2026,1,3,3,2),(2026,1,4,4,null),(2026,1,5,5,null),(2027,99,1,99,null);
    INSERT INTO gradebook.professor VALUES (1,2026,'PROFESSOR SINTETICO');
    INSERT INTO gradebook.disciplina SELECT n,2026,'COMPONENTE SINTETICO '||n FROM generate_series(1,180) n;
    INSERT INTO gradebook.oferta SELECT n,2026,1,1,n FROM generate_series(1,180) n;
    INSERT INTO gradebook.instrumento
      SELECT o.id*100+t.n*20+s.n,o.id,t.n,s.n,
             CASE WHEN s.n=11 THEN CASE WHEN t.n=3 THEN 22000 ELSE 16500 END
                  ELSE CASE WHEN t.n=3 THEN 9000 ELSE 6750 END END
      FROM gradebook.oferta o CROSS JOIN generate_series(1,3) t(n) CROSS JOIN (VALUES (1),(2),(11)) s(n);
    INSERT INTO gradebook.nota SELECT id,1,CASE WHEN slot=11 THEN 8000 ELSE 6000 END FROM gradebook.instrumento;
    INSERT INTO gradebook.nota SELECT id,4,CASE WHEN slot=1 THEN 0 WHEN slot=2 THEN 2000 ELSE 6000 END FROM gradebook.instrumento WHERE oferta_id=1;
    INSERT INTO gradebook.fechamento SELECT id,1,20000,20000,20000,null,null,null,0,60000 FROM gradebook.oferta;
    INSERT INTO gradebook.fechamento VALUES (1,4,8000,8000,8000,null,null,null,1,null),(1,5,20000,20000,20000,null,null,null,0,null);
  `);
  const sql: GradebookPostgresSqlV1 = {
    async unsafe(query, values = []) {
      queries.push(query);
      parameters.push(values);
      return (await pg.query<Record<string, unknown>>(query, [...values])).rows;
    },
    async begin() { throw new Error('A read projection must not open a write transaction'); },
    async end() { await pg.close(); },
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
}, 30_000);

afterAll(async () => { await database?.close(); });
beforeEach(() => { queries.length = 0; parameters.length = 0; });

describe('relational projection batch through the PostgreSQL adapter', () => {
  it.each([1,12,180])('projects %i pairs with one SQL statement, not N+1', async (count) => {
    const result = await createRelationalAcademicProjectionServiceV1(database).projectMany(
      Array.from({ length: count }, (_, index) => ({ ofertaId: index+1, alunoId: 1 })),
    );
    expect(result).toHaveLength(count);
    expect(queries).toHaveLength(1);
    expect(parameters[0]).toHaveLength(count*2);
    expect(queries[0]).toContain('$1::integer');
    expect(queries[0]).not.toMatch(/academic_record|academic_entity|\b(INSERT|UPDATE|DELETE)\b/iu);
    expect(result.every((entry) => entry.recovery.classification === 'approved-direct')).toBe(true);
  });

  it('preserves requested order', async () => {
    const service = createRelationalAcademicProjectionServiceV1(database);
    const bulk = await service.projectMany([{ ofertaId: 9, alunoId: 1 },{ ofertaId: 1, alunoId: 1 }]);
    expect(bulk.map((entry) => entry.ofertaId)).toEqual([9,1]);
  });

  it('separates explicit zero, unavailable grades, source AM and REC N/C', async () => {
    const result = await createRelationalAcademicProjectionServiceV1(database).projectMany([
      { ofertaId: 1, alunoId: 4 }, { ofertaId: 1, alunoId: 5 },
    ]);
    expect(result[0]!.terms[0].outcome.rawMilli).toBe(8000);
    expect(result[0]!.terms[0].outcome.coverage.complete).toBe(true);
    expect(result[0]!.terms[0].sourceComparison).toBe('match');
    expect(result[0]!.recovery.classification).toBe('failed-no-show');
    expect(result[0]!.recovery.recoveryTerms[1].source).toBe('NC');
    expect(result[1]!.terms[0].outcome.coverage.complete).toBe(true);
    expect(result[1]!.terms[0].sourceAmMilli).toBe(20000);
    expect(result[1]!.terms[0].sourceComparison).toBe('mismatch');
    expect(result[1]!.sourceUComparison).toBe('unavailable');
  });

  it.each([2,99,999])('rejects non-current, cross-year or missing membership (%i)', async (alunoId) => {
    await expect(createRelationalAcademicProjectionServiceV1(database).projectMany([
      { ofertaId: 1, alunoId: 1 }, { ofertaId: 1, alunoId },
    ])).rejects.toMatchObject({ code: 'offer-student-not-found' });
    expect(queries).toHaveLength(1);
  });

  it('returns an empty batch without SQL', async () => {
    expect(await createRelationalAcademicProjectionServiceV1(database).projectMany([])).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('rejects duplicate pairs and invalid IDs before any SQL', async () => {
    const service = createRelationalAcademicProjectionServiceV1(database);
    await expect(service.projectMany([{ ofertaId: 1, alunoId: 1 },{ ofertaId: 1, alunoId: 1 }])).rejects.toMatchObject({ code: 'invalid-relational-row' });
    await expect(service.projectMany([{ ofertaId: 1.5, alunoId: 1 }])).rejects.toMatchObject({ code: 'invalid-relational-row' });
    await expect(service.projectMany([{ ofertaId: 1, alunoId: 2_147_483_648 }])).rejects.toMatchObject({ code: 'invalid-relational-row' });
    expect(queries).toHaveLength(0);
  });

  it('rejects oversized batches rather than silently truncating a class', async () => {
    await expect(createRelationalAcademicProjectionServiceV1(database).projectMany(
      Array.from({ length: RELATIONAL_PROJECTION_BATCH_LIMIT_V1+1 }, (_, index) => ({ ofertaId: index+1, alunoId: 1 })),
    )).rejects.toMatchObject({ code: 'projection-batch-too-large' });
    expect(queries).toHaveLength(0);
  });
});
