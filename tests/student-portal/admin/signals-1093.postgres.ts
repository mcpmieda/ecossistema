import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  cleanupPortalSignalsV1,
  readPortalSignalsV1,
  savePortalSignalsV1,
} from '../../../server/student-portal/observability/signal-store-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://missing.invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Signals tests require disposable local PostgreSQL.');
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = 'signal1093_' + suffix,
  ownerRole = 'signal1093_owner_' + suffix;
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
let owner: ReturnType<typeof postgres>,
  portal: ReturnType<typeof postgres>,
  second: ReturnType<typeof postgres>;
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
const insert =
  'INSERT INTO system_health.portal_signal_v1 (bucket_at,source,outcome,samples,total_ms,max_ms,slow,capped)';
const batch = (samples = 2, capped = false) => ({
  version: 1,
  generatedAt: new Date().toISOString(),
  points: [
    {
      bucketAt: new Date(Math.floor((Date.now() - 300_000) / 300_000) * 300_000).toISOString(),
      source: 'login',
      outcome: 'ok',
      samples,
      totalMs: samples * 10,
      maxMs: 10,
      slow: 0,
      capped,
    },
  ],
});
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
  await owner.unsafe(
    'ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO student_portal_app,anon,authenticated,service_role,gradebook_app',
  );
  for (const name of ['0001_portal_health_history_v1.sql', '0002_portal_signals_v1.sql'])
    await owner.unsafe(readFileSync('migrations/observability/' + name, 'utf8'), [], {
      prepare: false,
    });
  portal = connect();
  second = connect();
  await portal.unsafe('SET ROLE student_portal_app');
  await second.unsafe('SET ROLE student_portal_app');
}, 30_000);
beforeEach(async () => {
  await owner.unsafe('DELETE FROM system_health.portal_signal_v1');
});
afterAll(async () => {
  await Promise.all(clients.map((sql) => sql.end({ timeout: 2 })));
  if (created) await cluster.unsafe('DROP DATABASE ' + databaseName);
  if (roleCreated) await cluster.unsafe('DROP ROLE ' + ownerRole);
  await cluster.end({ timeout: 2 });
});
it('runs as the existing backend role, rejects API roles and cannot update keys or recorded time', async () => {
  const rls = await owner.unsafe(
    "SELECT relrowsecurity FROM pg_class WHERE oid='system_health.portal_signal_v1'::regclass",
  );
  expect(rls[0]?.relrowsecurity).toBe(true);
  const grants =
    await owner.unsafe(`SELECT rolname,has_table_privilege(rolname,'system_health.portal_signal_v1','SELECT') AS can_read
    FROM pg_roles WHERE rolname IN ('student_portal_app','anon','authenticated','service_role','gradebook_app')`);
  for (const row of grants) expect(row.can_read).toBe(row.rolname === 'student_portal_app');
  await expect(
    portal.unsafe("UPDATE system_health.portal_signal_v1 SET source='profile'"),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    portal.unsafe('UPDATE system_health.portal_signal_v1 SET recorded_at=now()'),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(portal.unsafe('TRUNCATE system_health.portal_signal_v1')).rejects.toMatchObject({
    code: '42501',
  });
  const anonymous = connect();
  await anonymous.unsafe('SET ROLE anon');
  await expect(
    anonymous.unsafe('SELECT * FROM system_health.portal_signal_v1'),
  ).rejects.toMatchObject({ code: '42501' });
});
it('deduplicates concurrent snapshots and never decreases previously persisted counters', async () => {
  const first = batch();
  await Promise.all([
    savePortalSignalsV1(adapter(portal), first),
    savePortalSignalsV1(adapter(second), first),
  ]);
  await savePortalSignalsV1(adapter(portal), {
    ...first,
    points: [{ ...first.points[0]!, samples: 5, totalMs: 50 }],
  });
  await savePortalSignalsV1(adapter(portal), first);
  await savePortalSignalsV1(adapter(portal), {
    ...first,
    points: [{ ...first.points[0]!, samples: 5, totalMs: 50, capped: true }],
  });
  const data = await readPortalSignalsV1(adapter(portal), null);
  expect(data.points).toHaveLength(1);
  expect(data.points[0]).toMatchObject({ samples: 5, totalMs: 50, capped: true });
});
it('rejects malformed, stale and duplicate batches before writing, and never stores a browser identity', async () => {
  const good = batch();
  for (const input of [
    { ...good, raw: 'private' },
    { ...good, points: [good.points[0], good.points[0]] },
    { ...good, generatedAt: '2000-01-01T00:00:00.000Z' },
    { ...good, points: [{ ...good.points[0], name: 'private' }] },
  ])
    await expect(savePortalSignalsV1(adapter(portal), input)).rejects.toThrow();
  expect((await readPortalSignalsV1(adapter(portal), null)).points).toEqual([]);
  const goodBrowser = {
    ...good,
    points: [
      { ...good.points[0]!, source: 'browser-render', outcome: 'failed', maxMs: 0, totalMs: 0 },
    ],
  };
  await savePortalSignalsV1(adapter(portal), goodBrowser);
  expect((await readPortalSignalsV1(adapter(portal), null)).points[0]?.source).toBe(
    'browser-render',
  );
});
it('rejects arbitrary source text at the database boundary', async () => {
  await expect(
    portal.unsafe(
      `${insert} VALUES (date_bin(interval '5 minutes',now(),timestamptz '2000-01-01'),'SYNTHETIC-PRIVATE','failed',1,0,0,0,false)`,
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
it('uses exclusive pages of twelve windows, including multiple sources in the last window', async () => {
  await owner.unsafe(`${insert} SELECT date_bin(interval '5 minutes',statement_timestamp(),timestamptz '2000-01-01') - n*interval '5 minutes',
    s,'ok',1,10,10,0,false FROM generate_series(1,13) q(n) CROSS JOIN (VALUES ('login'),('profile')) sources(s)`);
  const first = await readPortalSignalsV1(adapter(portal), null),
    next = await readPortalSignalsV1(adapter(portal), first.nextBefore);
  expect(first.points).toHaveLength(24);
  expect(next.points).toHaveLength(2);
  expect(next.nextBefore).toBeNull();
  expect(new Set([...first.points, ...next.points].map((p) => p.bucketAt + p.source)).size).toBe(
    26,
  );
});
it('filters retention independently of cleanup and removes only 500 expired aggregates at once', async () => {
  await owner.unsafe(`${insert} SELECT date_bin(interval '5 minutes',statement_timestamp()-interval '721 hours',timestamptz '2000-01-01') - n*interval '5 minutes',
    'login','ok',1,10,10,0,false FROM generate_series(1,501) q(n)`);
  await savePortalSignalsV1(adapter(portal), batch());
  expect((await readPortalSignalsV1(adapter(portal), null)).points).toHaveLength(1);
  await cleanupPortalSignalsV1(adapter(portal));
  expect(
    (await owner.unsafe('SELECT count(*)::integer AS n FROM system_health.portal_signal_v1'))[0]?.n,
  ).toBe(2);
  await expect(savePortalSignalsV1(adapter(portal), { invalid: true })).rejects.toThrow();
  await cleanupPortalSignalsV1(adapter(portal));
  await cleanupPortalSignalsV1(adapter(portal));
  expect(
    (await owner.unsafe('SELECT count(*)::integer AS n FROM system_health.portal_signal_v1'))[0]?.n,
  ).toBe(1);
  expect(
    (await owner.unsafe('SELECT count(*)::integer AS n FROM system_health.portal_sample_v1'))[0]?.n,
  ).toBe(0);
});
