// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { adminReadQueryV2 } from '../../../shared/student-portal-contracts/admin-read-v2';
import { adminCommandV1 } from '../../../shared/student-portal-contracts/admin-v1';
import type { ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { readCustomizationsV1 } from '../../../server/student-portal/admin/customizations-read-v1';
import { AdminCursorV1 } from '../../../server/student-portal/admin/cursor-v1';
import { inheritPublicationV1 } from '../../../server/student-portal/publication/publication-inheritance-v1';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import { readScopedSourcesV2 } from '../../../server/student-portal/publication/scoped-source-v2';
import {
  CUSTOM_ACCOUNT_V1 as account,
  CUSTOM_CURSOR_SECRET_V1,
  customizationApiV1,
  installCustomizationFixtureV1,
  releaseCustomizationV1 as release,
  resetCustomizationFixtureV1,
} from './customizations-fixture-827';
import {
  READ_ACTOR_V2,
  READ_CLASS_V2,
  READ_SCHOOL_V2,
  readAccountIdV2,
  readContextV2,
} from './read-fixture-v2';

let pg: PGlite, sql: StudentPortalPostgresSqlV1;
const statements: string[] = [];
let failReceipt = false;
beforeAll(async () => {
  pg = new PGlite();
  const run = async <R extends Record<string, unknown>>(
    db: Pick<PGlite, 'query'>,
    q: string,
    v: readonly unknown[] = [],
  ): Promise<R[]> => {
    statements.push(q);
    if (failReceipt && q.includes('INSERT INTO student_portal.operation_receipt'))
      throw new Error('SYNTHETIC receipt failure');
    return (await db.query<R>(q, [...v])).rows;
  };
  sql = {
    unsafe: (q, v) => run(pg, q, v),
    begin: (cb) => pg.transaction((tx) => cb({ unsafe: (q, v) => run(tx, q, v) })),
  };
  await installCustomizationFixtureV1(pg, sql);
}, 30_000);
afterAll(async () => pg?.close());
beforeEach(async () => {
  failReceipt = false;
  await resetCustomizationFixtureV1(sql);
  statements.length = 0;
});
function read(
  scope: ScopeV1 = READ_SCHOOL_V2,
  extra: { page?: { limit: number; cursor?: string }; nameSearch?: string } = {},
) {
  const query = adminReadQueryV2.parse({
    contractVersion: 2,
    operation: 'customizations-read',
    scope,
    page: { limit: 100 },
    ...extra,
  });
  return sql.begin((tx) =>
    readCustomizationsV1(
      tx,
      query,
      READ_ACTOR_V2,
      crypto.randomUUID(),
      new Date(),
      new AdminCursorV1(CUSTOM_CURSOR_SECRET_V1),
    ),
  );
}
async function inheritInput(scope: ScopeV1 = account, period: 'T1' | 'T2' | 'T3' = 'T2') {
  const page = await read(scope);
  const row = page.items.find((row) => row.scope.kind === scope.kind);
  const own = row?.publications.find((item) => item.period === period);
  if (!own || own.ownVersion === null) throw new Error('Missing current synthetic customization');
  return {
    contractVersion: 1 as const,
    operation: 'publication-inherit' as const,
    scope,
    period,
    expectedVersion: page.publicationVersion,
    expectedDecisionVersion: own.ownVersion,
    confirmed: true as const,
    idempotencyKey: crypto.randomUUID(),
  };
}
async function option(scope: ScopeV1, value: Record<string, unknown>) {
  const policy = new PolicyServiceV1(sql);
  const current = await policy.read(scope);
  return policy.mutate(READ_ACTOR_V2, {
    contractVersion: 1,
    operation: 'settings-set',
    scope,
    value,
    expectedVersion: current.version,
    idempotencyKey: crypto.randomUUID(),
    acknowledgeImmediateEffect: true,
  });
}
const approved = async (period = 'T2') =>
  (await readScopedSourcesV2(sql, account.accountId, 746001, 746001)).find(
    (item) => item.period === period,
  )?.approved_revision;

it('still reads when the school snapshot predates the Fechamento policy fields (migration 0020, #1132)', async () => {
  const removed = await sql.unsafe(`DELETE FROM student_portal.setting WHERE scope_key='school:2026'
    AND field_key IN ('showTermClosing','termClosingConclusive') RETURNING field_key,value_json,source_scope_json,version`);
  try {
    expect(removed).toHaveLength(2);
    const page = await read();
    expect(page.state).toBe('customizations-read');
  } finally {
    for (const row of removed)
      await sql.unsafe(
        `INSERT INTO student_portal.setting(scope_key,field_key,scope_kind,academic_year,value_json,source_scope_json,version)
        VALUES('school:2026',$1,'school',2026,$2::text::jsonb,$3::text::jsonb,$4)`,
        [
          row.field_key,
          JSON.stringify(row.value_json),
          JSON.stringify(row.source_scope_json),
          row.version,
        ],
      );
  }
});
it('lists a current individual T2 release against the school T1 default, not the school aggregate', async () => {
  await release(sql, READ_SCHOOL_V2, 'T1');
  await release(sql, account, 'T2');
  statements.length = 0;
  const page = await read();
  expect(statements).toHaveLength(2);
  expect(statements.some((q) => /\b(?:INSERT|UPDATE|DELETE|FOR UPDATE)\b/u.test(q))).toBe(false);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    label: 'SYNTHETIC READ STUDENT 001',
    value: null,
    publications: [
      {
        period: 'T2',
        customized: true,
        current: { source: account },
        school: { revision: null },
        inherited: { revision: null },
      },
    ],
  });
  expect(page.items[0]!.publications[0]!.current.revision).toBeTruthy();
  const second = await read({ ...account, accountId: readAccountIdV2(2) });
  expect(second.items).toEqual([]);
  expect(second.context?.publications.find((p) => p.period === 'T2')?.current.revision).toBeNull();
});
it('records a class difference once and exposes its origin in a normally opened student context', async () => {
  await release(sql, READ_CLASS_V2, 'T2');
  expect((await read()).items.map((row) => row.scope)).toEqual([READ_CLASS_V2]);
  const student = await read(account);
  expect(student.items).toEqual([]);
  expect(student.context?.publications.find((p) => p.period === 'T2')).toMatchObject({
    customized: false,
    current: { source: READ_CLASS_V2 },
    school: { revision: null },
  });
});
it('does not list equal, superseded, disabled or previous-class publications as current differences', async () => {
  await release(sql, account, 'T2');
  await release(sql, READ_SCHOOL_V2, 'T2');
  expect((await read()).items).toEqual([]);
  await release(sql, account, 'T2');
  expect((await read()).items).toEqual([]);
  await release(sql, account, 'T3');
  await sql.unsafe('UPDATE gradebook.vinculo SET turma_id=746002 WHERE aluno_id=746001');
  expect((await read()).items).toEqual([]);
  await sql.unsafe('UPDATE student_portal.publication_control_v2 SET enabled=false');
  await expect(read()).rejects.toThrow('preparation-unavailable');
});
it('lists current explicit false, an empty period set and a manual block; inherited/equal options do not duplicate rows', async () => {
  await option(READ_SCHOOL_V2, { accessEnabled: true, allowedPeriods: ['T1', 'T2'] });
  await option(READ_CLASS_V2, { showPartials: false });
  await option(account, { accessEnabled: false, allowedPeriods: [] });
  await sql.unsafe('UPDATE student_portal.account SET blocked=true WHERE id=$1::uuid', [
    readAccountIdV2(2),
  ]);
  const page = await read();
  const first = page.items.find(
    (row) => row.scope.kind === 'account' && row.scope.accountId === account.accountId,
  )!;
  expect(first.value).toMatchObject({ accessEnabled: false, allowedPeriods: [] });
  expect(first.inheritedValue).toMatchObject({ accessEnabled: true, allowedPeriods: ['T1', 'T2'] });
  expect(
    page.items.find(
      (row) => row.scope.kind === 'account' && row.scope.accountId === readAccountIdV2(2),
    )?.blocked,
  ).toBe(true);
  await option(account, { accessEnabled: true, allowedPeriods: ['T2', 'T1'] });
  expect((await read(account)).items).toEqual([]);
});
it('returns to dynamic defaults with a marker, preserves notes/audit and makes the last-difference row disappear', async () => {
  await release(sql, READ_SCHOOL_V2, 'T1');
  await release(sql, account, 'T2');
  const beforeNotes = await sql.unsafe('SELECT * FROM gradebook.fechamento ORDER BY aluno_id');
  const input = await inheritInput();
  const committed = await inheritPublicationV1(sql, READ_ACTOR_V2, input);
  expect(await approved()).toBeNull();
  expect((await read(account)).items).toEqual([]);
  const releaseRows = await sql.unsafe(
    'SELECT version::text,inherit_version::text,target_revision FROM student_portal.publication_release_v2 WHERE scope_kind=$1',
    ['account'],
  );
  expect(releaseRows).toHaveLength(1);
  expect(releaseRows[0]!.inherit_version).toBe(releaseRows[0]!.version);
  expect(releaseRows[0]!.target_revision).toBeTruthy();
  expect(await inheritPublicationV1(sql, READ_ACTOR_V2, input)).toEqual(committed);
  expect(await sql.unsafe('SELECT * FROM gradebook.fechamento ORDER BY aluno_id')).toEqual(
    beforeNotes,
  );
  expect(
    (
      await sql.unsafe(
        "SELECT count(*)::integer AS n FROM student_portal.audit_event WHERE kind='settings-changed'",
      )
    )[0]!.n,
  ).toBe(1);
  await release(sql, READ_SCHOOL_V2, 'T2');
  expect(await approved()).toBeTruthy();
  expect((await read(account)).items).toEqual([]);
  await release(sql, account, 'T2', 'unpublish');
  expect((await read(account)).items[0]?.publications[0]).toMatchObject({
    period: 'T2',
    current: { revision: null },
  });
});
it('preserves independent student exceptions and other periods when a class returns to the school default', async () => {
  await release(sql, READ_CLASS_V2, 'T2');
  await release(sql, account, 'T3');
  await inheritPublicationV1(sql, READ_ACTOR_V2, await inheritInput(READ_CLASS_V2));
  const page = await read();
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.scope).toEqual(account);
  expect(page.items[0]!.publications.map((p) => p.period)).toEqual(['T3']);
  expect(await approved('T2')).toBeNull();
  expect(await approved('T3')).toBeTruthy();
});
it('rejects stale resets and rolls marker, counter and audit back when the receipt cannot commit', async () => {
  await release(sql, account, 'T2');
  const stale = await inheritInput();
  await release(sql, READ_SCHOOL_V2, 'T1');
  await expect(inheritPublicationV1(sql, READ_ACTOR_V2, stale)).rejects.toThrow('version-conflict');
  const input = await inheritInput();
  const before = await sql.unsafe(
    'SELECT * FROM student_portal.publication_release_v2 ORDER BY scope_key,period',
  );
  failReceipt = true;
  await expect(inheritPublicationV1(sql, READ_ACTOR_V2, input)).rejects.toThrow(
    'SYNTHETIC receipt failure',
  );
  failReceipt = false;
  expect(
    await sql.unsafe(
      'SELECT * FROM student_portal.publication_release_v2 ORDER BY scope_key,period',
    ),
  ).toEqual(before);
  expect((await read()).publicationVersion).toBe(input.expectedVersion);
  expect(
    (
      await sql.unsafe(
        "SELECT count(*)::integer AS n FROM student_portal.audit_event WHERE kind='settings-changed'",
      )
    )[0]!.n,
  ).toBe(0);
});
it('paginates more than 100 current owners and applies search/scope filters before the limit', async () => {
  const revision = (
    await sql.unsafe(
      "SELECT generation||':'||revision::text AS revision FROM student_portal.publication_source_head_v2",
    )
  )[0]!.revision;
  await sql.unsafe(
    `INSERT INTO student_portal.publication_release_v2(scope_key,scope_kind,academic_year,account_id,bound_class_id,period,target_revision,version)
    SELECT 'account:2026:'||a.id::text,'account',2026,a.id,746001,'T2',$1,2
    FROM student_portal.account a WHERE a.closed_at IS NULL`,
    [revision],
  );
  await sql.unsafe('UPDATE student_portal.publication_control_v2 SET version=2');
  const first = await read();
  expect(first.items).toHaveLength(100);
  expect(first.nextCursor).toBeTruthy();
  const last = await read(READ_SCHOOL_V2, { page: { limit: 100, cursor: first.nextCursor! } });
  expect(last.items).toHaveLength(5);
  expect(last.nextCursor).toBeNull();
  expect(new Set([...first.items, ...last.items].map((row) => row.id)).size).toBe(105);
  expect((await read(READ_SCHOOL_V2, { nameSearch: 'STUDENT 105' })).items).toHaveLength(1);
  expect((await read({ ...READ_CLASS_V2, classId: 746002 })).items).toEqual([]);
  await expect(
    read(READ_CLASS_V2, { page: { limit: 100, cursor: first.nextCursor! } }),
  ).rejects.toThrow();
  await expect(
    read(READ_SCHOOL_V2, {
      nameSearch: 'changed',
      page: { limit: 100, cursor: first.nextCursor! },
    }),
  ).rejects.toThrow();
});
it('keeps the new query and reset behind the existing strict capability, scope and command contracts', async () => {
  await release(sql, account, 'T2');
  const api = customizationApiV1(sql);
  const input = await inheritInput();
  expect((await api.command(readContextV2(), input)).state).toBe('forbidden');
  expect(adminCommandV1.safeParse({ ...input, scope: READ_SCHOOL_V2 }).success).toBe(false);
  expect(adminCommandV1.safeParse({ ...input, confirmed: false }).success).toBe(false);
  expect(adminCommandV1.safeParse({ ...input, expectedDecisionVersion: undefined }).success).toBe(
    false,
  );
  expect(
    (await api.command({ ...readContextV2(), capability: 'platform.settings.write' }, input)).state,
  ).toBe('committed');
  expect(
    (
      await api.query(readContextV2(), {
        contractVersion: 2,
        operation: 'customizations-read',
        scope: READ_SCHOOL_V2,
        page: { limit: 100 },
      })
    ).state,
  ).toBe('customizations-read');
  const rights = await sql.unsafe(
    "SELECT has_table_privilege('student_portal_app','student_portal.publication_release_v2','DELETE') AS can_delete",
  );
  expect(rights[0]!.can_delete).toBe(false);
});
