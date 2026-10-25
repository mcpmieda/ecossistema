import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = 'migrations/gradebook-simplified/';
const ddl = readFileSync(`${root}0001_current_schema.sql`, 'utf8');
const inspect = readFileSync(`${root}inspect_current_schema.sql`, 'utf8');
const expected: unknown = JSON.parse(readFileSync(`${root}catalog_20260910.json`, 'utf8'));
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(ddl);
  // Disposable roles with no credentials. These are not Supabase/production roles.
  await pg.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(readFileSync(`${root}application_role_grants.sql`, 'utf8'));
}, 30_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => { await pg.exec('BEGIN;'); });
afterEach(async () => { await pg.exec('ROLLBACK;'); });

async function seed() {
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2090,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
      (1,2090,'S1','TURMA SINTETICA UM',6,'TESTE'),(2,2090,'S2','TURMA SINTETICA DOIS',6,'TESTE');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2090,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (1,2090,'COMPONENTE SINTETICO');
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2090,'ALUNO SINTETICO UM'),(2,2090,'ALUNO SINTETICO DOIS');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2090,1,1,1),(2090,2,1,2);
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES (1,2090,1,1,1);
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo) VALUES (1,1,1,1,10000);
    INSERT INTO gradebook.importacao (id,ano,tipo,arquivo,hash) VALUES (1,2090,1,'synthetic.xlsx',decode(repeat('a',64),'hex'));
  `);
}

describe('current relational schema reconstructed from the production catalog', () => {
  it('reproduces the observed 20 tables, 127 columns, 123 constraints, 38 indexes, 4 functions and 3 triggers exactly', async () => {
    expect((await pg.query(inspect)).rows).toEqual(expected);
  });

  it('contains no academic rows and does not recreate the previous record model', async () => {
    const tables = (await pg.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='gradebook' ORDER BY tablename")).rows;
    expect(tables).toHaveLength(20);
    for (const {tablename} of tables) {
      expect(tablename).toMatch(/^[a-z_]+$/u);
      expect(tablename).not.toMatch(/streams|versions/u);
      expect((await pg.query<{count:number}>(`SELECT count(*)::integer AS count FROM gradebook.${tablename}`)).rows[0]!.count).toBe(0);
    }
  });

  it('fails on an existing schema instead of resetting or overwriting it', async () => {
    await seed();
    await expect(pg.exec(ddl)).rejects.toMatchObject({ code:'42P06' });
  });

  it('preserves the deferred first-import year reference', async () => {
    await pg.exec("INSERT INTO gradebook.importacao (ano,tipo,arquivo,hash) VALUES (2091,1,'synthetic-first.xlsx',decode(repeat('a',64),'hex')); INSERT INTO gradebook.ano_letivo VALUES (2091,60000,2); SET CONSTRAINTS ALL IMMEDIATE;");
    expect((await pg.query('SELECT ano FROM gradebook.importacao')).rows).toEqual([{ano:2091}]);
  });

  it('distinguishes three physical triggers from six information-schema event rows', async () => {
    const result = await pg.query(`SELECT
      (SELECT count(*)::integer FROM pg_constraint WHERE connamespace='gradebook'::regnamespace AND contype='f') AS fks,
      (SELECT count(*)::integer FROM information_schema.triggers WHERE trigger_schema='gradebook') AS event_rows`);
    expect(result.rows).toEqual([{fks:34,event_rows:6}]);
  });

  it('keeps backend-only grants and does not grant public access or DDL to the application', async () => {
    const rows = (await pg.query(`SELECT r.rolname,
      has_schema_privilege(r.rolname,'gradebook','USAGE') AS usage,
      has_schema_privilege(r.rolname,'gradebook','CREATE') AS create_schema_objects,
      count(*) FILTER (WHERE has_table_privilege(r.rolname,c.oid,'SELECT'))::integer AS readable
      FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE r.rolname IN ('anon','authenticated','gradebook_app') AND n.nspname='gradebook' AND c.relkind='r'
      GROUP BY r.rolname ORDER BY r.rolname`)).rows;
    expect(rows).toEqual([
      {rolname:'anon',usage:false,create_schema_objects:false,readable:0},
      {rolname:'authenticated',usage:false,create_schema_objects:false,readable:0},
      {rolname:'gradebook_app',usage:true,create_schema_objects:false,readable:20},
    ]);
  });

  it('accepts an explicit academic zero as a row, not as absence', async () => {
    await seed();
    await pg.exec('INSERT INTO gradebook.nota VALUES (1,1,0);');
    expect((await pg.query('SELECT valor FROM gradebook.nota')).rows).toEqual([{valor:0}]);
  });

  it.each([
    ['a negative grade', 'INSERT INTO gradebook.nota VALUES (1,1,-1)', '23514'],
    ['a grade for a student without membership in the offer class', 'INSERT INTO gradebook.nota VALUES (1,2,5000)', 'P0001'],
    ['a closing for a student without membership in the offer class', 'INSERT INTO gradebook.fechamento (oferta_id,aluno_id) VALUES (1,2)', 'P0001'],
    ['simultaneous numeric recovery and N/C', 'INSERT INTO gradebook.fechamento (oferta_id,aluno_id,rec1,rec_nc_mask) VALUES (1,1,1000,1)', '23514'],
  ])('rejects %s', async (_case, statement, code) => {
    await seed();
    await expect(pg.exec(statement)).rejects.toMatchObject({code});
  });

  it('rejects a second current binding for the same student', async () => {
    await seed();
    await expect(pg.exec('INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2090,2,2,1)')).rejects.toMatchObject({code:'23505'});
  });

  it('rejects a historical row without an actual delta', async () => {
    await seed();
    await expect(pg.exec('INSERT INTO gradebook.nota_historico VALUES (1,1,1,5000,5000)')).rejects.toMatchObject({code:'23514'});
  });

  it('requires an actor when recording previous Council information', async () => {
    await seed();
    await expect(pg.exec('UPDATE gradebook.aluno SET conselho_anterior=true WHERE id=1')).rejects.toMatchObject({code:'P0001'});
  });
});
