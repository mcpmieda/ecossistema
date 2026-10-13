// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GradebookRelationImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';

type Row = Record<string, unknown>;
const migrations = 'migrations/gradebook-simplified/';
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;

async function execute(
  client: Pick<PGlite, 'query'>,
  query: string,
  values: readonly unknown[] = [],
) {
  const result = await client.query<Row>(query, [...values]);
  return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(`${migrations}0001_current_schema.sql`, 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  for (const migration of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
  ])
    await pg.exec(readFileSync(`${migrations}${migration}`, 'utf8'));

  const sql: GradebookPostgresSqlV1 = {
    unsafe: (query, values = []) => execute(pg, query, values),
    begin: (operation) =>
      pg.transaction((client) => {
        const transaction: GradebookPostgresQuerySqlV1 = {
          unsafe: (query, values = []) => execute(client, query, values),
        };
        return operation(transaction);
      }),
    end: () => pg.close(),
  };
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  await pg.exec(readFileSync('migrations/student-photos/0001_private_delivery_v1.sql', 'utf8'));
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
}, 30_000);

afterAll(async () => {
  await database?.close();
});

function relation(
  prefix: string,
  digit: string,
  linked: boolean,
): GradebookRelationImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-relacao',
    manifest: {
      fileName: `RELACAO SINTETICA ${prefix}.xlsb`,
      sha256: digit.repeat(64),
      parserVersion: 'synthetic-split-identity-repair-v9',
    },
    ano: 2026,
    turmas: [
      {
        codigo: `${prefix}A`,
        nome: `TURMA ${prefix} A`,
        etapa: 7,
        turno: 'MATUTINO',
        alunos: [
          linked
            ? ([1, 'ESTUDANTE SINTETICO', 6, `${prefix}B`] as const)
            : ([1, 'ESTUDANTE SINTETICO', 4] as const),
        ],
      },
      {
        codigo: `${prefix}B`,
        nome: `TURMA ${prefix} B`,
        etapa: 7,
        turno: 'MATUTINO',
        alunos: [
          linked
            ? ([1, 'ESTUDANTE SINTÉTICO', 7, `${prefix}A`] as const)
            : ([1, 'ESTUDANTE SINTÉTICO', 0] as const),
        ],
      },
    ],
  };
}

async function pair(prefix: string) {
  const rows = (
    await pg.query<{ codigo: string; turma_id: number; aluno_id: number }>(
      `SELECT t.codigo,t.id AS turma_id,v.aluno_id
       FROM gradebook.turma t
       JOIN gradebook.vinculo v ON v.turma_id=t.id
       WHERE t.ano=2026 AND t.codigo IN ($1,$2)
       ORDER BY t.codigo`,
      [`${prefix}A`, `${prefix}B`],
    )
  ).rows;
  expect(rows).toHaveLength(2);
  return { origin: rows[0]!, destination: rows[1]! };
}

async function addCurrentFact(
  prefix: string,
  turmaId: number,
  alunoId: number,
  value: number,
) {
  const professor = (
    await pg.query<{ id: number }>(
      `INSERT INTO gradebook.professor (ano,nome)
       VALUES (2026,$1) RETURNING id`,
      [`DOCENTE ${prefix}`],
    )
  ).rows[0]!;
  const disciplina = (
    await pg.query<{ id: number }>(
      `INSERT INTO gradebook.disciplina (ano,nome)
       VALUES (2026,$1) RETURNING id`,
      [`COMPONENTE ${prefix}`],
    )
  ).rows[0]!;
  const oferta = (
    await pg.query<{ id: number }>(
      `INSERT INTO gradebook.oferta (ano,turma_id,professor_id,disciplina_id)
       VALUES (2026,$1,$2,$3) RETURNING id`,
      [turmaId, professor.id, disciplina.id],
    )
  ).rows[0]!;
  const instrumento = (
    await pg.query<{ id: number }>(
      `INSERT INTO gradebook.instrumento (oferta_id,trimestre,slot,maximo,descricao)
       VALUES ($1,1,1,30000,'AVALIACAO SINTETICA') RETURNING id`,
      [oferta.id],
    )
  ).rows[0]!;
  await pg.query(
    'INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor) VALUES ($1,$2,$3)',
    [instrumento.id, alunoId, value],
  );
  await pg.query(
    `INSERT INTO gradebook.fechamento
      (oferta_id,aluno_id,am1_fonte,rec_nc_mask,rec_rr_mask)
      VALUES ($1,$2,$3,0,0)`,
    [oferta.id, alunoId, value],
  );
  return { ofertaId: oferta.id, instrumentoId: instrumento.id };
}

async function addProtectedResources(studentIds: readonly number[]) {
  for (const studentId of studentIds) {
    const account = (await pg.query<{ id: string; student_uid: string }>(`INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility)
      VALUES(gen_random_uuid(),2026,$1,'active','eligible') RETURNING id,student_uid`, [studentId])).rows[0]!;
    await pg.query(`INSERT INTO student_photos.portal_delivery_v1
      (student_uid,revision,source_revision,source_sha256,portrait_sha256,width,height)
      VALUES($1,gen_random_uuid(),gen_random_uuid(),$2,$3,300,400)`, [account.student_uid, 'a'.repeat(64), 'b'.repeat(64)]);
    await pg.query(`INSERT INTO student_portal.qr_credential(credential_id,account_id,key_version,state)
      VALUES($1,$2,1,'active')`, [crypto.randomUUID().replaceAll('-', '') + 'syntest1', account.id]);
    await pg.query(`INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES(gen_random_uuid(),$1,$2,1,now()+interval '1 day',false)`, [account.id, 'synthetic-' + account.id]);
  }
}

async function protectedSnapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['gradebook.aluno', 'gradebook.vinculo', 'gradebook.nota', 'gradebook.fechamento',
    'gradebook.conselho_decisao', 'gradebook.importacao', 'student_portal.account', 'student_portal.qr_credential',
    'student_portal.session', 'student_photos.portal_delivery_v1', 'student_portal.academic_revision']) {
    result[table] = (await pg.query<{ snapshot: unknown }>(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) AS snapshot
      FROM (SELECT to_jsonb(t) AS j FROM ${table} t) r`)).rows[0]!.snapshot;
  }
  return result;
}

describe('reparo de identidade dividida por movimentacao explicita V9', () => {
  it('blocks two existing UIDs and preserves notes, accounts, photos and access atomically', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    await expect(service.execute(relation('R1105', 'a', false))).resolves.toMatchObject({
      state: 'applied',
    });
    const before = await pair('R1105');
    expect(before.origin.aluno_id).not.toBe(before.destination.aluno_id);

    await addCurrentFact('R1105A', before.origin.turma_id, before.origin.aluno_id, 11000);
    await addCurrentFact(
      'R1105B',
      before.destination.turma_id,
      before.destination.aluno_id,
      22000,
    );
    await addProtectedResources([before.origin.aluno_id, before.destination.aluno_id]);
    const preserved = await protectedSnapshot();

    const corrected = relation('R1105', 'b', true);
    await expect(service.execute(corrected)).resolves.toMatchObject({ state: 'conflict' });
    expect(await protectedSnapshot()).toEqual(preserved);

    const after = await pair('R1105');
    expect(after.origin.aluno_id).toBe(before.origin.aluno_id);
    expect(after.destination.aluno_id).toBe(before.destination.aluno_id);

    expect(
      (
        await pg.query<{ aluno_id: number; valor: number }>(
          `SELECT aluno_id,valor FROM gradebook.nota
           WHERE aluno_id IN ($1,$2)
           ORDER BY valor`,
          [before.origin.aluno_id, before.destination.aluno_id],
        )
      ).rows,
    ).toEqual([
      { aluno_id: before.origin.aluno_id, valor: 11000 },
      { aluno_id: before.destination.aluno_id, valor: 22000 },
    ]);
    expect(
      (
        await pg.query<{ aluno_id: number; am1_fonte: number }>(
          `SELECT aluno_id,am1_fonte FROM gradebook.fechamento
           WHERE aluno_id IN ($1,$2)
           ORDER BY am1_fonte`,
          [before.origin.aluno_id, before.destination.aluno_id],
        )
      ).rows,
    ).toEqual([
      { aluno_id: before.origin.aluno_id, am1_fonte: 11000 },
      { aluno_id: before.destination.aluno_id, am1_fonte: 22000 },
    ]);

    expect(
      (
        await pg.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM gradebook.aluno WHERE id IN ($1,$2)',
          [before.origin.aluno_id, before.destination.aluno_id],
        )
      ).rows[0]?.count,
    ).toBe(2);
    await expect(service.execute(corrected)).resolves.toMatchObject({ state: 'conflict' });
    expect(await protectedSnapshot()).toEqual(preserved);
  });

  it('falha fechado e reverte tudo se os ids tiverem estado corrente de Conselho concorrente', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    await expect(service.execute(relation('R1106', 'c', false))).resolves.toMatchObject({
      state: 'applied',
    });
    const before = await pair('R1106');
    const actor = '11111111-1111-4111-8111-111111111111';
    await pg.query(
      `INSERT INTO gradebook.conselho_decisao
        (aluno_id,decisao,justificativa,registrado_por)
       VALUES ($1,1,'DECISAO SINTETICA A',$3),($2,2,'DECISAO SINTETICA B',$3)`,
      [before.origin.aluno_id, before.destination.aluno_id, actor],
    );

    await expect(service.execute(relation('R1106', 'd', true))).resolves.toMatchObject({
      state: 'conflict',
      reason: 'A movimentação entre R1106A nº 1 e R1106B nº 1 envolve identidades distintas. Confira os vínculos existentes.',
    });

    const after = await pair('R1106');
    expect(after.origin.aluno_id).toBe(before.origin.aluno_id);
    expect(after.destination.aluno_id).toBe(before.destination.aluno_id);
    const ids = (
      await pg.query<{ aluno_id: number }>(
        'SELECT aluno_id FROM gradebook.conselho_decisao WHERE aluno_id IN ($1,$2) ORDER BY aluno_id',
        [before.origin.aluno_id, before.destination.aluno_id],
      )
    ).rows.map((row) => row.aluno_id);
    expect(ids).toEqual(
      [before.origin.aluno_id, before.destination.aluno_id].sort((a, b) => a - b),
    );
  });

  it('does not let another known person occupying the same position inherit grades or the original access', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    const original = relation('REPLACE', 'e', false);
    const request = { ...original, turmas: original.turmas.map((turma, index) => ({ ...turma,
      alunos: [[1, index === 0 ? 'PESSOA SINTETICA ORIGINAL' : 'PESSOA SINTETICA SUBSTITUTA', 0] as const] })) };
    expect(await service.execute(request)).toMatchObject({ state: 'applied' });
    const initial = await pair('REPLACE');
    await addCurrentFact('REPLACE', initial.origin.turma_id, initial.origin.aluno_id, 19000);
    await addProtectedResources([initial.origin.aluno_id, initial.destination.aluno_id]);
    const before = await protectedSnapshot();
    const replaced = { ...request, turmas: request.turmas.map((turma) => ({ ...turma,
      alunos: [[1, 'PESSOA SINTETICA SUBSTITUTA', 0] as const] })) };
    expect(await service.execute(replaced)).toMatchObject({ state: 'review-required' });
    expect(await protectedSnapshot()).toEqual(before);
  });

  it('blocks an unlinked report person with a contradictory birth at the same position through normalized SQL booleans', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    const base = relation('EVIDENCE', 'c', false);
    const originalName = 'SINTETICO EVIDENCIA ORIGINAL';
    const replacementName = 'SINTETICO EVIDENCIA NOVA PESSOA';
    const original = { ...base, turmas: [{ ...base.turmas[0]!, alunos: [[1, originalName, 0] as const] }] };
    expect(await service.execute(original)).toMatchObject({ state: 'applied' });
    const student = (await pg.query<{ id: number; student_uid: string; turma_id: number }>(`SELECT a.id,a.student_uid,v.turma_id
      FROM gradebook.aluno a JOIN gradebook.vinculo v ON v.aluno_id=a.id JOIN gradebook.turma t ON t.id=v.turma_id
      WHERE t.codigo='EVIDENCEA'`)).rows[0]!;
    await addCurrentFact('EVIDENCE', student.turma_id, student.id, 23000);
    await addProtectedResources([student.id]);
    const [batchId, classId, originalSource, replacementSource, originalObservation, replacementObservation, decisionId] =
      Array.from({ length: 7 }, () => crypto.randomUUID()) as [string, string, string, string, string, string, string];
    await pg.transaction(async (tx) => {
      await tx.query('INSERT INTO gradebook.student_reconciliation_scope_v1(academic_year) VALUES(2026) ON CONFLICT DO NOTHING');
      await tx.query(`INSERT INTO gradebook.student_report_batch_v1(id,academic_year,generation,actor_id,source_evidence,
        normalization_version,digest,request_digest,idempotency_key,base_revision,base_academic_revision,state,expires_at,class_links)
        SELECT $1::uuid,2026,generation,'11111111-1111-4111-8111-111111111111','unknown',1,repeat('c',64),repeat('d',64),
          gen_random_uuid(),revision,'synthetic-revision','applied',now()+interval '1 day','[]'::jsonb
        FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026`, [batchId]);
      await tx.query(`INSERT INTO gradebook.student_report_class_v1(id,academic_year,label,class_key,shift,shift_key,stage_label,stage,gradebook_class_id)
        VALUES($1,2026,'EVIDENCEA','EVIDENCEA','MATUTINO','MATUTINO','7',7,$2)`, [classId, student.turma_id]);
      for (const [sourceId, observationId, name, birth] of [
        [originalSource, originalObservation, originalName, '2012-01-01'],
        [replacementSource, replacementObservation, replacementName, '2011-05-06'],
      ] as const) {
        await tx.query(`INSERT INTO gradebook.student_source_record_v1(id,academic_year,last_batch_id) VALUES($1,2026,$2)`, [sourceId, batchId]);
        await tx.query(`INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,version,batch_id,report_class_id,
          name,name_key,birth_date,enrollment_hash,shift,shift_key,status,status_key)
          VALUES($1,2026,$2,1,$3,$4,$5,$5,$6::date,$7,'MATUTINO','MATUTINO','CURSANDO','CURSANDO')`,
        [observationId, sourceId, batchId, classId, name, birth, 'synthetic-evidence-' + sourceId]);
        await tx.query('UPDATE gradebook.student_source_record_v1 SET current_observation_id=$2 WHERE id=$1', [sourceId, observationId]);
      }
      await tx.query(`INSERT INTO gradebook.student_reconciliation_decision_v1(id,academic_year,generation,sequence,actor_id,action,source_id,student_uid,observation_id,reason)
        SELECT $1,2026,generation,revision+1,'11111111-1111-4111-8111-111111111111','associate',$2,$3,$4,'synthetic-confirmed-profile'
        FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026`, [decisionId, originalSource, student.student_uid, originalObservation]);
      await tx.query(`INSERT INTO gradebook.student_source_link_v1(academic_year,source_id,student_uid,version,decision_id)
        VALUES(2026,$1,$2,1,$3)`, [originalSource, student.student_uid, decisionId]);
      await tx.query(`INSERT INTO gradebook.student_report_profile_v1(academic_year,student_uid,source_id,observation_id,version)
        VALUES(2026,$1,$2,$3,1)`, [student.student_uid, originalSource, originalObservation]);
    });
    const evidence = await database.query<Row>(`SELECT (p.observation_id=o.id) AS selected_profile,
      (s.current_observation_id=o.id) AS current_observation FROM gradebook.student_source_observation_v1 o
      JOIN gradebook.student_source_record_v1 s ON s.id=o.source_id
      JOIN gradebook.student_report_profile_v1 p ON p.observation_id=o.id WHERE o.id=$1`, [originalObservation]);
    expect(evidence).toEqual([{ selected_profile: 1, current_observation: 1 }]);
    expect((await pg.query('SELECT id FROM gradebook.aluno WHERE nome=$1', [replacementName])).rows).toHaveLength(0);
    const before = await protectedSnapshot();
    const replaced = { ...original, turmas: [{ ...original.turmas[0]!, alunos: [[1, replacementName, 0] as const] }] };
    expect(await service.execute(replaced)).toMatchObject({ state: 'review-required' });
    expect(await protectedSnapshot()).toEqual(before);
  });

  it('allows ordinary name correction without moving identity, notes, account or photo', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    const original = relation('CORRECT', 'f', false);
    const request = { ...original, turmas: [{ ...original.turmas[0]!,
      alunos: [[1, 'SINTETICO ALEX CORRECAO', 0] as const] }] };
    expect(await service.execute(request)).toMatchObject({ state: 'applied' });
    const student = (await pg.query<{ id: number; student_uid: string; turma_id: number }>(`SELECT a.id,a.student_uid,v.turma_id
      FROM gradebook.aluno a JOIN gradebook.vinculo v ON v.aluno_id=a.id JOIN gradebook.turma t ON t.id=v.turma_id
      WHERE t.codigo='CORRECTA'`)).rows[0]!;
    await addCurrentFact('CORRECT', student.turma_id, student.id, 17000);
    await addProtectedResources([student.id]);
    const before = await protectedSnapshot();
    const corrected = { ...request, turmas: [{ ...request.turmas[0]!, alunos: [[1, 'SINTETICO ALEX CORREÇÃO CORRIGIDA', 0] as const] }] };
    expect(await service.execute(corrected)).toMatchObject({ state: 'applied' });
    const after = await protectedSnapshot();
    for (const table of ['gradebook.nota','gradebook.fechamento','student_portal.account','student_portal.qr_credential',
      'student_portal.session','student_photos.portal_delivery_v1']) expect(after[table]).toEqual(before[table]);
    expect((await pg.query<{ student_uid: string }>('SELECT student_uid FROM gradebook.aluno WHERE id=$1', [student.id])).rows[0]!.student_uid).toBe(student.student_uid);
    expect(await service.execute(corrected)).toMatchObject({ state: 'no-changes' });
  });

  it('applies a unique differently spelled transfer without creating a second person or moving protected resources', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    const base = relation('UNIQUE', 'a', false);
    const initial = { ...base, turmas: base.turmas.map((turma,index) => ({ ...turma,
      alunos: index === 0 ? [[1,'PESSOA SINTETICA MOVIMENTO',0] as const] : [] })) };
    expect(await service.execute(initial)).toMatchObject({ state: 'applied' });
    const student = (await pg.query<{ id: number; student_uid: string }>(`SELECT a.id,a.student_uid FROM gradebook.aluno a
      JOIN gradebook.vinculo v ON v.aluno_id=a.id JOIN gradebook.turma t ON t.id=v.turma_id WHERE t.codigo='UNIQUEA'`)).rows[0]!;
    await addProtectedResources([student.id]);
    const before = await protectedSnapshot();
    const transfer = { ...base, turmas: base.turmas.map((turma,index) => ({ ...turma, alunos: [index === 0
      ? [1,'PESSOA SINTETICA MOVIMENTO',6,'UNIQUEB'] as const
      : [1,'PESSOA SINTETICA MOVIMENTO CORRIGIDA',7,'UNIQUEA'] as const] })) };
    expect(await service.execute(transfer)).toMatchObject({ state: 'applied', warnings: [
      { code: 'movement-spelling', classCode: 'UNIQUEA', number: 1, relatedClassCode: 'UNIQUEB' },
    ] });
    const bindings = await pair('UNIQUE');
    expect(bindings.origin.aluno_id).toBe(student.id);
    expect(bindings.destination.aluno_id).toBe(student.id);
    const after = await protectedSnapshot();
    for (const table of ['student_portal.account','student_portal.qr_credential','student_portal.session','student_photos.portal_delivery_v1'])
      expect(after[table]).toEqual(before[table]);
  });
});
