// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';

let pg: PGlite;
const REVISION = '11111111111111111111111111111111:2';

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  await installResetSchemaFixtureV1(pg);
  await pg.exec(readFileSync('migrations/student-portal/0011_live_event_outbox_v1.sql', 'utf8'));
}, 30_000);
afterAll(async () => pg?.close());

describe('transactional live notification outbox', () => {
  it('groups one academic change into minimal audience events and rolls back with its source', async () => {
    const source = '81111111-1111-4111-8111-111111111111';
    await pg.query(
      `SELECT * FROM student_portal.record_gradebook_change_v1(
      $1::uuid,2026::smallint,'marks'::text,true,ARRAY[10,11]::integer[],now())`,
      [source],
    );
    expect(
      (
        await pg.query(
          `SELECT audience,domain,student_ids,account_id,class_id
      FROM student_portal.live_event_outbox_v1 WHERE source_event_id=$1 ORDER BY audience`,
          [source],
        )
      ).rows,
    ).toEqual([
      {
        audience: 'admin',
        domain: 'gradebook',
        student_ids: [10, 11],
        account_id: null,
        class_id: null,
      },
      {
        audience: 'student',
        domain: 'gradebook',
        student_ids: [10, 11],
        account_id: null,
        class_id: null,
      },
    ]);
    await expect(
      pg.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO student_portal.revision_event
        (event_id,academic_year,student_ids,cause,affects_academic,affects_reset,data_version,reset_version,portal_link_version,occurred_at)
        VALUES('82222222-2222-4222-8222-222222222222',2026,'{}','marks',true,true,$1,$1,$1,now())`,
          [REVISION],
        );
        throw new Error('synthetic-rollback');
      }),
    ).rejects.toThrow('synthetic-rollback');
    expect(
      (
        await pg.query(`SELECT count(*)::integer AS count FROM student_portal.live_event_outbox_v1
      WHERE source_event_id='82222222-2222-4222-8222-222222222222'`)
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('routes a portal event without copying protected fields and ignores login noise', async () => {
    const account = '83333333-3333-4333-8333-333333333333';
    const event = '84444444-4444-4444-8444-444444444444';
    await pg.query(
      `INSERT INTO student_portal.account
      (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version,pin_version,closed_at)
      VALUES($1,2026,NULL,'pending-activation','unlinked',0,0,0,now())`,
      [account],
    );
    await pg.query(
      `INSERT INTO student_portal.audit_event
      (event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version,masked_ip)
      VALUES($1,now(),'85555555-5555-4555-8555-555555555555',$2,
        '{"kind":"account","academicYear":2026,"accountId":"83333333-3333-4333-8333-333333333333"}',
        'birth-changed','success','86666666-6666-4666-8666-666666666666',7,NULL)`,
      [event, account],
    );
    expect(
      (
        await pg.query(
          `SELECT audience,domain,version,account_id,class_id,student_ids
      FROM student_portal.live_event_outbox_v1 WHERE source_event_id=$1 ORDER BY audience`,
          [event],
        )
      ).rows,
    ).toEqual([
      {
        audience: 'admin',
        domain: 'portal',
        version: '7',
        account_id: account,
        class_id: null,
        student_ids: [],
      },
      {
        audience: 'student',
        domain: 'portal',
        version: '7',
        account_id: account,
        class_id: null,
        student_ids: [],
      },
    ]);
    await pg.query(`INSERT INTO student_portal.audit_event
      (event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version,masked_ip)
      VALUES('87777777-7777-4777-8777-777777777777',now(),'85555555-5555-4555-8555-555555555555',NULL,
        '{"kind":"school","academicYear":2026}','login','success',
        '88888888-8888-4888-8888-888888888888',0,NULL)`);
    expect(
      (
        await pg.query(`SELECT count(*)::integer AS count FROM student_portal.live_event_outbox_v1
      WHERE source_event_id='87777777-7777-4777-8777-777777777777'`)
      ).rows,
    ).toEqual([{ count: 0 }]);
    const columns = (
      await pg.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='student_portal' AND table_name='live_event_outbox_v1'`)
    ).rows.map((row) => row.column_name);
    expect(columns).not.toEqual(
      expect.arrayContaining(['year', 'confirmation', 'verifier', 'password', 'qr', 'secret']),
    );
  });
});
