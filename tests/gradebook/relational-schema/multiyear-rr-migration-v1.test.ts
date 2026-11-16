// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = 'migrations/gradebook-simplified/';
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(`${root}0001_current_schema.sql`, 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(readFileSync(`${root}0003_council_session_v3.sql`, 'utf8'));
  await pg.exec(readFileSync(`${root}0004_council_v3_least_privilege.sql`, 'utf8'));
  await pg.exec(readFileSync(`${root}0005_relational_bulletin_snapshot_v2.sql`, 'utf8'));
  await pg.exec(readFileSync(`${root}0006_import_diagnostic_treatment_v1.sql`, 'utf8'));
  await pg.exec(readFileSync(`${root}0007_multiyear_rr_v1.sql`, 'utf8'));
}, 30_000);

afterAll(async () => {
  await pg.close();
});

describe('multiyear and R/R migration v1', () => {
  it('is additive and removes only the two fixed-2026 constraints', () => {
    const ddl = readFileSync(`${root}0007_multiyear_rr_v1.sql`, 'utf8');
    expect(ddl).not.toMatch(/\b(?:UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/iu);
    expect(ddl).toContain('DROP CONSTRAINT boletim_snapshot_ano_2026_ck');
    expect(ddl).toContain('DROP CONSTRAINT importacao_diagnostico_tratamento_ano_ck');
  });

  it('stores R/R separately from N/C and rejects numeric or overlapping markers', async () => {
    await pg.exec(`
      INSERT INTO gradebook.ano_letivo VALUES (2025,60000,2);
      INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES (1,2025,'T1','TURMA TESTE',6,'M');
      INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2025,'DOCENTE TESTE');
      INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (1,2025,'COMPONENTE TESTE');
      INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2025,'ALUNO TESTE');
      INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2025,1,1,1);
      INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES (1,2025,1,1,1);
      INSERT INTO gradebook.fechamento (oferta_id,aluno_id,rec_rr_mask) VALUES (1,1,2);
      INSERT INTO gradebook.importacao (id,ano,tipo,arquivo,hash) VALUES (1,2025,2,'test.xlsx',decode(repeat('a',64),'hex'));
      INSERT INTO gradebook.fechamento_historico
        (importacao_id,oferta_id,aluno_id,campo,estado_anterior,estado_novo)
        VALUES (1,1,1,5,0,3);
    `);
    expect(
      (await pg.query('SELECT rec_nc_mask,rec_rr_mask,rec2 FROM gradebook.fechamento')).rows,
    ).toEqual([{ rec_nc_mask: 0, rec_rr_mask: 2, rec2: null }]);
    await expect(
      pg.exec('UPDATE gradebook.fechamento SET rec2=1000 WHERE oferta_id=1 AND aluno_id=1'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pg.exec('UPDATE gradebook.fechamento SET rec_nc_mask=2 WHERE oferta_id=1 AND aluno_id=1'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pg.exec(`INSERT INTO gradebook.fechamento_historico
      (importacao_id,oferta_id,aluno_id,campo,estado_anterior,estado_novo)
      VALUES (1,1,1,1,0,3)`),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
