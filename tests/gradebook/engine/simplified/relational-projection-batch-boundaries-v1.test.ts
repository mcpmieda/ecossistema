import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresSqlV1,
} from '../../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createRelationalAcademicProjectionServiceV1 } from '../../../../server/gradebook/application/results/relational-academic-projection-v1';

// Synthetic SQL fixture for read boundaries, deliberately not a production-schema baseline.
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
const queries: string[] = [];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA gradebook;
    CREATE TABLE gradebook.ano_letivo (ano integer PRIMARY KEY, minimo_aprovacao integer);
    CREATE TABLE gradebook.oferta (id integer PRIMARY KEY, ano integer, turma_id integer);
    CREATE TABLE gradebook.vinculo (ano integer, turma_id integer, aluno_id integer, situacao integer);
    CREATE TABLE gradebook.instrumento (id integer PRIMARY KEY, oferta_id integer, trimestre integer, slot integer, maximo integer, descricao text);
    CREATE TABLE gradebook.nota (instrumento_id integer, aluno_id integer, valor integer, PRIMARY KEY (instrumento_id, aluno_id));
    CREATE TABLE gradebook.fechamento (oferta_id integer, aluno_id integer, am1_fonte integer, am2_fonte integer, am3_fonte integer, rec1 integer, rec2 integer, rec3 integer, rec_nc_mask integer, u_fonte integer, rec_rr_mask integer NOT NULL DEFAULT 0);
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000);
    INSERT INTO gradebook.oferta SELECT n,2026,1 FROM generate_series(1,100) n;
    INSERT INTO gradebook.vinculo SELECT 2026,1,n,null FROM generate_series(1,10) n;
    INSERT INTO gradebook.instrumento
      SELECT o.id*100+t.n*20+s.n,o.id,t.n,s.n,
             CASE WHEN s.n=11 THEN CASE WHEN t.n=3 THEN 22000 ELSE 16500 END
                  ELSE CASE WHEN t.n=3 THEN 9000 ELSE 6750 END END
      FROM gradebook.oferta o CROSS JOIN generate_series(1,3) t(n) CROSS JOIN (VALUES (1),(2),(11)) s(n);
    INSERT INTO gradebook.nota SELECT id,1,CASE WHEN slot=11 THEN 8000 ELSE 6000 END FROM gradebook.instrumento;
    INSERT INTO gradebook.nota SELECT id,2,CASE WHEN slot=11 THEN 6000 ELSE 2000 END FROM gradebook.instrumento;
    INSERT INTO gradebook.fechamento VALUES (1,1,19500,20000,20000,null,null,null,0,60000),(1,2,10000,10000,10000,null,null,null,2,null);
  `);
  const sql: GradebookPostgresSqlV1 = {
    async unsafe(query, values = []) {
      queries.push(query);
      return (await pg.query<Record<string, unknown>>(query, [...values])).rows;
    },
    async begin() { throw new Error('Unexpected transaction in a read-only projection'); },
    async end() { await pg.close(); },
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
}, 30_000);

afterAll(async () => { await database?.close(); });
beforeEach(() => { queries.length = 0; });

describe('relational batch boundary and source parity', () => {
  it('accepts exactly 1,000 unique pairs in one SQL read without dropping students', async () => {
    const requests = Array.from({ length: 1000 }, (_, index) => ({
      ofertaId: (index % 100) + 1, alunoId: Math.floor(index / 100) + 1,
    }));
    const results = await createRelationalAcademicProjectionServiceV1(database).projectMany(requests);
    expect(results).toHaveLength(1000);
    expect(queries).toHaveLength(1);
    expect(results.map(({ ofertaId, alunoId }) => ({ ofertaId, alunoId }))).toEqual(requests);
    expect(queries[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
    expect(results[999]!.terms[0].outcome.coverage.complete).toBe(true);
  });

  it('rejects 1,001 pairs before issuing any SQL', async () => {
    await expect(createRelationalAcademicProjectionServiceV1(database).projectMany(
      Array.from({ length: 1001 }, (_, index) => ({ ofertaId: index + 1, alunoId: 1 })),
    )).rejects.toMatchObject({ code: 'projection-batch-too-large' });
    expect(queries).toHaveLength(0);
  });

  it('rejects a missing offer atomically as a result instead of returning a shortened batch', async () => {
    await expect(createRelationalAcademicProjectionServiceV1(database).projectMany([
      { ofertaId: 1, alunoId: 1 }, { ofertaId: 101, alunoId: 1 },
    ])).rejects.toMatchObject({ code: 'offer-student-not-found' });
    expect(queries).toHaveLength(1);
  });

  it('reads mismatch, second-term NC and incomplete coverage in one batch', async () => {
    const service = createRelationalAcademicProjectionServiceV1(database);
    const requests = [1,2,10].map((alunoId) => ({ ofertaId: 1, alunoId }));
    const batch = await service.projectMany(requests);
    expect(batch[0]!.terms[0].sourceComparison).toBe('mismatch');
    expect(batch[1]!.recovery.classification).toBe('failed-no-show');
    expect(batch[1]!.recovery.recoveryTerms[2].source).toBe('NC');
    expect(batch[2]!.terms[0].sourceComparison).toBe('unavailable');
  });

  it('rejects an offer without instrument definitions instead of inventing an all-zero result', async () => {
    await pg.exec('BEGIN; DELETE FROM gradebook.instrumento WHERE oferta_id=100;');
    try {
      await expect(createRelationalAcademicProjectionServiceV1(database).projectMany([
        { ofertaId: 100, alunoId: 10 },
      ])).rejects.toMatchObject({ code: 'incomplete-offer-definition' });
      expect(queries).toHaveLength(1);
    } finally {
      await pg.exec('ROLLBACK;');
    }
  });
});
