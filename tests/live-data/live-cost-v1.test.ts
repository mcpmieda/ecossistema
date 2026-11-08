// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notifyLiveChangeV1, subscribeLiveRefreshV1 } from '../../src/shared/live-data/live-refresh-v1';
import { createLatestPortalRequestV1 } from '../../src/features/student-portal/shared/latest-request-v1';
import { mockSecureJitterV1 } from './secure-jitter-fixture';

const dispose: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  mockSecureJitterV1(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
  dispose
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('backs off displayed failures rather than retrying every thirty seconds, then recovers', async () => {
  const reader = createLatestPortalRequestV1(vi.fn());
  const load = vi.fn(async () => {
    throw new Error('offline');
  });
  dispose.push(subscribeLiveRefreshV1({ domains: ['portal'], refresh: () => reader.run(load) }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(2);
  for (let n = 0; n < 10; n++) notifyLiveChangeV1('portal');
  await vi.advanceTimersByTimeAsync(59_999);
  expect(load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(load).toHaveBeenCalledTimes(3);
  load.mockImplementation(async () => undefined as never);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(5);
});
