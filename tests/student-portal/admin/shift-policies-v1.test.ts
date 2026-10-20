// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { PolicyScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { POLICY_FIELDS_V1 } from '../../../shared/student-portal-contracts/policy-v1';
import { adminCommandV1, adminQueryV1 } from '../../../shared/student-portal-contracts/admin-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import { readScopedSourcesV2 } from '../../../server/student-portal/publication/scoped-source-v2';
import { CUSTOM_ACCOUNT_V1 as ACCOUNT, customizationApiV1, installCustomizationFixtureV1,
  releaseCustomizationV1, resetCustomizationFixtureV1 } from './customizations-fixture-827';
import { READ_ACTOR_V2, READ_CLASS_V2 as CLASS, READ_SCHOOL_V2 as SCHOOL, readContextV2 } from './read-fixture-v2';

const MORNING = { kind: 'shift', academicYear: 2026, shift: 'MATUTINO' } as const;
const AFTERNOON = { ...MORNING, shift: 'VESPERTINO' } as const;
const NIGHT = { ...MORNING, shift: 'NOTURNO' } as const;
let pg: PGlite, sql: StudentPortalPostgresSqlV1, policy: PolicyServiceV1;
let originalPin: Record<string, unknown>;
const pinMetadata = () => sql.unsafe(`SELECT p.proowner,p.proacl,p.prosecdef,p.proconfig,
  has_function_privilege('student_portal_app',p.oid,'EXECUTE') AS runtime_execute
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='student_portal' AND p.proname='pin_publication_auto_approval_v2'`);

beforeAll(async () => {
  pg = new PGlite();
  const run = async <R extends Record<string, unknown>>(db: Pick<PGlite, 'query'>, query: string, args: readonly unknown[] = []): Promise<R[]> =>
    (await db.query<R>(query, [...args])).rows;
  sql = { unsafe: (q, p) => run(pg, q, p), begin: (cb) => pg.transaction((tx) => cb({ unsafe: (q, p) => run(tx, q, p) })) };
  await installCustomizationFixtureV1(pg, sql);
  originalPin = (await pinMetadata())[0]!;
  // Apply the real complete migration after the atomic-publication foundation; the shared
  // historical fixture installs only the narrow view for old-policy compatibility reads.
  for (const name of ['0021_access_schedule_v1.sql', '0022_shift_policy_v1.sql', '0027_frequency_policy_v1.sql'])
    await pg.exec(readFileSync('migrations/student-portal/' + name, 'utf8'));
  policy = new PolicyServiceV1(sql);
}, 30_000);
afterAll(async () => pg?.close());
beforeEach(async () => {
  await resetCustomizationFixtureV1(sql);
  await sql.unsafe('DELETE FROM student_portal.setting');
  await policy.initializeDefaults();
  await sql.unsafe('DELETE FROM student_portal.publication_auto_approval_v2');
  await sql.unsafe("UPDATE gradebook.turma SET turno=CASE id WHEN 746001 THEN ' matutino ' WHEN 746002 THEN 'VESPERTINO' ELSE 'TESTE' END WHERE ano=2026");
});
async function set(scope: PolicyScopeV1, value: Record<string, unknown>) {
  const current = await policy.read(scope);
  return policy.mutate(READ_ACTOR_V2, { contractVersion: 1, operation: 'settings-set', scope, value,
    expectedVersion: current.version, idempotencyKey: crypto.randomUUID(), acknowledgeImmediateEffect: true });
}
async function inherit(scope: PolicyScopeV1, keys: readonly string[]) {
  return policy.mutate(READ_ACTOR_V2, { contractVersion: 1, operation: 'settings-inherit', scope, keys,
    expectedVersion: (await policy.read(scope)).version, idempotencyKey: crypto.randomUUID() });
}
async function inventory(operation: 'customizations-read' | 'settings-overrides', cursor?: string) {
  const result = await customizationApiV1(sql).query(readContextV2(), { contractVersion: 2, operation, scope: SCHOOL,
    page: { limit: 1, ...(cursor ? { cursor } : {}) } });
  if (result.state !== operation) throw new Error(`Unexpected inventory state: ${result.state}`);
  return result;
}
async function advanceSource() {
  await sql.begin(async (tx) => {
    await tx.unsafe('UPDATE gradebook.fechamento SET am1_fonte=am1_fonte+1 WHERE aluno_id=746001');
    await tx.unsafe('UPDATE student_portal.academic_revision SET academic_counter=academic_counter+1 WHERE academic_year=2026');
  });
  return (await sql.unsafe("SELECT generation||':'||revision::text AS revision FROM student_portal.publication_source_head_v2"))[0]!.revision;
}
const selectedRevision = async () => (await readScopedSourcesV2(sql, ACCOUNT.accountId, 746001, 746001))
  .find((row) => row.period === 'T1')!.target_revision;

it('normalizes current Relação shifts and keeps the view and replacement pin private', async () => {
  const result = await customizationApiV1(sql).query(readContextV2(), {
    contractVersion: 2, operation: 'shifts-read', scope: SCHOOL, page: { limit: 100 },
  });
  expect(result).toMatchObject({ state: 'shifts-read', items: [
    { shift: 'MATUTINO', ownFields: [], classes: [{ classId: 746001, label: 'R746-001', ownFields: [] }] },
    { shift: 'VESPERTINO', ownFields: [], classes: [{ classId: 746002, label: 'R746-002', ownFields: [] }] },
  ] });
  expect((await sql.unsafe('SELECT shift FROM student_portal.academic_class_v1 WHERE class_id=746003'))[0]!.shift).toBeNull();
  expect(await sql.unsafe('SELECT * FROM student_portal.academic_class_v1 WHERE academic_year<>2026')).toEqual([]);
  expect((await pinMetadata())[0]).toEqual(originalPin);
  expect(originalPin).toMatchObject({ prosecdef: true, proconfig: ['search_path=pg_catalog'], runtime_execute: false });
  expect((await sql.unsafe(`SELECT
    has_table_privilege('student_portal_app','student_portal.academic_class_v1','SELECT') AS can_read,
    has_table_privilege('student_portal_app','student_portal.academic_class_v1','UPDATE') AS can_write,
    has_table_privilege('student_portal_app','gradebook.turma','SELECT') AS direct_read,
    COALESCE((SELECT bool_or(a.grantee=0 AND a.privilege_type='SELECT') FROM pg_class c,
      LATERAL aclexplode(c.relacl) a WHERE c.oid='student_portal.academic_class_v1'::regclass),false) AS public_read`))[0])
    .toEqual({ can_read: true, can_write: false, direct_read: false, public_read: false });
  await expect(sql.unsafe(`INSERT INTO student_portal.setting(scope_key,field_key,scope_kind,value_json,source_scope_json,version)
    VALUES('shift:2026:INVALID','autoUpdate','shift','false','{"kind":"shift"}',1)`)).rejects.toMatchObject({ code: '23514' });
});

it('applies all eleven policy fields, preserves inactive class choices and restores them on inherit', async () => {
  const defaults = initialPolicyDefaultsV1();
  const classValues = { ...defaults, accessEnabled: true, accessSchedule: [{ at: '2026-10-01T12:00:00Z', action: 'close' }],
    showPartials: true, autoUpdate: true, showFinalResult: true, showTermClosing: true,
    termClosingConclusive: false, showFrequency: true, allowedPeriods: ['T1'], risk: { ...defaults.risk, blockSeconds: 600 },
    calendar: { ...defaults.calendar, finalDisclosureAt: '2026-12-01T12:00:00Z' } };
  const shiftValues = { ...defaults, accessSchedule: [] };
  await set(CLASS, classValues);
  await set(MORNING, shiftValues);
  for (const scope of [CLASS, ACCOUNT]) {
    const effective = await policy.read(scope);
    expect(effective.value).toEqual(shiftValues);
    for (const field of POLICY_FIELDS_V1) expect(effective.sources[field]).toEqual(MORNING);
  }
  await set(ACCOUNT, { showPartials: true });
  expect((await policy.read(ACCOUNT)).sources.showPartials).toEqual(ACCOUNT);
  const suspended = await sql.unsafe("SELECT field_key,value_json FROM student_portal.setting WHERE scope_key='class:2026:746001' ORDER BY field_key");
  await inherit(MORNING, POLICY_FIELDS_V1);
  expect((await policy.read(CLASS)).value).toEqual(classValues);
  expect(await sql.unsafe("SELECT field_key,value_json FROM student_portal.setting WHERE scope_key='class:2026:746001' ORDER BY field_key")).toEqual(suspended);
});

it('keeps current class/shift lookup equal for single and batched account reads', async () => {
  await set(MORNING, { accessEnabled: true });
  const first = await policy.readSnapshot(ACCOUNT);
  const result = await customizationApiV1(sql).query(readContextV2(), {
    contractVersion: 2, operation: 'accounts-read', scope: ACCOUNT, page: { limit: 100 },
  });
  expect(result).toMatchObject({ state: 'accounts-read', items: [{ access: { source: MORNING, settingsVersion: first.settings.version } }] });
  await sql.unsafe("UPDATE gradebook.turma SET turno='VESPERTINO' WHERE id=746001");
  const second = await policy.readSnapshot(ACCOUNT);
  expect(second.settings.sources.accessEnabled).toEqual(SCHOOL);
  expect(second.policyVersion).not.toBe(first.policyVersion);
});

it('rejects new settings for absent shifts but permits removing an old shift override', async () => {
  const api = customizationApiV1(sql);
  const input = { contractVersion: 1, operation: 'settings-set', scope: NIGHT, value: { accessEnabled: false },
    expectedVersion: (await policy.read(NIGHT)).version, idempotencyKey: crypto.randomUUID(), acknowledgeImmediateEffect: true };
  expect((await api.command({ ...readContextV2(), capability: 'platform.settings.write' }, input)).state).toBe('invalid-request');
  await set(MORNING, { accessEnabled: true });
  await sql.unsafe("UPDATE gradebook.turma SET turno='TESTE' WHERE id=746001");
  await expect(set(MORNING, { accessEnabled: false })).rejects.toThrow('shift-invalid-request');
  await inherit(MORNING, ['accessEnabled']);
  expect(await sql.unsafe("SELECT 1 FROM student_portal.setting WHERE scope_key='shift:2026:MATUTINO'")).toEqual([]);
  for (const operation of ['publication', 'sessions', 'accounts'])
    expect(adminQueryV1.safeParse({ contractVersion: 1, operation, scope: MORNING, page: { limit: 1 } }).success).toBe(false);
  expect(adminCommandV1.safeParse({ contractVersion: 1, operation: 'sessions-revoke', scope: MORNING,
    expectedVersion: 1, idempotencyKey: crypto.randomUUID(), confirmed: true }).success).toBe(false);
  expect(adminCommandV1.safeParse({ contractVersion: 1, operation: 'unpublish', scope: MORNING, period: 'T1',
    expectedVersion: 1, idempotencyKey: crypto.randomUUID(), confirmed: true }).success).toBe(false);
});

it('paginates shift owners and lists schedules without a school schedule, hiding suspended class choices', async () => {
  await set(CLASS, { showPartials: true });
  await set(MORNING, { showPartials: false, accessSchedule: [] });
  await set(AFTERNOON, { accessSchedule: [] });
  for (const operation of ['customizations-read', 'settings-overrides'] as const) {
    let page = await inventory(operation);
    const items = [...page.items];
    while (page.nextCursor) { page = await inventory(operation, page.nextCursor); items.push(...page.items); }
    const shifts = items.filter((item) => item.scope.kind === 'shift');
    expect(shifts).toHaveLength(2);
    expect(shifts.every((item) => item.value?.accessSchedule?.length === 0)).toBe(true);
    if (operation === 'customizations-read') expect(items.some((item) => item.scope.kind === 'class')).toBe(false);
  }
  await inherit(MORNING, ['showPartials']);
  expect((await inventory('customizations-read')).items[0]).toMatchObject({ scope: CLASS, value: { showPartials: true } });
});

it('freezes a published edition when shift auto-update is OFF despite school and class ON', async () => {
  await releaseCustomizationV1(sql, SCHOOL, 'T1');
  await set(SCHOOL, { autoUpdate: true });
  await set(CLASS, { autoUpdate: true });
  await set(MORNING, { autoUpdate: false });
  const frozen = await selectedRevision();
  const next = await advanceSource();
  expect(next).not.toBe(frozen);
  expect(await selectedRevision()).toBe(frozen);
  await set(ACCOUNT, { autoUpdate: true });
  expect(await selectedRevision()).toBe(next);
});

it('pins shift auto-update editions and preserves the last one when the shift turns OFF', async () => {
  await releaseCustomizationV1(sql, SCHOOL, 'T1');
  await set(MORNING, { autoUpdate: true });
  const approved = await advanceSource();
  expect(await selectedRevision()).toBe(approved);
  await set(MORNING, { autoUpdate: false });
  expect(await selectedRevision()).toBe(approved);
  await advanceSource();
  expect(await selectedRevision()).toBe(approved);
});
