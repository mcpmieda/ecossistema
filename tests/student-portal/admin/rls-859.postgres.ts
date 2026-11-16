import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://missing.invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
) {
  throw new Error('RLS #859 tests require disposable local PostgreSQL.');
}

const databaseName = 'portal859_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
let created = false;
let owner: ReturnType<typeof postgres>;
let portal: ReturnType<typeof postgres>;
let gradebook: ReturnType<typeof postgres>;
let anonymous: ReturnType<typeof postgres>;
let authenticated: ReturnType<typeof postgres>;
let grantsBefore: string[] = [];

function connect(role?: string) {
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  if (role) url.username = role;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  clients.push(sql);
  return sql;
}

async function portalGrants() {
  const rows = await owner.unsafe(`
    SELECT table_name||':'||privilege_type AS signature
    FROM information_schema.role_table_grants
    WHERE table_schema='student_portal' AND grantee='student_portal_app'
    ORDER BY table_name,privilege_type
  `);
  return rows.map((row) => String(row.signature));
}

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + databaseName);
  created = true;
  owner = connect();

  await owner.unsafe(
    readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'),
    [],
    { prepare: false },
  );
  await owner.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gradebook_app') THEN
        CREATE ROLE gradebook_app LOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon LOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated LOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;
    ALTER TABLE gradebook.fechamento
      ADD COLUMN IF NOT EXISTS rec_rr_mask SMALLINT NOT NULL DEFAULT 0;
  `);

  for (const name of [
    '0001_identity_credentials_acl_v1.sql',
    '0002_policy_publication_revision_v1.sql',
    '0003_audit_receipts_closure_integration_v1.sql',
    '0004_gradebook_integration_usage_v1.sql',
    '0005_year_reset_protocol_v1.sql',
    '0006_gradebook_revision_year_range_v1.sql',
    '0007_lifecycle_integration_v1.sql',
    '0008_atomic_publication_v2.sql',
    '0009_publication_cutover_guard_v2.sql',
    '0010_incremental_publication_v3.sql',
    '0011_live_event_outbox_v1.sql',
  ]) {
    await owner.unsafe(readFileSync('migrations/student-portal/' + name, 'utf8'), [], {
      prepare: false,
    });
  }

  await owner.unsafe(
    readFileSync('migrations/gradebook-simplified/0009_granular_observations_names_v1.sql', 'utf8'),
    [],
    { prepare: false },
  );
  for (const name of [
    '0012_granular_observations_names_v1.sql',
    '0013_publication_inheritance_v1.sql',
    '0014_year_reset_full_cleanup_v1.sql',
  ]) {
    await owner.unsafe(readFileSync('migrations/student-portal/' + name, 'utf8'), [], {
      prepare: false,
    });
  }

  await owner.unsafe(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho)
    VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
    VALUES (859001,2026,'R859','SYNTHETIC RLS CLASS',6,'TESTE');
    INSERT INTO gradebook.aluno (id,ano,nome)
    VALUES (859001,2026,'SYNTHETIC RLS STUDENT');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id)
    VALUES (2026,859001,1,859001);
    INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version,pin_version)
    VALUES
      ('85900000-0000-4000-8000-000000000001',2026,859001,'pending-activation','eligible',0,0,0);
  `);

  grantsBefore = await portalGrants();
  await owner.unsafe(
    readFileSync('migrations/student-portal/0015_student_portal_rls_v1.sql', 'utf8'),
    [],
    { prepare: false },
  );

  portal = connect('student_portal_app');
  gradebook = connect('gradebook_app');
  anonymous = connect('anon');
  authenticated = connect('authenticated');
}, 60_000);

afterAll(async () => {
  for (const client of clients) await client.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + databaseName);
  await cluster.end({ timeout: 2 });
});

it('enables non-forced RLS with one backend policy on all 27 current Portal tables', async () => {
  expect(
    await owner.unsafe(`
      SELECT count(*)::integer AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='student_portal'
        AND c.relkind IN ('r','p')
        AND c.relrowsecurity=true
        AND c.relforcerowsecurity=false
    `),
  ).toEqual([{ n: 27 }]);

  expect(
    await owner.unsafe(`
      SELECT count(*)::integer AS n
      FROM pg_policy p
      JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='student_portal'
        AND p.polname='student_portal_app_backend_v1'
        AND p.polcmd='*'
        AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='student_portal_app')]::oid[]
        AND pg_get_expr(p.polqual,p.polrelid)='true'
        AND pg_get_expr(p.polwithcheck,p.polrelid)='true'
    `),
  ).toEqual([{ n: 27 }]);

  expect(
    await owner.unsafe(`
      SELECT rolbypassrls
      FROM pg_roles
      WHERE rolname='student_portal_app'
    `),
  ).toEqual([{ rolbypassrls: false }]);
});

it('preserves the exact student_portal_app table ACL', async () => {
  expect(await portalGrants()).toEqual(grantsBefore);
});

it('keeps runtime login, self/admin, publication and job data reachable through the restricted backend role', async () => {
  expect((await portal`SELECT count(*)::integer AS n FROM student_portal.account`)[0]!.n).toBe(1);
  expect(
    (await portal`SELECT count(*)::integer AS n FROM student_portal.published_projection`)[0]!.n,
  ).toBe(0);
  expect(
    (await portal`SELECT count(*)::integer AS n FROM student_portal.publication_source_v2`)[0]!.n,
  ).toBeGreaterThanOrEqual(0);
  expect(
    (await portal`SELECT count(*)::integer AS n FROM student_portal.publication_job`)[0]!.n,
  ).toBeGreaterThanOrEqual(0);
  expect(
    (await portal`SELECT count(*)::integer AS n FROM student_portal.live_event_outbox_v1`)[0]!.n,
  ).toBeGreaterThanOrEqual(0);

  await portal.unsafe(`
    UPDATE student_portal.academic_revision
    SET academic_counter=academic_counter
    WHERE academic_year=2026
  `);
  const synchronized = await portal.unsafe(
    'SELECT * FROM student_portal.synchronize_profiles_v1(false)',
  );
  expect(Array.isArray(synchronized)).toBe(true);
});

it('preserves the SECURITY DEFINER Gradebook integration across Portal RLS', async () => {
  const eventId = crypto.randomUUID();
  const result = await gradebook.unsafe(
    `SELECT * FROM student_portal.record_gradebook_change_v1(
      $1::uuid,2026::smallint,'marks'::text,true,ARRAY[859001]::integer[],statement_timestamp()
    )`,
    [eventId],
  );
  expect(result).toHaveLength(1);
  expect(
    (
      await owner.unsafe(
        'SELECT count(*)::integer AS n FROM student_portal.revision_event WHERE event_id=$1::uuid',
        [eventId],
      )
    )[0]!.n,
  ).toBe(1);
});

it('keeps the full-chain Gradebook integration ACL exact', async () => {
  const functions = await owner.unsafe<{ function_name: string }[]>(`
    SELECT p.proname AS function_name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='student_portal'
      AND has_function_privilege('gradebook_app',p.oid,'EXECUTE')
    ORDER BY p.proname
  `);
  expect(functions.map((row) => row.function_name)).toEqual([
    'complete_year_reset_v1',
    'consume_year_reset_v1',
    'ensure_year_coordination_v1',
    'inspect_year_reset_guard_v1',
    'prepare_year_reset_v1',
    'record_gradebook_change_v1',
    'synchronize_gradebook_profiles_v1',
  ]);

  const tableGrants = await owner.unsafe<{ count: number }[]>(`
    SELECT count(*)::integer AS count
    FROM information_schema.tables
    WHERE table_schema='student_portal'
      AND (
        has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'SELECT')
        OR has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'INSERT')
        OR has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'UPDATE')
        OR has_table_privilege('gradebook_app', format('%I.%I',table_schema,table_name), 'DELETE')
      )
  `);
  expect(tableGrants).toEqual([{ count: 0 }]);
});

it.each([
  ['anon', () => anonymous],
  ['authenticated', () => authenticated],
] as const)('keeps %s outside the private Portal schema', async (role, client) => {
  await expect(client().unsafe('SELECT * FROM student_portal.account')).rejects.toMatchObject({
    code: '42501',
  });

  expect(
    await owner.unsafe(
      `SELECT has_schema_privilege($1,'student_portal','USAGE') AS usage,
              has_table_privilege($1,'student_portal.account','SELECT') AS account_select`,
      [role],
    ),
  ).toEqual([{ usage: false, account_select: false }]);
});

it('leaves service_role without direct private-schema grants', async () => {
  expect(
    await owner.unsafe(`
      SELECT has_schema_privilege('service_role','student_portal','USAGE') AS usage,
             has_table_privilege('service_role','student_portal.account','SELECT') AS account_select
    `),
  ).toEqual([{ usage: false, account_select: false }]);
});
