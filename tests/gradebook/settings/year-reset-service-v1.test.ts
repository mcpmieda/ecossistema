// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import { createYearResetServiceV1 } from '../../../server/gradebook/application/settings/year-reset-v1';
import { replaceGradebookImportDiagnosticsSnapshotV1 } from '../../../server/gradebook/application/import/import-diagnostics-snapshot-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';

const ACTOR = '11111111-1111-4111-8111-111111111111';
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
let failOnNoteDelete = false;

function snapshotJson(year: number, id: number) {
  return JSON.stringify({
    snapshotId: `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`,
    snapshotVersion: 1,
    dataVersion: `synthetic-${year}`,
    model: {
      year,
      classGroup: { id },
      student: { id },
      period: { kind: 'annual' },
    },
    presentation: { detail: 'summary' },
  });
}

function sqlLiteral(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

async function seedYear(year: number, id: number) {
  const hash = id === 1 ? 'a' : 'b';
  const snapshotId = `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`;
  const period = JSON.stringify({ kind: 'annual' });
  const presentation = JSON.stringify({ detail: 'summary' });
  let sql = `INSERT INTO gradebook.ano_letivo VALUES ($1,60000,2);
     INSERT INTO gradebook.aluno (id,ano,nome) VALUES ($2,$1,$3);
     INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES ($2,$1,$4,$5,6,'M');
     INSERT INTO gradebook.professor (id,ano,nome) VALUES ($2,$1,$6);
     INSERT INTO gradebook.disciplina (id,ano,nome) VALUES ($2,$1,$7);
     INSERT INTO gradebook.importacao (id,ano,tipo,arquivo,hash) VALUES ($2,$1,1,$8,decode(repeat($9,64),'hex'));
     INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES ($2,$1,$2,$2,$2);
     INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES ($1,$2,1,$2);
     INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao) VALUES ($2,$2,1,1,30000,'AVALIACAO SINTETICA');
     INSERT INTO gradebook.nota VALUES ($2,$2,18000);
     INSERT INTO gradebook.fechamento (oferta_id,aluno_id,am1_fonte) VALUES ($2,$2,18000);
     INSERT INTO gradebook.ano_letivo_historico VALUES ($1,50000,60000,2,2,$10,transaction_timestamp());
     INSERT INTO gradebook.conselho_anterior_historico VALUES ($2,false,true,$10,transaction_timestamp());
     INSERT INTO gradebook.conselho_decisao VALUES ($2,1,'DECISAO SINTETICA',$10,transaction_timestamp());
     INSERT INTO gradebook.conselho_decisao_historico VALUES ($2,2,1,'ANTERIOR','NOVA',$10,transaction_timestamp());
     INSERT INTO gradebook.fechamento_historico VALUES ($2,$2,$2,1,NULL,18000,0,1);
     INSERT INTO gradebook.instrumento_historico VALUES ($2,$2,20000,30000,'ANTERIOR','NOVA');
     INSERT INTO gradebook.nota_historico VALUES ($2,$2,$2,17000,18000);
     INSERT INTO gradebook.vinculo_historico VALUES ($2,$2,1,NULL,1,NULL,NULL);
     INSERT INTO gradebook.importacao_diagnostico
       (id,ano,arquivo,hash,chave,nivel,codigo,aluno_numero,campo)
       VALUES ($2,$1,$8,decode(repeat($9,64),'hex'),$11,'warning','source-unavailable',1,'file');
     INSERT INTO gradebook.importacao_diagnostico_tratamento
       (id,diagnostico_origem_id,ano,arquivo,hash,chave,nivel,codigo,aluno_numero,campo,
        acao,nota,chave_idempotencia,registrado_por)
       VALUES ($2,$2,$1,$8,decode(repeat($9,64),'hex'),$11,'warning','source-unavailable',1,
        'file',1,NULL,$12,$10);
     INSERT INTO gradebook.conselho_sessao
       (ano,turma_id,estado,versao,atualizado_por) VALUES ($1,$2,1,4,$10);
     INSERT INTO gradebook.conselho_sessao_historico
       (id,ano,turma_id,versao,evento,estado_novo,justificativa,alterado_por,chave_idempotencia)
       VALUES ($2,$1,$2,1,1,1,'ABERTURA SINTETICA',$10,$13);
     INSERT INTO gradebook.conselho_idempotencia
       (chave,operacao,ano,turma_id,versao_anterior,versao_nova,justificativa,registrado_por)
       VALUES ($14,1,$1,$2,0,1,'ABERTURA SINTETICA',$10);
     INSERT INTO gradebook.conselho_votacao
       (ano,turma_id,aluno_id,favoraveis,contrarios,versao,justificativa,registrado_por)
       VALUES ($1,$2,$2,3,1,2,'VOTACAO SINTETICA',$10);
     INSERT INTO gradebook.conselho_votacao_historico
       (id,ano,turma_id,aluno_id,versao,favoraveis_novo,contrarios_novo,justificativa,
        alterado_por,chave_idempotencia)
       VALUES ($2,$1,$2,$2,2,3,1,'VOTACAO SINTETICA',$10,$15);
     INSERT INTO gradebook.conselho_decisao_comando
       (id,ano,turma_id,aluno_id,versao,decisao_nova,justificativa_nova,alterado_por,
        chave_idempotencia)
       VALUES ($2,$1,$2,$2,3,1,'DECISAO SINTETICA',$10,$16);
     INSERT INTO gradebook.conselho_fechamento
       (id,ano,turma_id,sequencia,versao,total,elegiveis,aprovados,reprovados,faltas,
        nao_elegiveis,justificativa,fechado_por,chave_idempotencia)
       VALUES ($2,$1,$2,1,4,1,1,1,0,0,0,'FECHAMENTO SINTETICO',$10,$17);
     INSERT INTO gradebook.conselho_fechamento_item
       (fechamento_id,aluno_id,elegivel,motivo_elegibilidade,decisao,favoraveis,contrarios)
       VALUES ($2,$2,true,'ELEGIVEL',1,3,1);
     UPDATE gradebook.conselho_sessao SET fechamento_atual_id=$2 WHERE ano=$1;
     INSERT INTO gradebook.boletim_snapshot
       (snapshot_id,versao,chave_serie,ano,turma_id,aluno_id,emitido_em,emitido_por_oid,
        data_version,periodo_json,detalhe,apresentacao_json,snapshot_json)
       VALUES ($18,1,$19,$1,$2,$2,transaction_timestamp(),'synthetic-actor',$20,$21::jsonb,
        'summary',$22::jsonb,$23::jsonb)`;
  const values: readonly (string | number)[] = [
    year,
    id,
    `ALUNO SINTETICO ${id}`,
    `S${id}`,
    `TURMA SINTETICA ${id}`,
    `DOCENTE SINTETICO ${id}`,
    `COMPONENTE SINTETICO ${id}`,
    `fonte-sintetica-${id}.xlsx`,
    hash,
    ACTOR,
    `achado-${id}`,
    `audit:synthetic:${id}`,
    `council:open:${id}`,
    `council:idempotence:${id}`,
    `council:vote:${id}`,
    `council:decision:${id}`,
    `council:close:${id}`,
    snapshotId,
    `bulletin:synthetic:${id}`,
    `synthetic-${year}`,
    period,
    presentation,
    snapshotJson(year, id),
  ];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    sql = sql.replaceAll(`$${String(index + 1)}`, sqlLiteral(values[index]!));
  }
  await pg.exec(sql);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  for (const file of [
    '0003_council_session_v3.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
  ]) {
    await pg.exec(readFileSync(`migrations/gradebook-simplified/${file}`, 'utf8'));
  }
  await seedYear(2025, 1);
  await seedYear(2026, 2);
  await pg.exec(`INSERT INTO gradebook.importacao_diagnostico
    (id,ano,arquivo,hash,chave,nivel,codigo,campo)
    VALUES (99,NULL,'fonte-sem-ano.xlsx',decode(repeat('d',64),'hex'),'sem-ano','warning',
      'source-unavailable','file')`);
  for (const file of [
    '0001_identity_credentials_acl_v1.sql',
    '0002_policy_publication_revision_v1.sql',
    '0003_audit_receipts_closure_integration_v1.sql',
    '0004_gradebook_integration_usage_v1.sql',
    '0005_year_reset_protocol_v1.sql',
    '0014_year_reset_full_cleanup_v1.sql',
  ])
    await pg.exec(readFileSync(`migrations/student-portal/${file}`, 'utf8'));
  await installReconciliationSchemaFixtureV1(pg);
  await pg.exec(readFileSync('migrations/student-portal/0025_reconciliation_credentials_v1.sql', 'utf8'));
  await pg.exec(readFileSync('migrations/gradebook-simplified/0016_reconciliation_year_reset_v1.sql', 'utf8'));
  await pg.exec(`
    INSERT INTO student_portal.revision_event
      (event_id,academic_year,student_ids,cause,affects_academic,affects_reset,
       data_version,reset_version,portal_link_version,occurred_at)
    SELECT gen_random_uuid(),academic_year,'{}'::integer[],'diagnostics',false,true,
           academic_generation||':'||academic_counter::text,
           reset_generation||':'||reset_counter::text,
           portal_link_generation||':'||portal_link_counter::text,
           transaction_timestamp()
    FROM student_portal.academic_revision
    WHERE academic_year IN (2025,2026)
  `);
  database = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe() {
      throw new Error('outside-transaction');
    },
    async begin(operation) {
      return pg.transaction(async (transaction) =>
        operation({
          async unsafe(sql, values = []) {
            if (failOnNoteDelete && /^DELETE FROM gradebook\.nota\s/iu.test(sql)) {
              throw new Error('synthetic-delete-failure');
            }
            const result = await transaction.query<Record<string, unknown>>(sql, [...values]);
            return Object.assign(result.rows, {
              count: result.affectedRows ?? result.rows.length,
            });
          },
        }),
      );
    },
    async end() {
      await pg.close();
    },
  });
}, 30_000);

afterAll(async () => {
  await database?.close();
});

async function preview(year: number) {
  return createYearResetServiceV1(database, ACTOR).execute({
    contractVersion: 1,
    operation: 'preview',
    year,
  });
}

async function technicalState(year: number) {
  return (
    await pg.query<{
      revision_events: number;
      academic_revision: number;
      reset_proofs: number;
    }>(
      `SELECT
        (SELECT count(*)::integer FROM student_portal.revision_event WHERE academic_year=$1) AS revision_events,
        (SELECT count(*)::integer FROM student_portal.academic_revision WHERE academic_year=$1) AS academic_revision,
        (SELECT count(*)::integer FROM student_portal.year_reset_preview_proof WHERE academic_year=$1) AS reset_proofs`,
      [year],
    )
  ).rows[0]!;
}

describe('year reset V1 PostgreSQL service', () => {
  it('blocks pending and blocked linked accounts on preview and execution without deletion', async () => {
    const before = await preview(2026);
    if (before.state !== 'ready' || before.operation !== 'preview') throw new Error('preview');
    await pg.exec(`INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility,blocked)
      VALUES ('22222222-2222-4222-8222-222222222222',2026,2,'pending-activation','eligible',true)`);
    const blocked = { contractVersion: 1, state: 'portal-linked-accounts' };
    await expect(preview(2026)).resolves.toEqual(blocked);
    await expect(
      createYearResetServiceV1(database, ACTOR).execute({
        contractVersion: 1,
        operation: 'execute',
        year: 2026,
        previewRevision: before.previewRevision,
        confirmationPhrase: before.confirmationPhrase,
        understandsIrreversible: true,
      }),
    ).resolves.toEqual(blocked);
    await pg.exec(
      "DELETE FROM student_portal.account WHERE id='22222222-2222-4222-8222-222222222222'",
    );
    await expect(preview(2026)).resolves.toMatchObject({ counts: before.counts });
  });

  it('refuses another actor and changed content with identical counts', async () => {
    const before = await preview(2026);
    if (before.state !== 'ready' || before.operation !== 'preview') throw new Error('preview');
    const command = {
      contractVersion: 1,
      operation: 'execute',
      year: 2026,
      previewRevision: before.previewRevision,
      confirmationPhrase: before.confirmationPhrase,
      understandsIrreversible: true,
    };
    await expect(
      createYearResetServiceV1(database, '33333333-3333-4333-8333-333333333333').execute(command),
    ).resolves.toEqual({ contractVersion: 1, state: 'preview-changed' });
    await pg.exec(`UPDATE gradebook.nota SET valor=19000 WHERE instrumento_id=2;
      UPDATE student_portal.academic_revision SET reset_counter=reset_counter+1 WHERE academic_year=2026`);
    await expect(preview(2026)).resolves.toMatchObject({ counts: before.counts });
    await expect(createYearResetServiceV1(database, ACTOR).execute(command)).resolves.toEqual({
      contractVersion: 1,
      state: 'preview-changed',
    });
  });

  it('rolls back an injected failure without losing any row', async () => {
    const before = await preview(2025);
    expect(before).toMatchObject({ state: 'ready', operation: 'preview' });
    if (before.state !== 'ready' || before.operation !== 'preview') throw new Error('preview');
    const technicalBefore = await technicalState(2025);
    failOnNoteDelete = true;
    await expect(
      createYearResetServiceV1(database, ACTOR).execute({
        contractVersion: 1,
        operation: 'execute',
        year: 2025,
        previewRevision: before.previewRevision,
        confirmationPhrase: before.confirmationPhrase,
        understandsIrreversible: true,
      }),
    ).rejects.toThrow('synthetic-delete-failure');
    failOnNoteDelete = false;
    expect(await technicalState(2025)).toEqual(technicalBefore);
    await expect(preview(2025)).resolves.toMatchObject({
      state: before.state,
      counts: before.counts,
    });
  });

  it('rejects a stale preview, then removes exactly one year and permits rematerialization', async () => {
    const stale = await preview(2025);
    if (stale.state !== 'ready' || stale.operation !== 'preview') throw new Error('preview');
    await pg.exec(`INSERT INTO gradebook.importacao_diagnostico
      (id,ano,arquivo,hash,chave,nivel,codigo,campo)
      VALUES (3,2025,'nova-fonte.xlsx',decode(repeat('c',64),'hex'),'novo-achado','warning',
        'source-unavailable','file');
      UPDATE student_portal.academic_revision SET reset_counter=reset_counter+1 WHERE academic_year=2025`);
    await expect(
      createYearResetServiceV1(database, ACTOR).execute({
        contractVersion: 1,
        operation: 'execute',
        year: 2025,
        previewRevision: stale.previewRevision,
        confirmationPhrase: stale.confirmationPhrase,
        understandsIrreversible: true,
      }),
    ).resolves.toEqual({ contractVersion: 1, state: 'preview-changed' });

    const current = await preview(2025);
    if (current.state !== 'ready' || current.operation !== 'preview') throw new Error('preview');
    expect(current.counts.totalRows).toBeGreaterThan(30);
    const untouchedBefore = await preview(2026);
    const untouchedTechnicalBefore = await technicalState(2026);
    const result = await createYearResetServiceV1(database, ACTOR).execute({
      contractVersion: 1,
      operation: 'execute',
      year: 2025,
      previewRevision: current.previewRevision,
      confirmationPhrase: current.confirmationPhrase,
      understandsIrreversible: true,
    });
    expect(result).toEqual({
      contractVersion: 1,
      state: 'ready',
      operation: 'execute',
      year: 2025,
      deletedRows: current.counts.totalRows,
    });
    expect(await technicalState(2025)).toEqual({
      revision_events: 0,
      academic_revision: 0,
      reset_proofs: 0,
    });
    await expect(preview(2025)).resolves.toEqual({ contractVersion: 1, state: 'not-found' });
    await expect(
      replaceGradebookImportDiagnosticsSnapshotV1(database, {
        version: 1,
        academicYear: 2025,
        fileName: 'fonte-antiga-2025.xlsx',
        sha256: 'f'.repeat(64),
        diagnostics: [
          {
            key: 'stale-after-reset',
            severity: 'warning',
            code: 'source-unavailable',
            message: 'Valor indisponível.',
            recommendedAction: 'Confira a fonte.',
            fieldKind: 'recovery',
          },
        ],
      }),
    ).resolves.toBe(0);
    expect(
      (
        await pg.query(`SELECT count(*)::integer AS count
          FROM gradebook.importacao_diagnostico WHERE ano=2025`)
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(await technicalState(2025)).toEqual({
      revision_events: 0,
      academic_revision: 0,
      reset_proofs: 0,
    });
    if (untouchedBefore.state !== 'ready' || untouchedBefore.operation !== 'preview')
      throw new Error('preview');
    expect(await technicalState(2026)).toEqual(untouchedTechnicalBefore);
    await expect(preview(2026)).resolves.toMatchObject({ counts: untouchedBefore.counts });
    expect(
      (
        await pg.query(`SELECT count(*)::integer AS count FROM gradebook.importacao_diagnostico
          WHERE ano IS NULL`)
      ).rows,
    ).toEqual([{ count: 1 }]);

    await pg.transaction(async (transaction) => {
      await transaction.exec('SELECT pg_advisory_xact_lock_shared(613,0)');
      await transaction.exec('SELECT pg_advisory_xact_lock(613,2025)');
      await transaction.exec('SELECT student_portal.ensure_year_coordination_v1(2025::smallint)');
      await transaction.exec(`INSERT INTO gradebook.ano_letivo VALUES (2025,60000,2);
        INSERT INTO gradebook.aluno (ano,nome) VALUES (2025,'NOVO ALUNO SINTETICO');
        INSERT INTO gradebook.turma (ano,codigo,nome,etapa,turno)
          VALUES (2025,'N1','NOVA TURMA SINTETICA',6,'M');
        INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id)
          SELECT 2025,t.id,1,a.id FROM gradebook.turma t CROSS JOIN gradebook.aluno a
          WHERE t.ano=2025 AND a.ano=2025`);
    });
    expect(await technicalState(2025)).toMatchObject({ academic_revision: 1 });
    await expect(preview(2025)).resolves.toMatchObject({
      state: 'ready',
      counts: { academicYear: 1, students: 1, classes: 1, bindings: 1 },
    });
  });
});
