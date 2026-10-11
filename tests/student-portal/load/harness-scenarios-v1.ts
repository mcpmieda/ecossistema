import { expect } from 'vitest';
import { adminResponseV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { failureV1 } from '../../../shared/student-portal-contracts/core-v1';
import { challengeResponseV1, sessionResponseV1 } from '../../../shared/student-portal-contracts/auth-v1';
import { createLocalPortalHarnessV1 } from './local-harness-v1';
import type { ReconciliationHarnessFixtureV1 } from './reconciliation-harness-fixture-v1';
import { emitHarnessDiagnosticV1, HarnessDiagnosticsV1, type HarnessDiagnosticV1, type HarnessDiagnosticStateV1 } from './harness-diagnostics-v1';

export async function runPortalHarnessScenariosV1(connectionString: string, emit: (diagnostic: HarnessDiagnosticV1) => void = emitHarnessDiagnosticV1,
  reconciliation?: ReconciliationHarnessFixtureV1) {
  let harness: Awaited<ReturnType<typeof createLocalPortalHarnessV1>> | undefined;
  const scope = { kind: 'class', academicYear: 2026, classId: 950001 };
  const samples: { kind: string; ms: number; queries: number; rows: number; bytes: number }[] = [];
  const diagnostics = new HarnessDiagnosticsV1();
  const state: HarnessDiagnosticStateV1 = { outcome: 'failed', phase: 'creation', scenariosComplete: false,
    checks: 'not-reached', cleanup: 'not-created' };
  let originalFailure = false;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  let report: { kind: string; count: number; p50: number; p95: number; p99: number;
    maxQueries: number; maxRows: number; maxBytes: number }[];
  try {
    harness = await createLocalPortalHarnessV1(connectionString);
    const runtime = harness.runtime;
    state.phase = 'scenarios';
    const call = async (path: string, input?: unknown, cookie?: string, kind = 'setup', expectedStatus = 200) => {
      const observation = diagnostics.begin(kind);
      const started = Date.now();
      let response: Awaited<ReturnType<typeof runtime.dispatchFetch>> | undefined;
      let ms: number | undefined;
      let bytes: number | null = null;
      try {
        response = await runtime.dispatchFetch(`https://aluno.escolaieda.com${path}`, {
          method: input === undefined ? 'GET' : 'POST', headers: { origin: 'https://aluno.escolaieda.com',
            'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        const text = await response.text();
        ms = Date.now() - started;
        bytes = new TextEncoder().encode(text).byteLength;
        samples.push({ kind, ms, queries: Number(response.headers.get('x-harness-queries')),
          rows: Number(response.headers.get('x-harness-rows')), bytes });
        expect(response.status).toBe(expectedStatus);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(samples.at(-1)!.bytes).toBeLessThanOrEqual(256 * 1024);
        return { body: JSON.parse(text) as unknown, cookie: response.headers.get('set-cookie') };
      } finally { diagnostics.finish(observation, ms ?? Date.now() - started, response, bytes); }
    };
    const query = async (operation: string) => adminResponseV1.parse((await call('/harness/admin/query', { contractVersion: 1, operation, scope, page: { limit: 100 } })).body);
    const command = async (input: object, kind = 'setup') => adminResponseV1.parse((await call('/harness/admin/command', { contractVersion: 1, idempotencyKey: crypto.randomUUID(), ...input }, undefined, kind)).body);
    const birth = await query('birth-years');
    if (birth.state !== 'birth-years') throw new Error('synthetic-harness-birth-state');
    expect(birth.items).toHaveLength(5);
    const batch = { operation: 'birth-batch', idempotencyKey: crypto.randomUUID(), expectedVersion: birth.scopeVersion,
      classId: 950001, expectedCount: 5, confirmed: true,
      items: birth.items.map((item) => ({ action: 'set', accountId: item.accountId, expectedVersion: item.version, year: '2001', confirmation: 'confirmed' })) };
    if (!reconciliation) throw new Error('synthetic-reconciliation-fixture-required');
    // Real bounded KDF runs inside workerd; accounts stay untouched until the application's final transaction.
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = (await call('/harness/reconciliation/stage', reconciliation.request, undefined, 'reconciliation-stage')).body;
      expect(result).toEqual(attempt === 0 ? { state: 'preparing', preparedCount: 4, remainingCount: 1 }
        : { state: 'ready', preparedCount: 5, remainingCount: 0 });
      await reconciliation.assertUnchanged();
    }
    await reconciliation.activate();
    for (let attempt = 0; attempt < 2; attempt++)
      expect(failureV1.parse((await call('/harness/admin/command', { contractVersion: 1, ...batch }, undefined, 'manual-denied')).body).state).toBe('invalid-request');
    const settings = await query('settings');
    if (settings.state !== 'settings') throw new Error('synthetic-harness-settings-state');
    const clock = Math.floor(Date.now() / 1000) * 1000;
    expect((await command({ operation: 'settings-set', scope, expectedVersion: settings.settings.version, acknowledgeImmediateEffect: true,
      value: { accessEnabled: true, calendar: { ...settings.settings.value.calendar,
        yearStartsAt: new Date(clock - 365 * 86400_000).toISOString(), yearEndsAt: new Date(clock + 365 * 86400_000).toISOString() } } })).state).toBe('committed');
    const accounts = await query('accounts');
    if (accounts.state !== 'accounts') throw new Error('synthetic-harness-accounts-state');
    const cards = await command({ operation: 'qr-batch', classId: 950001, accountIds: accounts.items.map((item) => item.accountId),
      mode: 'qr-only', confirmed: true, expectedVersion: accounts.scopeVersion });
    if (cards.state !== 'qr') throw new Error('synthetic-harness-qr-state');
    const cookies: string[] = [];
    for (const card of cards.cards) {
      const challenge = challengeResponseV1.parse((await call('/api/student/auth/challenge', { contractVersion: 1, qr: card.qr, pin: '2001' })).body);
      if (challenge.state !== 'password-creation') throw new Error('synthetic-harness-challenge-state');
      const activated = await call('/api/student/auth/activate', { contractVersion: 1, challenge: challenge.challenge,
        password: '013579', confirmation: '013579', keepConnected: true });
      expect(sessionResponseV1.parse(activated.body).state).toBe('authenticated');
      expect(activated.cookie).toContain('; Secure; HttpOnly; SameSite=Strict');
      expect(activated.cookie).toContain('; Expires=');
      cookies.push(activated.cookie!.split(';')[0]!);
    }
    for (const concurrency of [1, 2, 5]) {
      for (let round = 0; round < 4; round++) {
        await Promise.all(cookies.slice(0, concurrency).map(async (cookie) => {
          const result = await call('/api/student/me', undefined, cookie, `self-${concurrency}`);
          expect((result.body as { state: string }).state).toBe('no-publication');
        }));
        await Promise.all(cards.cards.slice(0, concurrency).map(async (card) => {
          const result = await call('/api/student/auth/login', { contractVersion: 1, qr: card.qr, password: '013579', keepConnected: false }, undefined, `login-${concurrency}`);
          expect(sessionResponseV1.parse(result.body).state).toBe('authenticated');
          expect(result.cookie).not.toContain('Expires=');
        }));
      }
    }
    // All five accounts share the same synthetic school NAT IP. Counters remain per account in PG.
    await Promise.all([0, 1, 2].map(() => call('/api/student/auth/login',
      { contractVersion: 1, qr: cards.cards[0]!.qr, password: '654321', keepConnected: false }, undefined, 'denied', 401)));
    await call('/api/student/auth/login', { contractVersion: 1, qr: cards.cards[0]!.qr, password: '013579', keepConnected: false }, undefined, 'denied', 401);
    expect(sessionResponseV1.parse((await call('/api/student/auth/login',
      { contractVersion: 1, qr: cards.cards[1]!.qr, password: '013579', keepConnected: false }, undefined, 'nat-unaffected')).body).state).toBe('authenticated');
    await call('/api/student/auth/login', { contractVersion: 1, qr: cards.cards[1]!.qr, password: '013579', keepConnected: false,
      accountId: cards.cards[0]!.accountId }, undefined, 'invalid-claim', 400);
    const csrf = await harness.runtime.dispatchFetch('https://aluno.escolaieda.com/api/student/auth/login', {
      method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: '{}',
    });
    expect(csrf.status).toBe(403);
    await call('/api/student/auth/logout', { contractVersion: 1 }, cookies[1], 'logout');
    await call('/api/student/session', undefined, cookies[1], 'revoked', 401);
    const original = cards.cards[4]!.qr;
    const invalidQr = original.slice(0, -1) + (original.endsWith('A') ? 'B' : 'A');
    // Invalid signatures are now rejected before the proven-credential quota (#1249).
    for (let attempt = 0; attempt < 3; attempt++) {
      const invalid = await harness.runtime.dispatchFetch('https://aluno.escolaieda.com/api/student/auth/login', {
        method: 'POST', headers: { origin: 'https://aluno.escolaieda.com', 'content-type': 'application/json' },
        body: JSON.stringify({ contractVersion: 1, qr: invalidQr, password: '013579', keepConnected: false }),
      });
      await invalid.arrayBuffer();
      expect(invalid.status).toBe(401);
      expect(Number(invalid.headers.get('x-harness-queries'))).toBe(1);
    }
    let burstRejected = false;
    // Exercise the same native local limiter using an actually signed credential, without KDF.
    // At most 61 local requests covers a possible 60-second window boundary without sleeping.
    for (let attempt = 0; attempt < 61; attempt++) {
      const response = await harness.runtime.dispatchFetch('https://aluno.escolaieda.com/api/student/auth/challenge', {
        method: 'POST', headers: { origin: 'https://aluno.escolaieda.com', 'content-type': 'application/json' },
        body: JSON.stringify({ contractVersion: 1, qr: original }),
      });
      await response.arrayBuffer();
      expect([200, 429]).toContain(response.status);
      if (response.status === 429) {
        // Only the factory's role check occurred; no authentication transaction was entered.
        expect(Number(response.headers.get('x-harness-queries'))).toBe(1);
        burstRejected = true; break;
      }
    }
    expect(burstRejected).toBe(true);

    state.scenariosComplete = true;
    state.phase = 'validation';
    state.checks = 'failed';
    report = [...new Set(samples.map((sample) => sample.kind))].map((kind) => {
      const values = samples.filter((sample) => sample.kind === kind);
      const times = values.map((sample) => sample.ms).sort((a, b) => a - b);
      const percentile = (q: number) => times[Math.ceil(q * times.length) - 1]!;
      const result = { kind, count: times.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99),
        maxQueries: Math.max(...values.map((sample) => sample.queries)), maxRows: Math.max(...values.map((sample) => sample.rows)), maxBytes: Math.max(...values.map((sample) => sample.bytes)) };
      return result;
    });
    for (const result of report) {
      const { kind } = result;
      if (kind.startsWith('self-')) { expect(result.p95).toBeLessThanOrEqual(750); expect(result.p99).toBeLessThanOrEqual(1500); expect(result.maxQueries).toBeLessThanOrEqual(40); }
      if (kind.startsWith('login-')) { expect(result.p95, `${kind} p95`).toBeLessThanOrEqual(1500); expect(result.p99, `${kind} p99`).toBeLessThanOrEqual(2500); expect(result.maxQueries).toBeLessThanOrEqual(40); }
      if (kind === 'reconciliation-stage') { expect(result.p95).toBeLessThanOrEqual(2000); expect(result.p99).toBeLessThanOrEqual(3000); expect(result.maxQueries).toBeLessThanOrEqual(65); }
      expect(result.maxRows).toBeLessThanOrEqual(1500);
    }
    state.checks = 'passed';
    state.phase = 'complete';
    state.outcome = 'passed';
  } catch (error) { originalFailure = true; throw error; }
  finally {
    try {
      if (harness) { await harness.close(); state.cleanup = 'closed'; }
    } catch (error) {
      state.cleanup = 'failed'; state.outcome = 'failed';
      if (!originalFailure) { state.phase = 'cleanup'; cleanupFailed = true; cleanupFailure = error; }
    } finally {
      try { emit(diagnostics.snapshot(state)); }
      catch { /* Best effort only: preserve the original exception and resource closure. */ }
    }
  }
  if (cleanupFailed) throw cleanupFailure;
  return report;
}
