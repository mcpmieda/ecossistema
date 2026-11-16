// @vitest-environment node
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isSystemHealthSnapshotV1,
  isPortalMonitorSampleV1,
  isPortalMaintenanceSampleV1,
  isHealthInstantV1,
  systemHealthStateV1,
  sampleIsFreshV1,
  cappedHealthCountV1,
} from '../../shared/system-health-v1.ts';
import { healthDeadlineV1, readHealthJsonV1 } from '../../shared/health-io-v1.ts';
import {
  collectSystemHealthV1,
  createSystemHealthCacheV1,
} from '../../server/platform/system-health-source-v1.ts';
import { createHealthMonitorV1 } from '../../src/platform/system-health-controller-v1.ts';
import type {
  PortalMaintenanceSampleV1,
  PortalMonitorSampleV1,
  SystemHealthSnapshotV1,
} from '../../shared/system-health-v1';
const at = '2026-09-21T18:00:00.000Z';
const NOW = Date.parse(at);
const m = (): PortalMaintenanceSampleV1 => ({
  status: 'normal',
  liveOutboxAvailable: true,
  expiredIp: 0,
  expiredAudit: 0,
  backlog: false,
  exhausted: false,
  publicationDue: 0,
  oldestPublicationDueMs: 0,
  liveBacklog: false,
  livePending: 0,
  liveRetrying: 0,
  oldestLiveDueMs: 0,
  waitingConnections: 0,
  oldestWaitingQueryMs: 0,
});
const portal = (): PortalMonitorSampleV1 => ({
  schemaVersion: 1,
  observedAt: at,
  servingEnabled: true,
  credentialsConfigured: true,
  database: 'ok',
  readDurationMs: 20,
  maintenance: m(),
});
const snapshot = (): SystemHealthSnapshotV1 => ({
  schemaVersion: 1,
  generatedAt: at,
  portalReadState: 'ok',
  portal: portal(),
  publicEntry: { outcome: 'ok', status: 200, durationMs: 30, observedAt: at },
});
const abort = () => new AbortController().signal;
const delay = (ms = 8) => new Promise<void>((resolve) => setTimeout(resolve, ms));
test('closed aggregate contract accepts valid zeros', () => {
  assert.ok(isSystemHealthSnapshotV1(snapshot()));
  assert.ok(isPortalMaintenanceSampleV1(m()));
});
for (const field of ['studentId', 'name', 'cookie', 'sql', 'token', 'rawError', 'ip'])
  test(`rejects unexpected private field ${field}`, () => {
    const p = { ...portal(), [field]: 'MUST-NOT-LEAK' };
    assert.equal(isPortalMonitorSampleV1(p), false);
    const s = snapshot();
    s.publicEntry = { ...s.publicEntry, [field]: 'MUST-NOT-LEAK' };
    assert.equal(isSystemHealthSnapshotV1(s), false);
  });
for (const value of [-1, 0.5, 1002, Infinity, NaN, '1'])
  test(`rejects invalid bounded queue count ${String(value)}`, () => {
    const valueM = { ...m(), livePending: value };
    assert.equal(isPortalMaintenanceSampleV1(valueM), false);
  });
test('unavailable database cannot carry stale counters', () => {
  const p = portal();
  p.database = 'unavailable';
  assert.equal(isPortalMonitorSampleV1(p), false);
  p.maintenance = null;
  assert.ok(isPortalMonitorSampleV1(p));
});
test('only canonical server instants are accepted', () => {
  for (const v of ['', 'hello', null, '2026-13-21T18:00:00.000Z', '2026-09-21'])
    assert.equal(isHealthInstantV1(v), false);
  assert.ok(isHealthInstantV1(at));
});
test('freshness rejects future timestamps and expires after two minutes', () => {
  assert.ok(sampleIsFreshV1(at, NOW));
  assert.equal(sampleIsFreshV1(at, NOW - 6000), false);
  assert.equal(sampleIsFreshV1(at, NOW + 120001), false);
});
test('normal means only basic checks; stale snapshots become unknown', () => {
  assert.equal(systemHealthStateV1(snapshot(), NOW), 'normal');
  assert.equal(systemHealthStateV1(snapshot(), NOW + 120001), 'unknown');
});
test('individual source dates cannot be refreshed by a recent envelope', () => {
  const s = snapshot();
  assert.ok(s.portal?.maintenance);
  s.portal.observedAt = '2026-09-21T17:00:00.000Z';
  assert.equal(systemHealthStateV1(s, NOW), 'unknown');
});
test('missing outbox schema never appears as healthy zero', () => {
  const s = snapshot();
  assert.ok(s.portal?.maintenance);
  s.portal.maintenance.liveOutboxAvailable = false;
  assert.equal(systemHealthStateV1(s, NOW), 'unknown');
});
test('disabled portal and missing credentials require attention', () => {
  for (const field of ['servingEnabled', 'credentialsConfigured'] as const) {
    const s = snapshot();
    assert.ok(s.portal);
    s.portal[field] = false;
    assert.equal(systemHealthStateV1(s, NOW), 'attention');
  }
});
test('existing intervention and HTTP errors are critical checks', () => {
  const s = snapshot();
  assert.ok(s.portal?.maintenance);
  s.portal.maintenance.status = 'intervention';
  assert.equal(systemHealthStateV1(s, NOW), 'critical');
  const h = snapshot();
  h.publicEntry = { ...h.publicEntry, outcome: 'http-error', status: 503 };
  assert.equal(systemHealthStateV1(h, NOW), 'critical');
});
test('saturated counts are not displayed as exact totals', () => {
  assert.equal(cappedHealthCountV1(1001), '1.000+');
  assert.equal(cappedHealthCountV1(101, 101), '100+');
});
test('source collection uses fixed HEAD, omits cookies and rejects redirects', async () => {
  let calls = 0;
  const result = await collectSystemHealthV1({
    production: true,
    now: () => NOW,
    readPortal: async () => portal(),
    fetcher: async (url, init) => {
      calls++;
      assert.equal(url, 'https://aluno.escolaieda.com/');
      assert.ok(init);
      assert.equal(init.method, 'HEAD');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).has('cookie'), false);
      assert.equal(new Headers(init.headers).has('authorization'), false);
      return new Response(null, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
    },
  });
  assert.equal(calls, 1);
  assert.ok(isSystemHealthSnapshotV1(result));
});
test('nonproduction never probes production origin', async () => {
  const result = await collectSystemHealthV1({
    production: false,
    now: () => NOW,
    fetcher: () => {
      throw Error('must-not-run');
    },
  });
  assert.equal(result.publicEntry.outcome, 'not-probed');
  assert.equal(result.portalReadState, 'unconfigured');
});
test('one failed source does not erase other successful samples', async () => {
  const result = await collectSystemHealthV1({
    production: true,
    now: () => NOW,
    readPortal: async () => portal(),
    fetcher: async () => {
      throw new Error('RAW-SECRETS-MUST-NOT-LEAK');
    },
  });
  assert.ok(result.portal);
  assert.equal(result.portal.database, 'ok');
  assert.equal(result.publicEntry.outcome, 'unavailable');
  assert.equal(JSON.stringify(result).includes('RAW-SECRETS'), false);
});
test('invalid private data is refused without reflecting its contents', async () => {
  const result = await collectSystemHealthV1({
    production: false,
    now: () => NOW,
    readPortal: async () => ({ ...portal(), secret: 'DO-NOT-LEAK' }),
  });
  assert.equal(result.portal, null);
  assert.equal(result.portalReadState, 'unavailable');
  assert.equal(JSON.stringify(result).includes('DO-NOT-LEAK'), false);
});
test('HTTP 200 with unexpected content type is not healthy', async () => {
  const result = await collectSystemHealthV1({
    production: true,
    now: () => NOW,
    fetcher: async () => Response.json({ error: true }),
  });
  assert.equal(result.publicEntry.outcome, 'unexpected-response');
});
test('cache coalesces concurrent reads, respects TTL and never resets sampled time', async () => {
  let now = NOW;
  let calls = 0;
  const cached = createSystemHealthCacheV1(() => now);
  const load = async () => {
    calls++;
    await delay();
    return snapshot();
  };
  const [a, b] = await Promise.all([cached(load), cached(load)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  now += 29999;
  await cached(load);
  assert.equal(calls, 1);
  now++;
  const after = await cached(load);
  assert.equal(calls, 2);
  assert.equal(after.generatedAt, at);
});
test('failed cache load is retryable and instances do not share data', async () => {
  const cache = createSystemHealthCacheV1();
  await assert.rejects(
    cache(async () => {
      throw Error('failure');
    }),
  );
  assert.equal((await cache(async () => snapshot())).generatedAt, at);
  const other = createSystemHealthCacheV1();
  let calls = 0;
  await other(async () => {
    calls++;
    return snapshot();
  });
  assert.equal(calls, 1);
});
test('deadline works when a transport ignores cancellation', async () => {
  await assert.rejects(
    healthDeadlineV1(() => new Promise(() => {}), 15),
    /health-read-aborted/,
  );
});
test('bounded JSON rejects oversized streams and content-length', async () => {
  await assert.rejects(
    readHealthJsonV1(new Response('"' + 'x'.repeat(20000) + '"'), abort()),
    /too-large/,
  );
  await assert.rejects(
    readHealthJsonV1(new Response('{}', { headers: { 'content-length': '20000' } }), abort()),
    /too-large/,
  );
  assert.deepEqual(await readHealthJsonV1(Response.json({}), abort()), {});
});
test('bound counts bytes, including multibyte input', async () => {
  await assert.rejects(
    readHealthJsonV1(new Response(JSON.stringify('á'.repeat(40))), abort(), 64),
    /too-large/,
  );
});
test('deadline cancels an unfinished response stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    healthDeadlineV1((signal) => readHealthJsonV1(new Response(body), signal), 15),
    /health-read-aborted/,
  );
  await delay();
  assert.equal(cancelled, true);
});
test('controller does not poll until started and coalesces refresh clicks', async () => {
  let calls = 0;
  const monitor = createHealthMonitorV1({
    fetcher: async () => {
      calls++;
      await delay(15);
      return Response.json(snapshot());
    },
  });
  await delay();
  assert.equal(calls, 0);
  monitor.start();
  void monitor.refresh();
  void monitor.refresh();
  await delay(35);
  assert.equal(calls, 1);
  assert.ok(monitor.getState().snapshot);
  monitor.stop();
  assert.equal(monitor.getState().snapshot, null);
});
test('hidden/offline controller does not start network work', async () => {
  let calls = 0;
  const monitor = createHealthMonitorV1({
    fetcher: async () => {
      calls++;
      return Response.json(snapshot());
    },
  });
  monitor.setAvailable(false);
  monitor.start();
  await delay();
  assert.equal(calls, 0);
  monitor.setAvailable(true);
  await delay();
  assert.equal(calls, 1);
  monitor.stop();
});
for (const code of [401, 403])
  test(`confirmed ${code} clears data and stops retries`, async () => {
    let now = NOW;
    let calls = 0;
    let denied = 0;
    const monitor = createHealthMonitorV1({
      now: () => now,
      onDenied: () => {
        denied++;
      },
      fetcher: async () =>
        ++calls === 1 ? Response.json(snapshot()) : new Response('sensitive', { status: code }),
    });
    monitor.start();
    await delay();
    assert.ok(monitor.getState().snapshot);
    now += 6000;
    await monitor.refresh();
    assert.equal(monitor.getState().snapshot, null);
    assert.equal(monitor.getState().error, 'denied');
    now += 6000;
    await monitor.refresh();
    assert.equal(calls, 2);
    assert.equal(denied, 1);
    monitor.stop();
  });
test('unmounted controller rejects late data even when fetch ignores abort', async () => {
  let finish: (response: Response) => void = () => {
    throw new Error('request-not-started');
  };
  const monitor = createHealthMonitorV1({
    fetcher: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  monitor.start();
  await delay();
  monitor.stop();
  finish(Response.json(snapshot()));
  await delay();
  assert.equal(monitor.getState().snapshot, null);
});
test('transient failure retains historical sample but marks the read unavailable', async () => {
  let now = NOW;
  let calls = 0;
  const monitor = createHealthMonitorV1({
    now: () => now,
    fetcher: async () => {
      if (++calls === 1) return Response.json(snapshot());
      throw Error('private error');
    },
  });
  monitor.start();
  await delay();
  now += 6000;
  await monitor.refresh();
  assert.ok(monitor.getState().snapshot);
  assert.equal(monitor.getState().error, 'unavailable');
  monitor.stop();
});
