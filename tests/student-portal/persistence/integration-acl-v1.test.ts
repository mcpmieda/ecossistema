// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  await pg.exec(readFileSync('migrations/gradebook-simplified/application_role_grants.sql', 'utf8'));
  for (const file of [
    '0003_council_session_v3.sql','0004_council_v3_least_privilege.sql','0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql','0007_multiyear_rr_v1.sql','0008_year_reset_acl_v1.sql',
  ]) await pg.exec(readFileSync(`migrations/gradebook-simplified/${file}`, 'utf8'));
  for (const file of [
    '0001_identity_credentials_acl_v1.sql','0002_policy_publication_revision_v1.sql',
    '0003_audit_receipts_closure_integration_v1.sql','0004_gradebook_integration_usage_v1.sql',
  ]) await pg.exec(readFileSync(`migrations/student-portal/${file}`, 'utf8'));
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,2);
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO');
    INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version,pin_version)
    VALUES ('11111111-1111-4111-8111-111111111111',2026,1,'pending-activation','eligible',0,0,0);
  `);
}, 30_000);

afterAll(async () => { await pg?.close(); });

describe('gradebook_app narrow Portal integration surface', () => {
  it('has schema usage and only the two approved function executions', async () => {
    const result = (await pg.query(`SELECT
      has_schema_privilege('gradebook_app','student_portal','USAGE') AS schema_usage,
      has_table_privilege('gradebook_app','student_portal.account','SELECT') AS account_select,
      has_table_privilege('gradebook_app','student_portal.account','INSERT') AS account_insert,
      has_function_privilege('gradebook_app','student_portal.inspect_year_reset_guard_v1(smallint)','EXECUTE') AS guard_execute,
      has_function_privilege('gradebook_app','student_portal.record_gradebook_change_v1(uuid,smallint,text,boolean,integer[],timestamptz)','EXECUTE') AS revision_execute`)).rows[0];
    expect(result).toEqual({
      schema_usage: true,
      account_select: false,
      account_insert: false,
      guard_execute: true,
      revision_execute: true,
    });
  });

  it('returns the reset guard state without exposing Portal tables', async () => {
    await pg.exec('SET ROLE gradebook_app');
    const guard = (await pg.query<{ linked_count: bigint; state: string; portal_link_revision: string }>(
      'SELECT * FROM student_portal.inspect_year_reset_guard_v1(2026::smallint)',
    )).rows[0]!;
    expect(Number(guard.linked_count)).toBe(1);
    expect(guard.state).toBe('portal-linked-accounts');
    expect(guard.portal_link_revision).toMatch(/^[a-f0-9]{32}:[1-9][0-9]{0,19}$/u);
    await expect(pg.query('SELECT * FROM student_portal.account')).rejects.toMatchObject({ code: '42501' });
    await pg.exec('RESET ROLE');
  });
});
