import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Security outbox tests require disposable local PostgreSQL');
const databaseName = 'portal1102_security_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
let owner: ReturnType<typeof postgres>;
let created = false;
interface Query {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ): Promise<{ rows: R[] }>;
}
let pg: Query & {
  exec(sql: string): Promise<unknown>;
  transaction<T>(run: (tx: Query) => Promise<T>): Promise<T>;
};
const actor = '11111111-1111-4111-8111-111111111111';
const acl = async () =>
  (
    await pg.query(
      "SELECT proname,proacl::text,prosecdef,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='student_portal' AND proname IN ('enqueue_revision_live_event_v1','enqueue_portal_live_event_v1') ORDER BY proname",
    )
  ).rows;
async function audit(kind: string, result = 'success') {
  const id = crypto.randomUUID();
  await pg.query(
    'INSERT INTO student_portal.audit_event(event_id,occurred_at,actor_id,scope_json,kind,result,request_id,version) VALUES ($1,statement_timestamp(),$2,\'{"kind":"school","academicYear":2026}\',$3,$4,$1,1)',
    [id, actor, kind, result],
  );
  return (
    await pg.query<{ security_relevant: boolean }>(
      'SELECT security_relevant FROM student_portal.live_event_outbox_v1 WHERE source_event_id=$1 ORDER BY audience',
      [id],
    )
  ).rows;
}
beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + databaseName);
  created = true;
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  owner = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  const query: Query['query'] = async <R extends Record<string, unknown>>(
    sql: string,
    args: unknown[] = [],
  ) => ({ rows: (await owner.unsafe(sql, args as never[])) as unknown as R[] });
  pg = {
    query,
    exec: (sql) => owner.unsafe(sql, [], { prepare: false }),
    transaction: (run) =>
      owner.begin(async (tx) =>
        run({
          query: async <R extends Record<string, unknown>>(sql: string, args: unknown[] = []) => ({
            rows: (await tx.unsafe(sql, args as never[])) as unknown as R[],
          }),
        }),
      ) as Promise<Awaited<ReturnType<typeof run>>>,
  };
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gradebook_app') THEN CREATE ROLE gradebook_app LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$",
  );
  await installResetSchemaFixtureV1(pg);
  await pg.exec(readFileSync('migrations/student-portal/0011_live_event_outbox_v1.sql', 'utf8'));
  await pg.query(
    'INSERT INTO student_portal.audit_event(event_id,occurred_at,actor_id,scope_json,kind,result,request_id,version) VALUES ($1,statement_timestamp(),$2,\'{"kind":"school","academicYear":2026}\',\'blocked\',\'success\',$1,1)',
    [crypto.randomUUID(), actor],
  );
  const before = await acl();
  await pg.exec(
    readFileSync('migrations/student-portal/0017_security_event_priority_v1.sql', 'utf8'),
  );
  expect(await acl()).toEqual(before);
}, 30_000);
afterAll(async () => {
  await owner?.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + databaseName);
  await cluster.end({ timeout: 2 });
});
it('keeps old pending entries non-priority and limits new priority to successful security operations', async () => {
  expect(
    (await pg.query('SELECT security_relevant FROM student_portal.live_event_outbox_v1')).rows,
  ).toEqual([{ security_relevant: false }, { security_relevant: false }]);
  for (const kind of [
    'activated',
    'password-reset',
    'account-reset',
    'qr-regenerated',
    'blocked',
    'unblocked',
    'session-revoked',
    'settings-changed',
    'links-closed',
  ]) {
    expect(await audit(kind)).toEqual([{ security_relevant: true }, { security_relevant: true }]);
    expect(await audit(kind, 'denied')).toEqual([
      { security_relevant: false },
      { security_relevant: false },
    ]);
  }
  for (const kind of [
    'qr-issued',
    'qr-reprinted',
    'birth-changed',
    'published',
    'unpublished',
    'projection-updated',
  ])
    expect(await audit(kind)).toEqual([{ security_relevant: false }, { security_relevant: false }]);
  expect(await audit('login')).toEqual([]);
});
it('rolls back notices with their source transaction and preserves function ACL', async () => {
  const before = (
    await pg.query('SELECT count(*)::integer AS count FROM student_portal.live_event_outbox_v1')
  ).rows;
  await expect(
    pg.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO student_portal.audit_event(event_id,occurred_at,actor_id,scope_json,kind,result,request_id,version) VALUES ($1,statement_timestamp(),$2,\'{"kind":"school","academicYear":2026}\',\'blocked\',\'success\',$1,1)',
        [crypto.randomUUID(), actor],
      );
      throw new Error('synthetic-rollback');
    }),
  ).rejects.toThrow('synthetic-rollback');
  expect(
    (await pg.query('SELECT count(*)::integer AS count FROM student_portal.live_event_outbox_v1'))
      .rows,
  ).toEqual(before);
  expect(
    (
      await pg.query(
        "SELECT has_function_privilege('gradebook_app','student_portal.enqueue_portal_live_event_v1()','EXECUTE') AS execute",
      )
    ).rows[0],
  ).toEqual({ execute: false });
});
it('classifies relation changes as security but academic marks only as academic notices', async () => {
  for (const [cause, expected] of [
    ['relation', true],
    ['academic-policy', true],
    ['marks', false],
    ['council', false],
  ] as const) {
    const id = crypto.randomUUID();
    await pg.query(
      'SELECT student_portal.record_gradebook_change_v1($1,2026::smallint,$2,true,ARRAY[910001],statement_timestamp())',
      [id, cause],
    );
    expect(
      (
        await pg.query(
          'SELECT security_relevant FROM student_portal.live_event_outbox_v1 WHERE source_event_id=$1 ORDER BY audience',
          [id],
        )
      ).rows,
    ).toEqual([{ security_relevant: expected }, { security_relevant: expected }]);
  }
});
