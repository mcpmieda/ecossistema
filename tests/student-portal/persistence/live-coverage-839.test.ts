// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';

// Synthetic event-to-outbox coverage, complementary to the existing command/CAS suites.
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  await installResetSchemaFixtureV1(pg);
  await pg.exec(readFileSync('migrations/student-portal/0011_live_event_outbox_v1.sql', 'utf8'));
}, 30_000);
afterAll(async () => pg?.close());

const academicCauses = [
  ['marks', true, ['admin', 'student']],
  ['relation', true, ['admin', 'student']],
  ['council', true, ['admin', 'student']],
  ['council', false, ['admin', 'student']],
  ['academic-policy', true, ['admin', 'student']],
  ['diagnostics', false, ['admin']],
  ['audit-treatment', false, ['admin']],
  ['bulletin-snapshot', false, ['admin']],
] as const;
it.each(academicCauses)(
  'routes %s (academic=%s) and deduplicates replay',
  async (cause, academic, audiences) => {
    const id = crypto.randomUUID();
    const query = `SELECT * FROM student_portal.record_gradebook_change_v1(
    $1::uuid,2026::smallint,$2::text,$3::boolean,ARRAY[10,11]::integer[],now())`;
    await pg.query(query, [id, cause, academic]);
    await pg.query(query, [id, cause, academic]);
    const rows = (
      await pg.query(
        `SELECT audience,domain,student_ids
    FROM student_portal.live_event_outbox_v1 WHERE source_event_id=$1 ORDER BY audience`,
        [id],
      )
    ).rows;
    expect(rows).toEqual(
      audiences.map((audience) => ({ audience, domain: 'gradebook', student_ids: [10, 11] })),
    );
  },
);
const portalKinds = [
  'activated',
  'password-reset',
  'account-reset',
  'qr-issued',
  'qr-reprinted',
  'qr-regenerated',
  'blocked',
  'unblocked',
  'session-revoked',
  'birth-changed',
  'settings-changed',
  'published',
  'unpublished',
  'projection-updated',
  'links-closed',
];
it.each(portalKinds)('routes the %s audit kind to both audiences', async (kind) => {
  const id = crypto.randomUUID();
  await pg.query(
    `INSERT INTO student_portal.audit_event
    (event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version,masked_ip)
    VALUES($1,now(),'85555555-5555-4555-8555-555555555555',NULL,
      '{"kind":"class","academicYear":2026,"classId":42}',$2,'success',$1,7,NULL)`,
    [id, kind],
  );
  expect(
    (
      await pg.query(
        `SELECT audience,domain,version,class_id,account_id,student_ids
    FROM student_portal.live_event_outbox_v1 WHERE source_event_id=$1 ORDER BY audience`,
        [id],
      )
    ).rows,
  ).toEqual(
    ['admin', 'student'].map((audience) => ({
      audience,
      domain: 'portal',
      version: '7',
      class_id: 42,
      account_id: null,
      student_ids: [],
    })),
  );
});
it.each(['login', 'login-failed'])(
  'does not turn %s noise into a data-change notice',
  async (kind) => {
    const id = crypto.randomUUID();
    await pg.query(
      `INSERT INTO student_portal.audit_event
    (event_id,occurred_at,actor_id,scope_json,kind,result,request_id,version)
    VALUES($1,now(),'85555555-5555-4555-8555-555555555555',
      '{"kind":"school","academicYear":2026}',$2,'denied',$1,0)`,
      [id, kind],
    );
    expect(
      (
        await pg.query(
          `SELECT count(*)::integer AS count FROM student_portal.live_event_outbox_v1
    WHERE source_event_id=$1`,
          [id],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  },
);
it('allocates distinct cursors even when administrative changes retain the academic version', async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids)
    await pg.query(
      `SELECT * FROM student_portal.record_gradebook_change_v1(
    $1::uuid,2026::smallint,'diagnostics'::text,false,'{}'::integer[],now())`,
      [id],
    );
  const rows = (
    await pg.query<{ id: string; version: string }>(
      `SELECT id::text,version
    FROM student_portal.live_event_outbox_v1 WHERE source_event_id IN ($1::uuid,$2::uuid)
      AND audience='admin' ORDER BY id`,
      ids,
    )
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0]!.version).toBe(rows[1]!.version);
  expect(rows[0]!.id).not.toBe(rows[1]!.id);
});
