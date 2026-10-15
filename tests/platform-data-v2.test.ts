import { describe, expect, it, vi } from 'vitest';
import { createPlatformDataV2, prefetchPlatformDataV2, type PlatformLoadStateV2 } from '../src/platform/platform-data-v2';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

const template = () => buildPlatformSnapshot({ lists: [], moduleItems: [], configurationItems: [], auditItems: [], migrationItems: [],
  correlationId: 'synthetic' }, ['platform.snapshot.read', 'platform.settings.read']);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('native Center bootstrap #806', () => {
  it('uses the reads started with the identity check once, and reads again when they failed', async () => {
    const early = vi.fn<typeof fetch>(async (path) => String(path).endsWith('/bootstrap')
      ? json({ ...template(), correlationId: 'early' }) : json({}, 503));
    prefetchPlatformDataV2(early);
    expect(early).toHaveBeenCalledTimes(2);
    const states: PlatformLoadStateV2[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => json({ ...template(), correlationId: 'late' }));
    const controller = createPlatformDataV2((state) => states.push(state), fetcher);
    try {
      await controller.start();
      await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'ready' }));
      expect(fetcher.mock.calls.map(([path]) => String(path))).toEqual(['/api/platform/snapshot-v2']);
      expect(states.find((state) => state.status === 'ready')).toMatchObject({ snapshot: { correlationId: 'early' } });
      await controller.start();
      expect(fetcher.mock.calls.map(([path]) => String(path)).filter((path) => path.endsWith('/bootstrap'))).toHaveLength(1);
    } finally { controller.dispose(); }
  });
  it('opens native modules before the independent Microsoft request completes', async () => {
    const auxiliary = deferred<Response>();
    const states: PlatformLoadStateV2[] = [];
    const fetcher = vi.fn<typeof fetch>(async (path) => String(path).endsWith('/bootstrap') ? json(template()) : auxiliary.promise);
    const controller = createPlatformDataV2((state) => states.push(state), fetcher);
    try {
      await controller.start();
      expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'loading' });
      const complete = { ...template(), correlationId: 'auxiliary-ready' };
      auxiliary.resolve(json(complete));
      await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'ready', snapshot: { correlationId: 'auxiliary-ready' } }));
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { controller.dispose(); }
  });
  it('keeps the native bootstrap on Microsoft failure and respects its retry deadline', async () => {
    let clock = 0; let auxiliaryReads = 0;
    const states: PlatformLoadStateV2[] = [];
    const fetcher = vi.fn<typeof fetch>(async (path, init) => {
      expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      if (String(path).endsWith('/bootstrap')) return json(template());
      auxiliaryReads++;
      return auxiliaryReads === 1 ? json({}, 503, { 'Retry-After': '60' }) : json(template());
    });
    const controller = createPlatformDataV2((state) => states.push(state), fetcher, () => clock);
    try {
      await controller.start();
      await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'error' }));
      clock = 59_999; await controller.refresh(); expect(auxiliaryReads).toBe(1);
      clock = 60_000; await controller.refresh(); expect(auxiliaryReads).toBe(2);
      expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'ready' });
    } finally { controller.dispose(); }
  });
  it.each([401,403])('clears protected content on %s rather than silently falling back', async (status) => {
    const auxiliary = deferred<Response>();
    const states: PlatformLoadStateV2[] = [];
    const controller = createPlatformDataV2((state) => states.push(state), async (path) => String(path).endsWith('/bootstrap') ? json(template()) : auxiliary.promise);
    try {
      await controller.start(); expect(states.at(-1)?.status).toBe('ready');
      auxiliary.resolve(json({}, status));
      await vi.waitFor(() => expect(states.at(-1)?.status).toBe('error'));
      const count = states.length; await controller.refresh(); expect(states).toHaveLength(count);
    } finally { controller.dispose(); }
  });
  it('deduplicates auxiliary refreshes and drops disposed responses', async () => {
    const auxiliary = deferred<Response>(); const states: PlatformLoadStateV2[] = [];
    const fetcher = vi.fn<typeof fetch>(async (path) => String(path).endsWith('/bootstrap') ? json(template()) : auxiliary.promise);
    const controller = createPlatformDataV2((state) => states.push(state), fetcher);
    await controller.start(); await controller.refresh(); await controller.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    controller.dispose(); const count = states.length;
    auxiliary.resolve(json(template())); await flush(); expect(states).toHaveLength(count);
  });
});
