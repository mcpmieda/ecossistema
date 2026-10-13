import { seedExistingBirthFixtureV1 } from '../smoke/legacy-seed-fixture-v1';
import postgres from 'postgres';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createIntegrationHarnessV1, type IntegrationRequestV1 } from './harness-v1';
import { installIntegrationFixtureV1 } from './fixture-v1';
import { localPortalDatabaseV1 } from '../frontend-foundation/harness-v1';
import { createPortalAdminClientV1 } from '../../../src/features/student-portal-admin/shared/admin-client-v1';
import { createPortalAdminReadClientV2 } from '../../../src/features/student-portal-admin/accounts/accounts-client-v2';
import { createPortalSelfClientV1 } from '../../../src/features/student-portal/shared/self-client-v1';
import { PortalClientErrorV1 } from '../../../src/features/student-portal/shared/transport-v1';

const target = process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid';
localPortalDatabaseV1(target);
const sql = postgres(target, { max: 1, onnotice: () => undefined });
let harness: Awaited<ReturnType<typeof createIntegrationHarnessV1>>;
let fixture: Awaited<ReturnType<typeof installIntegrationFixtureV1>>;
let cookie: string | undefined;
const fetcher = (surface: 'admin' | 'student') => async (path: string, init: RequestInit) => {
  init.signal?.throwIfAborted();
  const response = await harness.fetch({
    surface,
    path,
    method: init.method,
    body: init.body as string | undefined,
    ...(surface === 'student' && cookie ? { cookie } : {}),
  });
  if (surface === 'student' && response.headers.has('set-cookie'))
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  return response as unknown as Response;
};
const client = createPortalAdminClientV1({ fetch: fetcher('admin') });
const reader = createPortalAdminReadClientV2({ fetch: fetcher('admin') });
const student = createPortalSelfClientV1({ fetch: fetcher('student') });
beforeAll(async () => {
  fixture = await installIntegrationFixtureV1(sql);
  harness = await createIntegrationHarnessV1(target);
});
afterAll(async () => {
  await harness?.dispose();
  await sql.end({ timeout: 2 });
});
it('uses the full Pages handler for inherited identity/capabilities and rejects foreign origin or role', async () => {
  const me = await harness.fetch({ surface: 'admin', path: '/api/me' });
  expect(me.status).toBe(200);
  const identity = (await me.json()) as {
    identityKey: string;
    expiresAt: string;
    capabilities: string[];
  };
  expect(identity.identityKey).toMatch(/^75700000-/u);
  expect(Date.parse(identity.expiresAt)).toBeGreaterThan(Date.now());
  expect(identity.capabilities).toContain('platform.settings.write');
  expect(
    me.headers
      .get('Cache-Control')
      ?.split(',')
      .map((part) => part.trim()),
  ).toContain('no-store');
  const query = JSON.stringify({
    contractVersion: 2,
    operation: 'accounts-read',
    scope: fixture.scope,
    page: { limit: 100 },
  });
  for (const extra of [
    { anonymous: true },
    { role: 'PROFESSOR' as const },
    { origin: 'https://foreign.invalid' },
  ]) {
    const response = await harness.fetch({
      surface: 'admin',
      path: '/api/student-portal/admin/query',
      body: query,
      ...extra,
    });
    expect([401, 403]).toContain(response.status);
  }
  const invalidYear = await harness.fetch({
    surface: 'admin',
    path: '/api/student-portal/admin/query',
    body: query.replace('"academicYear":2026', '"academicYear":2025'),
  });
  expect(invalidYear.status).toBe(400);
});
it('composes typed clients, actual SQL/RPC, activation, official publication, revocation and logout', async () => {
  const accounts = await reader.query({
    contractVersion: 2,
    operation: 'accounts-read',
    scope: fixture.scope,
    page: { limit: 100 },
  });
  if (accounts.state !== 'accounts-read') throw new Error('Synthetic accounts not returned');
  const account = accounts.items.find((item) => item.link?.studentId === fixture.studentId)!;
  expect(account).toBeDefined();
  const scope = {
    kind: 'account' as const,
    academicYear: 2026 as const,
    accountId: account.accountId,
  };
  const birth = await client.query({
    contractVersion: 1,
    operation: 'birth-years',
    scope,
    page: { limit: 100 },
  });
  if (birth.state !== 'birth-years') throw new Error('Synthetic birth read failed');
  await seedExistingBirthFixtureV1(sql, account.accountId);
  const settings = await client.query({
    contractVersion: 1,
    operation: 'settings',
    scope,
    page: {},
  });
  if (settings.state !== 'settings') throw new Error('Synthetic settings read failed');
  const now = Math.floor(Date.now() / 1000) * 1000;
  await client.command({
    contractVersion: 1,
    operation: 'settings-set',
    scope,
    expectedVersion: settings.settings.version,
    idempotencyKey: crypto.randomUUID(),
    acknowledgeImmediateEffect: true,
    value: {
      accessEnabled: true,
      showPartials: true,
      allowedPeriods: ['T1'],
      calendar: {
        ...settings.settings.value.calendar,
        yearStartsAt: new Date(now - 86400_000).toISOString(),
        t1EndsAt: null,
        t2EndsAt: null,
        t3EndsAt: null,
        recoveriesStartAt: null,
        yearEndsAt: new Date(now + 86400_000).toISOString(),
        disclosure: { mode: 'single', at: new Date(now - 3600_000).toISOString(), periods: ['T1'] },
      },
    },
  });
  const fresh = await reader.query({
    contractVersion: 2,
    operation: 'accounts-read',
    scope,
    page: {},
  });
  if (fresh.state !== 'accounts-read') throw new Error('Synthetic account freshness failed');
  const qr = await client.command({
    contractVersion: 1,
    operation: 'qr-issue',
    accountId: account.accountId,
    expectedVersion: fresh.items[0]!.version,
    idempotencyKey: crypto.randomUUID(),
  });
  if (qr.state !== 'qr') throw new Error('Synthetic QR handoff failed');
  const challenge = await student.challenge({
    contractVersion: 1,
    qr: qr.cards[0]!.qr,
    pin: '2001',
  });
  if (challenge.state !== 'password-creation')
    throw new Error('Synthetic activation challenge failed');
  await student.activate({
    contractVersion: 1,
    challenge: challenge.challenge,
    password: '013579',
    confirmation: '013579',
    keepConnected: true,
  });
  const activeSession = await student.session();
  expect(activeSession.state).toBe('authenticated');
  if (activeSession.state !== 'authenticated') throw new Error('Synthetic session was not active');
  const bound = await harness.fetch({ surface: 'student', path: '/api/student/session?accountId=' + account.accountId, cookie });
  expect(bound.status).toBe(200);
  expect(await bound.json()).toMatchObject({ state: 'authenticated' });
  const foreign = await harness.fetch({ surface: 'student', path: '/api/student/session?accountId=' + crypto.randomUUID(), cookie });
  expect(foreign.status).toBe(401);
  const connectionId = crypto.randomUUID();
  const security = await harness.connectStudentSecurity(account.accountId, cookie!, connectionId);
  expect(security.status).toBe(101);
  const socket = security.webSocket!;
  const connected = new Promise<string>((resolve) => socket.addEventListener('message', event => resolve(String(event.data)), { once: true }));
  socket.accept();
  expect(JSON.parse(await connected)).toEqual({
    contractVersion: 1,
    type: 'security-connected',
    renewable: true,
    expiresAt: activeSession.expiresAt,
  });
  const renewed = await student.session(undefined, account.accountId, connectionId);
  expect(renewed.liveRenewed).toBe(true);
  expect((await student.session(undefined, account.accountId, crypto.randomUUID())).liveRenewed).toBe(false);
  const unboundRenewal = await harness.fetch({ surface: 'student', path: '/api/student/session?connectionId=' + connectionId, cookie });
  expect(unboundRenewal.status).toBe(403);
  socket.close(1000, 'synthetic-test-complete');

  expect((await student.me()).profile.accountId).toBe(account.accountId);
  // The prepared V2 edition is available at once; no scheduled work is involved.
  const publication = await client.query({
    contractVersion: 1,
    operation: 'publication',
    scope,
    page: {},
  });
  if (publication.state !== 'publication') throw new Error('Synthetic publication read failed');
  const t1 = publication.items.find((item) => item.period === 'T1')!;
  expect(t1.availableRevision).not.toBeNull();
  await client.command({
    contractVersion: 1,
    operation: 'publish',
    scope,
    period: 'T1',
    expectedVersion: t1.version,
    targetDataVersion: t1.availableRevision!,
    idempotencyKey: crypto.randomUUID(),
  });
  const self = await student.me();
  expect(self.state).toBe('ready');
  expect(self.subjects.length).toBeGreaterThan(0);
  expect(
    self.subjects.flatMap((subject) => subject.periods).every((period) => period.period === 'T1'),
  ).toBe(true);
  expect(JSON.stringify(self)).not.toContain(fixture.prefix + ' OTHER');
  const sessions = await reader.query({
    contractVersion: 2,
    operation: 'sessions-read',
    scope,
    page: {},
  });
  if (sessions.state !== 'sessions-read') throw new Error('Synthetic session read failed');
  expect(sessions.items.some((session) => session.validity === 'valid')).toBe(true);
  await client.command({
    contractVersion: 1,
    operation: 'sessions-revoke',
    scope,
    expectedVersion: sessions.version,
    confirmed: true,
    idempotencyKey: crypto.randomUUID(),
  });
  await expect(student.me()).rejects.toBeInstanceOf(PortalClientErrorV1);
  await student.login({
    contractVersion: 1,
    qr: qr.cards[0]!.qr,
    password: '013579',
    keepConnected: false,
  });
  expect((await student.session()).persistent).toBe(false);
  let activeQr = qr.cards[0]!.qr;
  // Repeat the whole reset through Pages/RPC/PG; replay must not rotate twice.
  for (let round = 0; round < 2; round++) {
    const beforeReset = await reader.query({
      contractVersion: 2,
      operation: 'accounts-read',
      scope,
      page: {},
    });
    if (beforeReset.state !== 'accounts-read') throw new Error('Synthetic reset read failed');
    const resetCommand = {
      contractVersion: 1 as const,
      operation: 'account-reset' as const,
      accountId: account.accountId,
      expectedVersion: beforeReset.items[0]!.version,
      confirmed: true as const,
      idempotencyKey: crypto.randomUUID(),
    };
    const reset = await client.command(resetCommand);
    if (reset.state !== 'committed') throw new Error('Synthetic reset not committed');
    expect(await client.command(resetCommand)).toMatchObject({
      state: reset.state,
      version: reset.version,
    });
    const afterReset = await reader.query({
      contractVersion: 2,
      operation: 'accounts-read',
      scope,
      page: {},
    });
    if (afterReset.state !== 'accounts-read') throw new Error('Synthetic reset read failed');
    expect(afterReset.items[0]).toMatchObject({
      state: 'pending-activation',
      validSessionCount: 0,
    });
    await expect(student.session()).rejects.toMatchObject({ state: 'unauthenticated' });
    await expect(student.me()).rejects.toMatchObject({ state: 'unauthenticated' });
    const reprinted = await client.command({
      contractVersion: 1,
      operation: 'qr-reprint',
      accountId: account.accountId,
      expectedVersion: afterReset.items[0]!.version,
      idempotencyKey: crypto.randomUUID(),
    });
    if (reprinted.state !== 'qr') throw new Error('Synthetic reset QR missing');
    const newQr = reprinted.cards[0]!.qr;
    expect(newQr).not.toBe(activeQr);
    await expect(student.challenge({ contractVersion: 1, qr: activeQr })).rejects.toMatchObject({
      state: 'unauthenticated',
    });
    await expect(
      student.login({ contractVersion: 1, qr: activeQr, password: '013579', keepConnected: false }),
    ).rejects.toMatchObject({ state: 'unauthenticated' });
    await expect(
      student.login({ contractVersion: 1, qr: newQr, password: '013579', keepConnected: false }),
    ).rejects.toMatchObject({ state: 'unauthenticated' });
    expect(await student.challenge({ contractVersion: 1, qr: newQr })).toMatchObject({
      state: 'credential-required',
      next: 'pin',
    });
    const proof = await student.challenge({ contractVersion: 1, qr: newQr, pin: '2001' });
    if (proof.state !== 'password-creation') throw new Error('Synthetic reset PIN failed');
    await student.activate({
      contractVersion: 1,
      challenge: proof.challenge,
      password: '013579',
      confirmation: '013579',
      keepConnected: false,
    });
    expect((await student.me()).profile.accountId).toBe(account.accountId);
    activeQr = newQr;
  }
  await student.logout();
  await expect(student.session()).rejects.toMatchObject({ state: 'unauthenticated' });
});
it('serves actual compiled HTML/assets and separates public documents from self/admin boundaries', async () => {
  for (const path of ['/', '/access']) {
    const response = await harness.fetch({ surface: 'student', path });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Permissions-Policy')).toContain('camera=(self)');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  const rejected: IntegrationRequestV1[] = [
    { surface: 'student', path: '/api/student-portal/admin/query' },
    { surface: 'student', path: '/not-found' },
    { surface: 'student', path: '/assets/not-found.js' },
  ];
  for (const input of rejected) expect((await harness.fetch(input)).status).toBe(404);
  expect(
    (
      await harness.fetch({
        surface: 'student',
        path: '/api/student/session',
        origin: 'https://foreign.invalid',
      })
    ).status,
  ).toBe(403);
});
