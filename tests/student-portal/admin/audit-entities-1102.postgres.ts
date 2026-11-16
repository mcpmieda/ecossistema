import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ACADEMIC_FIXTURE_SQL_V1 } from '../academic/academic-fixture-v1';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresSqlV1,
} from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { withAuditSqlV1 } from '../../../server/student-portal/observability/audit-context-v1';
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Audit tests require disposable local PostgreSQL');
const name = 'portal1102_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
let owner: ReturnType<typeof postgres>;
let sql: StudentPortalPostgresSqlV1;
let account: string;
let created = false;
const actor = '11111111-1111-4111-8111-111111111111';
const event = () =>
  ({
    eventId: crypto.randomUUID(),
    at: new Date().toISOString(),
    actorId: actor,
    accountId: account,
    scope: { kind: 'account', academicYear: 2026, accountId: account },
    kind: 'settings-changed',
    result: 'success',
    requestId: crypto.randomUUID(),
    version: 1,
    maskedIp: null,
  }) as const;
const acl = () =>
  owner.unsafe(
    "SELECT relname,relacl::text,relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='student_portal' AND c.relkind='r' ORDER BY relname",
  );
beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name);
  created = true;
  const url = new URL(target);
  url.pathname = '/' + name;
  owner = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  const exec = (q: string) => owner.unsafe(q, [], { prepare: false });
  await exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await exec(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gradebook_app') THEN CREATE ROLE gradebook_app LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$",
  );
  await exec(
    'ALTER TABLE gradebook.fechamento ADD COLUMN IF NOT EXISTS rec_rr_mask SMALLINT NOT NULL DEFAULT 0',
  );
  for (const file of readdirSync('migrations/student-portal')
    .filter((f) => /^00(?:0[1-9]|1[0-5])_/.test(f))
    .sort()) {
    if (file.startsWith('0012_'))
      await exec(
        readFileSync(
          'migrations/gradebook-simplified/0009_granular_observations_names_v1.sql',
          'utf8',
        ),
      );
    await exec(readFileSync('migrations/student-portal/' + file, 'utf8'));
  }
  await exec(ACADEMIC_FIXTURE_SQL_V1);
  account = (
    await owner.unsafe('SELECT id FROM student_portal.account WHERE gradebook_student_id=910001')
  )[0]!.id;
  const before = await acl();
  await exec(readFileSync('migrations/student-portal/0016_audit_entities_v1.sql', 'utf8'));
  expect(await acl()).toEqual(before);
  const raw = owner as unknown as StudentPortalPostgresSqlV1;
  sql = {
    unsafe: raw.unsafe.bind(raw),
    begin: (op) =>
      raw.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE student_portal_app');
        return op(tx);
      }),
  };
}, 30_000);
afterAll(async () => {
  await owner?.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + name);
  await cluster.end({ timeout: 2 });
});
it('runs the invoker trigger through the restricted role under RLS and keeps pool context isolated', async () => {
  const value = event();
  await new StudentPortalPostgresPersistenceV1(
    withAuditSqlV1(sql, '192.0.2.2', { actorId: actor, actorName: 'SYNTHETIC NATIVE OPERATOR' }),
  ).transaction((tx) => tx.appendAudit(value));
  expect(
    (
      await owner.unsafe(
        'SELECT actor_name,subject_name,subject_class_id FROM student_portal.audit_event WHERE event_id=$1',
        [value.eventId],
      )
    )[0],
  ).toEqual({
    actor_name: 'SYNTHETIC NATIVE OPERATOR',
    subject_name: 'SYNTHETIC ACADEMIC ONE',
    subject_class_id: 910001,
  });
  const clean = event();
  await new StudentPortalPostgresPersistenceV1(withAuditSqlV1(sql, null)).transaction((tx) =>
    tx.appendAudit(clean),
  );
  expect(
    (
      await owner.unsafe(
        'SELECT actor_name,raw_ip FROM student_portal.audit_event WHERE event_id=$1',
        [clean.eventId],
      )
    )[0],
  ).toEqual({ actor_name: null, raw_ip: null });
  const failed = event();
  await expect(
    new StudentPortalPostgresPersistenceV1(
      withAuditSqlV1(sql, '192.0.2.9', { actorId: actor, actorName: 'SYNTHETIC ROLLBACK' }),
    ).transaction(async (tx) => {
      await tx.appendAudit(failed);
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(
    await owner.unsafe('SELECT event_id FROM student_portal.audit_event WHERE event_id=$1', [
      failed.eventId,
    ]),
  ).toHaveLength(0);
});
it('does not grant audit access or trigger execution to the academic role', async () => {
  expect(
    (
      await owner.unsafe(
        "SELECT has_table_privilege('gradebook_app','student_portal.audit_event','SELECT') AS read, has_function_privilege('gradebook_app','student_portal.capture_audit_entities_v1()','EXECUTE') AS execute",
      )
    )[0],
  ).toEqual({ read: false, execute: false });
});
