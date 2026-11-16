// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  PERFORMANCE_READ_TIMEOUT_V1,
  withPerformanceReadDeadlineV1,
} from '../../../src/features/gradebook/performance/performance-read-deadline-v1';
import { requestPerformanceAnalyticsV6 } from '../../../src/features/gradebook/performance/performance-analytics-client-v6';
import { requestPerformanceDashboardV5 } from '../../../src/features/gradebook/performance/performance-dashboard-client-v5';
import { requestRelationalPerformanceV2 } from '../../../src/features/gradebook/performance/relational-performance-client-v2';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('returns a successful read and clears the deadline', async () => {
  await expect(withPerformanceReadDeadlineV1(async () => 'synthetic')).resolves.toBe('synthetic');
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds a stalled operation even when the transport ignores cancellation', async () => {
  let signal!: AbortSignal;
  const pending = withPerformanceReadDeadlineV1((value) => {
    signal = value;
    return new Promise<never>(() => undefined);
  });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(PERFORMANCE_READ_TIMEOUT_V1);
  await rejected;
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates context cancellation without waiting for the deadline', async () => {
  const parent = new AbortController();
  const pending = withPerformanceReadDeadlineV1(
    () => new Promise<never>(() => undefined),
    parent.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  parent.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start a read whose parent is already cancelled', async () => {
  const parent = new AbortController();
  parent.abort();
  const read = vi.fn(async () => 'synthetic');
  await expect(withPerformanceReadDeadlineV1(read, parent.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(read).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

const analytics = () =>
  requestPerformanceAnalyticsV6({
    transportVersion: 6,
    operation: 'analytics',
    year: 2026,
    classId: 1,
    period: 2,
    includeLearning: true,
    includeStudentDimensions: true,
  });
const dashboard = () =>
  requestPerformanceDashboardV5({
    transportVersion: 5,
    operation: 'dashboard',
    year: 2026,
    classId: 1,
    period: 2,
    mode: 'regular',
    statuses: [null, 7],
    lens: 'result',
    offerId: null,
    referencePeriod: null,
  });
const classes = () =>
  requestRelationalPerformanceV2({
    transportVersion: 2,
    operation: 'classes',
    year: 2026,
    offset: 0,
    limit: 100,
  });

it.each([analytics, dashboard, classes])(
  'applies the deadline to each real read-only client',
  async (request) => {
    const fetcher = vi.fn(() => new Promise<never>(() => undefined));
    vi.stubGlobal('fetch', fetcher);
    const pending = request();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(PERFORMANCE_READ_TIMEOUT_V1);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/gradebook/performance',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('covers a stalled response body, not just the time to response headers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      text: () => new Promise<never>(() => undefined),
    })),
  );
  const rejected = expect(analytics()).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(PERFORMANCE_READ_TIMEOUT_V1);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps authorization failures typed and does not retry the HTTP request', async () => {
  const fetcher = vi.fn(async () => ({ status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(analytics()).resolves.toEqual({ transportVersion: 6, state: 'not-authorized' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
