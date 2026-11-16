// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  relationalCouncilRequestSchemaV3,
  relationalCouncilResponseSchemaV3,
} from '../../../shared/gradebook-contracts/council/relational-council-v3';

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0003_council_session_v3.sql', 'utf8'),
  );
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0004_council_v3_least_privilege.sql', 'utf8'),
  );
}, 30_000);
afterAll(async () => {
  await pg?.close();
});

describe('relational Council V3 contract', () => {
  it('accepts valid academic-year commands with CAS, idempotency and justification', () => {
    const valid = {
      contractVersion: 3,
      operation: 'decision',
      year: 2026,
      classId: 1,
      studentId: 2,
      decision: 1,
      expectedVersion: 3,
      idempotencyKey: 'decision:test:0001',
      justification: 'Deliberação registrada.',
    };
    expect(relationalCouncilRequestSchemaV3.safeParse(valid).success).toBe(true);
    expect(relationalCouncilRequestSchemaV3.safeParse({ ...valid, year: 2025 }).success).toBe(true);
    expect(relationalCouncilRequestSchemaV3.safeParse({ ...valid, year: 1999 }).success).toBe(
      false,
    );
    expect(
      relationalCouncilRequestSchemaV3.safeParse({ ...valid, expectedVersion: -1 }).success,
    ).toBe(false);
    expect(relationalCouncilRequestSchemaV3.safeParse({ ...valid, tieBreak: true }).success).toBe(
      false,
    );
    expect(relationalCouncilRequestSchemaV3.safeParse({ ...valid, presentes: 3 }).success).toBe(
      false,
    );
  });

  it('derives presentes and rejects contradictory transport data', () => {
    const failure = { contractVersion: 3, state: 'version-conflict', currentVersion: 4 };
    expect(relationalCouncilResponseSchemaV3.safeParse(failure).success).toBe(true);
    const source = readFileSync(
      'shared/gradebook-contracts/council/relational-council-v3.ts',
      'utf8',
    );
    expect(source).toContain('presentes !== value.favoraveis + value.contrarios');
    expect(source).not.toMatch(/tieBreak|desempate|director|diretor/iu);
  });
});

describe('additive Council V3 schema', () => {
  it('creates only the missing relational facts without touching legacy columns or rows', async () => {
    const tables = (
      await pg.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='gradebook' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    expect(tables).toEqual(
      expect.arrayContaining([
        'conselho_sessao',
        'conselho_sessao_historico',
        'conselho_votacao',
        'conselho_votacao_historico',
        'conselho_decisao_comando',
        'conselho_fechamento',
        'conselho_fechamento_item',
        'conselho_idempotencia',
      ]),
    );
    expect(
      (
        await pg.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='gradebook' AND table_name='aluno' AND column_name='conselho_anterior'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await pg.query('SELECT count(*)::integer AS count FROM gradebook.conselho_decisao')).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('stores no persisted presentes, director or tie-break field', async () => {
    const columns = (
      await pg.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='gradebook' AND table_name LIKE 'conselho_%' ORDER BY column_name",
      )
    ).rows.map((row) => row.column_name);
    expect(columns).not.toEqual(expect.arrayContaining(['presentes', 'diretor_id', 'desempate']));
  });

  it('enforces immutable command keys, non-negative votes and backend-only grants', async () => {
    await pg.exec(`
      INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
      INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES (1,2026,'S1','TURMA SINTETICA',6,'TESTE');
      INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO');
      INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,1,1,1);
      INSERT INTO gradebook.conselho_sessao (ano,turma_id,estado,versao,atualizado_por)
        VALUES (2026,1,1,1,'11111111-1111-4111-8111-111111111111');
    `);
    await expect(
      pg.exec(`INSERT INTO gradebook.conselho_votacao
      (ano,turma_id,aluno_id,favoraveis,contrarios,versao,justificativa,registrado_por)
      VALUES (2026,1,1,-1,0,2,'Teste','11111111-1111-4111-8111-111111111111')`),
    ).rejects.toMatchObject({ code: '23514' });
    const publicAccess = (
      await pg.query(
        "SELECT has_table_privilege('public','gradebook.conselho_sessao','SELECT') AS allowed",
      )
    ).rows;
    expect(publicAccess).toEqual([{ allowed: false }]);
    const backendAccess = (
      await pg.query(`SELECT
      has_table_privilege('gradebook_app','gradebook.conselho_sessao','SELECT') AS session_select,
      has_table_privilege('gradebook_app','gradebook.conselho_sessao','INSERT') AS session_insert,
      has_table_privilege('gradebook_app','gradebook.conselho_sessao','UPDATE') AS session_update,
      has_table_privilege('gradebook_app','gradebook.conselho_sessao','DELETE') AS session_delete,
      has_table_privilege('gradebook_app','gradebook.conselho_fechamento_item','SELECT') AS snapshot_select,
      has_table_privilege('gradebook_app','gradebook.conselho_fechamento_item','INSERT') AS snapshot_insert,
      has_table_privilege('gradebook_app','gradebook.conselho_fechamento_item','UPDATE') AS snapshot_update,
      has_table_privilege('gradebook_app','gradebook.conselho_fechamento_item','DELETE') AS snapshot_delete,
      has_sequence_privilege('gradebook_app','gradebook.conselho_fechamento_id_seq','USAGE') AS sequence_usage,
      has_sequence_privilege('gradebook_app','gradebook.conselho_fechamento_id_seq','SELECT') AS sequence_select,
      has_sequence_privilege('gradebook_app','gradebook.conselho_fechamento_id_seq','UPDATE') AS sequence_update`)
    ).rows;
    expect(backendAccess).toEqual([
      {
        session_select: true,
        session_insert: true,
        session_update: true,
        session_delete: false,
        snapshot_select: true,
        snapshot_insert: true,
        snapshot_update: false,
        snapshot_delete: false,
        sequence_usage: true,
        sequence_select: true,
        sequence_update: false,
      },
    ]);
  });
});
