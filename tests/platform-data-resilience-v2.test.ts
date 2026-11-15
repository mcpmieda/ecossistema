import { afterEach, expect, it, vi } from 'vitest';
import { createPlatformDataV2, PLATFORM_AUXILIARY_TIMEOUT_MS_V2, PLATFORM_BOOTSTRAP_TIMEOUT_MS_V2, type PlatformLoadStateV2 } from '../src/platform/platform-data-v2';
import { buildPlatformSnapshot } from '../server/platform/snapshot';
import { platformRouteUnavailableV2 } from '../shared/platform-snapshot-v2';

const template = () => buildPlatformSnapshot({ lists: [], moduleItems: [], correlationId: 'synthetic' }, ['platform.snapshot.read', 'platform.settings.read']);
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });

it('honors a partial response retry deadline while leaving unrelated sections usable', async () => {
  let clock = 0, auxiliaryReads = 0;
  const states: PlatformLoadStateV2[] = [];
  const controller = createPlatformDataV2((state) => states.push(state), async (path) => {
    if (String(path).endsWith('/bootstrap')) return Response.json(template());
    auxiliaryReads++;
    return Response.json({ ...template(), unavailableSections: ['modules'], retryAfterSeconds: 90 });
  }, () => clock);
  try {
    await controller.start(); await flush();
    const state = states.at(-1)!;
    expect(state).toMatchObject({ status: 'ready', auxiliary: 'partial' });
    if (state.status !== 'ready') throw new Error('Expected native bootstrap');
    expect(platformRouteUnavailableV2('operacao', state.snapshot)).toBe(false);
    expect(platformRouteUnavailableV2('configuracoes', state.snapshot)).toBe(false);
    clock = 89999; await controller.refresh(); expect(auxiliaryReads).toBe(1);
    clock = 90000; await controller.refresh(); expect(auxiliaryReads).toBe(2);
  } finally { controller.dispose(); }
});
it('aborts a stuck auxiliary request, clears pending state and can recover without reloading native modules', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const states: PlatformLoadStateV2[] = [];
  let pendingSignal: AbortSignal | undefined, calls = 0;
  const controller = createPlatformDataV2((state) => states.push(state), async (path, init) => {
    if (String(path).endsWith('/bootstrap')) return Response.json(template());
    calls++;
    if (calls === 1) { pendingSignal = init?.signal ?? undefined; return new Promise<Response>(() => {}); }
    return Response.json(template());
  });
  try {
    await controller.start();
    await vi.advanceTimersByTimeAsync(PLATFORM_AUXILIARY_TIMEOUT_MS_V2);
    expect(pendingSignal?.aborted).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'error' });
    await vi.advanceTimersByTimeAsync(30000); await controller.refresh();
    expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'ready' });
    expect(calls).toBe(2);
  } finally { controller.dispose(); }
});
it('never uses auxiliary data as a substitute for a missing authenticated native bootstrap', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const states: PlatformLoadStateV2[] = [];
  const controller = createPlatformDataV2((state) => states.push(state), async (path) =>
    String(path).endsWith('/bootstrap') ? new Promise<Response>(() => {}) : Response.json(template()));
  try {
    const starting = controller.start();
    await vi.advanceTimersByTimeAsync(PLATFORM_BOOTSTRAP_TIMEOUT_MS_V2); await starting;
    expect(states.at(-1)?.status).toBe('error');
    expect(states.some((state) => state.status === 'ready')).toBe(false);
  } finally { controller.dispose(); }
});
it('rejects an invalid registered module rather than letting the rendered page crash or claim an empty successful response', async () => {
  const states: PlatformLoadStateV2[] = [];
  const controller = createPlatformDataV2((state) => states.push(state), async (path) =>
    Response.json(String(path).endsWith('/bootstrap') ? template() : { ...template(), registeredModules: [{}] }));
  try {
    await controller.start(); await flush();
    expect(states.at(-1)).toMatchObject({ status: 'ready', auxiliary: 'error' });
  } finally { controller.dispose(); }
});
