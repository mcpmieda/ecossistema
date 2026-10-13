import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthServiceV1 } from '../../../server/student-portal/auth/auth-service-v1';
import { QrServiceV1 } from '../../../server/student-portal/auth/qr-service-v1';
import { SessionServiceV1 } from '../../../server/student-portal/auth/session-service-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import { BirthYearServiceV1 } from '../birth-year/legacy-birth-fixture-v1';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import type { CryptoPortV1 } from '../../../shared/student-portal-contracts/ports-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
import { servePortalAuthV1 } from '../../../server/student-portal/http/auth/handler-v1';
import { ACCESS_CLOSED_ACCEPT_HEADER_V1 } from '../../../shared/student-portal-contracts/auth-v1';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const SCHOOL = { kind: 'school', academicYear: 2026 } as const;
const ORIGIN = 'https://aluno.escolaieda.com';
const cryptoPort = new PortalCryptoV1(
  new Map([[1, new Uint8Array(32).fill(11)]]),
  new Map([[1, new Uint8Array(32).fill(22)]]),
);
let pg: PGlite;
let sql: StudentPortalPostgresSqlV1;
let auth: AuthServiceV1;
let qrService: QrServiceV1;
let sessions: SessionServiceV1;
let birth: BirthYearServiceV1;
let policy: PolicyServiceV1;
let accountId: string;
let qr: string;
let failAudit = false;
let consumeMiss = false;
let nowCalls = 0;
let shiftNowAtCall = 0;
const risk = { verify: vi.fn(async (token: string) => token === 'synthetic-valid-risk') };
const id = () => crypto.randomUUID();

function cryptoWithV1(overrides: Partial<CryptoPortV1> = {}): CryptoPortV1 {
  return {
    randomToken: (bytes) => cryptoPort.randomToken(bytes),
    hashOpaqueToken: (token) => cryptoPort.hashOpaqueToken(token),
    deriveVerifier: (secret, pepperVersion) => cryptoPort.deriveVerifier(secret, pepperVersion),
    verifySecret: (secret, verifier) => cryptoPort.verifySecret(secret, verifier),
    signQr: (credentialId, keyVersion) => cryptoPort.signQr(credentialId, keyVersion),
    verifyQr: (credentialId, keyVersion, signature) =>
      cryptoPort.verifyQr(credentialId, keyVersion, signature),
    ...overrides,
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(`INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES (900001,2026,'A1','SYNTHETIC AUTH CLASS',6,'TESTE');
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES (900001,2026,'SYNTHETIC AUTH STUDENT');
    INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES (2026,900001,1,900001);
    SELECT * FROM student_portal.synchronize_profiles_v1(true);`);
  accountId = (await pg.query<{ id: string }>('SELECT id FROM student_portal.account')).rows[0]!.id;
  const run = async <R extends Record<string, unknown>>(
    target: Pick<PGlite, 'query'>,
    query: string,
    parameters: readonly unknown[] = [],
  ) => {
    if (failAudit && query.includes('INSERT INTO student_portal.audit_event'))
      throw new Error('synthetic-db-failure');
    // Simulates a proof consumed by a concurrent request between the checks and the update.
    if (consumeMiss && query.includes('UPDATE student_portal.auth_challenge') && query.includes('RETURNING token_hash'))
      return [] as R[];
    if (query === 'SELECT statement_timestamp() AS now' && shiftNowAtCall > 0 && ++nowCalls === shiftNowAtCall)
      return [{ now: new Date(Date.now() + 400 * 86400_000) }] as unknown as R[];
    return (await target.query<R>(query, [...parameters])).rows;
  };
  sql = {
    unsafe: (query, parameters) => run(pg, query, parameters),
    begin: (operation) =>
      pg.transaction((tx) =>
        operation({ unsafe: (query, parameters) => run(tx, query, parameters) }),
      ),
  };
  auth = new AuthServiceV1(sql, cryptoPort, 1, risk);
  qrService = new QrServiceV1(sql, cryptoPort, 1);
  sessions = new SessionServiceV1(sql, cryptoPort);
  birth = new BirthYearServiceV1(sql, cryptoPort, 1);
  policy = new PolicyServiceV1(sql);
}, 30_000);

async function version() {
  return Number(
    (
      await pg.query<{ version: string }>(
        'SELECT version::text FROM student_portal.account WHERE id=$1',
        [accountId],
      )
    ).rows[0]!.version,
  );
}
async function command(operation: string, extra: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    operation,
    accountId,
    expectedVersion: await version(),
    idempotencyKey: id(),
    ...extra,
  };
}
async function birthWrite(action = 'set', year = '2001', confirmation = 'confirmed') {
  const rows = (
    await pg.query<{ version: string }>(
      'SELECT version::text FROM student_portal.account_access_data WHERE account_id=$1',
      [accountId],
    )
  ).rows;
  return birth.write(ACTOR, {
    contractVersion: 1,
    operation: 'birth-write',
    expectedVersion: await version(),
    idempotencyKey: id(),
    item: {
      accountId,
      expectedVersion: Number(rows[0]?.version ?? 0),
      action,
      ...(action === 'set' ? { year, confirmation } : {}),
    },
  });
}
async function proof() {
  const result = await auth.challenge({ contractVersion: 1, qr, pin: '2001' }, id());
  if (result.state !== 'password-creation') throw new Error('synthetic-proof-failed');
  return result.challenge;
}
async function activate(persistent = false) {
  const result = await auth.activate(
    {
      contractVersion: 1,
      challenge: await proof(),
      password: '482913',
      confirmation: '482913',
      keepConnected: persistent,
    },
    id(),
  );
  if (!('token' in result)) throw new Error('synthetic-activation-failed');
  return result;
}
beforeEach(async () => {
  failAudit = false;
  consumeMiss = false;
  nowCalls = 0;
  shiftNowAtCall = 0;
  risk.verify.mockClear();
  await pg.exec(`TRUNCATE student_portal.setting,student_portal.operation_receipt,student_portal.audit_event,
    student_portal.account_access_data,student_portal.password_credential,student_portal.qr_credential,
    student_portal.session,student_portal.auth_attempt,student_portal.auth_challenge;
    UPDATE student_portal.account SET version=0,pin_version=0,security_version=0,auth_state='pending-activation',blocked=false,eligibility='eligible';
    UPDATE gradebook.vinculo SET situacao=NULL,turma_id=900001;`);
  await policy.initializeDefaults();
  const current = await policy.read(SCHOOL);
  const now = Date.now();
  await policy.mutate(ACTOR, {
    contractVersion: 1,
    operation: 'settings-set',
    scope: SCHOOL,
    expectedVersion: current.version,
    idempotencyKey: id(),
    acknowledgeImmediateEffect: true,
    value: {
      accessEnabled: true,
      calendar: {
        ...current.value.calendar,
        yearStartsAt: new Date(Math.floor(now / 1000) * 1000 - 86400_000).toISOString(),
        yearEndsAt: new Date(Math.floor(now / 1000) * 1000 + 60 * 86400_000).toISOString(),
      },
    },
  });
  await birthWrite();
  qr = (await qrService.command(ACTOR, await command('qr-issue'))).qr!;
}, 30_000);
afterAll(async () => {
  await pg?.close();
});

describe('KDF transaction boundary', () => {
  it('executes PIN/password KDF only after explicit SQL transactions release', async () => {
    let depth = 0;
    const trackedSql: StudentPortalPostgresSqlV1 = {
      unsafe: (query, parameters) => sql.unsafe(query, parameters),
      begin: async (operation) => {
        depth += 1;
        try {
          return await sql.begin(operation);
        } finally {
          depth -= 1;
        }
      },
    };
    const phases: string[] = [];
    const trackedCrypto = cryptoWithV1({
      deriveVerifier: async (secret, pepperVersion) => {
        expect(depth).toBe(0);
        phases.push('derive');
        return cryptoPort.deriveVerifier(secret, pepperVersion);
      },
      verifySecret: async (secret, verifier) => {
        expect(depth).toBe(0);
        phases.push('verify');
        return cryptoPort.verifySecret(secret, verifier);
      },
    });
    const service = new AuthServiceV1(trackedSql, trackedCrypto, 1, risk);
    const challenge = await service.challenge({ contractVersion: 1, qr, pin: '2001' }, id());
    if (challenge.state !== 'password-creation') throw new Error('synthetic-kdf-proof-missing');
    expect(await service.activate({
      contractVersion: 1,
      challenge: challenge.challenge,
      password: '482913',
      confirmation: '482913',
      keepConnected: false,
    }, id())).toHaveProperty('token');
    expect(await service.login({
      contractVersion: 1,
      qr,
      password: '482913',
      keepConnected: false,
    }, id())).toHaveProperty('token');
    expect(phases).toEqual(['verify', 'derive', 'verify']);
  });

  it('rejects a stale password proof if credentials rotate during KDF', async () => {
    await activate();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const service = new AuthServiceV1(sql, cryptoWithV1({
      verifySecret: async (secret, verifier) => {
        entered();
        await releasePromise;
        return cryptoPort.verifySecret(secret, verifier);
      },
    }), 1, risk);
    const before = Number((await pg.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM student_portal.session',
    )).rows[0]!.count);
    const pending = service.login({
      contractVersion: 1,
      qr,
      password: '482913',
      keepConnected: false,
    }, id());
    await enteredPromise;
    await qrService.command(ACTOR, await command('password-reset', { confirmed: true }));
    release();
    expect(await pending).toMatchObject({ state: 'unauthenticated' });
    expect(Number((await pg.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM student_portal.session',
    )).rows[0]!.count)).toBe(before);
  });
});

describe('auth with real schema, policies, birth service and scrypt', () => {
  it('rejects a weak new password without consuming the proof or spending an attempt', async () => {
    const challenge = await proof();
    const input = {
      contractVersion: 1,
      challenge,
      password: '123456',
      confirmation: '123456',
      keepConnected: false,
    };
    await expect(auth.activate(input, id())).rejects.toThrow('Weak password');
    expect((await pg.query<{ consumed_at: string | null }>(
      'SELECT consumed_at FROM student_portal.auth_challenge',
    )).rows).toEqual([{ consumed_at: null }]);
    expect((await pg.query('SELECT account_id FROM student_portal.auth_attempt')).rows).toEqual([]);
    expect(await auth.activate({ ...input, password: '482913', confirmation: '482913' }, id()))
      .toHaveProperty('token');
  });
  it('requires QR/PIN, commits activation once, stores only hashes and requires password for an active account', async () => {
    expect(await auth.challenge({ contractVersion: 1, qr }, id())).toMatchObject({
      state: 'credential-required',
      next: 'pin',
    });
    const challenge = await proof();
    const request = {
      contractVersion: 1,
      challenge,
      password: '482913',
      confirmation: '482913',
      keepConnected: false,
    };
    const results = await Promise.all([auth.activate(request, id()), auth.activate(request, id())]);
    expect(results.filter((item) => 'token' in item)).toHaveLength(1);
    expect(
      results.filter((item) => 'state' in item && item.state === 'unauthenticated'),
    ).toHaveLength(1);
    const result = results.find((item) => 'token' in item)!;
    if (!('token' in result)) throw new Error('synthetic-no-token');
    expect(await sessions.read(result.token, id())).toMatchObject({
      state: 'authenticated',
      persistent: false,
    });
    expect(await sessions.read(result.token, id(), accountId)).toMatchObject({ state: 'authenticated' });
    expect(await sessions.read(result.token, id(), id())).toBeNull();
    // A security revalidation must never authorize the old page after a cookie switches accounts.
    expect(await sessions.read(result.token, id(), accountId)).toMatchObject({ state: 'authenticated' });
    const stored = JSON.stringify((await pg.query('SELECT * FROM student_portal.session')).rows);
    expect(stored).not.toContain(result.token);
    expect(
      JSON.stringify((await pg.query('SELECT * FROM student_portal.auth_challenge')).rows),
    ).not.toContain(challenge);
    expect(await auth.challenge({ contractVersion: 1, qr, pin: '2001' }, id())).toMatchObject({
      state: 'credential-required',
      next: 'password',
    });
    expect(
      await auth.login({ contractVersion: 1, qr, password: '200100', keepConnected: false }, id()),
    ).toMatchObject({ state: 'unauthenticated' });
  });

  it('records failures across service instances, requires risk after three, blocks after five and expires by DB time', async () => {
    await activate();
    const other = new AuthServiceV1(sql, cryptoPort, 1, risk);
    const bad = { contractVersion: 1, qr, password: '000000', keepConnected: false };
    for (let i = 0; i < 3; i++)
      expect(await (i % 2 ? other : auth).login(bad, id())).toMatchObject({
        state: 'unauthenticated',
      });
    expect(await auth.challenge({ contractVersion: 1, qr }, id())).toMatchObject({ next: 'risk' });
    const guardedVerify = vi.fn((secret: string, verifier: Parameters<CryptoPortV1['verifySecret']>[1]) =>
      cryptoPort.verifySecret(secret, verifier));
    const guarded = new AuthServiceV1(sql, cryptoWithV1({ verifySecret: guardedVerify }), 1, risk);
    expect(await guarded.login({ ...bad, password: '482913' }, id())).toMatchObject({
      state: 'unauthenticated',
    });
    expect(guardedVerify).not.toHaveBeenCalled();
    expect(
      Number(
        (await pg.query<{ failures: number }>('SELECT failures FROM student_portal.auth_attempt'))
          .rows[0]!.failures,
      ),
    ).toBe(3);
    expect(await auth.login({ ...bad, riskToken: 'synthetic-valid-risk' }, id())).toMatchObject({
      state: 'unauthenticated',
    });
    expect(await other.login({ ...bad, riskToken: 'synthetic-valid-risk' }, id())).toMatchObject({
      state: 'rate-limited',
      retryAfterSeconds: expect.any(Number),
    });
    guardedVerify.mockClear();
    expect(
      await guarded.login({ ...bad, password: '482913', riskToken: 'synthetic-valid-risk' }, id()),
    ).toMatchObject({ state: 'rate-limited' });
    expect(guardedVerify).not.toHaveBeenCalled();
    await pg.exec(
      "UPDATE student_portal.auth_attempt SET blocked_until=statement_timestamp()-interval '1 second'",
    );
    expect(await other.login({ ...bad, password: '482913' }, id())).toHaveProperty('token');
    // Reasons for the family's support (owner request 29/09/2026), oldest first.
    const events = (
      await pg.query<{ kind: string; detail_json: Record<string, unknown> | null }>(
        "SELECT kind,detail_json FROM student_portal.audit_event WHERE kind IN ('login','login-failed') ORDER BY occurred_at,created_at",
      )
    ).rows;
    const reasons = events.map((event) => event.detail_json?.reason ?? event.kind);
    expect(reasons).toEqual([
      'wrong-password', 'wrong-password', 'wrong-password', 'verification-required',
      'wrong-password', 'wrong-password', 'temporarily-blocked', 'login',
    ]);
    expect(events[0]!.detail_json).toMatchObject({ step: 'password', failures: 1, blockAfter: 5 });
    expect(events[4]!.detail_json).not.toHaveProperty('blockedUntil');
    expect(events[5]!.detail_json).toMatchObject({ failures: 5, blockedUntil: expect.any(String) });
    expect(events[6]!.detail_json).toMatchObject({ step: 'password', blockedUntil: expect.any(String) });
    expect(events.at(-1)!.detail_json).toEqual({ keepConnected: false });
  });

  it('birth correction/clear rejects old proofs without revoking a valid session, and unconfirmed birth cannot activate', async () => {
    const old = await proof();
    await birthWrite('set', '2002');
    expect(
      await auth.activate(
        {
          contractVersion: 1,
          challenge: old,
          password: '482913',
          confirmation: '482913',
          keepConnected: false,
        },
        id(),
      ),
    ).toMatchObject({ state: 'unauthenticated' });
    await birthWrite();
    const signed = await activate();
    await birthWrite('clear');
    expect(await new SessionServiceV1(sql, cryptoPort).read(signed.token, id())).toHaveProperty(
      'state',
      'authenticated',
    );
    await birthWrite();
    await qrService.command(ACTOR, await command('password-reset', { confirmed: true }));
    await birthWrite('set', '2001', 'unconfirmed-test');
    const failuresBefore = Number(
      (
        await pg.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM student_portal.audit_event WHERE kind='login-failed'",
        )
      ).rows[0]!.count,
    );
    expect(await auth.challenge({ contractVersion: 1, qr }, id())).toMatchObject({
      state: 'unauthenticated',
    });
    expect(await auth.challenge({ contractVersion: 1, qr, pin: '2001' }, id())).toMatchObject({
      state: 'unauthenticated',
    });
    expect(
      Number(
        (
          await pg.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM student_portal.audit_event WHERE kind='login-failed'",
          )
        ).rows[0]!.count,
      ),
    ).toBe(failuresBefore + 2);
    expect((await pg.query('SELECT failures FROM student_portal.auth_attempt')).rows).toEqual([
      { failures: 0 },
    ]);
    await expect(
      qrService.command(ACTOR, await command('password-reset', { confirmed: true })),
    ).rejects.toThrow('recovery-conflict');
    await expect(qrService.command(ACTOR, await command('qr-reprint'))).rejects.toThrow(
      'recovery-conflict',
    );
    expect(await sessions.read(signed.token, id())).toBeNull();
  });

  it('keeps only the latest successful PIN proof usable', async () => {
    const first = await proof();
    const second = await proof();
    expect(
      Number(
        (
          await pg.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM student_portal.auth_challenge WHERE consumed_at IS NULL',
          )
        ).rows[0]!.count,
      ),
    ).toBe(1);
    expect(
      await auth.activate(
        {
          contractVersion: 1,
          challenge: first,
          password: '482913',
          confirmation: '482913',
          keepConnected: false,
        },
        id(),
      ),
    ).toMatchObject({ state: 'unauthenticated' });
    expect(
      await auth.activate(
        {
          contractVersion: 1,
          challenge: second,
          password: '482913',
          confirmation: '482913',
          keepConnected: false,
        },
        id(),
      ),
    ).toHaveProperty('token');
  });

  it('reprints identically, rotates QR while preserving password, resets password with same QR and resets account with new QR', async () => {
    const signed = await activate();
    const reprint = await command('qr-reprint');
    expect((await qrService.command(ACTOR, reprint)).qr).toBe(qr);
    expect((await qrService.command(ACTOR, reprint)).qr).toBe(qr);
    const rotated = await qrService.command(
      ACTOR,
      await command('qr-regenerate', { confirmed: true }),
    );
    expect(rotated.qr).not.toBe(qr);
    expect(await sessions.read(signed.token, id())).toBeNull();
    expect(
      await auth.login({ contractVersion: 1, qr, password: '482913', keepConnected: false }, id()),
    ).toMatchObject({ state: 'unauthenticated' });
    qr = rotated.qr!;
    expect(
      await auth.login({ contractVersion: 1, qr, password: '482913', keepConnected: false }, id()),
    ).toHaveProperty('token');
    await qrService.command(ACTOR, await command('password-reset', { confirmed: true }));
    expect((await qrService.command(ACTOR, await command('qr-reprint'))).qr).toBe(qr);
    expect(
      await auth.login({ contractVersion: 1, qr, password: '482913', keepConnected: false }, id()),
    ).toMatchObject({ state: 'unauthenticated' });
    await activate();
    await qrService.command(ACTOR, await command('account-reset', { confirmed: true }));
    expect((await qrService.command(ACTOR, await command('qr-reprint'))).qr).not.toBe(qr);
    expect(
      (await pg.query('SELECT birth_year FROM student_portal.account_access_data')).rows,
    ).toEqual([{ birth_year: 2001 }]);
  });

  it('blocking/unblocking never resurrects sessions and eligibility is freshly checked without lifecycle synchronization', async () => {
    const signed = await activate();
    await pg.exec('UPDATE gradebook.vinculo SET situacao=3');
    expect(await sessions.read(signed.token, id())).toBeNull();
    await pg.exec('UPDATE gradebook.vinculo SET situacao=NULL');
    await qrService.command(ACTOR, await command('block', { blocked: true, confirmed: true }));
    expect(
      await auth.login({ contractVersion: 1, qr, password: '482913', keepConnected: false }, id()),
    ).toMatchObject({ state: 'unauthenticated' });
    await qrService.command(ACTOR, await command('block', { blocked: false, confirmed: true }));
    expect(await sessions.read(signed.token, id())).toBeNull();
  });

  it('revalidates current policy and shorter TTL, then logout remains effective across service restarts', async () => {
    const signed = await activate(true);
    expect(Date.parse(signed.body.expiresAt) - Date.now()).toBeGreaterThan(29 * 86400_000);
    const current = await policy.read(SCHOOL);
    await policy.mutate(ACTOR, {
      contractVersion: 1,
      operation: 'settings-set',
      scope: SCHOOL,
      expectedVersion: current.version,
      idempotencyKey: id(),
      acknowledgeImmediateEffect: true,
      value: { risk: { ...current.value.risk, persistentSeconds: 60, shortSeconds: 60 } },
    });
    await pg.exec(
      "UPDATE student_portal.session SET created_at=statement_timestamp()-interval '61 seconds'",
    );
    expect(await sessions.read(signed.token, id())).toBeNull();
    const login = await auth.login(
      { contractVersion: 1, qr, password: '482913', keepConnected: false },
      id(),
    );
    if (!('token' in login)) throw new Error('synthetic-login-failed');
    await sessions.logout(login.token, id());
    expect(await new SessionServiceV1(sql, cryptoPort).read(login.token, id())).toBeNull();
  });

  it('caps issuance at year end and disables current sessions immediately when access is switched off', async () => {
    const current = await policy.read(SCHOOL);
    const yearEndsAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString();
    await policy.mutate(ACTOR, {
      contractVersion: 1,
      operation: 'settings-set',
      scope: SCHOOL,
      expectedVersion: current.version,
      idempotencyKey: id(),
      acknowledgeImmediateEffect: true,
      value: { calendar: { ...current.value.calendar, yearEndsAt } },
    });
    const signed = await activate(true);
    expect(Date.parse(signed.body.expiresAt)).toBe(Date.parse(yearEndsAt));
    const changed = await policy.read(SCHOOL);
    await policy.mutate(ACTOR, {
      contractVersion: 1,
      operation: 'settings-set',
      scope: SCHOOL,
      expectedVersion: changed.version,
      idempotencyKey: id(),
      acknowledgeImmediateEffect: true,
      value: { accessEnabled: false },
    });
    expect(await sessions.read(signed.token, id())).toBeNull();
    expect(
      await auth.login({ contractVersion: 1, qr, password: '482913', keepConnected: true }, id()),
    ).toMatchObject({ state: 'access-closed' });
  });

  it('discloses school closure only to a proven QR or valid session and keeps legacy responses generic', async () => {
    const signed = await activate();
    const current = await policy.read(SCHOOL);
    await policy.mutate(ACTOR, {
      contractVersion: 1, operation: 'settings-set', scope: SCHOOL,
      expectedVersion: current.version, idempotencyKey: id(), acknowledgeImmediateEffect: true,
      value: { accessEnabled: false },
    });
    expect(await auth.challenge({ contractVersion: 1, qr }, id())).toMatchObject({ state: 'access-closed' });
    expect(await sessions.read(signed.token, id())).toBeNull();
    expect(await sessions.read(signed.token, id(), undefined, true)).toMatchObject({ state: 'access-closed' });
    expect(await sessions.read(signed.token, id(), id(), true)).toBeNull();

    const challenge = (headers: Record<string, string>) => servePortalAuthV1(new Request(`${ORIGIN}/api/student/auth/challenge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ contractVersion: 1, qr }),
    }), 'production', ORIGIN, auth, sessions);
    expect(await (await challenge({})).json()).toMatchObject({ state: 'unauthenticated' });
    const disclosed = await challenge({ [ACCESS_CLOSED_ACCEPT_HEADER_V1]: 'v1' });
    expect(disclosed.status).toBe(403);
    expect(await disclosed.json()).toMatchObject({ state: 'access-closed' });
    const session = (headers: Record<string, string>) => servePortalAuthV1(new Request(`${ORIGIN}/api/student/session`, {
      headers: { cookie: `__Host-student_portal_session=${signed.token}`, ...headers },
    }), 'production', ORIGIN, auth, sessions);
    expect((await session({})).status).toBe(401);
    const closedSession = await session({ [ACCESS_CLOSED_ACCEPT_HEADER_V1]: 'v1' });
    expect(closedSession.status).toBe(403);
    expect(await closedSession.json()).toMatchObject({ state: 'access-closed' });

    const revoked = qr;
    qr = (await qrService.command(ACTOR, await command('qr-regenerate', { confirmed: true }))).qr!;
    expect(await auth.challenge({ contractVersion: 1, qr: revoked }, id())).toMatchObject({ state: 'unauthenticated' });
    expect(await sessions.read(signed.token, id(), undefined, true)).toBeNull();
    const school = await policy.read(SCHOOL);
    await policy.mutate(ACTOR, {
      contractVersion: 1, operation: 'settings-set', scope: SCHOOL,
      expectedVersion: school.version, idempotencyKey: id(), acknowledgeImmediateEffect: true,
      value: { accessEnabled: true },
    });
    const individual = { kind: 'account', academicYear: 2026, accountId } as const;
    const own = await policy.read(individual);
    await policy.mutate(ACTOR, {
      contractVersion: 1, operation: 'settings-set', scope: individual,
      expectedVersion: own.version, idempotencyKey: id(), acknowledgeImmediateEffect: true,
      value: { accessEnabled: false },
    });
    expect(await auth.challenge({ contractVersion: 1, qr }, id())).toMatchObject({ state: 'access-closed' });
    await qrService.command(ACTOR, await command('block', { blocked: true, confirmed: true }));
    expect(await auth.challenge({ contractVersion: 1, qr }, id())).toMatchObject({ state: 'unauthenticated' });
  });

  it('revokes all sessions in a current class with CAS and idempotent receipt', async () => {
    const signed = await activate();
    const second = await auth.login(
      { contractVersion: 1, qr, password: '482913', keepConnected: true },
      id(),
    );
    expect(second).toHaveProperty('token');
    const scope = { kind: 'class', academicYear: 2026, classId: 900001 } as const;
    const snapshot = await sessions.readRevocationScope(scope);
    const input = {
      contractVersion: 1,
      operation: 'sessions-revoke',
      scope,
      expectedVersion: snapshot.version,
      idempotencyKey: id(),
      confirmed: true,
    };
    const result = await sessions.revoke(ACTOR, input);
    expect(await sessions.revoke(ACTOR, input)).toEqual(result);
    expect(await sessions.read(signed.token, id())).toBeNull();
    if ('token' in second) expect(await sessions.read(second.token, id())).toBeNull();
    await expect(sessions.revoke(ACTOR, { ...input, idempotencyKey: id() })).rejects.toThrow(
      'version-conflict',
    );
  });

  it('cannot reuse an old class confirmation when removing an account would offset the revision increase', async () => {
    const scope = { kind: 'class', academicYear: 2026, classId: 900001 } as const;
    const before = await sessions.readRevocationScope(scope);
    await pg.exec(`INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES
      (900002,2026,'A2','SYNTHETIC MOVED AUTH CLASS',6,'TESTE') ON CONFLICT DO NOTHING;
      UPDATE gradebook.vinculo SET turma_id=900002 WHERE aluno_id=900001;
      UPDATE student_portal.academic_revision SET academic_counter=academic_counter+
        (SELECT version FROM student_portal.account WHERE gradebook_student_id=900001) WHERE academic_year=2026;`);
    const after = await sessions.readRevocationScope(scope);
    expect(after.count).toBe(0);
    expect(after.version).toBeGreaterThan(before.version);
    await expect(
      sessions.revoke(ACTOR, {
        contractVersion: 1,
        operation: 'sessions-revoke',
        scope,
        expectedVersion: before.version,
        idempotencyKey: id(),
        confirmed: true,
      }),
    ).rejects.toThrow('version-conflict');
  });

  it('rolls back activation and proof consumption on DB failure, and never sends a cookie before commit', async () => {
    const challenge = await proof();
    const input = {
      contractVersion: 1,
      challenge,
      password: '482913',
      confirmation: '482913',
      keepConnected: false,
    };
    failAudit = true;
    const response = await servePortalAuthV1(
      new Request(`${ORIGIN}/api/student/auth/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
      'production',
      ORIGIN,
      auth,
      sessions,
    );
    expect(response.status).toBe(503);
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(JSON.stringify(await response.json())).not.toContain('synthetic-db-failure');
    expect((await pg.query('SELECT * FROM student_portal.session')).rows).toHaveLength(0);
    failAudit = false;
    expect(await auth.activate(input, id())).toHaveProperty('token');
  });

  it('keeps tokens exclusively in secure cookies and rejects cross-origin, duplicate cookies and oversized JSON', async () => {
    const call = (path: string, input: unknown, headers: Record<string, string> = {}) =>
      servePortalAuthV1(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(input),
        }),
        'production',
        ORIGIN,
        auth,
        sessions,
      );
    const input = {
      contractVersion: 1,
      challenge: await proof(),
      password: '482913',
      confirmation: '482913',
      keepConnected: false,
    };
    const response = await call('/api/student/auth/activate', input);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(
      /^__Host-student_portal_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/u,
    );
    const token = cookie.split(';')[0]!.split('=')[1]!;
    expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const duplicated = await servePortalAuthV1(
      new Request(`${ORIGIN}/api/student/session`, {
        headers: { cookie: `${cookie.split(';')[0]}; ${cookie.split(';')[0]}` },
      }),
      'production',
      ORIGIN,
      auth,
      sessions,
    );
    expect(duplicated.status).toBe(401);
    for (const [query, status] of [
      [`accountId=${accountId}`, 200],
      [`accountId=${id()}`, 401],
      ['accountId=invalid', 403],
      [`accountId=${accountId}&accountId=${id()}`, 403],
    ] as const) {
      const bound = await servePortalAuthV1(new Request(`${ORIGIN}/api/student/session?${query}`, {
        headers: { cookie: cookie.split(';')[0]! },
      }), 'production', ORIGIN, auth, sessions);
      expect(bound.status).toBe(status);
    }
    expect(
      (await call('/api/student/auth/login', {}, { origin: 'https://attacker.invalid' })).status,
    ).toBe(403);
    expect((await call('/api/student/auth/login', { data: 'x'.repeat(8192) })).status).toBe(413);
    const persistent = await call('/api/student/auth/login', {
      contractVersion: 1,
      qr,
      password: '482913',
      keepConnected: true,
    });
    expect(persistent.headers.get('Set-Cookie')).toContain('; Expires=');
    expect(persistent.headers.get('Set-Cookie')).not.toContain('Domain');
    const logout = await call(
      '/api/student/auth/logout',
      { contractVersion: 1 },
      { cookie: cookie.split(';')[0]! },
    );
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await sessions.read(token, id())).toBeNull();
  });

  it('rejects tampering, expired challenges, bad password formats, stale CAS and idempotency payload changes', async () => {
    const parts = qr.split('.');
    parts[parts.length - 1] = 'A'.repeat(43);
    expect(
      await auth.challenge({ contractVersion: 1, qr: parts.join('.'), pin: '2001' }, id()),
    ).toMatchObject({ state: 'unauthenticated' });
    const challenge = await proof();
    await pg.exec(
      "UPDATE student_portal.auth_challenge SET created_at=statement_timestamp()-interval '10 minutes',expires_at=statement_timestamp()-interval '1 second'",
    );
    expect(
      await auth.activate(
        {
          contractVersion: 1,
          challenge,
          password: '482913',
          confirmation: '482913',
          keepConnected: false,
        },
        id(),
      ),
    ).toMatchObject({ state: 'unauthenticated' });
    await expect(
      auth.login({ contractVersion: 1, qr, password: '12345 ', keepConnected: false }, id()),
    ).rejects.toThrow();
    const cmd = await command('block', { blocked: true, confirmed: true });
    await qrService.command(ACTOR, cmd);
    await expect(qrService.command(ACTOR, { ...cmd, blocked: false })).rejects.toThrow(
      'idempotency-conflict',
    );
    await expect(qrService.command(ACTOR, { ...cmd, idempotencyKey: id() })).rejects.toThrow(
      'version-conflict',
    );
  });
});

describe('terminal auth result and audited refusal reasons (#1207)', () => {
  type Logged = Record<string, unknown>;
  async function capture<T>(run: () => Promise<T>): Promise<{ value?: T; error?: unknown; logged: Logged[] }> {
    const logged: Logged[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((value: unknown) => {
      const record = value as Logged;
      if (record?.event === 'student-portal-auth-result-v1') logged.push(record);
    });
    try {
      return { value: await run(), logged };
    } catch (error) {
      return { error, logged };
    } finally {
      spy.mockRestore();
    }
  }
  async function reasons() {
    return (
      await pg.query<{ detail_json: Record<string, unknown> | null }>(
        "SELECT detail_json FROM student_portal.audit_event WHERE kind='login-failed' ORDER BY occurred_at,created_at",
      )
    ).rows.map((row) => row.detail_json);
  }
  const event = 'student-portal-auth-result-v1';

  it('emits exactly one terminal result per public call, without reasons or identifiers', async () => {
    expect((await capture(() => auth.challenge({ contractVersion: 1, qr }, id()))).logged).toEqual([
      { event, step: 'challenge', outcome: 'required', next: 'pin' },
    ]);
    expect((await capture(() => auth.challenge({ contractVersion: 1, qr, pin: '1999' }, id()))).logged).toEqual([
      { event, step: 'challenge', outcome: 'denied' },
    ]);
    const issued = await capture(() => auth.challenge({ contractVersion: 1, qr, pin: '2001' }, id()));
    expect(issued.logged).toEqual([{ event, step: 'challenge', outcome: 'issued' }]);
    const challenge = (issued.value as { challenge: string }).challenge;
    const weak = await capture(() =>
      auth.activate({ contractVersion: 1, challenge, password: '123456', confirmation: '123456', keepConnected: false }, id()),
    );
    expect(weak.error).toBeInstanceOf(Error);
    expect(weak.logged).toEqual([{ event, step: 'activate', outcome: 'invalid-request' }]);
    const activated = await capture(() =>
      auth.activate({ contractVersion: 1, challenge, password: '482913', confirmation: '482913', keepConnected: false }, id()),
    );
    expect(activated.value).toHaveProperty('token');
    expect(activated.logged).toEqual([{ event, step: 'activate', outcome: 'issued' }]);
    const login = await capture(() => auth.login({ contractVersion: 1, qr, password: '482913', keepConnected: false }, id()));
    expect(login.logged).toEqual([{ event, step: 'login', outcome: 'issued' }]);
    const wrong = await capture(() => auth.login({ contractVersion: 1, qr, password: '200100', keepConnected: false }, id()));
    expect(wrong.logged).toEqual([{ event, step: 'login', outcome: 'denied' }]);
    const serialized = JSON.stringify([issued, activated, login, wrong].flatMap((item) => item.logged));
    for (const secret of [qr, challenge, accountId, '482913', '2001']) expect(serialized).not.toContain(secret);
  });

  it('reports the service rate limit as blocked and an unknown card as denied', async () => {
    const limited = new AuthServiceV1(sql, cryptoPort, 1, risk, undefined, async () => false);
    expect((await capture(() => limited.login({ contractVersion: 1, qr, password: '482913', keepConnected: false }, id()))).logged)
      .toEqual([{ event, step: 'login', outcome: 'blocked' }]);
    const parts = qr.split('.');
    parts[parts.length - 1] = 'A'.repeat(43);
    expect((await capture(() => auth.challenge({ contractVersion: 1, qr: parts.join('.'), pin: '2001' }, id()))).logged)
      .toEqual([{ event, step: 'challenge', outcome: 'denied' }]);
  });

  it('reports a rolled-back operation as unavailable and rethrows the same error', async () => {
    const challenge = await proof();
    failAudit = true;
    const result = await capture(() =>
      auth.activate({ contractVersion: 1, challenge, password: '482913', confirmation: '482913', keepConnected: false }, id()),
    );
    expect((result.error as Error).message).toBe('synthetic-db-failure');
    expect(result.logged).toEqual([{ event, step: 'activate', outcome: 'unavailable' }]);
  });

  it('emits once for a terminal activation preflight and keeps the result when the sink fails', async () => {
    const challenge = await proof();
    await pg.exec("UPDATE student_portal.auth_challenge SET created_at=statement_timestamp()-interval '10 minutes',expires_at=statement_timestamp()-interval '1 second'");
    const input = { contractVersion: 1, challenge, password: '482913', confirmation: '482913', keepConnected: false };
    expect((await capture(() => auth.activate(input, id()))).logged).toEqual([{ event, step: 'activate', outcome: 'denied' }]);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('sink-unavailable'); });
    try {
      expect(await auth.activate(input, id())).toMatchObject({ state: 'unauthenticated' });
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps concurrent calls independent', async () => {
    const result = await capture(() =>
      Promise.all([
        auth.challenge({ contractVersion: 1, qr }, id()),
        auth.login({ contractVersion: 1, qr, password: '482913', keepConnected: false }, id()),
      ]),
    );
    expect(result.logged).toHaveLength(2);
    expect(result.logged).toContainEqual({ event, step: 'challenge', outcome: 'required', next: 'pin' });
    expect(result.logged).toContainEqual({ event, step: 'login', outcome: 'denied' });
  });

  it('reports a consumed proof as a retry, not as an expired deadline', async () => {
    const input = { contractVersion: 1, challenge: await proof(), password: '482913', confirmation: '482913', keepConnected: false };
    expect(await auth.activate(input, id())).toHaveProperty('token');
    expect(await auth.activate(input, id())).toMatchObject({ state: 'unauthenticated' });
    expect(await reasons()).toEqual([{ reason: 'retry-needed', step: 'create' }]);
  });

  it('reports an expired deadline only when the proof really expired', async () => {
    const challenge = await proof();
    await pg.exec("UPDATE student_portal.auth_challenge SET created_at=statement_timestamp()-interval '10 minutes',expires_at=statement_timestamp()-interval '1 second'");
    expect(
      await auth.activate({ contractVersion: 1, challenge, password: '482913', confirmation: '482913', keepConnected: false }, id()),
    ).toMatchObject({ state: 'unauthenticated' });
    expect(await reasons()).toEqual([{ reason: 'password-window-expired', step: 'create' }]);
  });

  it('records a reason when the proof is consumed concurrently or the access window ends mid-request', async () => {
    const challenge = await proof();
    consumeMiss = true;
    expect(
      await auth.activate({ contractVersion: 1, challenge, password: '482913', confirmation: '482913', keepConnected: false }, id()),
    ).toMatchObject({ state: 'unauthenticated' });
    consumeMiss = false;
    // Third DB clock read in a PIN challenge: proof snapshot, locked context, then issuance.
    shiftNowAtCall = 3;
    expect(await auth.challenge({ contractVersion: 1, qr, pin: '2001' }, id())).toMatchObject({ state: 'unauthenticated' });
    expect(await reasons()).toEqual([
      { reason: 'retry-needed', step: 'create' },
      { reason: 'password-window-expired', step: 'pin' },
    ]);
  });
});
