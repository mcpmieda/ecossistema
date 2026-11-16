// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RELATIONAL_BULLETIN_LIMITS_V2,
  relationalBulletinRequestSchemaV2,
  relationalBulletinSnapshotSchemaV2,
} from '../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(
    readFileSync(
      'migrations/gradebook-simplified/0005_relational_bulletin_snapshot_v2.sql',
      'utf8',
    ),
  );
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe('relational bulletin V2 contract', () => {
  const selection = {
    year: 2026,
    classId: 1,
    studentId: 2,
    period: { kind: 'annual' },
    detail: 'summary',
    presentation: { locale: 'pt-BR', dateStyle: 'long' },
  } as const;

  it('accepts materialized academic years and bounded, unique batches', () => {
    expect(
      relationalBulletinRequestSchemaV2.safeParse({
        contractVersion: 2,
        operation: 'preview',
        selection,
      }).success,
    ).toBe(true);
    expect(
      relationalBulletinRequestSchemaV2.safeParse({
        contractVersion: 2,
        operation: 'preview',
        selection: { ...selection, year: 2025 },
      }).success,
    ).toBe(true);
    expect(
      relationalBulletinRequestSchemaV2.safeParse({
        contractVersion: 2,
        operation: 'emit-batch',
        selection: { ...selection, studentIds: [1, 1] },
      }).success,
    ).toBe(false);
    expect(
      relationalBulletinRequestSchemaV2.safeParse({
        contractVersion: 2,
        operation: 'emit-batch',
        selection: {
          ...selection,
          studentIds: Array.from(
            { length: RELATIONAL_BULLETIN_LIMITS_V2.batchStudents + 1 },
            (_, index) => index + 1,
          ),
        },
      }).success,
    ).toBe(false);
  });

  it('requires a coherent immutable artifact payload', () => {
    const source = readFileSync(
      'shared/gradebook-contracts/bulletins/relational-bulletin-v2.ts',
      'utf8',
    );
    expect(source).toContain("officialValues: z.literal('imported-source')");
    expect(source).toContain("calculatedValues: z.literal('descriptive-comparison')");
    expect(source).toContain("formalDecision: z.literal('human-recorded-only')");
    expect(relationalBulletinSnapshotSchemaV2.safeParse({ snapshotId: 'invalid' }).success).toBe(
      false,
    );
  });
});

describe('additive relational bulletin snapshot schema', () => {
  it('adds one append-only relation without academic backfill', async () => {
    const columns = (
      await pg.query<{ column_name: string }>(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'gradebook' AND table_name = 'boletim_snapshot'
         ORDER BY ordinal_position
      `)
    ).rows.map((row) => row.column_name);
    expect(columns).toEqual([
      'snapshot_id',
      'versao',
      'chave_serie',
      'ano',
      'turma_id',
      'aluno_id',
      'emitido_em',
      'emitido_por_oid',
      'data_version',
      'periodo_json',
      'detalhe',
      'apresentacao_json',
      'snapshot_json',
    ]);
    expect(
      (await pg.query('SELECT count(*)::integer AS count FROM gradebook.boletim_snapshot')).rows,
    ).toEqual([{ count: 0 }]);
    const migration = readFileSync(
      'migrations/gradebook-simplified/0005_relational_bulletin_snapshot_v2.sql',
      'utf8',
    );
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/iu);
  });

  it('enforces 2026, payload identity and least privilege', async () => {
    await pg.exec(`
      INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
      INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
        VALUES (1,2026,'6A','6º ANO A',6,'M');
      INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO');
    `);
    await expect(
      pg.exec(`
        INSERT INTO gradebook.boletim_snapshot
          (snapshot_id,versao,chave_serie,ano,turma_id,aluno_id,emitido_em,emitido_por_oid,
           data_version,periodo_json,detalhe,apresentacao_json,snapshot_json)
        VALUES
          ('11111111-1111-4111-8111-111111111111',1,'serie',2025,1,1,now(),'actor','v1',
           '{"kind":"annual"}','summary','{"locale":"pt-BR","dateStyle":"long"}',
           '{"snapshotId":"11111111-1111-4111-8111-111111111111","snapshotVersion":1,
             "dataVersion":"v1","presentation":{"locale":"pt-BR","dateStyle":"long"},
             "model":{"year":2025,"classGroup":{"id":1},"student":{"id":1},
             "period":{"kind":"annual"}}}')
      `),
    ).rejects.toBeTruthy();

    const privileges = (
      await pg.query(`SELECT
        has_table_privilege('public','gradebook.boletim_snapshot','SELECT') AS public_select,
        has_table_privilege('gradebook_app','gradebook.boletim_snapshot','SELECT') AS app_select,
        has_table_privilege('gradebook_app','gradebook.boletim_snapshot','INSERT') AS app_insert,
        has_table_privilege('gradebook_app','gradebook.boletim_snapshot','UPDATE') AS app_update,
        has_table_privilege('gradebook_app','gradebook.boletim_snapshot','DELETE') AS app_delete`)
    ).rows;
    expect(privileges).toEqual([
      {
        public_select: false,
        app_select: true,
        app_insert: true,
        app_update: false,
        app_delete: false,
      },
    ]);
  });
});
