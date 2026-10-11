// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../student-portal/year-reset/schema-fixture';
import { resolveStudentIdentitiesV1 } from '../../server/student-identity/resolve-student-identity-v1';
import { createGradebookRelationalImportServiceV11 } from '../../server/gradebook/application/import/import-relational-service-v11';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../server/gradebook/persistence/postgres/postgres-database-v1';
import type { GradebookRelationImportRequestV9 } from '../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

const accountId = '10000000-0000-4000-8000-000000000001';
const closedId = '10000000-0000-4000-8000-000000000002';
const newAccountId = '20000000-0000-4000-8000-000000000001';
let pg: PGlite;
let before: unknown;
let newUid: string;

async function snapshot() {
  const rows = await pg.query(`SELECT jsonb_build_object(
    'students',(SELECT jsonb_agg(to_jsonb(s)-'student_uid' ORDER BY id) FROM gradebook.aluno s),
    'accounts',(SELECT jsonb_agg(to_jsonb(a)-'student_uid' ORDER BY id) FROM student_portal.account a),
    'photos',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM student_portal.profile_photo p),
    'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM student_portal.session s),
    'qr',(SELECT jsonb_agg(to_jsonb(q) ORDER BY credential_id) FROM student_portal.qr_credential q),
    'birth',(SELECT jsonb_agg(to_jsonb(b) ORDER BY account_id) FROM student_portal.account_access_data b)
  ) AS snapshot`);
  return rows.rows;
}

async function uidOf(id: number) {
  const result = await pg.query<{ uid: string }>(
    'SELECT student_uid::text AS uid FROM gradebook.aluno WHERE id=$1', [id],
  );
  return result.rows[0]!.uid;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE anon; CREATE ROLE authenticated;');
  for (const migration of [
    '0003_council_session_v3.sql', '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql', '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
  ]) await pg.exec(readFileSync(`migrations/gradebook-simplified/${migration}`, 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho)
      VALUES (2026,60000,3),(2027,60000,3);
    INSERT INTO gradebook.aluno (id,ano,nome)
      VALUES (101,2026,'SYNTHETIC HOMONYM'),(102,2026,'SYNTHETIC HOMONYM');
    INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version,pin_version)
      VALUES ('${accountId}',2026,101,'active','eligible',5,2,4);
    INSERT INTO student_portal.account
      (id,academic_year,auth_state,eligibility,closed_at)
      VALUES ('${closedId}',2026,'active','unlinked',statement_timestamp());
    CREATE TABLE student_portal.profile_photo (
      account_id uuid PRIMARY KEY REFERENCES student_portal.account(id) ON DELETE RESTRICT,
      sharepoint_drive_id text NOT NULL, sharepoint_item_id text NOT NULL
    );
    INSERT INTO student_portal.profile_photo VALUES ('${accountId}','synthetic-drive','synthetic-item');
    INSERT INTO student_portal.account_access_data (account_id,birth_year,confirmation)
      VALUES ('${accountId}',2010,'unconfirmed-test');
    INSERT INTO student_portal.qr_credential (credential_id,account_id,key_version,state)
      VALUES ('${'q'.repeat(40)}','${accountId}',1,'active');
    INSERT INTO student_portal.session (id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES ('30000000-0000-4000-8000-000000000001','${accountId}','synthetic-identity-session',2,now()+interval '1 day',false);
  `);
  before = await snapshot();
  await pg.exec(readFileSync('migrations/student-portal/0018_shared_student_identity_v1.sql', 'utf8'));
  await installReconciliationSchemaFixtureV1(pg, true);
}, 30_000);

afterAll(async () => { await pg?.close(); });

describe('shared identity migration on the actual private schema', () => {
  it('adopts existing UUIDs while preserving academic rows, accounts, credentials, sessions and photo references', async () => {
    expect(await snapshot()).toEqual(before);
    expect(await uidOf(101)).toBe(accountId);
    const closed = await pg.query<{ student_uid: string }>('SELECT student_uid::text FROM student_portal.account WHERE id=$1', [closedId]);
    expect(closed.rows[0]!.student_uid).toBe(closedId);
    expect((await pg.query('SELECT id FROM gradebook.student_identity')).rows).toHaveLength(3);
  });

  it('returns the same UID through both authorized lookup paths', async () => {
    const query = async (sql: string, parameters: readonly (string | number)[]) =>
      (await pg.query<Record<string, unknown>>(sql, [...parameters])).rows;
    const fromGradebook = await resolveStudentIdentitiesV1(query, {
      source: 'gradebook', academicYear: 2026, studentIds: [101],
    });
    const fromPortal = await resolveStudentIdentitiesV1(query, {
      source: 'portal', academicYear: 2026, accountIds: [accountId],
    });
    expect(fromGradebook[0]!.studentUid).toBe(fromPortal[0]!.studentUid);
    expect(fromGradebook[0]!.studentUid).toBe(accountId);
  });

  it('keeps homonyms separate and preserves identity after a name correction or replay', async () => {
    const other = await uidOf(102);
    expect(other).not.toBe(accountId);
    await pg.exec("UPDATE gradebook.aluno SET nome='SYNTHETIC CORRECTED' WHERE id=102");
    await pg.exec("INSERT INTO gradebook.aluno (id,ano,nome) VALUES (102,2026,'SYNTHETIC CORRECTED') ON CONFLICT (id) DO UPDATE SET nome=EXCLUDED.nome");
    expect(await uidOf(102)).toBe(other);
    expect((await pg.query('SELECT id FROM gradebook.student_identity')).rows).toHaveLength(3);
  });

  it('creates identity before a Portal account exists and reuses it when the account is created', async () => {
    await pg.exec("INSERT INTO gradebook.aluno (id,ano,nome) VALUES (110,2026,'SYNTHETIC NEW')");
    newUid = await uidOf(110);
    expect(newUid).toMatch(/^[a-f0-9-]{36}$/u);
    await pg.query(`INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility)
      VALUES ($1,2026,110,'pending-activation','eligible')`, [newAccountId]);
    const result = await pg.query<{ student_uid: string }>('SELECT student_uid::text FROM student_portal.account WHERE id=$1', [newAccountId]);
    expect(result.rows[0]!.student_uid).toBe(newUid);
  });

  it('refuses identity mutation and reassignment of an existing account to a different person', async () => {
    const other = await uidOf(102);
    await expect(pg.query('UPDATE gradebook.aluno SET student_uid=$1 WHERE id=101', [other])).rejects.toThrow('student-identity-immutable');
    await expect(pg.query('UPDATE student_portal.account SET student_uid=$1 WHERE id=$2', [other, accountId])).rejects.toThrow('student-identity-immutable');
    await expect(pg.query('UPDATE student_portal.account SET gradebook_student_id=102 WHERE id=$1', [accountId])).rejects.toThrow('student-identity-mismatch');
    expect(await uidOf(101)).toBe(accountId);
  });

  it('enforces one annual academic reference per person, with explicit cross-year linkage only', async () => {
    const other = await uidOf(102);
    await expect(pg.query("INSERT INTO gradebook.aluno (id,ano,nome,student_uid) VALUES (201,2026,'SYNTHETIC DUPLICATE',$1)", [other])).rejects.toThrow();
    await pg.query("INSERT INTO gradebook.aluno (id,ano,nome,student_uid) VALUES (202,2027,'SYNTHETIC EXPLICIT LINK',$1)", [other]);
    expect(await uidOf(202)).toBe(other);
  });

  it('preserves the person/account/photo after closing the link and deleting the academic row; reused numbers do not inherit it', async () => {
    await pg.query("INSERT INTO student_portal.profile_photo VALUES ($1,'synthetic-drive','synthetic-new-item')", [newAccountId]);
    await expect(pg.exec('DELETE FROM gradebook.aluno WHERE id=110')).rejects.toThrow();
    await pg.query(`UPDATE student_portal.account SET gradebook_student_id=NULL,
      eligibility='unlinked',closed_at=statement_timestamp() WHERE id=$1`, [newAccountId]);
    await pg.exec('DELETE FROM gradebook.aluno WHERE id=110');
    expect((await pg.query('SELECT id FROM gradebook.student_identity WHERE id=$1', [newUid])).rows).toHaveLength(1);
    expect((await pg.query('SELECT account_id FROM student_portal.profile_photo WHERE account_id=$1', [newAccountId])).rows).toHaveLength(1);
    await pg.exec("INSERT INTO gradebook.aluno (id,ano,nome) VALUES (110,2026,'SYNTHETIC NEW')");
    expect(await uidOf(110)).not.toBe(newUid);
    await expect(pg.query(`UPDATE student_portal.account SET gradebook_student_id=110,
      eligibility='eligible',closed_at=NULL WHERE id=$1`, [newAccountId])).rejects.toThrow('student-identity-mismatch');
  });

  it('keeps registry and trigger functions private, including inherited default grants', async () => {
    const table = await pg.query<{ rls: boolean }>("SELECT relrowsecurity AS rls FROM pg_class WHERE oid='gradebook.student_identity'::regclass");
    expect(table.rows[0]!.rls).toBe(true);
    for (const role of ['anon', 'authenticated', 'gradebook_app', 'student_portal_app']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const result = await pg.query<{ allowed: boolean }>("SELECT has_table_privilege($1,'gradebook.student_identity',$2) AS allowed", [role, privilege]);
        expect(result.rows[0]!.allowed).toBe(false);
      }
      for (const name of ['gradebook.assign_student_uid_v1()', 'student_portal.assign_student_uid_v1()']) {
        const result = await pg.query<{ allowed: boolean }>("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, name]);
        expect(result.rows[0]!.allowed).toBe(false);
      }
    }
    const functions = await pg.query<{ prosecdef: boolean; proconfig: string[] }>(`SELECT prosecdef,proconfig FROM pg_proc
      WHERE oid IN ('gradebook.assign_student_uid_v1()'::regprocedure,'student_portal.assign_student_uid_v1()'::regprocedure)`);
    expect(functions.rows).toHaveLength(2);
    for (const fn of functions.rows) {
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain('search_path=pg_catalog');
    }
  });

  it('lets existing backend roles use the trigger boundary without direct registry writes', async () => {
    await pg.exec('GRANT USAGE ON SCHEMA gradebook TO gradebook_app; GRANT SELECT,INSERT,UPDATE ON gradebook.aluno TO gradebook_app;');
    await pg.exec('SET ROLE gradebook_app');
    try {
      await pg.exec("INSERT INTO gradebook.aluno (id,ano,nome) VALUES (330,2026,'SYNTHETIC BACKEND')");
    } finally { await pg.exec('RESET ROLE'); }
    const uid = await uidOf(330);
    await pg.exec('SET ROLE student_portal_app');
    try {
      await pg.exec(`INSERT INTO student_portal.account
        (id,academic_year,gradebook_student_id,auth_state,eligibility)
        VALUES ('40000000-0000-4000-8000-000000000001',2026,330,'pending-activation','eligible')`);
    } finally { await pg.exec('RESET ROLE'); }
    const result = await pg.query<{ student_uid: string }>('SELECT student_uid::text FROM student_portal.account WHERE gradebook_student_id=330');
    expect(result.rows[0]!.student_uid).toBe(uid);
  });

  it('preserves canonical identity through the actual V11 import and existing Portal population function', async () => {
    async function execute(client: Pick<PGlite, 'query'>, query: string, values: readonly unknown[] = []) {
      const result = await client.query<Record<string, unknown>>(query, [...values]);
      return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
    }
    const sql: GradebookPostgresSqlV1 = {
      unsafe: (query, values = []) => execute(pg, query, values),
      begin: (operation) => pg.transaction((client) => {
        const transaction: GradebookPostgresQuerySqlV1 = { unsafe: (query, values = []) => execute(client, query, values) };
        return operation(transaction);
      }),
      end: async () => undefined,
    };
    const service = createGradebookRelationalImportServiceV11(createGradebookPostgresDatabaseFromSqlV1(sql));
    const request: GradebookRelationImportRequestV9 = {
      transportVersion: 9, operation: 'persist-relacao', ano: 2026,
      manifest: { fileName: 'SYNTHETIC IDENTITY.xlsb', sha256: 'a'.repeat(64), parserVersion: 'synthetic-identity-v1' },
      turmas: [{ codigo: 'ID1114', nome: 'SYNTHETIC IDENTITY CLASS', etapa: 6, turno: 'MATUTINO', alunos: [[1, 'SYNTHETIC IMPORT IDENTITY', 0]] }],
    };
    await pg.exec('UPDATE student_portal.lifecycle_control SET population_enabled=true');
    expect(await service.execute(request)).toMatchObject({ state: 'applied' });
    const first = await pg.query<{ student_uid: string; account_uid: string }>(`SELECT s.student_uid::text AS student_uid,a.student_uid::text AS account_uid
      FROM gradebook.aluno s JOIN student_portal.account a ON a.gradebook_student_id=s.id AND a.academic_year=s.ano
      WHERE s.nome='SYNTHETIC IMPORT IDENTITY'`);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.student_uid).toBe(first.rows[0]!.account_uid);
    const count = (await pg.query('SELECT count(*)::integer AS count FROM gradebook.student_identity')).rows;
    expect(await service.execute(request)).toMatchObject({ state: 'no-changes' });
    expect((await pg.query('SELECT count(*)::integer AS count FROM gradebook.student_identity')).rows).toEqual(count);
  }, 30_000);
});
