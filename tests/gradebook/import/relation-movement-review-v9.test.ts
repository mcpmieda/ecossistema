// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isGradebookImportPersistenceRequestV9,
  isGradebookImportPersistenceResponseV9,
  type GradebookRelationImportRequestV9,
  type GradebookRelationMovementPairV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import { createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1, type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
const statements: string[] = [];
let failAtName: string | null = null;
const actor = '11111111-1111-4111-8111-111111111111';
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  for (const file of ['0001_current_schema.sql', '0003_council_session_v3.sql', '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql', '0006_import_diagnostic_treatment_v1.sql', '0007_multiyear_rr_v1.sql'])
    await pg.exec(readFileSync(`migrations/gradebook-simplified/${file}`, 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  await pg.exec(readFileSync('migrations/student-photos/0001_private_delivery_v1.sql', 'utf8'));
  const migration = readFileSync('migrations/student-portal/0025_reconciliation_credentials_v1.sql', 'utf8');
  const revision = migration.match(/CREATE FUNCTION student_portal\.reconciliation_revision_v1[\s\S]+?\$\$;/u)?.[0];
  if (!revision) throw new Error('missing-reconciliation-revision-function');
  await pg.exec(revision);
  const execute = async (client: Pick<PGlite, 'query'>, query: string, values: readonly unknown[] = []) => {
    statements.push(query);
    if (failAtName && query.startsWith('UPDATE gradebook.aluno') && values[0] === failAtName)
      throw new Error('synthetic-middle-of-relation-failure');
    const result = await client.query<Record<string, unknown>>(query, [...values]);
    return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
  };
  const sql: GradebookPostgresSqlV1 = {
    unsafe: (query, values = []) => execute(pg, query, values),
    begin: (operation) => pg.transaction((client) => operation({ unsafe: (query, values = []) => execute(client, query, values) })),
    end: () => pg.close(),
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
}, 30_000);
afterAll(async () => database?.close());

let ordinal = 0;
async function scenario() {
  const prefix = `M${++ordinal}`;
  const initial: GradebookRelationImportRequestV9 = {
    transportVersion: 9, operation: 'persist-relacao', ano: 2026,
    manifest: { fileName: `${prefix}.xlsb`, sha256: 'a'.repeat(64), parserVersion: 'synthetic' },
    turmas: [
      { codigo: `${prefix}6A`, nome: '6A', etapa: 6, turno: 'M', alunos: [[1, `${prefix} ORIGEM UM`, 0], [2, `${prefix} ORIGEM DOIS`, 0]] },
      { codigo: `${prefix}7C`, nome: '7C', etapa: 7, turno: 'M', alunos: [[1, `${prefix} INDEPENDENTE`, 0]] },
    ],
  };
  const service = createGradebookRelationalImportServiceV11(database, undefined, actor);
  expect((await service.execute(initial)).state).toBe('applied');
  const request: GradebookRelationImportRequestV9 = {
    ...initial, manifest: { ...initial.manifest, sha256: 'b'.repeat(64) },
    turmas: [
      { ...initial.turmas[0]!, alunos: [[1, `${prefix} ORIGEM UM`, 6, `${prefix}6B`], [2, `${prefix} ORIGEM DOIS`, 6, `${prefix}6B`]] },
      // New class: preview must not insert it or expose transient database IDs.
      { codigo: `${prefix}6B`, nome: '6B', etapa: 6, turno: 'M', alunos: [[8, `${prefix} CORRIGIDO DOIS`, 7, `${prefix}6A`], [9, `${prefix} CORRIGIDO UM`, 7, `${prefix}6A`]] },
      { ...initial.turmas[1]!, alunos: [[1, `${prefix} INDEPENDENTE CORRIGIDO`, 0]] },
    ],
  };
  const pairs: GradebookRelationMovementPairV9[] = [
    { origin: { classCode: `${prefix}6A`, number: 1 }, destination: { classCode: `${prefix}6B`, number: 9 } },
    { origin: { classCode: `${prefix}6A`, number: 2 }, destination: { classCode: `${prefix}6B`, number: 8 } },
  ];
  return { prefix, initial, request, pairs, service };
}

async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['gradebook.ano_letivo', 'gradebook.turma', 'gradebook.aluno', 'gradebook.student_identity',
    'gradebook.vinculo', 'gradebook.vinculo_historico', 'gradebook.importacao', 'gradebook.nota', 'gradebook.fechamento',
    'gradebook.conselho_decisao', 'student_photos.portal_delivery_v1',
    'student_portal.account', 'student_portal.qr_credential', 'student_portal.session', 'student_portal.academic_revision']) {
    result[table] = (await pg.query<{ data: unknown }>(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) AS data
      FROM (SELECT to_jsonb(t) AS j FROM ${table} t) r`)).rows[0]!.data;
  }
  return result;
}

async function preview(s: Awaited<ReturnType<typeof scenario>>) {
  const response = await s.service.execute(s.request);
  expect(response.state).toBe('review-required');
  if (response.state !== 'review-required' || !response.movementReview) throw new Error('missing-review');
  expect(isGradebookImportPersistenceResponseV9(response)).toBe(true);
  return response.movementReview;
}

async function protectOrigins(prefix: string) {
  const students = (await pg.query<{ aluno_id: number; turma_id: number; student_uid: string }>(
    `SELECT v.aluno_id,v.turma_id,a.student_uid FROM gradebook.vinculo v JOIN gradebook.aluno a ON a.id=v.aluno_id
     JOIN gradebook.turma t ON t.id=v.turma_id WHERE t.codigo=$1 ORDER BY v.numero`, [`${prefix}6A`])).rows;
  for (const student of students) {
    const account = (await pg.query<{ id: string }>(`INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility)
      VALUES(gen_random_uuid(),2026,$1,'active','eligible') RETURNING id`, [student.aluno_id])).rows[0]!;
    await pg.query(`INSERT INTO student_photos.portal_delivery_v1
      (student_uid,revision,source_revision,source_sha256,portrait_sha256,width,height)
      VALUES($1,gen_random_uuid(),gen_random_uuid(),$2,$3,300,400)`, [student.student_uid, 'a'.repeat(64), 'b'.repeat(64)]);
    await pg.query(`INSERT INTO student_portal.qr_credential(credential_id,account_id,key_version,state)
      VALUES($1,$2,1,'active')`, [crypto.randomUUID().replaceAll('-', '') + 'syntest1', account.id]);
    await pg.query(`INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES(gen_random_uuid(),$1,$2,1,now()+interval '1 day',false)`, [account.id, 'synthetic-' + account.id]);
  }
  const professor = (await pg.query<{ id: number }>('INSERT INTO gradebook.professor(ano,nome) VALUES(2026,$1) RETURNING id', [`${prefix} DOCENTE`])).rows[0]!;
  const discipline = (await pg.query<{ id: number }>('INSERT INTO gradebook.disciplina(ano,nome) VALUES(2026,$1) RETURNING id', [`${prefix} COMPONENTE`])).rows[0]!;
  const offer = (await pg.query<{ id: number }>(`INSERT INTO gradebook.oferta(ano,turma_id,professor_id,disciplina_id)
    VALUES(2026,$1,$2,$3) RETURNING id`, [students[0]!.turma_id, professor.id, discipline.id])).rows[0]!;
  const instrument = (await pg.query<{ id: number }>(`INSERT INTO gradebook.instrumento(oferta_id,trimestre,slot,maximo)
    VALUES($1,1,1,30000) RETURNING id`, [offer.id])).rows[0]!;
  for (const [index, student] of students.entries()) {
    await pg.query('INSERT INTO gradebook.nota(instrumento_id,aluno_id,valor) VALUES($1,$2,$3)', [instrument.id, student.aluno_id, 10000 + index]);
    await pg.query('INSERT INTO gradebook.fechamento(oferta_id,aluno_id,am1_fonte) VALUES($1,$2,$3)', [offer.id, student.aluno_id, 10000 + index]);
  }
}

describe('conferência explícita das transferências V9/V11', () => {
  it('previews without DML, then applies two chosen transfers and the independent 7C change atomically', async () => {
    const s = await scenario();
    await protectOrigins(s.prefix);
    const before = await snapshot();
    statements.length = 0;
    const review = await preview(s);
    expect(review.groups).toEqual([{ origins: [
      { classCode: `${s.prefix}6A`, number: 1, name: `${s.prefix} ORIGEM UM` },
      { classCode: `${s.prefix}6A`, number: 2, name: `${s.prefix} ORIGEM DOIS` },
    ], destinations: [
      { classCode: `${s.prefix}6B`, number: 8, name: `${s.prefix} CORRIGIDO DOIS` },
      { classCode: `${s.prefix}6B`, number: 9, name: `${s.prefix} CORRIGIDO UM` },
    ] }]);
    expect(statements.every((statement) => statement.trimStart().startsWith('SELECT'))).toBe(true);
    expect(statements.join(' ')).not.toContain('ensure_year_coordination');
    expect(await snapshot()).toEqual(before); // cancellation is local: no second request needed.
    const confirmed = { ...s.request, movementReview: { digest: review.digest, pairs: s.pairs } };
    expect(isGradebookImportPersistenceRequestV9(confirmed)).toBe(true);
    expect((await s.service.execute(confirmed)).state).toBe('applied');
    const rows = (await pg.query<{ codigo: string; numero: number; aluno_id: number; nome: string; student_uid: string }>(
      `SELECT t.codigo,v.numero,v.aluno_id,a.nome,a.student_uid FROM gradebook.vinculo v
       JOIN gradebook.turma t ON t.id=v.turma_id JOIN gradebook.aluno a ON a.id=v.aluno_id
       WHERE t.codigo LIKE $1 ORDER BY t.codigo,v.numero`, [`${s.prefix}%`])).rows;
    expect(rows).toHaveLength(5);
    expect(rows[0]!.aluno_id).toBe(rows[3]!.aluno_id);
    expect(rows[1]!.aluno_id).toBe(rows[2]!.aluno_id);
    expect(new Set(rows.map((row) => row.student_uid)).size).toBe(3);
    expect(rows[4]!.nome).toBe(`${s.prefix} INDEPENDENTE CORRIGIDO`);
    const committed = await snapshot();
    for (const table of ['gradebook.nota', 'gradebook.fechamento', 'student_portal.account', 'student_portal.qr_credential',
      'student_portal.session', 'student_photos.portal_delivery_v1']) {
      expect(before[table]).not.toEqual([]);
      expect(committed[table]).toEqual(before[table]);
    }
    // A lost HTTP response/retry cannot replay a stale choice or duplicate identities.
    expect((await s.service.execute(confirmed)).state).toBe('conflict');
    expect(await snapshot()).toEqual(committed);
  });

  it.each(['incomplete', 'duplicate', 'missing', 'nonreciprocal', 'arbitrary-id'] as const)(
    'rejects %s choices without any partial independent update', async (kind) => {
      const s = await scenario();
      const review = await preview(s);
      const before = await snapshot();
      const pairs = structuredClone(s.pairs);
      if (kind === 'incomplete') pairs.pop();
      if (kind === 'duplicate') pairs[1] = { ...pairs[1]!, destination: pairs[0]!.destination };
      if (kind === 'missing') pairs[0] = { ...pairs[0]!, destination: { classCode: `${s.prefix}6B`, number: 63 } };
      if (kind === 'nonreciprocal') pairs[0] = { ...pairs[0]!, destination: { classCode: `${s.prefix}7C`, number: 1 } };
      const confirmed = { ...s.request, movementReview: { digest: review.digest, pairs } };
      if (kind === 'arbitrary-id') {
        expect(isGradebookImportPersistenceRequestV9({ ...confirmed, movementReview: {
          ...confirmed.movementReview, pairs: [{ ...pairs[0], studentUid: crypto.randomUUID() }],
        } })).toBe(false);
      } else expect((await s.service.execute(confirmed)).state).toBe('conflict');
      expect(await snapshot()).toEqual(before);
    });

  it.each(['actor', 'file', 'content', 'order', 'year', 'revision', 'reset'] as const)(
    'rejects obsolete review after changing %s', async (kind) => {
      const s = await scenario();
      const review = await preview(s);
      let request = { ...s.request, movementReview: { digest: review.digest, pairs: s.pairs } };
      let service = s.service;
      if (kind === 'actor') service = createGradebookRelationalImportServiceV11(database, undefined, '22222222-2222-4222-8222-222222222222');
      if (kind === 'file') request = { ...request, manifest: { ...request.manifest, sha256: 'c'.repeat(64) } };
      if (kind === 'content') request = { ...request, turmas: request.turmas.map((turma, i) => i === 2 ? { ...turma, alunos: [[1, 'OUTRO CONTEUDO', 0]] } : turma) };
      if (kind === 'order') request = { ...request, turmas: [...request.turmas].reverse() };
      if (kind === 'year') request = { ...request, ano: 2027 };
      if (kind === 'revision') await pg.exec('UPDATE student_portal.academic_revision SET reset_counter=reset_counter+1 WHERE academic_year=2026');
      if (kind === 'reset') await pg.exec(`UPDATE student_portal.academic_revision SET reset_generation=replace(gen_random_uuid()::text,'-','') WHERE academic_year=2026`);
      const before = await snapshot();
      expect((await service.execute(request)).state).toBe('conflict');
      expect(await snapshot()).toEqual(before);
    });

  it('rolls back selected transfers and unrelated changes when a write fails halfway through', async () => {
    const s = await scenario();
    const review = await preview(s);
    const before = await snapshot();
    failAtName = `${s.prefix} INDEPENDENTE CORRIGIDO`;
    try {
      await expect(s.service.execute({ ...s.request, movementReview: { digest: review.digest, pairs: s.pairs } }))
        .rejects.toThrow('synthetic-middle-of-relation-failure');
    } finally { failAtName = null; }
    expect(await snapshot()).toEqual(before);
  });

  it('cannot use explicit choice to merge two existing identities', async () => {
    const s = await scenario();
    expect((await s.service.execute({ ...s.initial, turmas: [...s.initial.turmas,
      { ...s.request.turmas[1]!, alunos: [[8, `${s.prefix} TERCEIRO`, 0], [9, `${s.prefix} QUARTO`, 0]] },
    ] })).state).toBe('applied');
    const review = await preview(s);
    const before = await snapshot();
    expect((await s.service.execute({ ...s.request, movementReview: { digest: review.digest, pairs: s.pairs } })).state).toBe('conflict');
    expect(await snapshot()).toEqual(before);
  });

  it('does not let a chosen pair bypass a previous rejection', async () => {
    const s = await scenario();
    const student = (await pg.query<{ student_uid: string; turma_id: number }>(`SELECT a.student_uid,v.turma_id FROM gradebook.aluno a
      JOIN gradebook.vinculo v ON v.aluno_id=a.id JOIN gradebook.turma t ON t.id=v.turma_id WHERE t.codigo=$1 AND v.numero=1`, [`${s.prefix}6A`])).rows[0]!;
    const [batch, reportClass, source, observation] = Array.from({ length: 4 }, () => crypto.randomUUID());
    await pg.transaction(async (tx) => {
      await tx.exec('INSERT INTO gradebook.student_reconciliation_scope_v1(academic_year) VALUES(2026) ON CONFLICT DO NOTHING');
      await tx.query(`INSERT INTO gradebook.student_report_batch_v1(id,academic_year,generation,actor_id,source_evidence,
        normalization_version,digest,request_digest,idempotency_key,base_revision,base_academic_revision,state,expires_at,class_links)
        SELECT $1::uuid,2026,generation,$2,'unknown',1,repeat('c',64),repeat('d',64),gen_random_uuid(),revision,'synthetic',
          'applied',now()+interval '1 day','[]'::jsonb FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026`, [batch, actor]);
      await tx.query(`INSERT INTO gradebook.student_report_class_v1(id,academic_year,label,class_key,shift,shift_key,stage_label,stage,gradebook_class_id)
        VALUES($1,2026,$2,$2,'M','M','6',6,$3)`, [reportClass, `${s.prefix}6A`, student.turma_id]);
      await tx.query('INSERT INTO gradebook.student_source_record_v1(id,academic_year,last_batch_id) VALUES($1,2026,$2)', [source, batch]);
      await tx.query(`INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,version,batch_id,report_class_id,
        name,name_key,birth_date,enrollment_hash,shift,shift_key,status,status_key)
        VALUES($1,2026,$2,1,$3,$4,$5,$5,'2012-01-01',$6,'M','M','CURSANDO','CURSANDO')`,
      [observation, source, batch, reportClass, `${s.prefix} CORRIGIDO UM`, `${s.prefix}-synthetic-hash`]);
      await tx.query('UPDATE gradebook.student_source_record_v1 SET current_observation_id=$2 WHERE id=$1', [source, observation]);
      await tx.query(`INSERT INTO gradebook.student_reconciliation_decision_v1(id,academic_year,generation,sequence,actor_id,action,source_id,student_uid,observation_id,reason)
        SELECT gen_random_uuid(),2026,generation,revision+1,$1,'reject',$2,$3,$4,'synthetic-rejection'
        FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026`, [actor, source, student.student_uid, observation]);
    });
    const review = await preview(s);
    const before = await snapshot();
    expect((await s.service.execute({ ...s.request, movementReview: { digest: review.digest, pairs: s.pairs } })).state).toBe('review-required');
    expect(await snapshot()).toEqual(before);
  });
});
