import { seedExistingBirthFixtureV1 } from '../smoke/legacy-seed-fixture-v1';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createIntegrationHarnessV1 } from '../frontend-integration/harness-v1';
import { installIntegrationFixtureV1 } from '../frontend-integration/fixture-v1';
import { localPortalDatabaseV1 } from '../frontend-foundation/harness-v1';
import { createPortalAdminClientV1 } from '../../../src/features/student-portal-admin/shared/admin-client-v1';
import { createPortalAdminReadClientV2 } from '../../../src/features/student-portal-admin/accounts/accounts-client-v2';
import { createPortalSelfClientV1 } from '../../../src/features/student-portal/shared/self-client-v1';

const target = process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid';
localPortalDatabaseV1(target);
const sql = postgres(target, { max: 1, onnotice: () => undefined });
let harness: Awaited<ReturnType<typeof createIntegrationHarnessV1>>;
let fixture: Awaited<ReturnType<typeof installIntegrationFixtureV1>>;
const adminFetch = async (path: string, init: RequestInit) =>
  (await harness.fetch({
    surface: 'admin',
    path,
    method: init.method,
    body: init.body as string,
  })) as unknown as Response;
const admin = createPortalAdminClientV1({ fetch: adminFetch });
const reader = createPortalAdminReadClientV2({ fetch: adminFetch });
function studentClient() {
  let cookie: string | undefined;
  return {
    get cookie() {
      return cookie;
    },
    client: createPortalSelfClientV1({
      fetch: async (path, init) => {
        const response = await harness.fetch({
          surface: 'student',
          path,
          method: init.method,
          body: init.body as string | undefined,
          cookie,
        });
        if (response.headers.has('set-cookie'))
          cookie = response.headers.get('set-cookie')!.split(';')[0];
        return response as unknown as Response;
      },
    }),
  };
}
const first = studentClient(),
  second = studentClient();
let firstId: string, secondId: string, firstQr: string;
const scopeOf = (accountId: string) =>
  ({ kind: 'account', academicYear: 2026, accountId }) as const;
async function version(accountId: string) {
  const result = await reader.query({
    contractVersion: 2,
    operation: 'accounts-read',
    scope: scopeOf(accountId),
    page: {},
  });
  if (result.state !== 'accounts-read' || result.items.length !== 1)
    throw new Error('Synthetic account missing');
  return result.items[0]!.version;
}
async function activate(accountId: string, student: ReturnType<typeof studentClient>) {
  const scope = scopeOf(accountId);
  const birth = await admin.query({
    contractVersion: 1,
    operation: 'birth-years',
    scope,
    page: {},
  });
  if (birth.state !== 'birth-years') throw new Error('Synthetic birth missing');
  await seedExistingBirthFixtureV1(sql, accountId);
  const settings = await admin.query({
    contractVersion: 1,
    operation: 'settings',
    scope,
    page: {},
  });
  if (settings.state !== 'settings') throw new Error('Synthetic settings missing');
  const now = Math.floor(Date.now() / 1000) * 1000;
  await admin.command({
    contractVersion: 1,
    operation: 'settings-set',
    scope,
    expectedVersion: settings.settings.version,
    idempotencyKey: crypto.randomUUID(),
    acknowledgeImmediateEffect: true,
    value: {
      accessEnabled: true,
      allowedPeriods: [],
      calendar: {
        ...settings.settings.value.calendar,
        yearStartsAt: new Date(now - 86400_000).toISOString(),
        yearEndsAt: new Date(now + 86400_000).toISOString(),
      },
    },
  });
  const qr = await admin.command({
    contractVersion: 1,
    operation: 'qr-issue',
    accountId,
    expectedVersion: await version(accountId),
    idempotencyKey: crypto.randomUUID(),
  });
  if (qr.state !== 'qr') throw new Error('Synthetic QR missing');
  const challenge = await student.client.challenge({
    contractVersion: 1,
    qr: qr.cards[0]!.qr,
    pin: '2001',
  });
  if (challenge.state !== 'password-creation') throw new Error('Synthetic activation missing');
  await student.client.activate({
    contractVersion: 1,
    challenge: challenge.challenge,
    password: '013579',
    confirmation: '013579',
    keepConnected: false,
  });
  return qr.cards[0]!.qr;
}
beforeAll(async () => {
  fixture = await installIntegrationFixtureV1(sql);
  harness = await createIntegrationHarnessV1(target);
  const accounts = await reader.query({
    contractVersion: 2,
    operation: 'accounts-read',
    scope: fixture.scope,
    page: { limit: 100 },
  });
  if (accounts.state !== 'accounts-read') throw new Error('Synthetic accounts missing');
  firstId = accounts.items.find((a) => a.link?.studentId === fixture.studentId)!.accountId;
  secondId = accounts.items.find((a) => a.link?.studentId === fixture.otherStudentId)!.accountId;
  firstQr = await activate(firstId, first);
  await activate(secondId, second);
});
afterAll(async () => {
  await harness?.dispose();
  await sql.end({ timeout: 2 });
});

it('isolates two actual cookie sessions and rejects target selectors and forged administration', async () => {
  for (const [student, own, other] of [
    [first, firstId, secondId],
    [second, secondId, firstId],
  ] as const) {
    const self = await student.client.me();
    expect(self.profile.accountId).toBe(own);
    expect(JSON.stringify(self)).not.toContain(other);
    expect(self.subjects).toHaveLength(0);
    for (const path of [
      '/api/student/me?accountId=' + other,
      '/api/student/me?academicYear=2025',
    ]) {
      const response = await harness.fetch({ surface: 'student', path, cookie: student.cookie });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(other);
    }
  }
  const forged = {
    contractVersion: 1,
    operation: 'block',
    accountId: secondId,
    blocked: true,
    confirmed: true,
    expectedVersion: await version(secondId),
    idempotencyKey: crypto.randomUUID(),
  };
  for (const extra of [
    { anonymous: true, cookie: first.cookie },
    { role: 'PROFESSOR' as const },
    { origin: 'https://foreign.invalid' },
  ]) {
    const result = await harness.fetch({
      surface: 'admin',
      path: '/api/student-portal/admin/command',
      body: JSON.stringify(forged),
      ...extra,
    });
    expect([401, 403]).toContain(result.status);
  }
  expect((await second.client.me()).profile.accountId).toBe(secondId);
});
it('binds the actual cursor to scope and rejects forged context while preserving the valid page', async () => {
  const query = {
    contractVersion: 2 as const,
    operation: 'accounts-read' as const,
    scope: fixture.scope,
    page: { limit: 1 },
  };
  const page = await reader.query(query);
  if (page.state !== 'accounts-read') throw new Error('Synthetic page missing');
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBeTruthy();
  const next = await reader.query({ ...query, page: { limit: 1, cursor: page.nextCursor! } });
  if (next.state !== 'accounts-read') throw new Error('Synthetic next page missing');
  expect(next.items[0]!.accountId).not.toBe(page.items[0]!.accountId);
  await expect(
    reader.query({
      ...query,
      scope: { ...fixture.scope, classId: fixture.emptyClassId },
      page: { limit: 1, cursor: page.nextCursor! },
    }),
  ).rejects.toBeDefined();
  const forged = await harness.fetch({
    surface: 'admin',
    path: '/api/student-portal/admin/query',
    body: JSON.stringify({
      ...query,
      trustedAdminContext: { capability: 'platform.settings.write' },
    }),
  });
  expect(forged.status).toBe(400);
});
it('keeps revocation and QR rotation effective across compatible runtime restart without affecting another account', async () => {
  const oldCookie = first.cookie;
  const rotated = await admin.command({
    contractVersion: 1,
    operation: 'qr-regenerate',
    accountId: firstId,
    expectedVersion: await version(firstId),
    idempotencyKey: crypto.randomUUID(),
    confirmed: true,
  });
  expect(rotated.state).toBe('qr');
  await harness.dispose();
  harness = await createIntegrationHarnessV1(target);
  const revoked = await harness.fetch({
    surface: 'student',
    path: '/api/student/me',
    cookie: oldCookie,
  });
  expect(revoked.status).toBe(401);
  await expect(
    first.client.login({
      contractVersion: 1,
      qr: firstQr,
      password: '013579',
      keepConnected: false,
    }),
  ).rejects.toBeDefined();
  expect((await second.client.me()).profile.accountId).toBe(secondId);
  const sessions = await reader.query({
    contractVersion: 2,
    operation: 'sessions-read',
    scope: scopeOf(firstId),
    page: { limit: 100 },
  });
  if (sessions.state !== 'sessions-read') throw new Error('Synthetic sessions missing');
  expect(sessions.items.every((s) => s.validity !== 'valid')).toBe(true);
});
it('measures bounded full-HTTP self reads including failures against the pre-existing payload and latency budgets', async () => {
  const elapsed: number[] = [],
    bytes: number[] = [],
    statuses: number[] = [];
  for (let index = 0; index < 12; index++) {
    const start = performance.now();
    const response = await harness.fetch({
      surface: 'student',
      path: '/api/student/me',
      cookie: second.cookie,
    });
    const body = await response.text();
    elapsed.push(performance.now() - start);
    statuses.push(response.status);
    bytes.push(Buffer.byteLength(body));
    expect(
      response.headers
        .get('Cache-Control')
        ?.split(',')
        .map((x) => x.trim()),
    ).toContain('no-store');
    expect(body).not.toContain(firstId);
  }
  const sorted = [...elapsed].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    p99 = sorted[Math.ceil(sorted.length * 0.99) - 1]!;
  process.stdout.write(
    'P758_SELF_HTTP ' +
      JSON.stringify({
        samples: elapsed.length,
        statuses,
        p95,
        p99,
        maxBytes: Math.max(...bytes),
        concurrency: 1,
      }) +
      '\n',
  );
  expect(statuses.every((s) => s === 200)).toBe(true);
  expect(Math.max(...bytes)).toBeLessThanOrEqual(256 * 1024);
  expect(p95).toBeLessThanOrEqual(750);
  expect(p99).toBeLessThanOrEqual(1500);
});
