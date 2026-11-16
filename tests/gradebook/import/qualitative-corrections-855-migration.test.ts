// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let pg: PGlite;
const migration = readFileSync(
  'migrations/gradebook-simplified/0010_qualitative_corrections_2026_v1.sql',
  'utf8',
);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0009_granular_observations_names_v1.sql', 'utf8'),
  );
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,2);
    INSERT INTO gradebook.professor (id,ano,nome) VALUES
      (1,2026,'CLEBER'),(2,2026,'LURMÁRIA'),(3,2026,'EDILMA');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES
      (1,2026,'ÉTICA'),(2,2026,'RELIGIÃO'),(3,2026,'CIÊNCIAS');
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
      (1,2026,'6A','6A',6,'M'),(2,2026,'6B','6B',6,'M'),(3,2026,'6D','6D',6,'M'),
      (4,2026,'7A','7A',7,'M'),(5,2026,'7B','7B',7,'M'),(6,2026,'7C','7C',7,'M'),
      (7,2026,'7D','7D',7,'M'),(8,2026,'8A','8A',8,'M'),(9,2026,'8B','8B',8,'M'),
      (10,2026,'8C','8C',8,'M');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES
      (1,2026,1,1,1),(2,2026,2,2,2),(3,2026,3,2,2),(4,2026,4,2,2),
      (5,2026,5,2,2),(6,2026,6,2,2),(7,2026,7,2,2),(8,2026,8,2,2),
      (9,2026,9,2,2),(10,2026,10,3,3);
    INSERT INTO gradebook.aluno (id,ano,nome)
      SELECT 100+id,2026,'SINTETICO '||id FROM gradebook.turma WHERE ano=2026;
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id)
      SELECT 2026,id,1,100+id FROM gradebook.turma WHERE ano=2026;

    -- Base qualitative maxima that are already correct once the audited extra is removed.
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao) VALUES
      (2001,1,2,11,10500,'BASE'),
      (2002,2,1,11,16500,'BASE'),
      (2003,3,1,11,16500,'BASE'),(2004,3,2,11,16500,'BASE'),
      (2005,4,1,11,16500,'BASE'),(2006,5,1,11,16500,'BASE'),
      (2007,6,2,11,16500,'BASE'),
      (2008,7,1,11,16500,'BASE'),(2009,7,2,11,16500,'BASE'),
      (2010,8,1,11,16500,'BASE'),(2011,9,1,11,16500,'BASE'),
      (2012,10,1,11,16500,'BASE');

    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao) VALUES
      (3001,1,2,12,3000,'2ª ATIVIDADE'),
      (3002,2,1,16,NULL,'EX'),
      (3003,3,1,16,1000,'EX'),
      (3004,3,2,15,500,'EX'),
      (3005,4,1,16,NULL,'EX.P'),
      (3006,5,1,16,NULL,'EX'),
      (3007,6,2,14,4500,'P.D.'),
      (3008,7,1,15,1000,'EX.'),
      (3009,7,2,15,NULL,'EX.'),
      (3010,8,1,15,4500,'P.D.'),
      (3011,9,1,15,4500,'P.D'),
      (3012,9,1,16,1000,'EX'),
      (3013,10,1,13,3000,'II ATIV');

    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor) VALUES
      (3001,101,6000),
      (3002,102,NULL),(3003,103,NULL),(3004,103,NULL),(3005,104,NULL),
      (3006,105,NULL),(3007,106,NULL),(3008,107,NULL),(3009,107,NULL),
      (3010,108,NULL),(3011,109,NULL),(3012,109,NULL),(3013,110,NULL);
  `);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

it('repairs only the proved closed-term definitions and records auditable history', async () => {
  await pg.exec(migration);

  expect(
    (
      await pg.query(`
      SELECT maximo,descricao FROM gradebook.instrumento WHERE id=3001
    `)
    ).rows,
  ).toEqual([{ maximo: 6000, descricao: '2ª ATIVIDADE' }]);

  expect(
    (
      await pg.query(`
      SELECT count(*)::integer AS n
      FROM gradebook.instrumento
      WHERE id BETWEEN 3002 AND 3013 AND (maximo IS NOT NULL OR descricao IS NOT NULL)
    `)
    ).rows,
  ).toEqual([{ n: 0 }]);

  expect(
    (
      await pg.query(`
      SELECT count(*)::integer AS n
      FROM gradebook.nota WHERE instrumento_id BETWEEN 3002 AND 3013
    `)
    ).rows,
  ).toEqual([{ n: 0 }]);

  expect(
    (
      await pg.query(`
      SELECT count(*)::integer AS n FROM gradebook.instrumento_historico
    `)
    ).rows,
  ).toEqual([{ n: 13 }]);
  expect(
    (
      await pg.query(`
      SELECT count(*)::integer AS n FROM gradebook.nota_historico
      WHERE nao_feito_anterior=true AND nao_feito_novo=false
    `)
    ).rows,
  ).toEqual([{ n: 12 }]);
  expect(
    (
      await pg.query(`
      SELECT arquivo,count(*)::integer AS n
      FROM gradebook.importacao GROUP BY arquivo
    `)
    ).rows,
  ).toEqual([{ arquivo: 'CORRECAO QUALITATIVO #855 V1', n: 1 }]);
});

it('leaves every corrected T1/T2 qualitative maximum at exactly 16.5', async () => {
  const result = await pg.query<{ n: number }>(`
    WITH target(oferta_id,trimestre) AS (
      VALUES (1,2),(2,1),(3,1),(3,2),(4,1),(5,1),(6,2),(7,1),(7,2),(8,1),(9,1),(10,1)
    ),
    active AS (
      SELECT i.*
      FROM gradebook.instrumento i
      WHERE i.slot < 11 OR i.maximo IS NOT NULL
        OR (NULLIF(btrim(i.descricao),'') IS NOT NULL
          AND NOT btrim(i.descricao) ~ ('^' || (i.slot - 10)::text || '([.,]0+)?$'))
        OR EXISTS (SELECT 1 FROM gradebook.nota n WHERE n.instrumento_id=i.id)
    ),
    total AS (
      SELECT t.oferta_id,t.trimestre,
             sum(COALESCE(i.maximo,0)) FILTER (WHERE i.slot BETWEEN 11 AND 20) AS maximum
      FROM target t
      LEFT JOIN active i ON i.oferta_id=t.oferta_id AND i.trimestre=t.trimestre
      GROUP BY t.oferta_id,t.trimestre
    )
    SELECT count(*)::integer AS n FROM total WHERE maximum<>16500
  `);
  expect(result.rows).toEqual([{ n: 0 }]);
});

it('is idempotent after the one-time correction has already been applied', async () => {
  await pg.exec(migration);
  expect((await pg.query(`SELECT count(*)::integer AS n FROM gradebook.importacao`)).rows).toEqual([
    { n: 1 },
  ]);
});
