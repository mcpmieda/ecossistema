import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
import type { ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { EffectiveSettingsV1 } from '../../../shared/student-portal-contracts/policy-v1';

const SCHOOL = { kind: 'school', academicYear: 2026 } as const;
const CLASS = { kind: 'class', academicYear: 2026, classId: 900001 } as const;
const ACTOR = '11111111-1111-4111-8111-111111111111';
let pg: PGlite;
let service: PolicyServiceV1;
let sql: StudentPortalPostgresSqlV1;
let accountId: string;
let queries: string[] = [];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(`INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES
      (900001,2026,'P1','SYNTHETIC POLICY CLASS ONE',6,'TESTE'),(900002,2026,'P2','SYNTHETIC POLICY CLASS TWO',6,'TESTE');
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES (900001,2026,'SYNTHETIC POLICY STUDENT');
    INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES (2026,900001,1,900001);
    SELECT * FROM student_portal.synchronize_profiles_v1(true);`);
  accountId = (await pg.query<{ id: string }>('SELECT id FROM student_portal.account WHERE gradebook_student_id=900001')).rows[0]!.id;
  sql = {
    async unsafe<R extends Record<string, unknown>>(query: string, parameters: readonly unknown[] = []) {
      queries.push(query);
      return (await pg.query<R>(query, [...parameters])).rows;
    },
    begin: (operation) => pg.transaction((tx) => operation({
      async unsafe<R extends Record<string, unknown>>(query: string, parameters: readonly unknown[] = []) {
        queries.push(query);
        return (await tx.query<R>(query, [...parameters])).rows;
      },
    })),
  };
  service = new PolicyServiceV1(sql);
}, 30_000);

beforeEach(async () => {
  await pg.exec(`TRUNCATE student_portal.setting,student_portal.operation_receipt,student_portal.audit_event,
    student_portal.publication_job;
    UPDATE student_portal.account SET version=0,eligibility='eligible';
    DELETE FROM gradebook.vinculo;
    INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES (2026,900001,1,900001);
    DELETE FROM student_portal.lifecycle_snapshot;
    SELECT * FROM student_portal.synchronize_profiles_v1(false);`);
  queries = [];
});
afterAll(async () => { await pg?.close(); });

const accountScope = (): ScopeV1 => ({ kind: 'account', academicYear: 2026, accountId });
async function set(scope: ScopeV1, value: Partial<EffectiveSettingsV1['value']>, acknowledgeImmediateEffect = true) {
  const current = await service.read(scope);
  return service.mutate(ACTOR, { contractVersion: 1, operation: 'settings-set', scope,
    value, acknowledgeImmediateEffect, expectedVersion: current.version, idempotencyKey: crypto.randomUUID() });
}

describe('durable inherited policy', () => {
  it('requires explicit complete school defaults and never supplies a permissive read fallback', async () => {
    await expect(service.read(SCHOOL)).rejects.toThrow('student-portal-policy-defaults-unavailable');
    const first = await service.initializeDefaults();
    const second = await service.initializeDefaults();
    expect(second).toEqual(first);
    expect(first.settings).toMatchObject({ version: 1, value: { accessEnabled: false, allowedPeriods: [], showFinalResult: false } });
    expect(first.settings.value.calendar.yearEndsAt).toBeNull();
    expect((await pg.query('SELECT count(*)::integer AS count FROM student_portal.setting')).rows).toEqual([{ count: 9 }]);
    await set(CLASS, { accessEnabled: true });
    await pg.exec(`UPDATE student_portal.setting SET value_json='"synthetic-invalid-default"'::jsonb
      WHERE scope_key='school:2026' AND field_key='accessEnabled'`);
    await expect(service.read(accountScope())).rejects.toThrow();
  });

  it('preserves false and empty overrides and restores the immediate parent after removal', async () => {
    await service.initializeDefaults();
    await set(SCHOOL, { accessEnabled: true, allowedPeriods: ['T1'] });
    await set(CLASS, { accessEnabled: false });
    let effective = await service.read(accountScope());
    expect(effective.value.accessEnabled).toBe(false);
    expect(effective.sources.accessEnabled).toEqual(CLASS);
    expect(effective.sources.allowedPeriods).toEqual(SCHOOL);
    await set(accountScope(), { accessEnabled: true, allowedPeriods: [] });
    effective = await service.read(accountScope());
    expect(effective.value).toMatchObject({ accessEnabled: true, allowedPeriods: [] });
    expect(effective.sources.allowedPeriods).toEqual(accountScope());
    await service.mutate(ACTOR, { contractVersion: 1, operation: 'settings-inherit', scope: accountScope(),
      keys: ['accessEnabled', 'allowedPeriods'], expectedVersion: effective.version, idempotencyKey: crypto.randomUUID() });
    expect(await service.read(accountScope())).toMatchObject({ value: { accessEnabled: false, allowedPeriods: ['T1'] },
      sources: { accessEnabled: CLASS, allowedPeriods: SCHOOL } });
  });

  it('reads account, current class and policy in one SQL snapshot and changes version after a move', async () => {
    await service.initializeDefaults();
    await set(CLASS, { accessEnabled: true });
    queries = [];
    const before = await service.readSnapshot(accountScope());
    expect(queries).toHaveLength(1);
    expect(before.classId).toBe(900001);
    await pg.exec(`UPDATE gradebook.vinculo SET turma_id=900002;
      SELECT * FROM student_portal.synchronize_profiles_v1(false);`);
    const after = await service.readSnapshot(accountScope());
    expect(after.classId).toBe(900002);
    expect(after.settings.value.accessEnabled).toBe(false);
    expect(after.settings.version).toBeGreaterThan(before.settings.version);
    expect(after.policyVersion).not.toBe(before.policyVersion);
    await expect(service.mutate(ACTOR, { contractVersion: 1, operation: 'settings-set', scope: accountScope(),
      value: { accessEnabled: false }, acknowledgeImmediateEffect: true, expectedVersion: before.settings.version, idempotencyKey: crypto.randomUUID() }))
      .rejects.toThrow('student-portal-policy-version-conflict');
  });

  it('rejects root inheritance and unresolved account scope', async () => {
    await service.initializeDefaults();
    await expect(service.mutate(ACTOR, { contractVersion: 1, operation: 'settings-inherit', scope: SCHOOL,
      keys: ['risk'], expectedVersion: 1, idempotencyKey: crypto.randomUUID() })).rejects.toThrow('student-portal-school-cannot-inherit');
    await pg.exec('DELETE FROM gradebook.vinculo');
    await expect(service.read(accountScope())).rejects.toThrow('student-portal-policy-target-unresolved');
  });

  it('replays the original command receipt, rejects another payload and does not advance on no-op', async () => {
    await service.initializeDefaults();
    const command = { contractVersion: 1, operation: 'settings-set', scope: SCHOOL,
      value: { accessEnabled: true }, acknowledgeImmediateEffect: true, expectedVersion: 1, idempotencyKey: crypto.randomUUID() };
    const first = await service.mutate(ACTOR, command);
    expect(await service.mutate(ACTOR, command)).toEqual(first);
    await expect(service.mutate(ACTOR, { ...command, value: { accessEnabled: false } })).rejects.toThrow('student-portal-policy-idempotency-conflict');
    const before = await service.readSnapshot(SCHOOL);
    await set(SCHOOL, { accessEnabled: true });
    expect(await service.readSnapshot(SCHOOL)).toEqual(before);
    expect((await pg.query('SELECT count(*)::integer AS count FROM student_portal.audit_event')).rows).toEqual([{ count: 1 }]);
  });

  it('requires acknowledgment for immediate effect and rolls back every field when a later field is rejected', async () => {
    await service.initializeDefaults();
    await expect(set(SCHOOL, { accessEnabled: true }, false)).rejects.toThrow('student-portal-policy-immediate-confirmation-required');
    const original = await service.read(SCHOOL);
    await expect(service.mutate(ACTOR, { contractVersion: 1, operation: 'settings-set', scope: SCHOOL,
      value: { accessEnabled: true, calendar: { ...original.value.calendar, yearStartsAt: '2026-01-01T00:00:00.001Z' } },
      acknowledgeImmediateEffect: true, expectedVersion: original.version, idempotencyKey: crypto.randomUUID() })).rejects.toThrow('student-portal-calendar-second-precision');
    expect(await service.read(SCHOOL)).toEqual(original);
  });

  it('does not require immediate-effect acknowledgment for a future-only date change', async () => {
    await service.initializeDefaults();
    const current = await service.read(SCHOOL);
    const at = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const calendar = { ...current.value.calendar, yearStartsAt: at(-30), yearEndsAt: at(30) };
    await set(SCHOOL, { calendar });
    await expect(set(SCHOOL, { calendar: { ...calendar, yearEndsAt: at(60) } }, false)).resolves.toMatchObject({ version: 3 });
  });

  it('requires acknowledgment when a release date is cleared or added, since a blank release opens with the term', async () => {
    await service.initializeDefaults();
    const current = await service.read(SCHOOL);
    const at = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const none = { T1: null, T2: null, T3: null, REC1: null, REC2: null, REC3: null };
    const released = (T1: string | null) => ({ ...current.value.calendar, yearStartsAt: at(-30), yearEndsAt: at(200),
      disclosure: { mode: 'per-period' as const, at: { ...none, T1 } } });
    await set(SCHOOL, { calendar: released(at(30)) });
    await expect(set(SCHOOL, { calendar: released(null) }, false)).rejects.toThrow('student-portal-policy-immediate-confirmation-required');
    await expect(set(SCHOOL, { calendar: released(at(40)) }, false)).resolves.toBeDefined();
    await set(SCHOOL, { calendar: released(null) });
    await expect(set(SCHOOL, { calendar: released(at(30)) }, false)).rejects.toThrow('student-portal-policy-immediate-confirmation-required');
  });

  it('keeps calendar and risk atomic and invalidates jobs with the old policy version', async () => {
    await service.initializeDefaults();
    const original = await service.read(accountScope());
    const calendar = { ...original.value.calendar, yearStartsAt: '2026-01-01T00:00:00-03:00', yearEndsAt: '2027-01-01T00:00:00-03:00' };
    await set(SCHOOL, { calendar });
    await set(CLASS, { calendar: { ...calendar, yearEndsAt: null } });
    expect((await service.read(accountScope())).value.calendar.yearEndsAt).toBeNull();
    await pg.query(`INSERT INTO student_portal.publication_job(id,account_id,data_version,policy_version,publication_version,state,next_attempt_at)
      VALUES (gen_random_uuid(),$1,'academic:1','policy:old','publication:1','queued',now())`, [accountId]);
    const before = await service.readSnapshot(accountScope());
    await set(SCHOOL, { autoUpdate: true });
    const after = await service.readSnapshot(accountScope());
    expect(after.policyVersion).not.toBe(before.policyVersion);
    expect((await pg.query('SELECT state FROM student_portal.publication_job')).rows).toEqual([{ state: 'failed' }]);
  });

  it('rolls back policy, receipt and audit if the surrounding publication transaction fails', async () => {
    await service.initializeDefaults();
    const before = await service.readSnapshot(SCHOOL);
    await expect(sql.begin(async (tx) => {
      await service.mutateInTransaction(tx, ACTOR, { contractVersion: 1, operation: 'settings-set', scope: SCHOOL,
        value: { showPartials: true }, acknowledgeImmediateEffect: true, expectedVersion: before.settings.version, idempotencyKey: crypto.randomUUID() });
      throw new Error('synthetic-publication-failure');
    })).rejects.toThrow('synthetic-publication-failure');
    expect(await service.readSnapshot(SCHOOL)).toEqual(before);
    expect((await pg.query('SELECT count(*)::integer AS count FROM student_portal.operation_receipt')).rows).toEqual([{ count: 0 }]);
    expect((await pg.query('SELECT count(*)::integer AS count FROM student_portal.audit_event')).rows).toEqual([{ count: 0 }]);
  });
});
