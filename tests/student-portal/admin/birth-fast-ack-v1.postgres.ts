import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BirthYearServiceV1 } from '../birth-year/legacy-birth-fixture-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installAdminReadFixtureV2, readAccountIdV2, READ_ACTOR_V2, readApiV2, readContextV2 } from './read-fixture-v2';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://missing.invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' || target.pathname !== '/portal705_test' || target.search || target.hash)
  throw new Error('Birth acknowledgement tests require disposable local PostgreSQL.');
const name = 'portal808_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
let created = false;
let owner: ReturnType<typeof postgres>;
let sql: StudentPortalPostgresSqlV1;
let peer: StudentPortalPostgresSqlV1;
const cryptography = new PortalCryptoV1(new Map([[1, new Uint8Array(32).fill(7)]]), new Map([[1, new Uint8Array(32).fill(8)]]));
function connect(role?: string) {
  const url = new URL(target); url.pathname = '/' + name; if (role) url.username = role;
  const client = postgres(url.toString(), { max: 1, onnotice: () => undefined }); clients.push(client); return client;
}
beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name); created = true;
  owner = connect();
  await installAdminReadFixtureV2({ exec: (text) => owner.unsafe(text, [], { prepare: false }) }, owner as unknown as StudentPortalPostgresSqlV1);
  await owner.unsafe(readFileSync('migrations/student-portal/0011_live_event_outbox_v1.sql', 'utf8'), [], { prepare: false });
  sql = connect('student_portal_app') as unknown as StudentPortalPostgresSqlV1;
  peer = connect('student_portal_app') as unknown as StudentPortalPostgresSqlV1;
});
afterAll(async () => {
  for (const client of clients) await client.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + name);
  await cluster.end({ timeout: 2 });
});
async function command(index: number, year: string) {
  const id = readAccountIdV2(index);
  const rows = await owner.unsafe(`SELECT a.version::integer AS account_version,COALESCE(b.version,0)::integer AS birth_version
    FROM student_portal.account a LEFT JOIN student_portal.account_access_data b ON b.account_id=a.id WHERE a.id=$1::uuid`, [id]);
  return { contractVersion: 1, operation: 'birth-write', expectedVersion: rows[0]!.account_version,
    idempotencyKey: crypto.randomUUID(), includeSavedBirth: true,
    item: { action: 'set', accountId: id, expectedVersion: rows[0]!.birth_version, year, confirmation: 'unconfirmed-test' } };
}
it('returns the committed opt-in value through the admin contract and an independent connection sees it', async () => {
  const input = await command(2, '2003');
  const result = await readApiV2(sql).command({ ...readContextV2(), capability: 'platform.settings.write' }, input);
  expect(result).toMatchObject({ state: 'committed', version: 1, savedBirth: { accountId: readAccountIdV2(2), classId: 746001,
    accountVersion: 1, version: 1, year: '2003', confirmation: 'unconfirmed-test' } });
  const rows = await peer.unsafe('SELECT birth_year::text AS year_value,version::integer FROM student_portal.account_access_data WHERE account_id=$1::uuid', [readAccountIdV2(2)]);
  expect(rows).toEqual([{ year_value: '2003', version: 1 }]);
  expect(JSON.stringify(result)).not.toMatch(/verifier|pepper|digest|password|signature/);
  const notices = await owner.unsafe(`SELECT audience,domain,account_id::text AS account_id FROM student_portal.live_event_outbox_v1
    WHERE account_id=$1::uuid ORDER BY audience`, [readAccountIdV2(2)]);
  expect(notices).toEqual([
    { audience: 'admin', domain: 'portal', account_id: readAccountIdV2(2) },
    { audience: 'student', domain: 'portal', account_id: readAccountIdV2(2) },
  ]);
});
it('replays a lost response idempotently without a second write or notification', async () => {
  const input = await command(4, '2007');
  const service = new BirthYearServiceV1(sql, cryptography, 1);
  const first = await service.write(READ_ACTOR_V2, input);
  const replay = await service.write(READ_ACTOR_V2, input);
  expect(replay).toEqual(first);
  const rows = await owner.unsafe(`SELECT count(*)::integer AS count FROM student_portal.live_event_outbox_v1
    WHERE account_id=$1::uuid`, [readAccountIdV2(4)]);
  expect(rows).toEqual([{ count: 2 }]);
});
it('rolls the durable notification back with its source event', async () => {
  const eventId = crypto.randomUUID();
  await expect(owner.begin(async (tx) => {
    await tx.unsafe(`INSERT INTO student_portal.audit_event
      (event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version,masked_ip)
      VALUES ($1::uuid,statement_timestamp(),$2::uuid,$3::uuid,$4::text::jsonb,'birth-changed','success',$5::uuid,1,NULL)`,
    [eventId, READ_ACTOR_V2, readAccountIdV2(5), JSON.stringify({ kind: 'account', academicYear: 2026, accountId: readAccountIdV2(5) }), crypto.randomUUID()]);
    throw new Error('synthetic-rollback');
  })).rejects.toThrow('synthetic-rollback');
  const rows = await owner.unsafe(`SELECT
    (SELECT count(*)::integer FROM student_portal.audit_event WHERE event_id=$1::uuid) AS audit_count,
    (SELECT count(*)::integer FROM student_portal.live_event_outbox_v1 WHERE source_event_id=$1::uuid) AS notice_count`, [eventId]);
  expect(rows).toEqual([{ audit_count: 0, notice_count: 0 }]);
});
it('serializes simultaneous edits, confirms only the winning value, and does not replay a superseded value as current', async () => {
  const first = await command(3, '2004');
  const second = { ...first, idempotencyKey: crypto.randomUUID(), item: { ...first.item, year: '2005' } };
  const left = new BirthYearServiceV1(sql, cryptography, 1), right = new BirthYearServiceV1(peer, cryptography, 1);
  const results = await Promise.allSettled([left.write(READ_ACTOR_V2, first), right.write(READ_ACTOR_V2, second)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  const original = winner === 0 ? first : second;
  const saved = results[winner]!;
  if (saved.status !== 'fulfilled') throw new Error('Expected one winner');
  expect(saved.value.savedBirth?.year).toBe(original.item.year);
  await left.write(READ_ACTOR_V2, await command(3, '2006'));
  const replay = await left.write(READ_ACTOR_V2, original);
  expect(replay.operationId).toBe(saved.value.operationId);
  expect(replay).not.toHaveProperty('savedBirth');
});
