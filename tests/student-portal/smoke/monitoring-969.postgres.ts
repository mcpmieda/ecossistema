import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  isPortalMonitorSampleV1,
  type PortalMonitorSampleV1,
} from '../../../shared/system-health-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';

// This suite owns its disposable database; no existing schema or production fallback is used.
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Monitoring #969 requires disposable local PostgreSQL.');
const databaseName = 'portal969_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
const tenant = '96900000-0000-4000-8000-000000000001';
const account = '96900000-0000-4000-8000-000000000002';
let created = false;
let owner: ReturnType<typeof postgres>;
let portal: ReturnType<typeof postgres>;
let runtime: Miniflare;
let caller: Awaited<ReturnType<Miniflare['getWorker']>>;

function connection(role?: string) {
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  if (role) {
    url.username = role;
    url.password = 'synthetic-local-trust-only';
  }
  return url.toString();
}
function client(role?: string) {
  const sql = postgres(connection(role), { max: 1, onnotice: () => undefined });
  clients.push(sql);
  return sql;
}
function context() {
  return {
    actorId: account,
    tenantId: tenant,
    requestId: crypto.randomUUID(),
    authenticatedAt: new Date().toISOString(),
    capability: 'platform.settings.read',
  };
}
async function call(binding = 'ADMIN', authority: unknown = context()) {
  return caller.fetch('http://monitoring-harness.invalid/', {
    method: 'POST',
    body: JSON.stringify({ binding, context: authority }),
  });
}
async function sample(binding = 'ADMIN'): Promise<PortalMonitorSampleV1> {
  const response = await call(binding);
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  if (!isPortalMonitorSampleV1(value)) throw new Error('Invalid aggregate monitoring sample.');
  return value;
}
async function persistedState() {
  const state: Record<string, unknown> = {};
  for (const table of ['audit_event', 'publication_job', 'live_event_outbox_v1', 'account']) {
    state[table] = await owner.unsafe(
      `SELECT to_jsonb(t) AS row FROM student_portal.${table} t ORDER BY to_jsonb(t)::text`,
    );
  }
  state.academic = await owner.unsafe(
    'SELECT to_jsonb(t) AS row FROM gradebook.aluno t ORDER BY id',
  );
  return state;
}

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + databaseName);
  created = true;
  owner = client();
  const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });
  await exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  // Match the native suite when this smoke is the first test on a fresh cluster.
  // The shared schema helper otherwise creates a NOLOGIN role that outlives this database.
  await exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gradebook_app') THEN
      CREATE ROLE gradebook_app LOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;`);
  await installResetSchemaFixtureV1({ exec });
  for (const migration of [
    '0008_atomic_publication_v2.sql',
    '0009_publication_cutover_guard_v2.sql',
    '0010_incremental_publication_v3.sql',
    '0011_live_event_outbox_v1.sql',
  ])
    await exec(readFileSync('migrations/student-portal/' + migration, 'utf8'));
  await exec(
    readFileSync('migrations/gradebook-simplified/0009_granular_observations_names_v1.sql', 'utf8'),
  );
  for (const migration of [
    '0012_granular_observations_names_v1.sql',
    '0013_publication_inheritance_v1.sql',
    '0015_student_portal_rls_v1.sql',
    '0016_audit_entities_v1.sql',
    '0017_security_event_priority_v1.sql',
  ])
    await exec(readFileSync('migrations/student-portal/' + migration, 'utf8'));
  await exec(
    'UPDATE student_portal.publication_control_v2 SET enabled=true WHERE academic_year=2026',
  );
  await exec(
    readFileSync('migrations/student-portal/0019_remove_legacy_projection_v1.sql', 'utf8'),
  );
  await exec(
    'UPDATE student_portal.publication_control_v2 SET enabled=false WHERE academic_year=2026',
  );
  await exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES(969001,2026,'SYNTHETIC MONITORING ACCOUNT');
    INSERT INTO student_portal.account(id,academic_year,gradebook_student_id,auth_state,eligibility)
      VALUES('${account}',2026,969001,'pending-activation','eligible');
    INSERT INTO student_portal.audit_event(event_id,occurred_at,actor_id,scope_json,kind,result,request_id,version,raw_ip,ip_expires_at)
      VALUES(gen_random_uuid(),statement_timestamp()-interval '1 day','${account}','{}','login','success',gen_random_uuid(),0,
        '192.0.2.69',statement_timestamp()-interval '1 minute'),
      (gen_random_uuid(),statement_timestamp()-interval '13 months','${account}','{}','login','success',gen_random_uuid(),0,NULL,NULL);
    INSERT INTO student_portal.publication_job(id,account_id,data_version,policy_version,publication_version,state,attempts,next_attempt_at)
      VALUES(gen_random_uuid(),'${account}','synthetic:1','policy:1','publication:1','queued',0,statement_timestamp()-interval '6 minutes'),
      (gen_random_uuid(),'${account}','synthetic:2','policy:1','publication:1','queued',0,statement_timestamp()+interval '1 hour'),
      (gen_random_uuid(),'${account}','synthetic:3','policy:1','publication:1','failed',5,statement_timestamp()-interval '1 hour');
    INSERT INTO student_portal.live_event_outbox_v1(source_event_id,audience,domain,version,account_id,occurred_at,next_attempt_at,attempts,delivered_at)
      VALUES(gen_random_uuid(),'admin','portal','synthetic:live:1','${account}',statement_timestamp(),statement_timestamp()-interval '6 minutes',2,NULL),
      (gen_random_uuid(),'student','portal','synthetic:live:2','${account}',statement_timestamp(),statement_timestamp(),0,NULL),
      (gen_random_uuid(),'admin','portal','synthetic:live:3','${account}',statement_timestamp(),statement_timestamp(),0,statement_timestamp());

    -- Test-only restrictive read policy observes settings in the actual Workerd SQL transaction.
    CREATE FUNCTION student_portal.assert_monitoring_transaction_969() RETURNS boolean
    LANGUAGE plpgsql AS $$ BEGIN
      IF current_user <> 'student_portal_app'
        OR current_setting('transaction_read_only') <> 'on'
        OR current_setting('transaction_isolation') <> 'repeatable read'
        OR current_setting('statement_timeout') <> '1500ms'
        OR current_setting('lock_timeout') <> '250ms' THEN
        RAISE EXCEPTION 'synthetic-monitoring-transaction-guard';
      END IF;
      RETURN true;
    END $$;
    REVOKE ALL ON FUNCTION student_portal.assert_monitoring_transaction_969() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION student_portal.assert_monitoring_transaction_969() TO student_portal_app;
    CREATE POLICY monitoring_transaction_969 ON student_portal.audit_event AS RESTRICTIVE
      FOR SELECT TO student_portal_app USING (student_portal.assert_monitoring_transaction_969());
  `);
  portal = client('student_portal_app');
  const config = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
  const keys = JSON.stringify({ 1: Buffer.alloc(32, 69).toString('base64') });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        ...['portal', 'wrong-role', 'disabled', 'preview'].map((name) => ({
          name,
          modules: true,
          scriptPath: 'node_modules/.cache/student-portal/index.js',
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          hyperdrives: {
            PORTAL_DB: connection(name === 'wrong-role' ? 'gradebook_app' : 'student_portal_app'),
          },
          bindings: {
            PORTAL_ENVIRONMENT: name === 'preview' ? 'preview' : 'production',
            PORTAL_ORIGIN: 'https://aluno.escolaieda.com',
            PORTAL_ADMIN_TENANT_ID: tenant,
            PORTAL_SERVING_ENABLED: name === 'disabled' ? 'false' : 'true',
            ...(name === 'disabled' ? {} : { PASSWORD_PEPPER: keys, QR_HMAC_KEYS: keys }),
          },
        })),
        {
          name: 'caller',
          modules: true,
          compatibilityDate: config.compatibility_date,
          serviceBindings: {
            ADMIN: { name: 'portal', entrypoint: 'PortalAdminEntrypoint' },
            SELF: { name: 'portal', entrypoint: 'PortalSelfEntrypoint' },
            DEFAULT: 'portal',
            WRONG_ROLE: { name: 'wrong-role', entrypoint: 'PortalAdminEntrypoint' },
            DISABLED: { name: 'disabled', entrypoint: 'PortalAdminEntrypoint' },
            PREVIEW: { name: 'preview', entrypoint: 'PortalAdminEntrypoint' },
          },
          script: `export default { async fetch(request, env) {
        const input = await request.json();
        try { return Response.json(await env[input.binding].monitoring(input.context)); }
        catch { return Response.json({ state: 'denied' }, { status: 403 }); }
      } }`,
        },
      ],
    }),
  );
  caller = await runtime.getWorker('caller');
});
afterAll(async () => {
  await runtime?.dispose();
  for (const sql of clients) await sql.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + databaseName);
  await cluster.end({ timeout: 2 });
});

it('reads bounded aggregates through private Workerd RPC, restricted role and a real read-only transaction', async () => {
  // The policy must actively reject a read outside the required monitoring transaction.
  await expect(portal.unsafe('SELECT * FROM student_portal.audit_event')).rejects.toThrow(
    'synthetic-monitoring-transaction-guard',
  );
  await expect(portal.unsafe('SELECT * FROM gradebook.aluno')).rejects.toThrow();
  const before = await persistedState();
  const result = await sample();
  expect(result).toMatchObject({
    servingEnabled: true,
    credentialsConfigured: true,
    database: 'ok',
    maintenance: {
      status: 'intervention',
      liveOutboxAvailable: true,
      expiredIp: 1,
      expiredAudit: 1,
      publicationDue: 1,
      backlog: true,
      exhausted: true,
      livePending: 2,
      liveRetrying: 1,
      liveBacklog: true,
    },
  });
  expect(result.maintenance!.oldestPublicationDueMs).toBeGreaterThanOrEqual(360_000);
  expect(result.maintenance!.oldestLiveDueMs).toBeGreaterThanOrEqual(360_000);
  expect(await persistedState()).toEqual(before);
  const json = JSON.stringify(result);
  for (const secret of [
    account,
    tenant,
    '192.0.2.69',
    'SYNTHETIC',
    'synthetic:',
    'postgres:',
    'SELECT',
  ])
    expect(json).not.toContain(secret);
});

it('caps a real live backlog without processing or deleting pending records', async () => {
  await owner.unsafe(`INSERT INTO student_portal.live_event_outbox_v1(source_event_id,audience,domain,version,occurred_at)
    SELECT gen_random_uuid(),'admin','portal','synthetic:cap',statement_timestamp() FROM generate_series(1,1005)`);
  try {
    expect((await sample()).maintenance?.livePending).toBe(1001);
    const count = await owner.unsafe(
      "SELECT count(*)::integer AS n FROM student_portal.live_event_outbox_v1 WHERE version='synthetic:cap'",
    );
    expect(count[0]?.n).toBe(1005);
  } finally {
    await owner.unsafe(
      "DELETE FROM student_portal.live_event_outbox_v1 WHERE version='synthetic:cap'",
    );
  }
});

it('reports an absent live outbox as unavailable coverage while keeping the database readable', async () => {
  await owner.unsafe(
    'ALTER TABLE student_portal.live_event_outbox_v1 RENAME TO monitoring_hidden_outbox_969',
  );
  try {
    expect(await sample()).toMatchObject({
      database: 'ok',
      maintenance: {
        liveOutboxAvailable: false,
        livePending: 0,
        liveRetrying: 0,
        liveBacklog: false,
      },
    });
  } finally {
    await owner.unsafe(
      'ALTER TABLE student_portal.monitoring_hidden_outbox_969 RENAME TO live_event_outbox_v1',
    );
  }
});

it('sanitizes a real SQL lock failure and recovers after the lock is released', async () => {
  await owner.begin(async (tx) => {
    await tx.unsafe('LOCK TABLE student_portal.audit_event IN ACCESS EXCLUSIVE MODE');
    const result = await sample();
    expect(result).toMatchObject({ database: 'unavailable', maintenance: null });
    expect(result.readDurationMs).toBeLessThan(5000);
    expect(JSON.stringify(result)).not.toMatch(/audit_event|lock timeout|55P03|postgres:/u);
  });
  expect((await sample()).database).toBe('ok');
});

it('refuses the Gradebook role instead of using it to read Portal data', async () => {
  const gradebook = client('gradebook_app');
  expect((await gradebook.unsafe('SELECT current_user AS role'))[0]?.role).toBe('gradebook_app');
  expect(await sample('WRONG_ROLE')).toMatchObject({ database: 'unavailable', maintenance: null });
});

it('still diagnoses the database when serving and credential configuration are disabled', async () => {
  expect(await sample('DISABLED')).toMatchObject({
    database: 'ok',
    servingEnabled: false,
    credentialsConfigured: false,
  });
});

it.each([
  {},
  { ...context(), tenantId: account },
  { ...context(), authenticatedAt: '2020-01-01T00:00:00.000Z' },
  { ...context(), authenticatedAt: '2099-01-01T00:00:00.000Z' },
  { ...context(), capability: 'student.read' },
  { ...context(), rawError: 'extra' },
])('rejects malformed or untrusted authority on the real named binding (%#)', async (authority) => {
  expect((await call('ADMIN', authority)).status).toBe(403);
});

it.each(['SELF', 'DEFAULT', 'PREVIEW'])(
  'keeps monitoring inaccessible through %s',
  async (binding) => {
    expect((await call(binding)).status).toBe(403);
  },
);
