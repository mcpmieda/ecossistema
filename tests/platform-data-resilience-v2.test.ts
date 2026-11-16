import { afterEach, expect, it, vi } from 'vitest';
import { createPlatformDataV2, PLATFORM_BOOTSTRAP_TIMEOUT_MS_V2, type PlatformLoadStateV2 } from '../src/platform/platform-data-v2';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

const template = () => buildPlatformSnapshot({ correlationId: 'synthetic' }, ['platform.snapshot.read', 'platform.settings.read']);
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });

it('aborts a stuck read on return, keeps the page shown and can recover', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const states: PlatformLoadStateV2[] = [];
  let pendingSignal: AbortSignal | undefined, calls = 0;
  const controller = createPlatformDataV2((state) => states.push(state), async (_path, init) => {
    calls++;
    if (calls === 2) { pendingSignal = init?.signal ?? undefined; return new Promise<Response>(() => {}); }
    return Response.json(template());
  });
  try {
    await controller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    void controller.refresh();
    await vi.advanceTimersByTimeAsync(PLATFORM_BOOTSTRAP_TIMEOUT_MS_V2);
    expect(pendingSignal?.aborted).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: 'ready' });
    await vi.advanceTimersByTimeAsync(30000); await controller.refresh();
    expect(states.at(-1)).toMatchObject({ status: 'ready' });
    expect(calls).toBe(3);
  } finally { controller.dispose(); }
});
it('reports a missing authenticated bootstrap instead of opening the Centro', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const states: PlatformLoadStateV2[] = [];
  const controller = createPlatformDataV2((state) => states.push(state), async () => new Promise<Response>(() => {}));
  try {
    const starting = controller.start();
    await vi.advanceTimersByTimeAsync(PLATFORM_BOOTSTRAP_TIMEOUT_MS_V2); await starting;
    expect(states.at(-1)?.status).toBe('error');
    expect(states.some((state) => state.status === 'ready')).toBe(false);
  } finally { controller.dispose(); }
});
it('rejects an invalid module rather than letting the rendered page crash or claim an empty successful response', async () => {
  const states: PlatformLoadStateV2[] = [];
  const controller = createPlatformDataV2((state) => states.push(state), async () =>
    Response.json({ ...template(), coreModules: [{}] }));
  try {
    await controller.start(); await flush();
    expect(states.at(-1)).toMatchObject({ status: 'error' });
    expect(states.some((state) => state.status === 'ready')).toBe(false);
  } finally { controller.dispose(); }
});
