// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockSecureJitterV1 } from './secure-jitter-fixture';
import {
  LIVE_HEAVY_READ_INTERVAL_V1,
  notifyLiveChangeV1,
  subscribeLiveRefreshV1,
} from '../../src/shared/live-data/live-refresh-v1';
import { routeLoadFailureV1 } from '../../src/shared/live-data/route-load-failure-v1';

const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T15:54:00Z'));
  mockSecureJitterV1(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('limits heavy polling to two minutes but keeps committed-change invalidation', async () => {
  const refresh = vi.fn(async () => true);
  disposers.push(
    subscribeLiveRefreshV1({
      domains: ['gradebook'],
      refresh,
      intervalMs: LIVE_HEAVY_READ_INTERVAL_V1,
    }),
  );
  await vi.advanceTimersByTimeAsync(119_999);
  expect(refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  notifyLiveChangeV1('gradebook');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('preserves the default cadence for interactive readers', async () => {
  const refresh = vi.fn(async () => undefined);
  disposers.push(subscribeLiveRefreshV1({ domains: ['portal'], refresh }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('does not enqueue another read for focus/pageshow while a read is pending', async () => {
  let resolve!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  disposers.push(subscribeLiveRefreshV1({ domains: ['gradebook'], refresh }));
  notifyLiveChangeV1('gradebook');
  await vi.advanceTimersByTimeAsync(250);
  expect(refresh).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('pageshow'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(5_000);
  resolve();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('backs off typed failures, honors cooldown during events and resets after success', async () => {
  const refresh = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  disposers.push(subscribeLiveRefreshV1({ domains: ['gradebook'], refresh }));
  notifyLiveChangeV1('gradebook');
  await vi.advanceTimersByTimeAsync(250);
  expect(refresh).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 8; i += 1) {
    notifyLiveChangeV1('gradebook');
    window.dispatchEvent(new Event('focus'));
  }
  await vi.advanceTimersByTimeAsync(29_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(refresh).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenCalledTimes(4);
});

it('caps consecutive failure delay at five minutes for heavy analytics', async () => {
  const refresh = vi.fn(async () => false);
  disposers.push(
    subscribeLiveRefreshV1({
      domains: ['gradebook'],
      refresh,
      intervalMs: LIVE_HEAVY_READ_INTERVAL_V1,
    }),
  );
  notifyLiveChangeV1('gradebook');
  await vi.advanceTimersByTimeAsync(250);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(240_000);
  expect(refresh).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(refresh).toHaveBeenCalledTimes(4);
});

it('a rejected read with a pending invalidation respects cooldown instead of looping', async () => {
  let reject!: (error: Error) => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  disposers.push(subscribeLiveRefreshV1({ domains: ['gradebook'], refresh }));
  notifyLiveChangeV1('gradebook');
  await vi.advanceTimersByTimeAsync(250);
  notifyLiveChangeV1('gradebook');
  reject(new Error('synthetic network failure'));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('spreads event-driven reads without adding a polling clock', async () => {
  mockSecureJitterV1(800);
  const refresh = vi.fn(async () => undefined);
  const dispose = subscribeLiveRefreshV1({ domains: ['gradebook'], refresh });
  disposers.push(dispose);
  notifyLiveChangeV1('gradebook');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  expect(refresh).toHaveBeenCalledTimes(1);
  dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('distinguishes module loading from a render failure without returning raw error data', () => {
  expect(
    routeLoadFailureV1(
      new TypeError('Failed to fetch dynamically imported module: /assets/synthetic.js'),
    ),
  ).toBe('module-load');
  expect(routeLoadFailureV1(new TypeError('Importing a module script failed.'))).toBe(
    'module-load',
  );
  expect(routeLoadFailureV1(new Error('Unable to preload CSS for /assets/synthetic.css'))).toBe(
    'module-load',
  );
  expect(routeLoadFailureV1(new Error('synthetic render failure'))).toBe('render');
  expect(routeLoadFailureV1(null)).toBe('render');
});
