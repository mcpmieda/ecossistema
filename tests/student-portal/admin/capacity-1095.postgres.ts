import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readPortalCapacityV1 } from '../../../server/student-portal/observability/capacity-v1';
import { isPortalCapacitySampleV1 } from '../../../shared/portal-capacity-v1';
import { withPortalSqlV1 } from '../../../server/student-portal/runtime/database-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://missing.invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Capacity tests require disposable local PostgreSQL.');
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = 'capacity1095_' + suffix,
  role = 'capacity1095_app_' + suffix;
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
let owner: ReturnType<typeof postgres>,
  portal: ReturnType<typeof postgres>,
  second: ReturnType<typeof postgres>;
let created = false,
  roleCreated = false;
function connection(runtime = false) {
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  if (runtime) {
    url.username = role;
    url.password = 'synthetic-local-trust-only';
  }
  return url.toString();
}
function connect(runtime = false) {
  const sql = postgres(connection(runtime), {
    max: 1,
    prepare: true,
    fetch_types: false,
    onnotice: () => undefined,
  });
  clients.push(sql);
  return sql;
}
const adapter = () => portal as unknown as StudentPortalPostgresSqlV1;
beforeAll(async () => {
  await cluster.unsafe(
    'CREATE ROLE ' +
      role +
      ' LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOBYPASSRLS CONNECTION LIMIT 3',
  );
  roleCreated = true;
  await cluster.unsafe('CREATE DATABASE ' + databaseName);
  created = true;
  owner = connect();
  await owner.unsafe('REVOKE ALL ON DATABASE ' + databaseName + ' FROM PUBLIC');
  await owner.unsafe('GRANT CONNECT ON DATABASE ' + databaseName + ' TO ' + role);
  await owner.unsafe('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await owner.unsafe(
    "CREATE TABLE public.private_probe (value text); INSERT INTO public.private_probe VALUES ('SYNTHETIC-PRIVATE')",
    [],
    { prepare: false },
  );
  portal = connect(true);
  second = connect(true);
}, 30_000);
afterAll(async () => {
  await Promise.all(clients.map((sql) => sql.end({ timeout: 2 })));
  if (created) await cluster.unsafe('DROP DATABASE ' + databaseName);
  if (roleCreated) await cluster.unsafe('DROP ROLE ' + role);
  await cluster.end({ timeout: 2 });
});
it('reads real database size and role limits using CONNECT only, with production driver serialization', async () => {
  const sample = await readPortalCapacityV1(adapter());
  expect(isPortalCapacitySampleV1(sample)).toBe(true);
  expect(sample.state).toBe('ok');
  expect(sample.metrics!.databaseBytes).toBeGreaterThan(0);
  expect(sample.metrics!.portalConnectionLimit).toBe(3);
  expect(sample.metrics!.portalConnections).toBeGreaterThanOrEqual(1);
  expect(sample.metrics!.portalActive).toBeGreaterThanOrEqual(1);
  expect(Date.parse(sample.observedAt)).toBeGreaterThan(Date.now() - 10_000);
  for (const privateValue of [databaseName, role, 'SYNTHETIC-PRIVATE', '127.0.0.1'])
    expect(JSON.stringify(sample)).not.toContain(privateValue);
  const permissions = await portal.unsafe(
    'SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user',
  );
  expect(permissions[0]).toMatchObject({
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
  });
  await expect(portal.unsafe('SELECT * FROM public.private_probe')).rejects.toMatchObject({
    code: '42501',
  });
  await expect(portal.unsafe('CREATE TABLE public.forbidden (id integer)')).rejects.toMatchObject({
    code: '42501',
  });
});
it('counts an actual lock wait separately without mistaking it for an extra connection', async () => {
  await owner.unsafe('SELECT pg_advisory_lock(1095,1)');
  const blocked = second.unsafe('SELECT pg_advisory_lock(1095,1)').then(() => undefined);
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await owner.unsafe(
        "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
        [role],
      );
      if (rows[0]?.n === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const sample = await readPortalCapacityV1(adapter());
    expect(sample.metrics!.portalConnections).toBe(2);
    expect(sample.metrics!.portalWaiting).toBe(1);
    expect(sample.metrics!.portalActive).toBeGreaterThanOrEqual(1);
  } finally {
    await owner.unsafe('SELECT pg_advisory_unlock(1095,1)');
    await blocked;
    await second.unsafe('SELECT pg_advisory_unlock(1095,1)');
  }
});
it('does not mutate private data and keeps the production factory role gate intact', async () => {
  const before = await owner.unsafe('SELECT value FROM public.private_probe');
  await readPortalCapacityV1(adapter());
  expect(await owner.unsafe('SELECT value FROM public.private_probe')).toEqual(before);
  let called = false;
  await expect(
    withPortalSqlV1({ connectionString: connection(true) }, async () => {
      called = true;
    }),
  ).rejects.toThrow('student-portal-database-unavailable');
  expect(called).toBe(false);
});
