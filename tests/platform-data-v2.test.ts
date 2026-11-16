import { describe, expect, it, vi } from 'vitest';
import {
  createPlatformDataV2,
  prefetchPlatformDataV2,
  type PlatformLoadStateV2,
} from '../src/platform/platform-data-v2';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

const template = () =>
  buildPlatformSnapshot({ correlationId: 'synthetic' }, [
    'platform.snapshot.read',
    'platform.settings.read',
  ]);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('native Center bootstrap #806', () => {
  it('uses the read started with the identity check once, and reads again when it failed', async () => {
    const early = vi.fn<typeof fetch>(async () => json({ ...template(), correlationId: 'early' }));
    prefetchPlatformDataV2(early);
    expect(early.mock.calls.map(([path]) => String(path))).toEqual(['/api/platform/bootstrap']);
    const states: PlatformLoadStateV2[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => json({ ...template(), correlationId: 'late' }));
    const controller = createPlatformDataV2((state) => states.push(state), fetcher);
    try {
      await controller.start();
      expect(states.at(-1)).toMatchObject({
        status: 'ready',
        snapshot: { correlationId: 'early' },
      });
      expect(fetcher).not.toHaveBeenCalled();
      await controller.start();
      expect(fetcher.mock.calls.map(([path]) => String(path))).toEqual(['/api/platform/bootstrap']);
      expect(states.at(-1)).toMatchObject({ status: 'ready', snapshot: { correlationId: 'late' } });
      prefetchPlatformDataV2(vi.fn<typeof fetch>(async () => json({}, 503)));
      await controller.start();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(states.at(-1)).toMatchObject({ status: 'ready' });
    } finally {
      controller.dispose();
    }
  });
  it('keeps the page shown when a read on return fails and respects its retry deadline', async () => {
    let clock = 0,
      reads = 0;
    const states: PlatformLoadStateV2[] = [];
    const fetcher = vi.fn<typeof fetch>(async (path, init) => {
      expect(String(path)).toBe('/api/platform/bootstrap');
      expect(init).toMatchObject({
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
      });
      reads++;
      return reads === 2 ? json({}, 503, { 'Retry-After': '60' }) : json(template());
    });
    const controller = createPlatformDataV2(
      (state) => states.push(state),
      fetcher,
      () => clock,
    );
    try {
      await controller.start();
      expect(states.at(-1)).toMatchObject({ status: 'ready' });
      // After a complete answer a return of focus reads again in 2 min at the soonest.
      clock = 119_999;
      await controller.refresh();
      expect(reads).toBe(1);
      clock = 120_000;
      await controller.refresh();
      expect(reads).toBe(2);
      const published = states.length;
      expect(states.at(-1)).toMatchObject({ status: 'ready' });
      clock = 179_999;
      await controller.refresh();
      expect(reads).toBe(2);
      clock = 180_000;
      await controller.refresh();
      expect(reads).toBe(3);
      expect(states).toHaveLength(published);
    } finally {
      controller.dispose();
    }
  });
  it.each([401, 403])(
    'clears protected content on %s rather than silently falling back',
    async (status) => {
      let clock = 0,
        reads = 0;
      const states: PlatformLoadStateV2[] = [];
      const controller = createPlatformDataV2(
        (state) => states.push(state),
        async () => (++reads === 1 ? json(template()) : json({}, status)),
        () => clock,
      );
      try {
        await controller.start();
        expect(states.at(-1)?.status).toBe('ready');
        clock = 120_000;
        await controller.refresh();
        expect(states.at(-1)).toMatchObject({
          status: 'error',
          message: expect.stringContaining('autorização'),
        });
        const count = states.length;
        clock = 600_000;
        await controller.refresh();
        expect(states).toHaveLength(count);
        expect(reads).toBe(2);
      } finally {
        controller.dispose();
      }
    },
  );
  it('deduplicates refreshes and drops disposed responses', async () => {
    let clock = 0,
      reads = 0;
    const late = deferred<Response>();
    const states: PlatformLoadStateV2[] = [];
    const fetcher = vi.fn<typeof fetch>(async () =>
      ++reads === 1 ? json(template()) : late.promise,
    );
    const controller = createPlatformDataV2(
      (state) => states.push(state),
      fetcher,
      () => clock,
    );
    await controller.start();
    clock = 120_000;
    void controller.refresh();
    await controller.refresh();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    controller.dispose();
    const count = states.length;
    late.resolve(json({ ...template(), coreModules: [] }));
    await flush();
    expect(states).toHaveLength(count);
  });
});
