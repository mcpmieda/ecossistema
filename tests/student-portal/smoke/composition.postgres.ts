import { seedExistingBirthFixtureV1 } from './legacy-seed-fixture-v1';
import { openSyntheticSchoolV1 } from '../academic/open-school-fixture-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { adminResponseV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { challengeResponseV1, sessionResponseV1 } from '../../../shared/student-portal-contracts/auth-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' || target.pathname !== '/portal705_test')
  throw new Error('Local synthetic database required');
const sql = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const scope = { kind: 'class', academicYear: 2026, classId: 970001 };
const directory = mkdtempSync(join(tmpdir(), 'portal-composition-715-'));
let runtime: Miniflare;
let caller: Awaited<ReturnType<Miniflare['getWorker']>>;
let scopedBefore: boolean | undefined;
async function call(path: string, input?: unknown, cookie?: string, anonymous = false, origin?: string) {
  return caller.fetch('http://test.invalid/', { method: 'POST', body: JSON.stringify({ path, input, cookie, anonymous, origin }) });
}
async function query(operation: string) {
  const response = await call('/api/student-portal/admin/query', { contractVersion: 1, operation, scope, page: { limit: 100 } });
  expect(response.status).toBe(200);
  return adminResponseV1.parse(await response.json());
}
async function command(input: object) {
  const response = await call('/api/student-portal/admin/command', { contractVersion: 1, idempotencyKey: crypto.randomUUID(), ...input });
  expect(response.status).toBe(200);
  return adminResponseV1.parse(await response.json());
}
beforeAll(async () => {
  await openSyntheticSchoolV1(sql as unknown as StudentPortalPostgresSqlV1);
  // The historical native migration suite intentionally stops before the live outbox.
  // This composed scheduled runtime exercises its existing retention contract too.
  const outbox = await sql`SELECT to_regclass('student_portal.live_event_outbox_v1') AS relation`;
  if (outbox[0]?.relation === null) {
    for (const name of ['0011_live_event_outbox_v1.sql', '0017_security_event_priority_v1.sql'])
      await sql.unsafe(readFileSync(`migrations/student-portal/${name}`, 'utf8'));
  }
  // Schema was replayed by the preceding native suite. New synthetic class avoids all H fixture state.
  await sql.unsafe(`INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES(970001,2026,'I715','SYNTHETIC COMPOSITION',6,'TESTE');
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES(970001,2026,'SYNTHETIC COMPOSITION ACCOUNT');
    INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES(2026,970001,1,970001);
    SELECT * FROM student_portal.synchronize_profiles_v1(true);`);
  // Production serves Self only from scoped V2 editions; restore the shared chain's state afterwards.
  scopedBefore = (await sql.unsafe('SELECT enabled FROM student_portal.publication_control_v2 WHERE academic_year=2026'))[0]!.enabled === true;
  if (!scopedBefore) await sql.unsafe('SELECT student_portal.activate_scoped_publication_v2()');
  for (const config of ['wrangler.student-portal.jsonc', 'tests/student-portal/smoke/wrangler.caller.jsonc']) {
    await promisify(execFile)(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', config,
      ...(config.startsWith('wrangler.') ? ['--env', 'preview'] : []), '--dry-run', '--outdir', directory],
    { windowsHide: true, timeout: 60_000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  }
  const workerConfig = JSON.parse(readFileSync('wrangler.student-portal.jsonc', 'utf8'));
  const restricted = new URL(target); restricted.username = 'student_portal_app'; restricted.password = 'synthetic-local-trust-only';
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'portal', modules: true,
    script: readFileSync(join(directory, 'index.js'), 'utf8'), compatibilityDate: '2026-09-11', compatibilityFlags: ['nodejs_compat'],
    hyperdrives: { PORTAL_DB: restricted.toString() }, bindings: { PORTAL_ENVIRONMENT: 'production',
      PORTAL_ORIGIN: 'https://aluno.escolaieda.com', PORTAL_ADMIN_TENANT_ID: '22222222-2222-4222-8222-222222222222',
      PORTAL_SERVING_ENABLED: 'true', PORTAL_PUBLICATION_MODE: 'scoped-v2', PASSWORD_PEPPER: JSON.stringify({ 1: Buffer.alloc(32, 71).toString('base64') }),
      QR_HMAC_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 72).toString('base64') }),
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
    ratelimits: { ...Object.fromEntries(workerConfig.env.production.ratelimits.filter((binding: { name: string }) => !['PORTAL_AUTH_GLOBAL', 'PORTAL_AUTH_SUBJECT'].includes(binding.name)).map((binding: { name: string; namespace_id: string; simple: { limit: number; period: 60 } }) => [binding.name, { namespace_id: binding.namespace_id, simple: binding.simple }])), PORTAL_AUTH_GLOBAL: { namespace_id: '100715', simple: { limit: 600, period: 60 } },
      PORTAL_AUTH_SUBJECT: { namespace_id: '200715', simple: { limit: 30, period: 60 } } } },
  { name: 'caller', modules: true, script: readFileSync(join(directory, 'caller-worker.js'), 'utf8'),
    compatibilityDate: '2026-09-11', compatibilityFlags: ['nodejs_compat'],
    serviceBindings: { SELF: { name: 'portal', entrypoint: 'PortalSelfEntrypoint' }, ADMIN: { name: 'portal', entrypoint: 'PortalAdminEntrypoint' } } }] }));
  caller = await runtime.getWorker('caller');
});
afterAll(async () => {
  await runtime?.dispose();
  if (scopedBefore === false) await sql.unsafe('UPDATE student_portal.publication_control_v2 SET enabled=false WHERE academic_year=2026');
  await sql.end();
  if (resolve(directory).startsWith(resolve(tmpdir())) && basename(directory).startsWith('portal-composition-715-')) rmSync(directory, { recursive: true, force: true });
});

it('uses real sealed ADM identity, named RPC and restricted Hyperdrive for the composed backend', async () => {
  const anonymous = await call('/api/student-portal/admin/query', { contractVersion: 1, operation: 'health', scope, page: {} }, undefined, true);
  expect(anonymous.status).toBe(401);
  const csrf = await call('/api/student-portal/admin/query', { contractVersion: 1, operation: 'health', scope, page: {} }, undefined, false, 'https://evil.invalid');
  expect(csrf.status).toBe(403);
  expect((await query('health')).state).toBe('health');
  const birth = await query('birth-years');
  if (birth.state !== 'birth-years' || birth.items.length !== 1) throw new Error('synthetic-birth-state');
  const accountId = birth.items[0]!.accountId;
  const retired = await call('/api/student-portal/admin/command', { contractVersion: 1,
    idempotencyKey: crypto.randomUUID(), operation: 'birth-batch', classId: 970001,
    expectedVersion: birth.scopeVersion, expectedCount: 1, confirmed: true,
    items: [{ action: 'set', accountId, expectedVersion: birth.items[0]!.version, year: '2001', confirmation: 'confirmed' }] });
  expect(retired.status).toBe(400);
  await seedExistingBirthFixtureV1(sql, accountId);
  const settings = await query('settings');
  if (settings.state !== 'settings') throw new Error('synthetic-settings-state');
  const now = Math.floor(Date.now() / 1000) * 1000;
  expect((await command({ operation: 'settings-set', scope, expectedVersion: settings.settings.version, acknowledgeImmediateEffect: true,
    value: { accessEnabled: true, calendar: { ...settings.settings.value.calendar,
      yearStartsAt: new Date(now - 86400_000).toISOString(), yearEndsAt: new Date(now + 86400_000).toISOString() } } })).state).toBe('committed');
  const accounts = await query('accounts');
  if (accounts.state !== 'accounts') throw new Error('synthetic-accounts-state');
  const qr = await command({ operation: 'qr-batch', classId: 970001, accountIds: [accountId], mode: 'qr-only', confirmed: true, expectedVersion: accounts.scopeVersion });
  if (qr.state !== 'qr') throw new Error('synthetic-qr-state');
  const challenge = challengeResponseV1.parse(await (await call('/api/student/auth/challenge', { contractVersion: 1, qr: qr.cards[0]!.qr, pin: '2001' })).json());
  if (challenge.state !== 'password-creation') throw new Error('synthetic-challenge-state');
  const activated = await call('/api/student/auth/activate', { contractVersion: 1, challenge: challenge.challenge, password: '013579', confirmation: '013579', keepConnected: true });
  expect(activated.status).toBe(200);
  expect(sessionResponseV1.parse(await activated.json()).state).toBe('authenticated');
  const cookie = activated.headers.get('set-cookie');
  expect(cookie?.includes('; Secure; HttpOnly; SameSite=Strict')).toBe(true);
  const token = cookie!.split(';')[0]!;
  expect((await call('/api/student/session', undefined, token)).status).toBe(200);
  const self = await call('/api/student/me', undefined, token);
  expect(self.status).toBe(200);
  expect((await self.json() as { state: string }).state).toBe('no-publication');
  expect((await call('/api/student/auth/logout', { contractVersion: 1 }, token)).status).toBe(200);
  expect((await call('/api/student/session', undefined, token)).status).toBe(401);
});

it('executes the actual scheduled entrypoint and physically removes expired synthetic receipts', async () => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO student_portal.operation_receipt(idempotency_key,actor_id,request_digest,operation_id,version,created_at,expires_at)
    VALUES(${id},'synthetic-cron-715',${'a'.repeat(64)},${crypto.randomUUID()},0,
      statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '1 minute')`;
  const eventId = crypto.randomUUID();
  await sql`INSERT INTO student_portal.live_event_outbox_v1
    (source_event_id,audience,domain,academic_year,version,occurred_at,delivered_at)
    VALUES(${eventId},'admin','portal',2026,'1',statement_timestamp()-interval '9 days',
      statement_timestamp()-interval '8 days')`;
  const worker = await runtime.getWorker('portal');
  await worker.scheduled({ cron: '* * * * *' });
  const rows = await sql`SELECT count(*)::integer AS count FROM student_portal.operation_receipt WHERE idempotency_key=${id}`;
  expect(rows[0]!.count).toBe(0);
  const expired = await sql`SELECT count(*)::integer AS count FROM student_portal.live_event_outbox_v1 WHERE source_event_id=${eventId}`;
  expect(expired[0]!.count).toBe(0);
  expect((await query('health')).state).toBe('health');
});
