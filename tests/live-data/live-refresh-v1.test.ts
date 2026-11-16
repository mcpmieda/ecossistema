// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockSecureJitterV1 } from './secure-jitter-fixture';
import {
  notifyLiveChangeV1,
  subscribeLiveRefreshV1,
} from '../../src/shared/live-data/live-refresh-v1';
const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  mockSecureJitterV1(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('coalesces changes, never overlaps reads, and follows an invalidation received while reading', async () => {
  let resolve!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  disposers.push(subscribeLiveRefreshV1({ domains: ['portal'], refresh }));
  notifyLiveChangeV1('portal');
  notifyLiveChangeV1('portal');
  await vi.advanceTimersByTimeAsync(250);
  expect(refresh).toHaveBeenCalledTimes(1);
  notifyLiveChangeV1('portal');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  resolve();
  await vi.advanceTimersByTimeAsync(250);
  expect(refresh).toHaveBeenCalledTimes(2);
  resolve();
});
it('pauses hidden/offline and honors eligibility/retry deadlines without replaying writes', async () => {
  let allowed = false;
  const refresh = vi.fn(async () => undefined);
  disposers.push(
    subscribeLiveRefreshV1({ domains: ['portal'], refresh, canRefresh: () => allowed }),
  );
  notifyLiveChangeV1('portal');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(refresh).not.toHaveBeenCalled();
  allowed = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(refresh).not.toHaveBeenCalled();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(250);
  expect(refresh).toHaveBeenCalledTimes(1);
});
it('does not refresh unrelated modules and stops after disposal', async () => {
  const refresh = vi.fn(async () => undefined);
  const dispose = subscribeLiveRefreshV1({ domains: ['portal'], refresh });
  disposers.push(dispose);
  notifyLiveChangeV1('gradebook');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(refresh).not.toHaveBeenCalled();
  dispose();
  notifyLiveChangeV1('portal');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).not.toHaveBeenCalled();
});
