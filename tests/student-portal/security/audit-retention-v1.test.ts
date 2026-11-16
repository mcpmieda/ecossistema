// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cloudflareClientIpV1, withAuditSqlV1 } from '../../../server/student-portal/observability/audit-context-v1';
import { cleanupPortalV1 } from '../../../server/student-portal/maintenance/retention-v1';
import { StudentPortalPostgresPersistenceV1, type StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';

let pg: PGlite;
let sql: StudentPortalPostgresSqlV1;
const actor = '11111111-1111-4111-8111-111111111111';
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  sql = { unsafe: async <R extends Record<string, unknown>>(query: string, args?: readonly unknown[]) => (await pg.query<R>(query, [...(args ?? [])])).rows,
    begin: (op) => pg.transaction((tx) => op({ unsafe: async <R extends Record<string, unknown>>(query: string, args?: readonly unknown[]) => (await tx.query<R>(query, [...(args ?? [])])).rows })) };
}, 30_000);
afterAll(async () => { await pg?.close(); });
const event = () => ({ eventId: crypto.randomUUID(), at: new Date().toISOString(), actorId: actor, accountId: null,
  scope: { kind: 'school', academicYear: 2026 }, kind: 'settings-changed', result: 'success', requestId: crypto.randomUUID(), version: 1, maskedIp: null } as const);

it('does not treat a client header without incoming Cloudflare metadata as audit authority', () => {
  const request = new Request('https://admin.escolaieda.com/api/student-portal/admin/command', { headers: { 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': '198.51.100.1' } });
  expect(cloudflareClientIpV1(request)).toBeNull();
  Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
  expect(cloudflareClientIpV1(request)).toBe('192.0.2.10');
  request.headers.set('cf-connecting-ip', '192.0.2.10, 198.51.100.1');
  expect(cloudflareClientIpV1(request)).toBeNull();
});

it('writes IPv4/IPv6 atomically, masks host bits, and never leaks SET LOCAL to the next transaction', async () => {
  for (const [ip, mask] of [['192.0.2.10', '192.0.2.0/24'], ['2001:db8:abcd:1234::1', '2001:db8:abcd::/48']]) {
    const value = event();
    await new StudentPortalPostgresPersistenceV1(withAuditSqlV1(sql, ip!)).transaction((tx) => tx.appendAudit(value));
    const rows = await pg.query('SELECT host(raw_ip) AS ip,masked_ip,extract(epoch FROM ip_expires_at-occurred_at)::integer AS seconds FROM student_portal.audit_event WHERE event_id=$1', [value.eventId]);
    expect(rows.rows[0]).toEqual({ ip, masked_ip: mask, seconds: 90 * 86400 });
  }
  const clean = event();
  await new StudentPortalPostgresPersistenceV1(sql).transaction((tx) => tx.appendAudit(clean));
  expect((await pg.query('SELECT raw_ip,ip_expires_at FROM student_portal.audit_event WHERE event_id=$1', [clean.eventId])).rows[0]).toEqual({ raw_ip: null, ip_expires_at: null });
  const failed = event();
  await expect(new StudentPortalPostgresPersistenceV1(withAuditSqlV1(sql, '192.0.2.50')).transaction(async (tx) => {
    await tx.appendAudit(failed); throw new Error('synthetic-rollback');
  })).rejects.toThrow('synthetic-rollback');
  expect((await pg.query('SELECT event_id FROM student_portal.audit_event WHERE event_id=$1', [failed.eventId])).rows).toHaveLength(0);
  expect(() => withAuditSqlV1(sql, '192.0.2.1/24')).toThrow();
});

it('bounds physical retention and repeats safely without deleting current audit metadata', async () => {
  await pg.exec('TRUNCATE student_portal.audit_event');
  for (let i = 0; i < 3; i++) {
    const value = event();
    await new StudentPortalPostgresPersistenceV1(withAuditSqlV1(sql, '192.0.2.10')).transaction((tx) => tx.appendAudit(value));
  }
  await pg.exec("UPDATE student_portal.audit_event SET occurred_at=statement_timestamp()-interval '91 days',ip_expires_at=statement_timestamp()-interval '1 day'");
  expect((await cleanupPortalV1(sql, 2)).rawIp).toBe(2);
  expect((await cleanupPortalV1(sql, 2)).rawIp).toBe(1);
  expect((await cleanupPortalV1(sql, 2)).rawIp).toBe(0);
  expect((await pg.query('SELECT event_id FROM student_portal.audit_event')).rows).toHaveLength(3);
  await pg.exec("UPDATE student_portal.audit_event SET occurred_at=statement_timestamp()-interval '13 months'");
  expect((await cleanupPortalV1(sql, 2)).audit).toBe(2);
  expect((await cleanupPortalV1(sql, 2)).audit).toBe(1);
  expect((await cleanupPortalV1(sql, 2)).audit).toBe(0);
  await expect(cleanupPortalV1(sql, 101)).rejects.toThrow();
});
