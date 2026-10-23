import { cleanupPortalV1 } from '../../../server/student-portal/maintenance/retention-v1';
import type { AdminReadResponseV2 } from '../../../shared/student-portal-contracts/admin-read-v2';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PortalAdminApiV1 } from '../../../server/student-portal/admin/api-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import { AdminCursorV1 } from '../../../server/student-portal/admin/cursor-v1';
import {
  adminQueryV1,
  type AdminResponseV1,
  type AdminQueryV1,
} from '../../../shared/student-portal-contracts/admin-v1';
import type { FailureV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
import { ACADEMIC_FIXTURE_SQL_V1 } from '../academic/academic-fixture-v1';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const SECRET = 'synthetic-admin-cursor-key-713-'.repeat(3);
const SCHOOL = { kind: 'school', academicYear: 2026 } as const;
const CLASS = { kind: 'class', academicYear: 2026, classId: 910001 } as const;
const context = (capability = 'platform.settings.write') => ({
  actorId: ACTOR,
  tenantId: TENANT,
  requestId: crypto.randomUUID(),
  authenticatedAt: new Date().toISOString(),
  capability,
});
const cryptography = new PortalCryptoV1(
  new Map([[1, new Uint8Array(32).fill(7)]]),
  new Map([[1, new Uint8Array(32).fill(8)]]),
);
let pg: PGlite;
let sql: StudentPortalPostgresSqlV1;
let api: PortalAdminApiV1;
let accounts: { id: string; student: number }[];
let failReceipt = false;
let calls = 0;
let pinVerifier: Awaited<ReturnType<typeof cryptography.deriveVerifier>>;
const accountScope = () =>
  ({ kind: 'account', academicYear: 2026, accountId: accounts[0]!.id }) as const;
function state<T extends AdminResponseV1['state']>(
  result: AdminResponseV1 | AdminReadResponseV2 | FailureV1,
  expected: T,
): Extract<AdminResponseV1, { state: T }> {
  expect(result.state).toBe(expected);
  if (result.state !== expected) throw new Error(`synthetic-unexpected-state-${result.state}`);
  return result as Extract<AdminResponseV1, { state: T }>;
}
async function query<T extends AdminQueryV1['operation']>(
  operation: T,
  extra: Record<string, unknown> = {},
) {
  return state(
    await api.query(context(), { contractVersion: 1, operation, scope: CLASS, page: {}, ...extra }),
    operation,
  );
}
const command = (
  operation: string,
  expectedVersion: number,
  extra: Record<string, unknown> = {},
) => ({
  contractVersion: 1,
  operation,
  expectedVersion,
  idempotencyKey: crypto.randomUUID(),
  ...extra,
});
const version = async () => (await query('accounts', { scope: accountScope() })).items[0]!.version;
const accountCommand = async (operation: string, extra: Record<string, unknown> = {}) =>
  command(operation, await version(), { accountId: accounts[0]!.id, ...extra });
async function setting(value: Record<string, unknown>) {
  const current = await query('settings', { scope: SCHOOL });
  return state(
    await api.command(
      context(),
      command('settings-set', current.settings.version, {
        scope: SCHOOL,
        value,
        acknowledgeImmediateEffect: true,
      }),
    ),
    'committed',
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(ACADEMIC_FIXTURE_SQL_V1);
  await pg.exec(readFileSync('migrations/student-portal/0029_school_calendar_v1.sql', 'utf8'));
  accounts = (
    await pg.query<{ id: string; student: number }>(
      'SELECT id,gradebook_student_id AS student FROM student_portal.account ORDER BY gradebook_student_id',
    )
  ).rows;
  const run = async <R extends Record<string, unknown>>(
    target: Pick<PGlite, 'query'>,
    query: string,
    parameters: readonly unknown[] = [],
  ) => {
    calls++;
    if (failReceipt && query.includes('INSERT INTO student_portal.operation_receipt'))
      throw new Error('synthetic-receipt-failure');
    return (await target.query<R>(query, [...parameters])).rows;
  };
  sql = {
    unsafe: (query, parameters) => run(pg, query, parameters),
    begin: (operation) =>
      pg.transaction((tx) =>
        operation({ unsafe: (query, parameters) => run(tx, query, parameters) }),
      ),
  };
  api = new PortalAdminApiV1(sql, {
    tenantId: TENANT,
    cryptoPort: cryptography,
    qrKeyVersion: 1,
    pepperVersion: 1,
    cursorSecret: SECRET,
  });
  pinVerifier = await cryptography.deriveVerifier('2001', 1);
}, 30_000);
beforeEach(async () => {
  failReceipt = false;
  await pg.exec(`TRUNCATE student_portal.operation_receipt,student_portal.audit_event,student_portal.qr_credential,
    student_portal.password_credential,student_portal.session,student_portal.auth_challenge,student_portal.auth_attempt,
    student_portal.account_access_data,student_portal.setting,student_portal.publication,student_portal.publication_job,
    student_portal.link_closure,student_portal.link_close_preview;
    UPDATE gradebook.vinculo SET turma_id=910001,situacao=NULL;
    UPDATE student_portal.lifecycle_control SET population_enabled=false;`);
  for (const account of accounts)
    await pg.query(
      `UPDATE student_portal.account SET gradebook_student_id=$2,closed_at=NULL,
    auth_state='pending-activation',eligibility='eligible',blocked=false,version=0,security_version=0,pin_version=0 WHERE id=$1`,
      [account.id, account.student],
    );
  await pg.exec('SELECT * FROM student_portal.synchronize_profiles_v1(false)');
  await new PolicyServiceV1(sql).initializeDefaults();
  calls = 0;
});
afterAll(async () => {
  await pg?.close();
});

async function seedRecovery(accountIds = accounts.map((account) => account.id)) {
  const payload = JSON.stringify(accountIds);
  await pg.query(
    `INSERT INTO student_portal.account_access_data(account_id,birth_year,confirmation,version)
    SELECT value::uuid,2001,'confirmed',1 FROM jsonb_array_elements_text($1::jsonb)
    ON CONFLICT (account_id) DO UPDATE SET birth_year=2001,confirmation='confirmed',version=student_portal.account_access_data.version+1`,
    [payload],
  );
  await pg.query(
    `INSERT INTO student_portal.password_credential(account_id,pin_verifier,pin_version)
    SELECT value::uuid,$2::jsonb,1 FROM jsonb_array_elements_text($1::jsonb)
    ON CONFLICT (account_id) DO UPDATE SET pin_verifier=$2::jsonb,pin_version=1`,
    [payload, JSON.stringify(pinVerifier)],
  );
  await pg.query(
    `UPDATE student_portal.account SET pin_version=1,version=version+1
    WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,
    [payload],
  );
}

describe('private administrative API with real persistence', () => {
  // Calendário escolar (owner decision 22/10/2026).
  const day = (date: string, kind = 'letivo', note?: string) => ({ date, kind, ...(note ? { note } : {}) });
  it('is read and written whole, school-wide, with its version and never past 200 school days', async () => {
    // It starts with the official calendar of 2026, saved by migration 0029 (200 school days).
    const official = await query('school-calendar', { scope: SCHOOL });
    expect(official.calendar?.version).toBe(1);
    expect(official.calendar?.days.filter((item) => item.kind !== 'feriado' && item.kind !== 'recesso' && item.kind !== 'evento')).toHaveLength(200);
    // Only the school scope: a class never has a calendar of its own.
    expect((await api.query(context(), { contractVersion: 1, operation: 'school-calendar', scope: CLASS, page: {} })).state).toBe('forbidden');
    const days = [day('2026-03-02'), day('2026-03-03'), day('2026-04-03', 'feriado', 'Paixão de Cristo')];
    const first = command('school-calendar-set', 1, { academicYear: 2026, days });
    const saved = state(await api.command(context(), first), 'committed');
    expect(state(await api.command(context(), first), 'committed')).toMatchObject({ operationId: saved.operationId });
    expect(await query('school-calendar', { scope: SCHOOL })).toMatchObject({
      calendar: { academicYear: 2026, version: 2, days },
    });
    // A write from an older reading is refused (two admins never overwrite each other).
    expect((await api.command(context(), command('school-calendar-set', 1, { academicYear: 2026, days: [] }))).state).toBe('conflict');
    // 201 school days are refused before anything is written.
    const many = Array.from({ length: 201 }, (_, index) =>
      day(new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)),
    );
    expect((await api.command(context(), command('school-calendar-set', 2, { academicYear: 2026, days: many }))).state).toBe('invalid-request');
    expect(await query('school-calendar', { scope: SCHOOL })).toMatchObject({ calendar: { version: 2 } });
    // Exactly 200 is the rule and is accepted.
    state(await api.command(context(), command('school-calendar-set', 2, { academicYear: 2026, days: many.slice(0, 200) })), 'committed');
    expect(await query('school-calendar', { scope: SCHOOL })).toMatchObject({ calendar: { version: 3 } });
  });
  it.each([200, 201, 300])('preserves %i-character accented names through QR batches and V1/V2 cursor pages', async (length) => {
    const original = (await pg.query<{ id: number; nome: string }>(
      'SELECT id,nome FROM gradebook.aluno WHERE id=ANY($1::bigint[])',
      [accounts.map((account) => account.student)],
    )).rows;
    const names = ['A', 'B'].map((prefix) => prefix + 'ÁÉÕÇ'.repeat(75).slice(0, length - 1));
    try {
      for (const [index, account] of accounts.entries())
        await pg.query('UPDATE gradebook.aluno SET nome=$2 WHERE id=$1', [account.student, names[index]]);
      await seedRecovery();
      for (const mode of ['qr-name', 'qr-name-class']) {
        const snapshot = await query('accounts');
        const input = command('qr-batch', snapshot.scopeVersion, {
          classId: CLASS.classId, accountIds: accounts.map((account) => account.id), mode, confirmed: true,
        });
        const result = state(await api.command(context(), input), 'qr');
        expect(result.cards.map((card) => 'name' in card ? card.name : null)).toEqual(names);
        expect(state(await api.command(context(), input), 'qr').cards).toEqual(result.cards);
      }
      for (const contractVersion of [1, 2]) {
        const operation = contractVersion === 1 ? 'accounts' : 'accounts-read';
        const read = async (cursor?: string) => {
          const result = await api.query(context(), {
            contractVersion, operation, scope: CLASS, page: { limit: 1, ...(cursor ? { cursor } : {}) },
          });
          if (result.state !== 'accounts' && result.state !== 'accounts-read')
            throw new Error(`synthetic-long-name-page-${result.state}`);
          return result;
        };
        const first = await read();
        expect(first.items).toHaveLength(1);
        if (contractVersion === 2) expect(first.nextCursor!.length).toBeGreaterThan(512);
        const second = await read(first.nextCursor!);
        expect(second.items).toHaveLength(1);
        const pageNames = [...first.items, ...second.items].map((item) => item.name);
        expect([...pageNames].sort()).toEqual(names);
        if (contractVersion === 2) expect(pageNames).toEqual(names);
        expect(second.items[0]!.accountId).not.toBe(first.items[0]!.accountId);
        expect(second.nextCursor).toBeNull();
        expect((await read(first.nextCursor!)).items).toEqual(second.items);
      }
    } finally {
      for (const row of original) await pg.query('UPDATE gradebook.aluno SET nome=$2 WHERE id=$1', [row.id, row.nome]);
    }
  });

  it('rejects absent, forged, stale, wrong-tenant or insufficient contexts before database access', async () => {
    const request = { contractVersion: 1, operation: 'accounts', scope: SCHOOL, page: {} };
    for (const invalid of [
      null,
      {},
      { ...context(), role: 'ADMINISTRADOR' },
      { ...context(), tenantId: ACTOR },
      { ...context(), authenticatedAt: new Date(Date.now() - 301_000).toISOString() },
      { ...context(), authenticatedAt: new Date(Date.now() + 1000).toISOString() },
    ]) {
      expect((await api.query(invalid, request)).state).toBe('forbidden');
    }
    expect(
      (
        await api.command(
          context('platform.settings.read'),
          command('block', 0, { accountId: accounts[0]!.id, blocked: true, confirmed: true }),
        )
      ).state,
    ).toBe('forbidden');
    expect(calls).toBe(0);
    expect((await api.query(context('platform.settings.read'), request)).state).toBe('accounts');
    expect((await api.query(context(), { ...request, role: 'ADMINISTRADOR' })).state).toBe(
      'invalid-request',
    );
    expect((await api.query(context(), { ...request, page: { limit: 101 } })).state).toBe(
      'invalid-request',
    );
  });

  it('lists only the requested accounts, state, name and class, with bounded scoped keyset cursors', async () => {
    const first = await query('accounts', { page: { limit: 1 } });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await query('accounts', { page: { limit: 1, cursor: first.nextCursor } });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.accountId).not.toBe(first.items[0]!.accountId);
    expect(second.nextCursor).toBeNull();
    const base = {
      contractVersion: 1,
      operation: 'accounts',
      scope: CLASS,
      page: { limit: 1, cursor: first.nextCursor },
    };
    expect((await api.query({ ...context(), actorId: TENANT }, base)).state).toBe(
      'invalid-request',
    );
    expect((await api.query(context(), { ...base, scope: SCHOOL })).state).toBe('invalid-request');
    expect(
      (await api.query(context(), { ...base, page: { limit: 1, cursor: 'a'.repeat(43) } })).state,
    ).toBe('invalid-request');
    expect((await query('accounts', { nameSearch: 'ONE' })).items).toHaveLength(1);
    expect((await query('accounts', { accountState: 'active' })).items).toHaveLength(0);
    expect((await query('accounts', { blocked: true })).items).toHaveLength(0);
    expect((await query('accounts', { scope: { ...CLASS, classId: 910002 } })).items).toHaveLength(
      0,
    );
    expect(JSON.stringify(first)).not.toMatch(
      /credential|password|birth|token|verifier|PRIVATE TEACHER/,
    );
  });

  it('issues, reprints, rotates and resets with account CAS, distinct semantics and explicit confirmation', async () => {
    await seedRecovery();
    const issue = state(await api.command(context(), await accountCommand('qr-issue')), 'qr');
    const reprint = state(await api.command(context(), await accountCommand('qr-reprint')), 'qr');
    expect(reprint.cards[0]!.qr).toBe(issue.cards[0]!.qr);
    const rotate = await accountCommand('qr-regenerate', { confirmed: true });
    const regenerated = state(await api.command(context(), rotate), 'qr');
    expect(regenerated.cards[0]!.qr).not.toBe(issue.cards[0]!.qr);
    expect(
      (await api.command(context(), { ...rotate, idempotencyKey: crypto.randomUUID() })).state,
    ).toBe('conflict');
    expect(
      (
        await api.command(context(), {
          ...rotate,
          expectedVersion: await version(),
          confirmed: false,
        })
      ).state,
    ).toBe('invalid-request');
    for (const operation of ['password-reset', 'account-reset']) {
      state(
        await api.command(context(), await accountCommand(operation, { confirmed: true })),
        'committed',
      );
      expect((await query('accounts', { scope: accountScope() })).items[0]!.state).toBe(
        operation === 'password-reset' ? 'reset-required' : 'pending-activation',
      );
    }
    for (const blocked of [true, false]) {
      state(
        await api.command(context(), await accountCommand('block', { blocked, confirmed: true })),
        'committed',
      );
      expect((await query('accounts', { scope: accountScope() })).items[0]!.blocked).toBe(blocked);
    }
    expect(
      (await api.command(context(), command('qr-issue', 0, { accountId: crypto.randomUUID() })))
        .state,
    ).toBe('forbidden');
  });

  it('prints all three batch modes atomically, retains active QRs and safely replays a committed reference', async () => {
    await seedRecovery();
    let previous: string[] | null = null;
    for (const mode of ['qr-only', 'qr-name', 'qr-name-class']) {
      const snapshot = await query('accounts');
      const input = command('qr-batch', snapshot.scopeVersion, {
        classId: CLASS.classId,
        accountIds: accounts.map((account) => account.id),
        mode,
        confirmed: true,
      });
      const beforeCalls = calls;
      const result = state(await api.command(context(), input), 'qr');
      expect(calls - beforeCalls).toBeLessThan(20);
      expect(result.cards).toHaveLength(2);
      const retry = state(await api.command(context(), input), 'qr');
      expect(retry.cards).toEqual(result.cards);
      expect(retry.version).toBe(result.version);
      const urls = result.cards.map((card) => card.qr);
      if (previous) expect(urls).toEqual(previous);
      previous = urls;
      expect(
        result.cards.every(
          (card) =>
            'name' in card === (mode !== 'qr-only') &&
            'classLabel' in card === (mode === 'qr-name-class'),
        ),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/birth|password|verifier|pin|tokenHash/);
      expect(
        (
          await api.command(context(), {
            ...input,
            mode: mode === 'qr-only' ? 'qr-name' : 'qr-only',
          })
        ).state,
      ).toBe('conflict');
    }
    expect(
      (
        await pg.query<{ n: number }>(
          'SELECT count(*)::integer AS n FROM student_portal.qr_credential',
        )
      ).rows[0]!.n,
    ).toBe(2);
  });

  it('rejects another class or duplicate ids and rolls back the entire QR batch when the receipt cannot commit', async () => {
    await seedRecovery();
    const snapshot = await query('accounts');
    const input = command('qr-batch', snapshot.scopeVersion, {
      classId: CLASS.classId,
      accountIds: accounts.map((account) => account.id),
      confirmed: true,
    });
    expect((await api.command(context(), { ...input, classId: 910002 })).state).toBe('forbidden');
    expect(
      (
        await api.command(context(), {
          ...input,
          accountIds: [accounts[0]!.id, accounts[0]!.id.toUpperCase()],
        })
      ).state,
    ).toBe('invalid-request');
    failReceipt = true;
    expect((await api.command(context(), input)).state).toBe('unavailable');
    failReceipt = false;
    expect(
      (
        await pg.query<{ n: number }>(
          'SELECT count(*)::integer AS n FROM student_portal.qr_credential',
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect((await query('accounts')).scopeVersion).toBe(snapshot.scopeVersion);
    state(await api.command(context(), input), 'qr');
    await api.command(context(), await accountCommand('qr-regenerate', { confirmed: true }));
    expect((await api.command(context(), input)).state).toBe('conflict');
  });

  it('rejects obsolete manual birth commands from an authorized current or old client without changing credentials', async () => {
    const initial = await query('birth-years');
    const item = initial.items.find((entry) => entry.accountId === accounts[0]!.id)!;
    const write = command('birth-write', item.accountVersion, {
      item: { action: 'set', accountId: item.accountId, expectedVersion: item.version,
        year: '2001', confirmation: 'confirmed' },
    });
    const batch = command('birth-batch', initial.scopeVersion, {
      classId: CLASS.classId, expectedCount: initial.items.length,
      items: initial.items.map((entry) => ({ action: 'clear', accountId: entry.accountId, expectedVersion: entry.version })),
      confirmed: true,
    });
    for (const input of [write, write, batch, batch]) {
      expect((await api.command(context(), input)).state).toBe('invalid-request');
    }
    expect(await query('birth-years')).toMatchObject({ ...initial, requestId: expect.any(String) });
    expect((await pg.query('SELECT account_id FROM student_portal.password_credential')).rows).toEqual([]);
    expect((await query('audit')).items).toEqual([]);
  });
  it('lists sessions without hashes and revokes only the selected account session', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (let index = 0; index < 2; index++)
      await pg.query(
        `INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES ($1,$2,$3,0,statement_timestamp()+interval '1 day',false)`,
        [ids[index], accounts[index]!.id, `synthetic-only-hash-${index}`.padEnd(43, 'x')],
      );
    const list = await query('sessions', { scope: accountScope() });
    expect(list.items.map((item) => item.sessionId)).toEqual([ids[0]]);
    expect(JSON.stringify(list)).not.toContain('hash');
    state(
      await api.command(
        context(),
        command('sessions-revoke', list.version, {
          scope: accountScope(),
          sessionId: ids[1],
          confirmed: true,
        }),
      ),
      'committed',
    );
    expect(
      (await query('sessions', { scope: SCHOOL })).items.every((item) => item.revokedAt === null),
    ).toBe(true);
    state(
      await api.command(
        context(),
        command('sessions-revoke', list.version, {
          scope: accountScope(),
          sessionId: ids[0],
          confirmed: true,
        }),
      ),
      'committed',
    );
    const current = await query('sessions', { scope: SCHOOL });
    expect(current.items.find((item) => item.sessionId === ids[0])!.revokedAt).not.toBeNull();
    expect(current.items.find((item) => item.sessionId === ids[1])!.revokedAt).toBeNull();
  });

  it('dispatches settings inheritance and refuses legacy publication without scoped V2', async () => {
    const initial = await query('settings');
    state(
      await api.command(
        context(),
        command('settings-set', initial.settings.version, {
          scope: CLASS,
          value: { showPartials: true },
          acknowledgeImmediateEffect: true,
        }),
      ),
      'committed',
    );
    const changed = await query('settings');
    expect(changed.settings.value.showPartials).toBe(true);
    state(
      await api.command(
        context(),
        command('settings-inherit', changed.settings.version, {
          scope: CLASS,
          keys: ['showPartials'],
        }),
      ),
      'committed',
    );
    expect((await query('settings')).settings.value.showPartials).toBe(false);
    const current = (await query('settings', { scope: SCHOOL })).settings.value.calendar;
    const at = (offset: number) =>
      new Date(Math.floor(Date.now() / 1000) * 1000 + offset * 86400_000).toISOString();
    await setting({
      accessEnabled: true,
      allowedPeriods: ['T1'],
      calendar: {
        ...current,
        yearStartsAt: at(-60),
        t1EndsAt: at(-50),
        t2EndsAt: at(-40),
        t3EndsAt: at(-30),
        recoveriesStartAt: at(-20),
        finalDisclosureAt: at(-10),
        yearEndsAt: at(30),
        disclosure: { mode: 'single', at: at(-10), periods: ['T1'] },
      },
    });
    // Scoped V2 is the only publisher; without it the legacy commands fail closed.
    for (const operation of ['publish', 'publish-update', 'unpublish']) {
      const t1 = (await query('publication', { scope: accountScope() })).items[0]!;
      const extra =
        operation === 'unpublish'
          ? { confirmed: true }
          : { targetDataVersion: t1.availableRevision ?? 'synthetic:1' };
      const result = await api.command(
        context(),
        command(operation, t1.version, { scope: accountScope(), period: 'T1', ...extra }),
      );
      expect(result.state).toBe('unavailable');
    }
    expect((await pg.query('SELECT 1 FROM student_portal.publication_job')).rows).toHaveLength(0);
  });

  it('starts the school population idempotently and removes pilot policy overrides', async () => {
    expect(
      (
        await api.query(context(), {
          contractVersion: 1,
          operation: 'population',
          scope: CLASS,
          page: {},
        })
      ).state,
    ).toBe('forbidden');
    const accountSettings = await query('settings', { scope: accountScope() });
    state(
      await api.command(
        context(),
        command('settings-set', accountSettings.settings.version, {
          scope: accountScope(),
          value: { showPartials: true },
          acknowledgeImmediateEffect: true,
        }),
      ),
      'committed',
    );
    const before = await query('population', { scope: SCHOOL });
    expect(before).toMatchObject({
      enabled: false,
      sourceProfiles: 2,
      accounts: 2,
      missingProfiles: 0,
      overrideRows: 1,
    });
    const input = command('population-start', before.version, {
      academicYear: 2026,
      clearOverrides: true,
      confirmed: true,
    });
    expect((await api.command(context(), { ...input, confirmed: false })).state).toBe(
      'invalid-request',
    );
    const first = state(await api.command(context(), input), 'committed');
    const replay = state(await api.command(context(), input), 'committed');
    expect(replay).toMatchObject({ operationId: first.operationId, version: first.version });
    expect(await query('population', { scope: SCHOOL })).toMatchObject({
      enabled: true,
      sourceProfiles: 2,
      accounts: 2,
      missingProfiles: 0,
      overrideRows: 0,
    });
    expect(
      (
        await api.command(context(), {
          ...input,
          expectedVersion: first.version,
          idempotencyKey: crypto.randomUUID(),
        })
      ).state,
    ).toBe('conflict');
    expect(
      (
        await pg.query<{ n: number }>(
          "SELECT count(*)::integer AS n FROM student_portal.audit_event WHERE kind='settings-changed'",
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  });

  it('paginates audit tuples precisely, masks lists and restricts raw IP to write capability within ninety days', async () => {
    await seedRecovery();
    for (const account of accounts) {
      const current = Number(
        (
          await pg.query<{ version: string }>(
            'SELECT version::text FROM student_portal.account WHERE id=$1',
            [account.id],
          )
        ).rows[0]!.version,
      );
      await api.command(context(), command('qr-issue', current, { accountId: account.id }));
    }
    await pg.exec(
      "UPDATE student_portal.audit_event SET occurred_at=date_trunc('second',statement_timestamp())+interval '0.123456 seconds',raw_ip='192.0.2.10',masked_ip='192.0.2.0/24',ip_expires_at=statement_timestamp()+interval '1 day'",
    );
    const first = await query('audit', { page: { limit: 1 } });
    const second = await query('audit', { page: { limit: 1, cursor: first.nextCursor } });
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]!.eventId).not.toBe(second.items[0]!.eventId);
    expect(first.items[0]!.maskedIp).toBe('192.0.2.0/24');
    expect(JSON.stringify(first)).not.toContain('192.0.2.10');
    const request = {
      contractVersion: 1,
      operation: 'audit-detail',
      scope: SCHOOL,
      page: {},
      eventId: first.items[0]!.eventId,
    };
    expect((await api.query(context('platform.settings.read'), request)).state).toBe('forbidden');
    expect(state(await api.query(context(), request), 'audit-detail').ip).toBe('192.0.2.10');
    await pg.query(
      "UPDATE student_portal.audit_event SET occurred_at=statement_timestamp()-interval '91 days' WHERE event_id=$1",
      [request.eventId],
    );
    expect(state(await api.query(context(), request), 'audit-detail')).toMatchObject({
      ip: null,
      ipExpiresAt: null,
    });
    expect(
      (await api.query(context(), { ...request, scope: { ...CLASS, classId: 910002 } })).state,
    ).toBe('forbidden');
  });

  it('rejects expired cursors, irrelevant query filters and unavailable databases without returning partial data', async () => {
    const parsed = adminQueryV1.parse({
      contractVersion: 1,
      operation: 'accounts',
      scope: CLASS,
      page: { limit: 1 },
    });
    const cursor = await new AdminCursorV1(SECRET).next(
      parsed,
      ACTOR,
      new Date(Date.now() - 301_000),
      accounts[0]!.id,
    );
    expect((await api.query(context(), { ...parsed, page: { limit: 1, cursor } })).state).toBe(
      'invalid-request',
    );
    expect(
      (await api.query(context(), { ...parsed, operation: 'settings', nameSearch: 'ignored' }))
        .state,
    ).toBe('invalid-request');
    const broken: StudentPortalPostgresSqlV1 = {
      unsafe: async () => {
        throw new Error('private-db-error');
      },
      begin: async () => {
        throw new Error('private-db-error');
      },
    };
    const other = new PortalAdminApiV1(broken, {
      tenantId: TENANT,
      cryptoPort: cryptography,
      qrKeyVersion: 1,
      pepperVersion: 1,
      cursorSecret: SECRET,
    });
    const result = await other.query(context(), parsed);
    expect(result.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private-db-error');
  });

  it('reports sanitized health and requires school preview for idempotent link closure without resetting the BN', async () => {
    await seedRecovery();
    state(
      await api.command({ ...context(), clientIp: '192.0.2.71' }, await accountCommand('qr-issue')),
      'qr',
    );
    await pg.exec(
      "UPDATE student_portal.audit_event SET occurred_at=statement_timestamp()-interval '91 days',ip_expires_at=statement_timestamp()-interval '1 day'",
    );
    expect(await query('health')).toMatchObject({ status: 'intervention' });
    await cleanupPortalV1(sql);
    expect(await query('health')).toMatchObject({ status: 'normal' });
    await pg.query(
      `INSERT INTO student_portal.publication_job(id,account_id,data_version,policy_version,publication_version,state,attempts,next_attempt_at)
      VALUES ($1,$2,'synthetic-data','synthetic-policy','synthetic-publication','queued',0,statement_timestamp()-interval '6 minutes')`,
      [crypto.randomUUID(), accounts[0]!.id],
    );
    expect(await query('health')).toMatchObject({ status: 'attention' });
    await pg.exec("UPDATE student_portal.publication_job SET state='failed',attempts=5");
    expect(await query('health')).toMatchObject({ status: 'intervention' });
    await pg.exec('UPDATE student_portal.publication_job SET attempts=0');
    expect(await query('health')).toMatchObject({ status: 'normal' });
    expect(
      (
        await api.query(context(), {
          contractVersion: 1,
          operation: 'links-preview',
          scope: CLASS,
          page: {},
        })
      ).state,
    ).toBe('forbidden');
    const before = (
      await pg.query<{ n: number }>('SELECT count(*)::integer AS n FROM gradebook.aluno')
    ).rows[0]!.n;
    const preview = await query('links-preview', { scope: SCHOOL });
    const input = command('links-close', preview.version, {
      academicYear: 2026,
      previewToken: preview.previewToken,
      expectedCount: preview.count,
      confirmed: true,
    });
    expect((await api.command(context(), { ...input, confirmed: false })).state).toBe(
      'invalid-request',
    );
    const first = state(await api.command(context(), input), 'committed');
    const replay = state(await api.command(context(), input), 'committed');
    expect(replay.operationId).toBe(first.operationId);
    expect(replay.version).toBe(first.version);
    expect(
      (await query('accounts', { scope: SCHOOL })).items.every((item) => item.link === null),
    ).toBe(true);
    expect(
      (await pg.query<{ n: number }>('SELECT count(*)::integer AS n FROM gradebook.aluno')).rows[0]!
        .n,
    ).toBe(before);
    expect(
      (await api.command(context(), { ...input, expectedCount: preview.count + 1 })).state,
    ).toBe('conflict');
  });

  it('accepts the full one-hundred-card boundary with bounded SQL rather than per-account round trips', async () => {
    await pg.exec(`INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno)
      VALUES (910003,2026,'S713','SYNTHETIC BATCH CLASS',6,'TESTE');
      INSERT INTO gradebook.aluno(id,ano,nome) SELECT 930000+n,2026,'SYNTHETIC BATCH '||n FROM generate_series(1,100) n;
      INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) SELECT 2026,910003,n,930000+n FROM generate_series(1,100) n;
      SELECT * FROM student_portal.synchronize_profiles_v1(true);`);
    let list = await query('accounts', {
      scope: { ...CLASS, classId: 910003 },
      page: { limit: 100 },
    });
    expect(list.items).toHaveLength(100);
    expect(list.nextCursor).toBeNull();
    await seedRecovery(list.items.map((item) => item.accountId));
    list = await query('accounts', { scope: { ...CLASS, classId: 910003 }, page: { limit: 100 } });
    const input = command('qr-batch', list.scopeVersion, {
      classId: 910003,
      accountIds: list.items.map((item) => item.accountId),
      mode: 'qr-only',
      confirmed: true,
    });
    const before = calls;
    const result = state(await api.command(context(), input), 'qr');
    expect(result.cards).toHaveLength(100);
    expect(new Set(result.cards.map((card) => card.qr)).size).toBe(100);
    expect(calls - before).toBeLessThan(20);
  });
});
