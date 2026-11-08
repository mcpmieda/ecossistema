import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LinkClosureServiceV1 } from '../../../server/student-portal/integration/lifecycle/link-closure-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { LifecycleServiceV1 } from './synchronize-profiles-helper';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';

let pg: PGlite;
let service: LifecycleServiceV1;
let closure: LinkClosureServiceV1;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
      VALUES (900001,2026,'S1','TURMA SINTETICA UM',6,'TESTE'),
             (900002,2026,'S2','TURMA SINTETICA DOIS',6,'TESTE');
    INSERT INTO gradebook.aluno (id,ano,nome)
      VALUES (900001,2026,'PESSOA SINTETICA'),(900002,2026,'PESSOA SINTETICA');
  `);
  const sql: StudentPortalPostgresSqlV1 = {
    async unsafe<R extends Record<string, unknown>>(query: string, parameters: readonly unknown[] = []) {
      return (await pg.query<R>(query, [...parameters])).rows;
    },
    begin: (operation) => pg.transaction((tx) => operation({
      async unsafe<R extends Record<string, unknown>>(query: string, parameters: readonly unknown[] = []) {
        return (await tx.query<R>(query, [...parameters])).rows;
      },
    })),
  };
  service = new LifecycleServiceV1(sql);
  closure = new LinkClosureServiceV1(sql);
}, 30_000);

beforeEach(async () => {
  await pg.exec(`TRUNCATE student_portal.account CASCADE;
    UPDATE student_portal.lifecycle_control SET population_enabled=false;
    DELETE FROM gradebook.vinculo;
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,900001,1,900001);`);
});
afterAll(async () => { await pg?.close(); });

async function account() {
  return (await pg.query<{ id: string; version: number; security_version: number; eligibility: string; blocked: boolean; auth_state: string }>(
    'SELECT id,version::integer,security_version::integer,eligibility,blocked,auth_state FROM student_portal.account WHERE gradebook_student_id=900001',
  )).rows[0]!;
}

async function saveSession(id: string) {
  await pg.query(`INSERT INTO student_portal.session (id,account_id,token_hash,security_version,expires_at,persistent)
    VALUES (gen_random_uuid(),$1,'synthetic-session-hash',0,now()+interval '1 day',false)`, [id]);
}

describe('transactional profile lifecycle', () => {
  it('does not create any profile through the dormant Gradebook gate', async () => {
    await pg.exec('SET ROLE gradebook_app');
    try {
      expect((await pg.query('SELECT * FROM student_portal.synchronize_gradebook_profiles_v1()')).rows)
        .toEqual([{ created_count: 0, updated_count: 0, denied_count: 0 }]);
      await expect(pg.query('SELECT * FROM student_portal.synchronize_profiles_v1(true)')).rejects.toThrow('permission denied');
      await expect(pg.query('UPDATE student_portal.lifecycle_control SET population_enabled=true')).rejects.toThrow('permission denied');
    } finally { await pg.exec('RESET ROLE'); }
  });

  it('creates once by year/id, without credentials or birth, and preserves account identity on repetition', async () => {
    expect(await service.synchronize({ createProfiles: true })).toEqual({ created: 1, updated: 0, denied: 0 });
    const before = await account();
    expect(before).toMatchObject({ auth_state: 'pending-activation', eligibility: 'eligible' });
    expect(await service.synchronize({ createProfiles: true })).toEqual({ created: 0, updated: 0, denied: 0 });
    expect(await account()).toEqual(before);
    for (const table of ['qr_credential','password_credential','account_access_data','session']) {
      expect((await pg.query(`SELECT count(*)::integer AS count FROM student_portal.${table}`)).rows).toEqual([{ count: 0 }]);
    }
  });

  it.each([1, 2])('keeps a profile eligible for academic status %s', async (status) => {
    await pg.query('UPDATE gradebook.vinculo SET situacao=$1', [status]);
    expect(await service.synchronize({ createProfiles: true })).toMatchObject({ created: 1, denied: 0 });
  });

  it.each([3, 4, 5])('revokes exit %s atomically and never restores old sessions or an administrative block', async (status) => {
    await service.synchronize({ createProfiles: true });
    const before = await account();
    await saveSession(before.id);
    await pg.exec('UPDATE student_portal.account SET blocked=true');
    await pg.query('UPDATE gradebook.vinculo SET situacao=$1', [status]);
    expect(await service.synchronize({ createProfiles: false })).toEqual({ created: 0, updated: 1, denied: 1 });
    expect(await account()).toMatchObject({ id: before.id, blocked: true, eligibility: 'exit', security_version: 1 });
    expect((await pg.query('SELECT revoked_at IS NOT NULL AS revoked FROM student_portal.session')).rows).toEqual([{ revoked: true }]);
    expect(await service.synchronize({ createProfiles: true })).toMatchObject({ created: 0, updated: 0 });
    await pg.exec('UPDATE gradebook.vinculo SET situacao=NULL');
    await service.synchronize({ createProfiles: true });
    expect(await account()).toMatchObject({ id: before.id, blocked: true, eligibility: 'eligible', security_version: 1 });
    expect((await pg.query('SELECT revoked_at IS NOT NULL AS revoked FROM student_portal.session')).rows).toEqual([{ revoked: true }]);
  });

  it('keeps a valid exit profile without granting access, and skips missing/history-only bindings', async () => {
    await pg.exec('UPDATE gradebook.vinculo SET situacao=3');
    expect(await service.synchronize({ createProfiles: true })).toMatchObject({ created: 1, denied: 1 });
    await pg.exec(`INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao,turma_relacionada_id)
      VALUES (2026,900002,2,900002,6,900001)`);
    expect(await service.synchronize({ createProfiles: true })).toMatchObject({ created: 0 });
  });

  it('keeps identity and sessions across rename/move', async () => {
    await service.synchronize({ createProfiles: true });
    const before = await account();
    await saveSession(before.id);
    await pg.exec(`UPDATE gradebook.aluno SET nome='PESSOA SINTETICA RENOMEADA' WHERE id=900001;
      UPDATE gradebook.vinculo SET situacao=6,turma_relacionada_id=900002 WHERE aluno_id=900001;
      INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao,turma_relacionada_id)
      VALUES (2026,900002,1,900001,7,900001)`);
    expect(await service.synchronize({ createProfiles: true })).toEqual({ created: 0, updated: 1, denied: 0 });
    expect(await account()).toMatchObject({ id: before.id, security_version: before.security_version });
    expect((await pg.query('SELECT class_id FROM student_portal.lifecycle_snapshot')).rows).toEqual([{ class_id: 900002 }]);
    expect((await pg.query('SELECT revoked_at FROM student_portal.session')).rows).toEqual([{ revoked_at: null }]);
  });

  it('denies a removed binding and treats a new same-name ID as a different account', async () => {
    await service.synchronize({ createProfiles: true });
    const before = await account();
    await saveSession(before.id);
    await pg.exec(`DELETE FROM gradebook.vinculo;
      INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,900001,2,900002)`);
    expect(await service.synchronize({ createProfiles: true })).toEqual({ created: 1, updated: 1, denied: 1 });
    expect(await account()).toMatchObject({ id: before.id, eligibility: 'unresolved' });
    expect((await pg.query('SELECT count(*)::integer AS count FROM student_portal.account')).rows).toEqual([{ count: 2 }]);
  });

  it('rolls back profiles and revision when the caller transaction fails', async () => {
    await expect(pg.transaction(async (tx) => {
      await tx.query('SELECT * FROM student_portal.synchronize_profiles_v1(true)');
      throw new Error('synthetic-rollback');
    })).rejects.toThrow('synthetic-rollback');
    expect((await pg.query('SELECT id FROM student_portal.account')).rows).toEqual([]);
  });
});

const ACTOR = '11111111-1111-4111-8111-111111111111';
function closeCommand(preview: { previewToken: string; version: number; count: number }) {
  return { contractVersion: 1, operation: 'links-close', academicYear: 2026,
    expectedVersion: preview.version, expectedCount: preview.count, previewToken: preview.previewToken,
    confirmed: true, idempotencyKey: crypto.randomUUID() };
}

describe('explicit closure preview and tombstone', () => {
  it('rejects another actor and stale scope even when the linked count is unchanged', async () => {
    await service.synchronize({ createProfiles: true });
    const preview = await closure.preview(ACTOR);
    await expect(closure.execute('22222222-2222-4222-8222-222222222222', closeCommand(preview)))
      .rejects.toThrow('student-portal-link-preview-conflict');
    await pg.exec('UPDATE student_portal.account SET version=version+1');
    await expect(closure.execute(ACTOR, closeCommand(preview))).rejects.toThrow('student-portal-link-preview-conflict');
    expect((await pg.query('SELECT closed_at FROM student_portal.account')).rows).toEqual([{ closed_at: null }]);
  });

  it('closes once, revokes sessions, preserves account history and prevents repopulation by the same ID', async () => {
    await service.synchronize({ createProfiles: true });
    const before = await account();
    await saveSession(before.id);
    const preview = await closure.preview(ACTOR);
    expect(await closure.execute(ACTOR, closeCommand(preview))).toEqual({ closed: 1, version: preview.version + 1 });
    expect((await pg.query('SELECT id,gradebook_student_id,eligibility FROM student_portal.account')).rows)
      .toEqual([{ id: before.id, gradebook_student_id: null, eligibility: 'unlinked' }]);
    expect((await pg.query('SELECT revoked_at IS NOT NULL AS revoked FROM student_portal.session')).rows).toEqual([{ revoked: true }]);
    expect((await pg.query('SELECT gradebook_student_id FROM student_portal.link_closure')).rows).toEqual([{ gradebook_student_id: 900001 }]);
    expect(await service.synchronize({ createProfiles: true })).toEqual({ created: 0, updated: 0, denied: 0 });
    await expect(closure.execute(ACTOR, closeCommand(preview))).rejects.toThrow('student-portal-link-preview-conflict');
    expect((await pg.query("SELECT count(*)::integer AS count FROM student_portal.audit_event WHERE kind='links-closed'")).rows).toEqual([{ count: 1 }]);
    expect((await pg.query('SELECT count(*)::integer AS count FROM gradebook.aluno')).rows).toEqual([{ count: 2 }]);
  });

  it('does not accept an expired preview', async () => {
    await service.synchronize({ createProfiles: true });
    const preview = await closure.preview(ACTOR);
    await pg.exec("UPDATE student_portal.link_close_preview SET issued_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes'");
    await expect(closure.execute(ACTOR, closeCommand(preview))).rejects.toThrow('student-portal-link-preview-conflict');
  });
});
