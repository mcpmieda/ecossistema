import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qrPrintCardsV1, qrPrintIdV1 } from '../qr-print/fixtures-v1';
import { settingsFixtureV1 } from '../ui/settings/fixtures-v1';
import { runPortalHarnessScenariosV1 as runScenariosV1 } from './harness-scenarios-v1';
function runPortalHarnessScenariosV1(connection: string, emit?: (value: HarnessDiagnosticV1) => void) {
  return runScenariosV1(connection, emit, { request: { contractVersion: 1, batchId: qrPrintIdV1(80), generation: qrPrintIdV1(81), expectedScopeRevision: 0 },
    assertUnchanged: async () => undefined, activate: async () => undefined });
}
import { createLocalPortalHarnessV1 } from './local-harness-v1';
import { emitHarnessDiagnosticV1, HARNESS_DIAGNOSTIC_SAMPLE_LIMIT_V1, HarnessDiagnosticsV1, type HarnessDiagnosticV1 } from './harness-diagnostics-v1';

vi.mock('./local-harness-v1', () => ({ createLocalPortalHarnessV1: vi.fn() }));

// Functional regression of reporting only. Scripted responses are not a performance benchmark.
function scriptedHarness(login5Ms: number | ((index: number) => number) = 1601,
  metrics: { selfMs?: number; stageMs?: number; queries?: number; rows?: number } = {}) {
  let clock = Date.UTC(2026, 0, 1);
  const measuredEnds: number[] = [];
  vi.spyOn(Date, 'now').mockImplementation(() => measuredEnds.shift() ?? clock);
  const cards = qrPrintCardsV1(5, 'qr-only');
  const base = { contractVersion: 1, requestId: qrPrintIdV1(99) };
  const authenticated = { ...base, state: 'authenticated', expiresAt: '2026-02-01T00:00:00.000Z', persistent: false };
  let loginCount = 0;
  let stageCount = 0;
  let revoked = false;
  const dispatchFetch = vi.fn(async (url: string, init: RequestInit) => {
    const started = clock;
    const path = new URL(url).pathname;
    const input = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    let body: unknown = {};
    let status = 200;
    let ms = 10;
    const headers = new Headers({ 'cache-control': 'no-store', 'x-harness-queries': String(metrics.queries ?? 31),
      'x-harness-rows': String(metrics.rows ?? 28), 'x-harness-ms': '0', 'x-harness-lock-timeouts': '0' });
    if (path === '/harness/admin/query') {
      if (input.operation === 'birth-years') body = { ...base, state: 'birth-years', scopeVersion: 1, nextCursor: null,
        items: cards.map(card => ({ accountId: card.accountId, accountVersion: 1, year: null, confirmation: null, version: 1 })) };
      if (input.operation === 'settings') body = { ...base, state: 'settings', settings: settingsFixtureV1() };
      if (input.operation === 'accounts') body = { ...base, state: 'accounts', scopeVersion: 1, nextCursor: null,
        items: cards.map(card => ({ accountId: card.accountId, link: null, name: 'PRIVATE_SYNTHETIC_NAME',
          classLabel: 'PRIVATE_SYNTHETIC_CLASS', state: 'pending-activation', eligibility: 'eligible', blocked: false, version: 1 })) };
    } else if (path === '/harness/reconciliation/stage') {
      ms = metrics.stageMs ?? ms;
      body = stageCount++ === 0 ? { state: 'preparing', preparedCount: 4, remainingCount: 1 } : { state: 'ready', preparedCount: 5, remainingCount: 0 };
    } else if (path === '/harness/admin/command') {
      if (input.operation === 'birth-batch') {
        body = { ...base, state: 'invalid-request' };
      }
      if (input.operation === 'settings-set') body = { ...base, state: 'committed', operationId: qrPrintIdV1(98), version: 1 };
      if (input.operation === 'qr-batch') body = { ...base, state: 'qr', cards, version: 1 };
    } else if (path === '/api/student/auth/challenge') {
      if (!('pin' in input)) { status = 429; headers.set('x-harness-queries', '1'); }
      body = { ...base, state: 'password-creation', challenge: 'PRIVATE_CHALLENGE_'.repeat(3), expiresAt: authenticated.expiresAt };
    } else if (path === '/api/student/auth/activate') {
      body = { ...authenticated, persistent: true };
      headers.set('set-cookie', '__Host-student_portal_session=PRIVATE_COOKIE; Secure; HttpOnly; SameSite=Strict; Expires=Sun, 01 Feb 2026 00:00:00 GMT');
    } else if (path === '/api/student/me') { body = { state: 'no-publication' }; ms = metrics.selfMs ?? ms; }
    else if (path === '/api/student/auth/login') {
      if (new Headers(init.headers).get('origin') === 'https://evil.invalid') status = 403;
      else if (!cards.some(card => card.qr === input.qr)) { status = 401; headers.set('x-harness-queries', '1'); }
      else {
        loginCount++;
        if (loginCount > 12 && loginCount <= 32) ms = typeof login5Ms === 'number' ? login5Ms : login5Ms(loginCount - 12);
        status = input.accountId ? 400 : loginCount >= 33 && loginCount <= 36 ? 401 : 200;
        body = authenticated;
        headers.set('set-cookie', '__Host-student_portal_session=PRIVATE_LOGIN_COOKIE; Secure; HttpOnly; SameSite=Strict');
      }
    } else if (path === '/api/student/auth/logout') revoked = true;
    else if (path === '/api/student/session') status = revoked ? 401 : 200;
    else throw new Error('unexpected synthetic route');
    const text = JSON.stringify(body);
    const response = new Response(text, { status, headers });
    vi.spyOn(response, 'text').mockImplementation(async () => {
      measuredEnds.push(started + ms);
      clock = Math.max(clock, started + ms);
      return text;
    });
    return response;
  });
  const close = vi.fn(async () => undefined);
  vi.mocked(createLocalPortalHarnessV1).mockResolvedValue({ runtime: { dispatchFetch }, close } as unknown as Awaited<ReturnType<typeof createLocalPortalHarnessV1>>);
  return { dispatchFetch, close, cards };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

it('exports all samples and the report even when the unchanged login-5 p95 gate rejects', async () => {
  const harness = scriptedHarness();
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  await expect(runPortalHarnessScenariosV1('synthetic-unused')).rejects.toThrow('login-5 p95');
  expect(harness.close).toHaveBeenCalledOnce();
  expect(output).toHaveBeenCalledWith('PORTAL_SYNTHETIC_HARNESS_DIAGNOSTIC', expect.any(String));
  const diagnostic = JSON.parse(output.mock.calls[0]![1] as string) as HarnessDiagnosticV1;
  expect(diagnostic).toMatchObject({ outcome: 'failed', phase: 'validation', scenariosComplete: true, checks: 'failed', cleanup: 'closed',
    coverage: { started: 94, finished: 94, retained: 94, inFlight: 0, omitted: 0 } });
  expect(diagnostic.report.find(item => item.kind === 'login-5')).toMatchObject({ count: 20, p95: 1601 });
  expect(diagnostic.samples.filter(item => item.kind === 'login-5')).toHaveLength(20);
  // No reports disappear merely because validation stops at the first rejected group.
  expect(diagnostic.report.at(-1)?.kind).toBe('revoked');
});

it('keeps the original workload, nearest-rank percentiles and exact performance boundaries', async () => {
  const harness = scriptedHarness(1500);
  const emit = vi.fn();
  const report = await runPortalHarnessScenariosV1('synthetic-unused', emit);
  expect(report.filter(item => item.kind.startsWith('login-') || item.kind.startsWith('self-'))
    .map(item => [item.kind, item.count])).toEqual([
    ['self-1', 4], ['login-1', 4], ['self-2', 8], ['login-2', 8], ['self-5', 20], ['login-5', 20],
  ]);
  expect(report.find(item => item.kind === 'login-5')).toMatchObject({ p50: 1500, p95: 1500, p99: 1500 });
  const calls = harness.dispatchFetch.mock.calls;
  expect(calls).toHaveLength(99); // 94 measured calls, one CSRF, three invalid QRs, one signed-QR burst rejection.
  const inputs = calls.map(([, init]) => init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
  expect(inputs.filter(input => input.operation === 'birth-batch')).toHaveLength(2);
  expect(inputs.filter(input => 'challenge' in input)).toHaveLength(5);
  expect(inputs.filter(input => input.password === '654321')).toHaveLength(3);
  expect(emit.mock.calls[0]![0]).toMatchObject({ outcome: 'passed', checks: 'passed', scenariosComplete: true });
  expect(harness.close).toHaveBeenCalledOnce();
});

it.each([
  { name: 'login p99', login5: (index: number) => index === 20 ? 2501 : 1000, metrics: {}, actual: 2501, expected: 2500 },
  { name: 'self p95', login5: 10, metrics: { selfMs: 751 }, actual: 751, expected: 750 },
  { name: 'reconciliation p95', login5: 10, metrics: { stageMs: 2001 }, actual: 2001, expected: 2000 },
  { name: 'query budget', login5: 10, metrics: { queries: 41 }, actual: 41, expected: 40 },
  { name: 'reconciliation query budget', login5: 10, metrics: { queries: 66 }, actual: 66, expected: 65 },
  { name: 'row budget', login5: 10, metrics: { rows: 1501 }, actual: 1501, expected: 1500 },
])('still rejects the existing $name boundary and exports diagnostics', async ({ login5, metrics, actual, expected }) => {
  const harness = scriptedHarness(login5, metrics);
  const emit = vi.fn();
  await expect(runPortalHarnessScenariosV1('synthetic-unused', emit)).rejects.toMatchObject({ actual, expected });
  expect(emit.mock.calls[0]![0]).toMatchObject({ outcome: 'failed', phase: 'validation', checks: 'failed', scenariosComplete: true });
  expect(harness.close).toHaveBeenCalledOnce();
});

it('preserves the identical rejection object with partial samples, a broken sink and a broken close', async () => {
  const harness = scriptedHarness();
  const original = new Error('PRIVATE_EXCEPTION_WITH_SQL_AND_TOKEN');
  const dispatch = harness.dispatchFetch.getMockImplementation()!;
  let calls = 0;
  harness.dispatchFetch.mockImplementation((...args) => ++calls === 3 ? Promise.reject(original) : dispatch(...args));
  harness.close.mockRejectedValue(new Error('PRIVATE_CLOSE_ERROR'));
  const emit = vi.fn((_diagnostic: HarnessDiagnosticV1) => { throw new Error('PRIVATE_SINK_ERROR'); });
  await expect(runPortalHarnessScenariosV1('synthetic-unused', emit)).rejects.toBe(original);
  expect(harness.close).toHaveBeenCalledOnce();
  const diagnostic = emit.mock.calls[0]![0];
  expect(diagnostic).toMatchObject({ outcome: 'failed', phase: 'scenarios', checks: 'not-reached', scenariosComplete: false, cleanup: 'failed',
    coverage: { started: 3, finished: 3, retained: 3, inFlight: 0 } });
  expect(diagnostic.samples[2]).toMatchObject({ status: null, bodyComplete: false, queries: null, internalMs: null, bytes: null });
  expect(diagnostic.report.find(item => item.kind === 'reconciliation-stage')?.count).toBe(1);
  expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
});

it('exports available headers and partial duration when reading the body fails', async () => {
  const harness = scriptedHarness();
  const original = new Error('PRIVATE_BODY_ERROR');
  const dispatch = harness.dispatchFetch.getMockImplementation()!;
  let calls = 0;
  harness.dispatchFetch.mockImplementation(async (...args) => {
    const response = await dispatch(...args);
    if (++calls === 2) vi.mocked(response.text).mockRejectedValue(original);
    return response;
  });
  const emit = vi.fn();
  await expect(runPortalHarnessScenariosV1('synthetic-unused', emit)).rejects.toBe(original);
  const diagnostic = emit.mock.calls[0]![0] as HarnessDiagnosticV1;
  expect(diagnostic.samples[1]).toMatchObject({ status: 200, bodyComplete: false, queries: 31, rows: 28, internalMs: 0, lockTimeouts: 0, bytes: null });
  expect(diagnostic.report.find(item => item.kind === 'reconciliation-stage')?.count).toBe(0);
  expect(diagnostic.scenariosComplete).toBe(false);
  expect(harness.close).toHaveBeenCalledOnce();
});

it('reports an empty partial run on creation failure without substituting diagnostic errors', async () => {
  const harness = scriptedHarness();
  const original = new Error('PRIVATE_CREATION_ERROR');
  vi.mocked(createLocalPortalHarnessV1).mockRejectedValue(original);
  const emit = vi.fn((_diagnostic: HarnessDiagnosticV1) => { throw new Error('PRIVATE_SINK_ERROR'); });
  await expect(runPortalHarnessScenariosV1('synthetic-unused', emit)).rejects.toBe(original);
  expect(emit.mock.calls[0]![0]).toMatchObject({ outcome: 'failed', phase: 'creation', cleanup: 'not-created', scenariosComplete: false,
    coverage: { started: 0, retained: 0 }, report: [], samples: [] });
  expect(harness.close).not.toHaveBeenCalled(); // The factory owns cleanup before it returns a harness.
});

it('propagates a cleanup failure after successful checks and exports the failed outcome', async () => {
  const harness = scriptedHarness(10);
  const original = new Error('PRIVATE_CLEANUP_ERROR');
  harness.close.mockRejectedValue(original);
  const emit = vi.fn();
  await expect(runPortalHarnessScenariosV1('synthetic-unused', emit)).rejects.toBe(original);
  expect(emit.mock.calls[0]![0]).toMatchObject({ outcome: 'failed', phase: 'cleanup', checks: 'passed', cleanup: 'failed', scenariosComplete: true });
});

it('keeps a successful scenario unchanged when its diagnostic callback fails', async () => {
  const harness = scriptedHarness(10);
  const emit = vi.fn((_diagnostic: HarnessDiagnosticV1) => { throw new Error('PRIVATE_SINK_ERROR'); });
  const report = await runPortalHarnessScenariosV1('synthetic-unused', emit);
  expect(report.find(item => item.kind === 'login-5')).toMatchObject({ count: 20, p95: 10 });
  expect(emit.mock.calls[0]![0]).toMatchObject({ outcome: 'passed', cleanup: 'closed' });
  expect(harness.close).toHaveBeenCalledOnce();
});

it('exports to independent destinations without leaking sensitive data or overriding a p95 failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'portal-diagnostic-test-'));
  try {
    const destination = join(directory, 'diagnostic.json');
    vi.stubEnv('PORTAL_TEST_METRICS_PATH', destination);
    scriptedHarness();
    vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('PRIVATE_CONSOLE_ERROR'); });
    await expect(runPortalHarnessScenariosV1('PRIVATE_CONNECTION_STRING')).rejects.toMatchObject({ actual: 1601, expected: 1500 });
    const json = readFileSync(destination, 'utf8');
    const diagnostic = JSON.parse(json) as HarnessDiagnosticV1;
    expect(diagnostic.report.find(item => item.kind === 'login-5')?.p95).toBe(1601);
    for (const secret of ['PRIVATE_', 'SYNTHETIC000', qrPrintIdV1(1), '013579', '654321', '"cookie"', '"password"', '"body"',
      '"qr"', '"accountId"', '"requestId"', '"sql"', directory]) expect(json).not.toContain(secret);

    vi.stubEnv('PORTAL_TEST_METRICS_PATH', directory); // A directory cannot be the output file.
    const output = vi.mocked(console.info).mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    scriptedHarness();
    await expect(runPortalHarnessScenariosV1('synthetic-unused')).rejects.toThrow('login-5 p95');
    expect(output).toHaveBeenCalledWith('PORTAL_SYNTHETIC_HARNESS_DIAGNOSTIC', expect.any(String));
    expect(warning).toHaveBeenCalledWith('PORTAL_SYNTHETIC_HARNESS_DIAGNOSTIC_FILE_UNAVAILABLE');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('distinguishes absent or malformed headers from zero and bounds retained samples', () => {
  const diagnostics = new HarnessDiagnosticsV1();
  const state = { outcome: 'failed', phase: 'scenarios', scenariosComplete: false, checks: 'not-reached', cleanup: 'closed' } as const;
  const zero = new Response(null, { headers: { 'x-harness-ms': '0', 'x-harness-lock-timeouts': '0', 'x-harness-queries': '0', 'x-harness-rows': '0' } });
  diagnostics.finish(diagnostics.begin('login-5'), 10, zero, 0);
  const missing = new Response(null, { headers: { 'x-harness-ms': '', 'x-harness-lock-timeouts': 'NaN', 'x-harness-queries': '-1', 'x-harness-rows': '1.5' } });
  diagnostics.finish(diagnostics.begin('login-5'), 20, missing, 0);
  for (let index = 0; index < 150; index++) diagnostics.finish(diagnostics.begin('PRIVATE_UNKNOWN_KIND'), 30);
  const snapshot = diagnostics.snapshot(state);
  expect(snapshot.samples[0]).toMatchObject({ internalMs: 0, lockTimeouts: 0, queries: 0, rows: 0 });
  expect(snapshot.samples[1]).toMatchObject({ internalMs: null, lockTimeouts: null, queries: null, rows: null });
  expect(snapshot.coverage).toMatchObject({ started: 152, finished: 152, retained: HARNESS_DIAGNOSTIC_SAMPLE_LIMIT_V1, omitted: 24 });
  expect(snapshot.samples[2]?.kind).toBe('unknown');
  expect(snapshot.report[0]).toMatchObject({ count: 2, p50: 10, p95: 20, p99: 20, missingQueries: 1, missingRows: 1 });
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_');
  expect(JSON.stringify(snapshot).length).toBeLessThan(40_000);
  // Export failure alone neither turns success into failure nor changes a recorded failed outcome.
  vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('PRIVATE_CONSOLE_ERROR'); });
  expect(() => emitHarnessDiagnosticV1(snapshot)).not.toThrow();
});

it('retains available samples if reading a diagnostic header fails', () => {
  const diagnostics = new HarnessDiagnosticsV1();
  const response = { status: 200, headers: { get: () => { throw new Error('PRIVATE_HEADER_ERROR'); } } };
  expect(() => diagnostics.finish(diagnostics.begin('login-5'), 15, response, 10)).not.toThrow();
  const snapshot = diagnostics.snapshot({ outcome: 'failed', phase: 'scenarios', scenariosComplete: false, checks: 'not-reached', cleanup: 'closed' });
  expect(snapshot.samples[0]).toMatchObject({ ms: 15, status: 200, bodyComplete: true, bytes: 10, queries: null });
  expect(snapshot.coverage).toMatchObject({ collectionFailures: 1, samples: 'partial' });
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_HEADER_ERROR');
});
