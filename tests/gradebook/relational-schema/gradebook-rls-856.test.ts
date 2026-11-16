// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let pg: PGlite;
let beforeGrants: string[] = [];

const root = 'migrations/gradebook-simplified/';

async function grants() {
  const rows = (
    await pg.query<{ signature: string }>(`
      SELECT table_name||':'||privilege_type AS signature
      FROM information_schema.role_table_grants
      WHERE table_schema='gradebook' AND grantee='gradebook_app'
      ORDER BY table_name,privilege_type
    `)
  ).rows;
  return rows.map((row) => row.signature);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(root + '0001_current_schema.sql', 'utf8'));
  await pg.exec(
    'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;',
  );
  await pg.exec(readFileSync(root + 'application_role_grants.sql', 'utf8'));
  for (const file of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
    '0008_year_reset_acl_v1.sql',
    '0009_granular_observations_names_v1.sql',
  ])
    await pg.exec(readFileSync(root + file, 'utf8'));

  await pg.exec("INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2)");
  beforeGrants = await grants();
  await pg.exec(readFileSync(root + '0011_gradebook_rls_v1.sql', 'utf8'));
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

it('enables non-forced RLS with one backend policy on every current gradebook table', async () => {
  expect(
    (await pg.query(`
      SELECT count(*)::integer AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='gradebook' AND c.relkind='r'
        AND c.relrowsecurity=true AND c.relforcerowsecurity=false
    `)).rows,
  ).toEqual([{ n: 30 }]);

  expect(
    (await pg.query(`
      SELECT count(*)::integer AS n
      FROM pg_policy p
      JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='gradebook'
        AND p.polname='gradebook_app_backend_v1'
        AND p.polcmd='*'
        AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='gradebook_app')]::oid[]
        AND pg_get_expr(p.polqual,p.polrelid)='true'
        AND pg_get_expr(p.polwithcheck,p.polrelid)='true'
    `)).rows,
  ).toEqual([{ n: 30 }]);

  expect(
    (await pg.query(`
      SELECT rolbypassrls FROM pg_roles WHERE rolname='gradebook_app'
    `)).rows,
  ).toEqual([{ rolbypassrls: false }]);
});

it('preserves every existing gradebook_app table grant exactly', async () => {
  expect(await grants()).toEqual(beforeGrants);
});

it('allows the backend role through RLS only for commands its ACL already grants', async () => {
  await pg.exec('SET ROLE gradebook_app');
  try {
    expect(
      (await pg.query('SELECT ano FROM gradebook.ano_letivo WHERE ano=2026')).rows,
    ).toEqual([{ ano: 2026 }]);

    await pg.exec("INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (990001,2026,'SINTETICA')");
    await pg.exec("UPDATE gradebook.disciplina SET nome='SINTETICA 2' WHERE id=990001");
    await pg.exec('DELETE FROM gradebook.disciplina WHERE id=990001');

    await expect(
      pg.exec('TRUNCATE gradebook.conselho_sessao_historico'),
    ).rejects.toThrow(/permission denied/iu);
  } finally {
    await pg.exec('RESET ROLE');
  }
});

it.each(['anon', 'authenticated'])('keeps %s outside the private gradebook schema', async (role) => {
  await pg.exec(`SET ROLE ${role}`);
  try {
    await expect(pg.query('SELECT * FROM gradebook.ano_letivo')).rejects.toThrow(
      /permission denied/iu,
    );
  } finally {
    await pg.exec('RESET ROLE');
  }

  expect(
    (await pg.query<{ usage: boolean }>(
      `SELECT has_schema_privilege('${role}','gradebook','USAGE') AS usage`,
    )).rows,
  ).toEqual([{ usage: false }]);
});

it('does not change application data while enabling RLS', async () => {
  expect(
    (await pg.query('SELECT ano,minimo_aprovacao,max_componentes_conselho FROM gradebook.ano_letivo')).rows,
  ).toEqual([{ ano: 2026, minimo_aprovacao: 60000, max_componentes_conselho: 2 }]);
});
