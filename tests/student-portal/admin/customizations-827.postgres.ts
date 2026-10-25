import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { inheritPublicationV1 } from '../../../server/student-portal/publication/publication-inheritance-v1';
import { readScopedSourcesV2 } from '../../../server/student-portal/publication/scoped-source-v2';
import { CUSTOM_ACCOUNT_V1 as account, customizationApiV1, installCustomizationFixtureV1,
  releaseCustomizationV1 as release, resetCustomizationFixtureV1 } from './customizations-fixture-827';
import { READ_ACTOR_V2, READ_CLASS_V2, READ_SCHOOL_V2, readContextV2 } from './read-fixture-v2';

// No production fallback. Only a disposable, uniquely named database on the test cluster.
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' || target.pathname !== '/portal705_test' || target.search || target.hash)
  throw new Error('Customization tests require the disposable local portal705_test cluster.');
const name = 'portal827_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
if (!/^portal827_[a-f0-9]{12}$/u.test(name)) throw new Error('Invalid disposable database name.');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
let owner: ReturnType<typeof postgres>, app: StudentPortalPostgresSqlV1, peer: StudentPortalPostgresSqlV1;
let created = false;
function connect(role?: string) {
  const url = new URL(target);
  url.pathname = '/' + name;
  if (role) url.username = role;
  const connection = postgres(url.toString(), { max: 1, onnotice: () => undefined,
    connection: { lock_timeout: 2000, statement_timeout: 10000 } });
  clients.push(connection);
  return connection;
}
beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name);
  created = true;
  owner = connect();
  await installCustomizationFixtureV1({ exec: (q) => owner.unsafe(q, [], { prepare: false }) }, owner as unknown as StudentPortalPostgresSqlV1);
  app = connect('student_portal_app') as unknown as StudentPortalPostgresSqlV1;
  peer = connect('student_portal_app') as unknown as StudentPortalPostgresSqlV1;
}, 30_000);
beforeEach(async () => resetCustomizationFixtureV1(owner as unknown as StudentPortalPostgresSqlV1));
afterAll(async () => {
  for (const connection of clients) await connection.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + name);
  await cluster.end({ timeout: 2 });
});
async function read(scope: ScopeV1 = READ_SCHOOL_V2) {
  const result = await customizationApiV1(app).query(readContextV2(), {
    contractVersion: 2, operation: 'customizations-read', scope, page: { limit: 100 },
  });
  if (result.state !== 'customizations-read') throw new Error('Synthetic query failed: ' + result.state);
  return result;
}
async function resetInput(scope: ScopeV1 = account, period: 'T2' | 'T3' = 'T2') {
  const page = await read(scope);
  const own = page.items.find((row) => row.scope.kind === scope.kind)?.publications.find((item) => item.period === period);
  if (!own || own.ownVersion === null) throw new Error('Missing synthetic difference');
  return { contractVersion: 1, operation: 'publication-inherit', scope, period,
    expectedVersion: page.publicationVersion, expectedDecisionVersion: own.ownVersion,
    idempotencyKey: crypto.randomUUID(), confirmed: true };
}
const approved = async (period = 'T2') => (await readScopedSourcesV2(app, account.accountId, 746001, 746001))
  .find((row) => row.period === period)?.approved_revision;

it('uses the real application role, preserves DELETE denial and changes only the confirmed inheritance marker', async () => {
  await release(app, READ_SCHOOL_V2, 'T1');
  await release(app, account, 'T2');
  await release(app, account, 'T3');
  const input = await resetInput();
  const before = await owner.unsafe('SELECT * FROM gradebook.fechamento ORDER BY aluno_id');
  const result = await customizationApiV1(app).command({ ...readContextV2(), capability: 'platform.settings.write' }, input);
  expect(result.state).toBe('committed');
  expect(await approved()).toBeNull();
  expect(await approved('T3')).toBeTruthy();
  expect((await read(account)).items[0]!.publications.map((item) => item.period)).toEqual(['T3']);
  expect(await owner.unsafe('SELECT * FROM gradebook.fechamento ORDER BY aluno_id')).toEqual(before);
  const marker = await owner.unsafe("SELECT inherit_version=version AS follows FROM student_portal.publication_release_v2 WHERE scope_kind='account' AND period='T2'");
  expect(marker[0]!.follows).toBe(true);
  await expect(app.unsafe('DELETE FROM student_portal.publication_release_v2 WHERE false')).rejects.toMatchObject({ code: '42501' });
  const audit = await owner.unsafe("SELECT count(*)::integer AS n FROM student_portal.audit_event WHERE request_id=$1::uuid", [input.idempotencyKey]);
  expect(audit[0]!.n).toBe(1);
});
it('serializes simultaneous resets, rejects stale CAS, and replays the same receipt without another audit', async () => {
  await release(app, account, 'T2');
  const input = await resetInput();
  const results = await Promise.allSettled([
    inheritPublicationV1(app, READ_ACTOR_V2, input),
    inheritPublicationV1(peer, READ_ACTOR_V2, { ...input, idempotencyKey: crypto.randomUUID() }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find((result) => result.status === 'rejected');
  expect(failure?.status === 'rejected' && String(failure.reason)).toContain('version-conflict');
  const audits = await owner.unsafe("SELECT count(*)::integer AS n FROM student_portal.audit_event WHERE kind='settings-changed'");
  expect(audits[0]!.n).toBe(1);
  const replay = await customizationApiV1(app).command({ ...readContextV2(), capability: 'platform.settings.write' }, input);
  // The first contender need not win. Only its own receipt can replay; the loser stays stale.
  expect(replay.state).toBe(results[0]!.status === 'fulfilled' ? 'committed' : 'conflict');
  expect((await owner.unsafe("SELECT count(*)::integer AS n FROM student_portal.audit_event WHERE kind='settings-changed'"))[0]!.n).toBe(1);
});
it('does not resurrect a legacy individual approval and follows later school changes dynamically', async () => {
  await release(app, account, 'T2');
  const approvedRevision = await approved();
  if (typeof approvedRevision !== 'string') throw new Error('Missing synthetic approved revision');
  await owner.unsafe(`INSERT INTO student_portal.publication(scope_key,scope_kind,academic_year,account_id,period,state,available_revision,published_revision,version)
    VALUES($1,'account',2026,$2::uuid,'T2','published',$3,$3,1)`, ['account:2026:' + account.accountId, account.accountId, approvedRevision]);
  await inheritPublicationV1(app, READ_ACTOR_V2, await resetInput());
  expect(await approved()).toBeNull();
  expect((await read(account)).items).toEqual([]);
  expect((await owner.unsafe('SELECT count(*)::integer AS n FROM student_portal.publication'))[0]!.n).toBe(1);
  await release(app, READ_SCHOOL_V2, 'T2');
  expect(await approved()).toBeTruthy();
  expect((await read(account)).items).toEqual([]);
  await release(app, READ_SCHOOL_V2, 'T2', 'unpublish');
  expect(await approved()).toBeNull();
});
it('keeps later independent student differences when a class follows school again', async () => {
  await release(app, READ_CLASS_V2, 'T2');
  await release(app, account, 'T3');
  await inheritPublicationV1(app, READ_ACTOR_V2, await resetInput(READ_CLASS_V2));
  const page = await read();
  expect(page.items.map((row) => row.scope)).toEqual([account]);
  expect(page.items[0]!.publications.map((item) => item.period)).toEqual(['T3']);
  expect(await approved()).toBeNull();
  expect(await approved('T3')).toBeTruthy();
});
it('reads an account option the school never stored against the default (Frequência, Horário)', async () => {
  // The fixture's schema predates Frequência and Horário; Fechamento do trimestre takes the same
  // path: an option with a code default and no school row.
  await owner.unsafe("DELETE FROM student_portal.setting WHERE scope_key='school:2026' AND field_key='showTermClosing'");
  await owner.unsafe(`INSERT INTO student_portal.setting
    (scope_key,field_key,scope_kind,academic_year,class_id,account_id,value_json,source_scope_json,version)
    SELECT 'account:2026:'||$1,'showTermClosing','account',2026,NULL,$1::uuid,'true'::jsonb,
      jsonb_build_object('kind','account','academicYear',2026,'accountId',$1::text),
      (SELECT min(version) FROM student_portal.setting WHERE scope_key='school:2026')`, [account.accountId]);
  const own = (await read(account)).items[0]!;
  expect(own.value).toEqual({ showTermClosing: true });
  expect(own.inheritedValue).toEqual({ showTermClosing: false });
  expect(own.schoolValue).toEqual({ showTermClosing: false });
  expect((await read()).items.map((row) => row.id)).toContain('account:2026:' + account.accountId);
});
