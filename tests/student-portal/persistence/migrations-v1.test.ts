import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let pg: PGlite;
const portalRoot = 'migrations/student-portal/';
const portalMigrations = [
  '0001_identity_credentials_acl_v1.sql',
  '0002_policy_publication_revision_v1.sql',
  '0003_audit_receipts_closure_integration_v1.sql',
  '0004_gradebook_integration_usage_v1.sql',
] as const;

async function applyGradebookBaseline() {
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(
    'CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;',
  );
  await pg.exec(readFileSync('migrations/gradebook-simplified/application_role_grants.sql', 'utf8'));
  for (const file of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
    '0009_granular_observations_names_v1.sql',
    '0008_year_reset_acl_v1.sql',
  ]) {
    await pg.exec(readFileSync(`migrations/gradebook-simplified/${file}`, 'utf8'));
  }
}

async function applyPortalMigrations() {
  for (const file of portalMigrations) await pg.exec(readFileSync(`${portalRoot}${file}`, 'utf8'));
}

beforeAll(async () => {
  pg = new PGlite();
  await applyGradebookBaseline();
  await applyPortalMigrations();
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho)
    VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
    VALUES (1,2026,'S1','TURMA SINTETICA',6,'TESTE');
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,1,1,1);
  `);
}, 30_000);

afterAll(async () => { await pg?.close(); });

describe('student_portal additive schema and ACL', () => {
  it('creates the private V1 catalog and only the approved academic views', async () => {
    const tables = (await pg.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='student_portal' ORDER BY tablename",
    )).rows.map((row) => row.tablename);
    expect(tables).toEqual([
      'academic_revision','account','account_access_data','audit_event','auth_attempt','auth_challenge',
      'link_closure','operation_receipt','password_credential','publication','publication_job',
      'published_projection','qr_credential','revision_event','session','setting','year_reset_preview_proof',
    ]);
    const views = (await pg.query<{ viewname: string }>(
      "SELECT viewname FROM pg_views WHERE schemaname='student_portal' ORDER BY viewname",
    )).rows.map((row) => row.viewname);
    expect(views).toEqual([
      'academic_binding_v1','academic_closure_v1','academic_council_decision_v1','academic_instrument_v1',
      'academic_mark_v1','academic_offer_v1','academic_student_v1','academic_year_policy_v1',
    ]);
  });

  it('keeps the runtime role non-administrative and client roles outside the private schema', async () => {
    const role = (await pg.query(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
      FROM pg_roles WHERE rolname='student_portal_app'`)).rows[0];
    expect(role).toEqual({ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    const acl = (await pg.query(`SELECT r.rolname,
      has_schema_privilege(r.rolname,'student_portal','USAGE') AS portal_usage,
      has_schema_privilege(r.rolname,'student_portal','CREATE') AS portal_create,
      has_schema_privilege(r.rolname,'gradebook','USAGE') AS gradebook_usage,
      has_table_privilege(r.rolname,'student_portal.account','SELECT') AS account_select,
      has_table_privilege(r.rolname,'gradebook.aluno','SELECT') AS gradebook_student_select,
      has_table_privilege(r.rolname,'student_portal.academic_student_v1','SELECT') AS academic_view_select
      FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','student_portal_app') ORDER BY r.rolname`)).rows;
    expect(acl).toEqual([
      { rolname: 'anon', portal_usage: false, portal_create: false, gradebook_usage: false, account_select: false, gradebook_student_select: false, academic_view_select: false },
      { rolname: 'authenticated', portal_usage: false, portal_create: false, gradebook_usage: false, account_select: false, gradebook_student_select: false, academic_view_select: false },
      { rolname: 'student_portal_app', portal_usage: true, portal_create: false, gradebook_usage: false, account_select: true, gradebook_student_select: false, academic_view_select: true },
    ]);
  });

  it('enforces 2026 identity, one live link and RESTRICT instead of academic cascade', async () => {
    const first = '11111111-1111-4111-8111-111111111111';
    await pg.exec(`INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version,pin_version)
      VALUES ('${first}',2026,1,'pending-activation','eligible',0,0,0)`);
    await expect(pg.exec(`INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version,pin_version)
      VALUES ('22222222-2222-4222-8222-222222222222',2026,1,'pending-activation','eligible',0,0,0)`))
      .rejects.toMatchObject({ code: '23505' });
    await expect(pg.exec(`INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version,pin_version)
      VALUES ('33333333-3333-4333-8333-333333333333',2025,1,'pending-activation','eligible',0,0,0)`))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pg.exec('DELETE FROM gradebook.aluno WHERE id=1 AND ano=2026')).rejects.toMatchObject({ code: '23503' });

    await pg.exec(`INSERT INTO student_portal.link_closure
      (account_id,academic_year,gradebook_student_id,closed_at,version)
      VALUES ('${first}',2026,1,now(),1);
      UPDATE student_portal.account SET gradebook_student_id=NULL,eligibility='unlinked',closed_at=now(),version=1
      WHERE id='${first}';
      DELETE FROM gradebook.vinculo WHERE ano=2026 AND turma_id=1 AND numero=1;
      DELETE FROM gradebook.aluno WHERE id=1 AND ano=2026;`);
    expect((await pg.query('SELECT gradebook_student_id FROM student_portal.link_closure')).rows)
      .toEqual([{ gradebook_student_id: 1 }]);
  });

  it('enforces one active QR and unique session hash without plaintext credential columns', async () => {
    await pg.exec(`
      INSERT INTO gradebook.aluno (id,ano,nome) VALUES (2,2026,'ALUNO SINTETICO DOIS');
      INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,1,2,2);
      INSERT INTO student_portal.account
        (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version,pin_version)
      VALUES ('44444444-4444-4444-8444-444444444444',2026,2,'pending-activation','eligible',0,0,0);
      INSERT INTO student_portal.qr_credential(credential_id,account_id,key_version,state)
      VALUES ('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','44444444-4444-4444-8444-444444444444',1,'active');
    `);
    await expect(pg.exec(`INSERT INTO student_portal.qr_credential(credential_id,account_id,key_version,state)
      VALUES ('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB','44444444-4444-4444-8444-444444444444',1,'active')`))
      .rejects.toMatchObject({ code: '23505' });
    await pg.exec(`INSERT INTO student_portal.session
      (id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','hash-1',0,now()+interval '1 hour',false)`);
    await expect(pg.exec(`INSERT INTO student_portal.session
      (id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES ('66666666-6666-4666-8666-666666666666','44444444-4444-4444-8444-444444444444','hash-1',0,now()+interval '1 hour',false)`))
      .rejects.toMatchObject({ code: '23505' });
    const columns = (await pg.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='student_portal' AND table_name IN ('password_credential','session','qr_credential')`)).rows
      .map((row) => row.column_name);
    expect(columns).not.toContain('pin');
    expect(columns).not.toContain('password');
    expect(columns).not.toContain('token');
    expect(columns).not.toContain('qr_payload');
  });

  it('exposes only narrow integration functions to gradebook_app and records an idempotent revision', async () => {
    const privileges = (await pg.query<{ revision_execute: boolean; guard_execute: boolean }>(`SELECT
      has_function_privilege('gradebook_app','student_portal.record_gradebook_change_v1(uuid,smallint,text,boolean,integer[],timestamptz)','EXECUTE') AS revision_execute,
      has_function_privilege('gradebook_app','student_portal.inspect_year_reset_guard_v1(smallint)','EXECUTE') AS guard_execute`)).rows[0];
    expect(privileges).toEqual({ revision_execute: true, guard_execute: true });
    const before = (await pg.query<{ academic_counter: number; reset_counter: number }>(
      `SELECT academic_counter::integer,reset_counter::integer FROM student_portal.academic_revision WHERE academic_year=2026`,
    )).rows[0]!;
    const event = '77777777-7777-4777-8777-777777777777';
    await pg.query(`SELECT * FROM student_portal.record_gradebook_change_v1($1::uuid,2026::smallint,'marks'::text,true,ARRAY[2]::integer[],now())`, [event]);
    await pg.query(`SELECT * FROM student_portal.record_gradebook_change_v1($1::uuid,2026::smallint,'marks'::text,true,ARRAY[2]::integer[],now())`, [event]);
    const after = (await pg.query<{ academic_counter: number; reset_counter: number }>(
      `SELECT academic_counter::integer,reset_counter::integer FROM student_portal.academic_revision WHERE academic_year=2026`,
    )).rows[0]!;
    expect(after).toEqual({ academic_counter: before.academic_counter + 1, reset_counter: before.reset_counter + 1 });
    expect((await pg.query('SELECT count(*)::integer AS count FROM student_portal.revision_event WHERE event_id=$1', [event])).rows)
      .toEqual([{ count: 1 }]);
  });

  it('fails closed on migration replay instead of dropping or resetting the schema', async () => {
    await expect(pg.exec(readFileSync(`${portalRoot}0001_identity_credentials_acl_v1.sql`, 'utf8'))).rejects.toMatchObject({ code: '42P06' });
  });

  it('refuses to remove the legacy projection before scoped V2 exists', async () => {
    await expect(pg.exec(readFileSync(`${portalRoot}0019_remove_legacy_projection_v1.sql`, 'utf8')))
      .rejects.toThrow();
    await pg.exec('ROLLBACK');
    expect((await pg.query<{ name: string | null }>(
      "SELECT to_regclass('student_portal.published_projection')::text AS name",
    )).rows[0]?.name).toBe('student_portal.published_projection');
  });
});
