import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readHealthReviewV1 } from '../../../server/student-portal/observability/health-review-v1';
import {
  isHealthReviewV1,
  reviewTotalsV1,
  HEALTH_REVIEW_BYTES_V1,
} from '../../../shared/health-review-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://missing.invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Review tests require disposable local PostgreSQL.');
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12),
  databaseName = 'review1097_' + suffix,
  role = 'review1097_owner_' + suffix;
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
let owner: ReturnType<typeof postgres>, portal: ReturnType<typeof postgres>;
let created = false,
  roleCreated = false;
function connect() {
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  const sql = postgres(url.toString(), {
    max: 1,
    fetch_types: false,
    prepare: true,
    onnotice: () => undefined,
  });
  clients.push(sql);
  return sql;
}
beforeAll(async () => {
  await cluster.unsafe(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='student_portal_app') THEN CREATE ROLE student_portal_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$",
  );
  await cluster.unsafe('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
  roleCreated = true;
  await cluster.unsafe('CREATE DATABASE ' + databaseName + ' OWNER ' + role);
  created = true;
  owner = connect();
  await owner.unsafe('SET ROLE ' + role);
  for (const name of ['0001_portal_health_history_v1.sql', '0002_portal_signals_v1.sql'])
    await owner.unsafe(readFileSync('migrations/observability/' + name, 'utf8'), [], {
      prepare: false,
    });
  await owner.unsafe(
    "CREATE TABLE public.private_probe(value text); INSERT INTO public.private_probe VALUES ('SYNTHETIC-PRIVATE')",
    [],
    { prepare: false },
  );
  portal = connect();
  await portal.unsafe('SET ROLE student_portal_app');
}, 30_000);
beforeEach(async () => {
  await owner.unsafe('DELETE FROM system_health.portal_sample_v1');
  await owner.unsafe('DELETE FROM system_health.portal_signal_v1');
});
afterAll(async () => {
  await Promise.all(clients.map((sql) => sql.end({ timeout: 2 })));
  if (created) await cluster.unsafe('DROP DATABASE ' + databaseName);
  if (roleCreated) await cluster.unsafe('DROP ROLE ' + role);
  await cluster.end({ timeout: 2 });
});
const read = () => readHealthReviewV1(portal as unknown as StudentPortalPostgresSqlV1);
async function seed() {
  await owner.unsafe(`INSERT INTO system_health.portal_sample_v1
    (bucket_at,observed_at,serving_enabled,credentials_configured,maintenance_state,publication_due,live_pending,waiting_connections,read_duration_ms)
    SELECT t,t+interval '1 second',true,true,CASE WHEN n=3 THEN 'intervention' ELSE 'normal' END,0,0,0,10
    FROM (SELECT n,date_bin(interval '5 minutes',statement_timestamp(),timestamptz '2000-01-01')-n*interval '5 minutes' AS t
      FROM (VALUES (2),(3),(400)) v(n)) q`);
  await owner.unsafe(`INSERT INTO system_health.portal_signal_v1 (bucket_at,source,outcome,samples,total_ms,max_ms,slow,capped)
    SELECT date_bin(interval '5 minutes',statement_timestamp(),timestamptz '2000-01-01')-n*interval '5 minutes',
      'login','failed',2,8000,4000,2,false FROM (VALUES (2),(3),(400)) v(n)`);
  await owner.unsafe(`INSERT INTO system_health.portal_signal_v1 (bucket_at,source,outcome,samples,total_ms,max_ms,slow,capped)
    VALUES (date_bin(interval '5 minutes',statement_timestamp(),timestamptz '2000-01-01')-interval '10 minutes',
      'browser-render','failed',1,0,0,0,false)`);
}
it('reads operational tables through the restricted role and cannot read private data', async () => {
  await seed();
  const data = await read();
  expect(isHealthReviewV1(data)).toBe(true);
  expect(data.state).toBe('ok');
  expect(reviewTotalsV1(data)).toMatchObject({
    samples: 2,
    missing: 286,
    critical: 1,
    recovered: 1,
    failed: 4,
    browser: 1,
    slow: 4,
  });
  expect(data.operations).toHaveLength(2);
  expect(data.hours).toHaveLength(24);
  expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThan(
    HEALTH_REVIEW_BYTES_V1,
  );
  expect(JSON.stringify(data)).not.toMatch(
    /SYNTHETIC-PRIVATE|private_probe|review1097|student_portal_app/u,
  );
  await expect(portal.unsafe('SELECT * FROM public.private_probe')).rejects.toMatchObject({
    code: '42501',
  });
  const counts = await owner.unsafe(
    'SELECT (SELECT count(*) FROM system_health.portal_sample_v1)::integer AS history,(SELECT count(*) FROM system_health.portal_signal_v1)::integer AS signals',
  );
  expect(counts[0]).toMatchObject({ history: 3, signals: 4 });
});
it('does not fabricate history when storage is empty and distinguishes missing configuration', async () => {
  expect(reviewTotalsV1(await read())).toMatchObject({ samples: 0, missing: 288, failed: 0 });
  await owner.unsafe('ALTER TABLE system_health.portal_signal_v1 RENAME TO hidden_signal_v1');
  try {
    expect((await read()).state).toBe('unconfigured');
  } finally {
    await owner.unsafe('ALTER TABLE system_health.hidden_signal_v1 RENAME TO portal_signal_v1');
  }
});
it('does not change existing data or remove expired rows as a side effect of reading', async () => {
  await seed();
  const before = await owner.unsafe(
    'SELECT count(*)::integer AS n FROM system_health.portal_sample_v1',
  );
  await read();
  await read();
  expect(
    await owner.unsafe('SELECT count(*)::integer AS n FROM system_health.portal_sample_v1'),
  ).toEqual(before);
  expect((await owner.unsafe('SELECT value FROM public.private_probe'))[0]?.value).toBe(
    'SYNTHETIC-PRIVATE',
  );
});
