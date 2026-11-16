import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  cleanupPortalHistoryV1,
  readPortalHistoryV1,
  recordPortalHistoryV1,
} from '../../../server/student-portal/observability/health-history-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { historyMaintenanceV1 } from '../../observability/history-fixtures-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://missing.invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('History tests require disposable local PostgreSQL.');
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = 'health1091_' + suffix;
const ownerRole = 'health1091_owner_' + suffix;
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
let owner: ReturnType<typeof postgres>;
let portal: ReturnType<typeof postgres>;
let second: ReturnType<typeof postgres>;
let created = false,
  roleCreated = false;
function connect() {
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  clients.push(sql);
  return sql;
}
const adapter = (sql: ReturnType<typeof postgres>) => sql as unknown as StudentPortalPostgresSqlV1;
const config = { servingEnabled: true, credentialsConfigured: true };
const insert = `INSERT INTO system_health.portal_sample_v1
  (bucket_at, observed_at, serving_enabled, credentials_configured, maintenance_state,
   publication_due, live_pending, waiting_connections, read_duration_ms)`;
beforeAll(async () => {
  await cluster.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='student_portal_app') THEN CREATE ROLE student_portal_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gradebook_app') THEN CREATE ROLE gradebook_app NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$;`);
  await cluster.unsafe('CREATE ROLE ' + ownerRole + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
  roleCreated = true;
  await cluster.unsafe('CREATE DATABASE ' + databaseName + ' OWNER ' + ownerRole);
  created = true;
  owner = connect();
  await owner.unsafe('SET ROLE ' + ownerRole);
  // Reproduce overly broad owner defaults; the migration must replace, not inherit, these grants.
  await owner.unsafe(
    'ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO student_portal_app, anon, authenticated, service_role, gradebook_app',
  );
  await owner.unsafe(
    readFileSync('migrations/observability/0001_portal_health_history_v1.sql', 'utf8'),
    [],
    { prepare: false },
  );
  portal = connect();
  second = connect();
  await portal.unsafe('SET ROLE student_portal_app');
  await second.unsafe('SET ROLE student_portal_app');
}, 30_000);
beforeEach(async () => {
  await owner.unsafe('DELETE FROM system_health.portal_sample_v1');
});
afterAll(async () => {
  await Promise.all(clients.map((sql) => sql.end({ timeout: 2 })));
  if (created) await cluster.unsafe('DROP DATABASE ' + databaseName);
  if (roleCreated) await cluster.unsafe('DROP ROLE ' + ownerRole);
  await cluster.end({ timeout: 2 });
});
it('applies as a non-superuser and isolates API/academic roles without timestamp or update privileges', async () => {
  const rows = await owner.unsafe(`SELECT r.rolname,
    has_table_privilege(r.rolname,'system_health.portal_sample_v1','SELECT') AS can_read,
    has_table_privilege(r.rolname,'system_health.portal_sample_v1','UPDATE') AS can_update,
    has_column_privilege(r.rolname,'system_health.portal_sample_v1','observed_at','INSERT') AS can_set_time
    FROM pg_roles r WHERE r.rolname IN ('student_portal_app','anon','authenticated','service_role','gradebook_app')`);
  for (const row of rows) {
    expect(row.can_read).toBe(row.rolname === 'student_portal_app');
    expect(row.can_update).toBe(false);
    expect(row.can_set_time).toBe(false);
  }
  const rls = await owner.unsafe(
    "SELECT relrowsecurity FROM pg_class WHERE oid='system_health.portal_sample_v1'::regclass",
  );
  expect(rls[0]?.relrowsecurity).toBe(true);
  await expect(
    portal.unsafe('UPDATE system_health.portal_sample_v1 SET read_duration_ms=0'),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    portal.unsafe(`${insert} VALUES (now(),now(),true,true,'normal',0,0,0,0)`),
  ).rejects.toMatchObject({ code: '42501' });
  const unauthorized = connect();
  await unauthorized.unsafe('SET ROLE anon');
  await expect(
    unauthorized.unsafe('SELECT * FROM system_health.portal_sample_v1'),
  ).rejects.toMatchObject({ code: '42501' });
});
it('records at most one sample across concurrent collectors and replays', async () => {
  const collect = (sql: ReturnType<typeof postgres>) =>
    recordPortalHistoryV1(adapter(sql), config, async () => historyMaintenanceV1());
  await Promise.all([collect(portal), collect(second)]);
  await collect(portal);
  const data = await readPortalHistoryV1(adapter(portal), null);
  expect(data.points).toHaveLength(1);
  expect(data.points[0]).toMatchObject({
    servingEnabled: true,
    publicationDue: 0,
    livePending: 0,
    maintenanceState: 'normal',
  });
});
it('does not store an unvalidated maintenance payload', async () => {
  await expect(
    recordPortalHistoryV1(adapter(portal), config, async () => ({
      ...historyMaintenanceV1(),
      name: 'synthetic-private',
    })),
  ).rejects.toThrow('health-history-unavailable');
  expect((await readPortalHistoryV1(adapter(portal), null)).points).toEqual([]);
});
it('excludes the exact expired boundary, older records and future samples independently of cleanup', async () => {
  await owner.unsafe(`${insert}
    SELECT date_bin(interval '5 minutes', t, timestamptz '2000-01-01 00:00:00+00'), t, true,true,'normal',0,0,0,1
    FROM (VALUES (statement_timestamp()-interval '720 hours'),
      (statement_timestamp()-interval '721 hours'), (statement_timestamp()+interval '1 hour'),
      (statement_timestamp()-interval '719 hours')) AS samples(t)`);
  const data = await readPortalHistoryV1(adapter(portal), null);
  expect(data.points).toHaveLength(1);
  await cleanupPortalHistoryV1(adapter(portal));
  expect(
    (await owner.unsafe('SELECT count(*)::integer AS n FROM system_health.portal_sample_v1'))[0]?.n,
  ).toBe(2);
});
it('deletes in bounded, idempotent batches and keeps deletion committed when collection fails', async () => {
  await owner.unsafe(`${insert}
    SELECT date_bin(interval '5 minutes', statement_timestamp()-interval '721 hours', timestamptz '2000-01-01 00:00:00+00') - n*interval '5 minutes',
      date_bin(interval '5 minutes', statement_timestamp()-interval '721 hours', timestamptz '2000-01-01 00:00:00+00') - n*interval '5 minutes',
      true,true,'normal',0,0,0,1 FROM generate_series(1,501) AS q(n)`);
  await cleanupPortalHistoryV1(adapter(portal));
  expect(
    (await owner.unsafe('SELECT count(*)::integer AS n FROM system_health.portal_sample_v1'))[0]?.n,
  ).toBe(1);
  await expect(
    recordPortalHistoryV1(adapter(portal), config, async () => {
      throw new Error('synthetic failure');
    }),
  ).rejects.toThrow();
  expect((await readPortalHistoryV1(adapter(portal), null)).points).toEqual([]);
  await cleanupPortalHistoryV1(adapter(portal));
  await cleanupPortalHistoryV1(adapter(portal));
  expect(
    (await owner.unsafe('SELECT count(*)::integer AS n FROM system_health.portal_sample_v1'))[0]?.n,
  ).toBe(0);
});
it('paginates a fixed maximum without duplication or accepting arbitrary filters', async () => {
  await owner.unsafe(`${insert}
    SELECT date_bin(interval '5 minutes', statement_timestamp(), timestamptz '2000-01-01 00:00:00+00') - n*interval '5 minutes',
      date_bin(interval '5 minutes', statement_timestamp(), timestamptz '2000-01-01 00:00:00+00') - n*interval '5 minutes',
      true,true,'normal',0,0,0,1 FROM generate_series(1,52) AS q(n)`);
  const first = await readPortalHistoryV1(adapter(portal), null);
  const next = await readPortalHistoryV1(adapter(portal), first.nextBefore);
  expect(first.points).toHaveLength(48);
  expect(next.points).toHaveLength(4);
  expect(next.nextBefore).toBeNull();
  expect(new Set([...first.points, ...next.points].map((point) => point.bucketAt)).size).toBe(52);
  await expect(readPortalHistoryV1(adapter(portal), 'invalid')).rejects.toThrow(
    'health-history-invalid-request',
  );
});
