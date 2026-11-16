// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1,
  importDiagnosticTreatmentRequestSchemaV1,
} from '../../../shared/gradebook-contracts/audit/import-diagnostic-treatment-v1';

let pg: PGlite;
const migrationPath = 'migrations/gradebook-simplified/0006_import_diagnostic_treatment_v1.sql';

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(readFileSync(migrationPath, 'utf8'));
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
      VALUES (1,2026,'6A','TURMA SINTETICA',6,'M');
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,1,1,1);
    INSERT INTO gradebook.importacao_diagnostico
      (id,ano,arquivo,hash,chave,nivel,codigo,turma_codigo,disciplina,periodo,
       aluno_numero,campo,rotulo)
      VALUES (1,2026,'fonte-sintetica.xlsb',decode(repeat('a',64),'hex'),'achado-1',
        'warning','source-unavailable','6A','MATEMATICA','1 trimestre',1,
        'term-result','Resultado');
  `);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

function treatmentValues(action: 1 | 2, note: string): string {
  return `(1,2026,'fonte-sintetica.xlsb',decode(repeat('a',64),'hex'),'achado-1',
    'warning','source-unavailable','6A','MATEMATICA','1 trimestre',1,'term-result',
    'Resultado',${String(action)},${note},'audit:synthetic:${String(action)}',
    '11111111-1111-4111-8111-111111111111')`;
}

describe('import diagnostic treatment V1 contract', () => {
  it('accepts valid academic years and keeps acknowledgement distinct from a note', () => {
    const base = {
      contractVersion: 1,
      operation: 'record',
      year: 2026,
      diagnosticId: 1,
      action: IMPORT_DIAGNOSTIC_TREATMENT_ACTIONS_V1.acknowledged,
      note: null,
      idempotencyKey: 'audit:synthetic:0001',
    } as const;
    expect(importDiagnosticTreatmentRequestSchemaV1.safeParse(base).success).toBe(true);
    expect(
      importDiagnosticTreatmentRequestSchemaV1.safeParse({ ...base, year: 2025 }).success,
    ).toBe(true);
    expect(
      importDiagnosticTreatmentRequestSchemaV1.safeParse({ ...base, year: 1999 }).success,
    ).toBe(false);
    expect(
      importDiagnosticTreatmentRequestSchemaV1.safeParse({ ...base, note: 'indevida' }).success,
    ).toBe(false);
    expect(
      importDiagnosticTreatmentRequestSchemaV1.safeParse({
        ...base,
        action: 2,
        note: 'Acompanhamento registrado.',
      }).success,
    ).toBe(true);
    expect(
      importDiagnosticTreatmentRequestSchemaV1.safeParse({ ...base, action: 2, note: null })
        .success,
    ).toBe(false);
    expect(
      importDiagnosticTreatmentRequestSchemaV1.safeParse({
        contractVersion: 1,
        operation: 'history',
        year: 2026,
        limit: 100,
        cursor: { recordedAt: '2026-09-11T18:00:00.000Z', id: 2 },
      }).success,
    ).toBe(true);
    expect(
      importDiagnosticTreatmentRequestSchemaV1.safeParse({
        contractVersion: 1,
        operation: 'history',
        year: 2026,
        limit: 100,
        offset: 0,
      }).success,
    ).toBe(false);
  });

  it('adds one append-only private relation without backfill or academic DML', async () => {
    const columns = (
      await pg.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='gradebook' AND table_name='importacao_diagnostico_tratamento'
        ORDER BY ordinal_position
      `)
    ).rows.map((row) => row.column_name);
    expect(columns).toEqual([
      'id',
      'diagnostico_origem_id',
      'ano',
      'arquivo',
      'hash',
      'chave',
      'nivel',
      'codigo',
      'turma_codigo',
      'disciplina',
      'periodo',
      'aluno_numero',
      'campo',
      'rotulo',
      'acao',
      'nota',
      'chave_idempotencia',
      'registrado_por',
      'registrado_em',
    ]);
    expect(
      (
        await pg.query(
          'SELECT count(*)::integer AS count FROM gradebook.importacao_diagnostico_tratamento',
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(readFileSync(migrationPath, 'utf8')).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/iu);
  });

  it('preserves a human action after the current finding disappears', async () => {
    await pg.exec(`INSERT INTO gradebook.importacao_diagnostico_tratamento
      (diagnostico_origem_id,ano,arquivo,hash,chave,nivel,codigo,turma_codigo,
       disciplina,periodo,aluno_numero,campo,rotulo,acao,nota,chave_idempotencia,registrado_por)
      VALUES ${treatmentValues(1, 'NULL')}`);
    await pg.exec('DELETE FROM gradebook.importacao_diagnostico WHERE id=1');
    expect(
      (await pg.query(`SELECT acao,nota FROM gradebook.importacao_diagnostico_tratamento`)).rows,
    ).toEqual([{ acao: 1, nota: null }]);
  });

  it('enforces action/note coherence and least privilege', async () => {
    await expect(
      pg.exec(`INSERT INTO gradebook.importacao_diagnostico_tratamento
      (diagnostico_origem_id,ano,arquivo,hash,chave,nivel,codigo,turma_codigo,
       disciplina,periodo,aluno_numero,campo,rotulo,acao,nota,chave_idempotencia,registrado_por)
      VALUES ${treatmentValues(2, 'NULL')}`),
    ).rejects.toMatchObject({ code: '23514' });

    expect(
      (
        await pg.query(`SELECT
      has_table_privilege('public','gradebook.importacao_diagnostico_tratamento','SELECT') AS public_select,
      has_table_privilege('gradebook_app','gradebook.importacao_diagnostico_tratamento','SELECT') AS app_select,
      has_table_privilege('gradebook_app','gradebook.importacao_diagnostico_tratamento','INSERT') AS app_insert,
      has_table_privilege('gradebook_app','gradebook.importacao_diagnostico_tratamento','UPDATE') AS app_update,
      has_table_privilege('gradebook_app','gradebook.importacao_diagnostico_tratamento','DELETE') AS app_delete,
      has_sequence_privilege('gradebook_app','gradebook.importacao_diagnostico_tratamento_id_seq','USAGE') AS sequence_usage,
      has_sequence_privilege('gradebook_app','gradebook.importacao_diagnostico_tratamento_id_seq','UPDATE') AS sequence_update`)
      ).rows,
    ).toEqual([
      {
        public_select: false,
        app_select: true,
        app_insert: true,
        app_update: false,
        app_delete: false,
        sequence_usage: true,
        sequence_update: false,
      },
    ]);
  });
});
