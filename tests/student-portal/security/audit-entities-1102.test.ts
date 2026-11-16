// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { adminQueryV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { withAuditSqlV1 } from '../../../server/student-portal/observability/audit-context-v1';
import { readAuditV1 } from '../../../server/student-portal/admin/queries-v1';
import { AdminCursorV1 } from '../../../server/student-portal/admin/cursor-v1';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresSqlV1,
} from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
import { ACADEMIC_FIXTURE_SQL_V1 } from '../academic/academic-fixture-v1';
let pg: PGlite;
let sql: StudentPortalPostgresSqlV1;
let account: string;
const actor = '11111111-1111-4111-8111-111111111111';
const cursor = new AdminCursorV1('synthetic-audit-entities-1102-secret-'.repeat(3));
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
const query = (extra: Record<string, unknown> = {}) =>
  adminQueryV1.parse({
    contractVersion: 1,
    operation: 'audit',
    scope: { kind: 'school', academicYear: 2026 },
    page: { limit: 100 },
    ...extra,
  });
const read = (extra: Record<string, unknown> = {}) =>
  readAuditV1(sql, query(extra), actor, new Date(), cursor);
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(ACADEMIC_FIXTURE_SQL_V1);
  account = (
    await pg.query<{ id: string }>(
      'SELECT id FROM student_portal.account WHERE gradebook_student_id=910001',
    )
  ).rows[0]!.id;
  sql = {
    unsafe: async <R extends Record<string, unknown>>(q: string, args?: readonly unknown[]) =>
      (await pg.query<R>(q, [...(args ?? [])])).rows,
    begin: (op) =>
      pg.transaction((tx) =>
        op({
          unsafe: async <R extends Record<string, unknown>>(q: string, args?: readonly unknown[]) =>
            (await tx.query<R>(q, [...(args ?? [])])).rows,
        }),
      ),
  };
}, 30_000);
afterAll(async () => {
  await pg?.close();
});
it('keeps legacy queries working before migration and historical unknown identities null', async () => {
  const old = event();
  await new StudentPortalPostgresPersistenceV1(sql).transaction((tx) => tx.appendAudit(old));
  const legacy = await read();
  expect('items' in legacy && legacy.items?.[0]).not.toHaveProperty('entities');
  await pg.exec(readFileSync('migrations/student-portal/0016_audit_entities_v1.sql', 'utf8'));
  const enriched = await read({ includeEntities: true });
  expect('items' in enriched && enriched.items?.[0]?.entities).toEqual({
    actorName: null,
    subjectName: null,
    classId: null,
    classLabel: null,
  });
});
it('captures verified operator and immutable entity snapshots; class transfer does not rewrite history', async () => {
  await pg.exec('TRUNCATE student_portal.audit_event');
  await new StudentPortalPostgresPersistenceV1(
    withAuditSqlV1(sql, '192.0.2.4', { actorId: actor, actorName: 'SYNTHETIC OPERATOR' }),
  ).transaction((tx) => tx.appendAudit(event()));
  await pg.exec(
    "UPDATE gradebook.aluno SET nome='SYNTHETIC RENAMED' WHERE id=910001; UPDATE gradebook.vinculo SET turma_id=910002 WHERE aluno_id=910001",
  );
  const original = await read({
    includeEntities: true,
    scope: { kind: 'class', academicYear: 2026, classId: 910001 },
  });
  expect('items' in original && original.items?.[0]?.entities).toEqual({
    actorName: 'SYNTHETIC OPERATOR',
    subjectName: 'SYNTHETIC ACADEMIC ONE',
    classId: 910001,
    classLabel: 'SYNTHETIC ACADEMIC CLASS',
  });
  const moved = await read({
    includeEntities: true,
    scope: { kind: 'class', academicYear: 2026, classId: 910002 },
  });
  expect('items' in moved && moved.items).toEqual([]);
  const legacy = await read({ scope: { kind: 'class', academicYear: 2026, classId: 910002 } });
  expect('items' in legacy && legacy.items).toHaveLength(1);
});
it('clears all transaction context, rejects actor mismatch and rolls back the audit atomically', async () => {
  const clean = event();
  await new StudentPortalPostgresPersistenceV1(withAuditSqlV1(sql, null)).transaction((tx) =>
    tx.appendAudit(clean),
  );
  expect(
    (
      await pg.query(
        'SELECT actor_name, raw_ip FROM student_portal.audit_event WHERE event_id=$1',
        [clean.eventId],
      )
    ).rows[0],
  ).toEqual({ actor_name: null, raw_ip: null });
  const mismatched = event();
  await new StudentPortalPostgresPersistenceV1(
    withAuditSqlV1(sql, null, { actorId: crypto.randomUUID(), actorName: 'SYNTHETIC WRONG ACTOR' }),
  ).transaction((tx) => tx.appendAudit(mismatched));
  expect(
    (
      await pg.query('SELECT actor_name FROM student_portal.audit_event WHERE event_id=$1', [
        mismatched.eventId,
      ])
    ).rows[0],
  ).toEqual({ actor_name: null });
  const failed = event();
  await expect(
    new StudentPortalPostgresPersistenceV1(
      withAuditSqlV1(sql, '192.0.2.7', { actorId: actor, actorName: 'SYNTHETIC FAILED' }),
    ).transaction(async (tx) => {
      await tx.appendAudit(failed);
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(
    (
      await pg.query('SELECT event_id FROM student_portal.audit_event WHERE event_id=$1', [
        failed.eventId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pg.query(
        "SELECT NULLIF(current_setting('student_portal.audit_actor_name',true),'') AS name, NULLIF(current_setting('student_portal.audit_actor_id',true),'') AS id",
      )
    ).rows[0],
  ).toEqual({ name: null, id: null });
});
it('binds includeEntities to the cursor and refuses it on non-audit queries', async () => {
  expect(
    adminQueryV1.safeParse({ ...query(), operation: 'accounts', includeEntities: true }).success,
  ).toBe(false);
  const now = new Date();
  const token = await cursor.next(query(), actor, now, crypto.randomUUID(), now.toISOString());
  await expect(
    cursor.read(query({ includeEntities: true, page: { limit: 100, cursor: token } }), actor, now),
  ).rejects.toThrow('cursor-invalid-request');
});
it('includes explicit class events and denies details outside the requested account scope', async () => {
  const value = {
    ...event(),
    accountId: null,
    scope: { kind: 'class', academicYear: 2026, classId: 910001 } as const,
  };
  await new StudentPortalPostgresPersistenceV1(withAuditSqlV1(sql, null)).transaction((tx) =>
    tx.appendAudit(value),
  );
  const result = await read({ includeEntities: true, scope: value.scope });
  expect(result.items?.find((item) => item.eventId === value.eventId)?.entities?.classId).toBe(
    910001,
  );
  await expect(
    read({
      operation: 'audit-detail',
      includeEntities: true,
      eventId: value.eventId,
      scope: { kind: 'account', academicYear: 2026, accountId: account },
    }),
  ).rejects.toThrow('audit-forbidden');
});
