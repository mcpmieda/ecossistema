// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = 'migrations/gradebook-simplified/';
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(root + '0001_current_schema.sql', 'utf8'));
  await pg.exec(
    'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;',
  );
  await pg.exec(readFileSync(root + 'application_role_grants.sql', 'utf8'));
  for (const file of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
    '0008_year_reset_acl_v1.sql',
    '0009_granular_observations_names_v1.sql',
    '0010_qualitative_corrections_2026_v1.sql',
    '0011_gradebook_rls_v1.sql',
  ])
    await pg.exec(readFileSync(root + file, 'utf8'));

  await pg.exec(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho)
      VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
      VALUES (1,2026,'T1','TURMA SINTETICA',6,'M');
    INSERT INTO gradebook.professor (id,ano,nome)
      VALUES (1,2026,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome)
      VALUES (1,2026,'COMPONENTE SINTETICO');
    INSERT INTO gradebook.aluno (id,ano,nome)
      VALUES (1,2026,'ALUNO SINTETICO');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id)
      VALUES (2026,1,1,1);
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id)
      VALUES (1,2026,1,1,1);

    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao) VALUES
      (1,1,1,11,5000,'ATIVIDADE ATIVA'),
      (2,1,1,12,5000,'ATIVIDADE EM BRANCO'),
      (3,1,1,13,NULL,NULL),
      (4,1,1,14,NULL,NULL);
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor) VALUES
      (1,1,4000),
      (2,1,NULL),
      (4,1,NULL);

    INSERT INTO gradebook.importacao (id,ano,tipo,arquivo,hash) VALUES
      (1,2026,2,'REFERENCIADA.xlsx',decode(repeat('a',64),'hex')),
      (2,2026,2,'SO HISTORICO.xlsx',decode(repeat('b',64),'hex')),
      (3,2026,2,'SEM REFERENCIA.xlsx',decode(repeat('c',64),'hex'));

    INSERT INTO gradebook.fechamento (oferta_id,aluno_id,am1_fonte)
      VALUES (1,1,9000);
    INSERT INTO gradebook.fechamento_historico
      (importacao_id,oferta_id,aluno_id,campo,valor_anterior,valor_novo,estado_anterior,estado_novo)
      VALUES (1,1,1,1,8000,9000,1,1);

    INSERT INTO gradebook.instrumento_historico
      (importacao_id,instrumento_id,maximo_anterior,maximo_novo,descricao_anterior,descricao_nova)
      VALUES (2,1,4000,5000,'ANTERIOR','ATIVIDADE ATIVA');
    INSERT INTO gradebook.nota_historico
      (importacao_id,instrumento_id,aluno_id,valor_anterior,valor_novo)
      VALUES (2,1,1,3000,4000);

    INSERT INTO gradebook.importacao_diagnostico
      (id,ano,arquivo,hash,chave,nivel,codigo,campo)
      VALUES (1,2026,'AUDIT.xlsx',decode(repeat('d',64),'hex'),'atual','warning','source-unavailable','file');
    INSERT INTO gradebook.importacao_diagnostico_tratamento
      (id,diagnostico_origem_id,ano,arquivo,hash,chave,nivel,codigo,campo,acao,nota,chave_idempotencia,registrado_por)
      VALUES
      (1,1,2026,'AUDIT.xlsx',decode(repeat('d',64),'hex'),'atual','warning','source-unavailable','file',1,NULL,'idem-atual','00000000-0000-4000-8000-000000000001'),
      (2,999,2026,'AUDIT.xlsx',decode(repeat('d',64),'hex'),'orfao','warning','source-unavailable','file',1,NULL,'idem-orfao','00000000-0000-4000-8000-000000000002');
  `);
  await pg.exec(readFileSync(root + '0012_current_state_cleanup_v1.sql', 'utf8'));
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

it('removes retired granular histories and only unreferenced import rows', async () => {
  expect(
    (
      await pg.query(`
      SELECT
        (SELECT count(*)::integer FROM gradebook.nota_historico) AS note_history,
        (SELECT count(*)::integer FROM gradebook.instrumento_historico) AS instrument_history,
        (SELECT array_agg(id ORDER BY id) FROM gradebook.importacao) AS imports
    `)
    ).rows,
  ).toEqual([{ note_history: 0, instrument_history: 0, imports: [1] }]);
});

it('removes only a completely empty qualitative instrument', async () => {
  expect(
    (
      await pg.query(`
      SELECT id,slot,maximo,descricao,
             EXISTS(SELECT 1 FROM gradebook.nota n WHERE n.instrumento_id=i.id) AS observed
      FROM gradebook.instrumento i
      ORDER BY id
    `)
    ).rows,
  ).toEqual([
    { id: 1, slot: 11, maximo: 5000, descricao: 'ATIVIDADE ATIVA', observed: true },
    { id: 2, slot: 12, maximo: 5000, descricao: 'ATIVIDADE EM BRANCO', observed: true },
    { id: 4, slot: 14, maximo: null, descricao: null, observed: true },
  ]);
  expect(
    (await pg.query('SELECT instrumento_id,valor FROM gradebook.nota ORDER BY instrumento_id'))
      .rows,
  ).toEqual([
    { instrumento_id: 1, valor: 4000 },
    { instrumento_id: 2, valor: null },
    { instrumento_id: 4, valor: null },
  ]);
});

it('keeps current academic values and retained closure history intact', async () => {
  expect(
    (
      await pg.query(`
      SELECT
        count(*)::integer AS notes,
        count(*) FILTER (WHERE valor IS NOT NULL)::integer AS numeric_notes,
        COALESCE(sum(valor) FILTER (WHERE valor IS NOT NULL),0)::integer AS numeric_sum
      FROM gradebook.nota
    `)
    ).rows,
  ).toEqual([{ notes: 3, numeric_notes: 1, numeric_sum: 4000 }]);
  expect((await pg.query('SELECT am1_fonte FROM gradebook.fechamento')).rows).toEqual([
    { am1_fonte: 9000 },
  ]);
  expect(
    (await pg.query('SELECT importacao_id,valor_novo FROM gradebook.fechamento_historico')).rows,
  ).toEqual([{ importacao_id: 1, valor_novo: 9000 }]);
});

it('removes only orphan Audit treatment and keeps the current treatment', async () => {
  expect(
    (await pg.query('SELECT chave FROM gradebook.importacao_diagnostico_tratamento ORDER BY chave'))
      .rows,
  ).toEqual([{ chave: 'atual' }]);
});

it('prevents runtime insertion/update of retired histories while preserving read/delete', async () => {
  expect(
    (
      await pg.query(`
      SELECT
        has_table_privilege('gradebook_app','gradebook.nota_historico','SELECT') AS note_select,
        has_table_privilege('gradebook_app','gradebook.nota_historico','DELETE') AS note_delete,
        has_table_privilege('gradebook_app','gradebook.nota_historico','INSERT') AS note_insert,
        has_table_privilege('gradebook_app','gradebook.nota_historico','UPDATE') AS note_update,
        has_table_privilege('gradebook_app','gradebook.instrumento_historico','SELECT') AS instrument_select,
        has_table_privilege('gradebook_app','gradebook.instrumento_historico','DELETE') AS instrument_delete,
        has_table_privilege('gradebook_app','gradebook.instrumento_historico','INSERT') AS instrument_insert,
        has_table_privilege('gradebook_app','gradebook.instrumento_historico','UPDATE') AS instrument_update
    `)
    ).rows,
  ).toEqual([
    {
      note_select: true,
      note_delete: true,
      note_insert: false,
      note_update: false,
      instrument_select: true,
      instrument_delete: true,
      instrument_insert: false,
      instrument_update: false,
    },
  ]);
});
