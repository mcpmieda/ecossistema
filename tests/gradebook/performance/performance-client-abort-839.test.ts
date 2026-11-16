// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { requestPerformanceAnalyticsV6 } from '../../../src/features/gradebook/performance/performance-analytics-client-v6';
import { requestPerformanceDashboardV5 } from '../../../src/features/gradebook/performance/performance-dashboard-client-v5';
import { requestRelationalPerformanceV2 } from '../../../src/features/gradebook/performance/relational-performance-client-v2';

const readers = [
  (signal: AbortSignal) =>
    requestPerformanceAnalyticsV6(
      { transportVersion: 6, operation: 'analytics', year: 2026, classId: 1, period: 2 },
      signal,
    ),
  (signal: AbortSignal) =>
    requestPerformanceDashboardV5(
      {
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
      },
      signal,
    ),
  (signal: AbortSignal) =>
    requestRelationalPerformanceV2(
      { transportVersion: 2, operation: 'classes', year: 2026, offset: 0, limit: 100 },
      signal,
    ),
];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(readers)(
  'propagates cancellation to the actual fetch signal and releases all deadline timers',
  async (read) => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        transportSignal = init?.signal;
        return new Promise<never>(() => undefined);
      }),
    );
    const parent = new AbortController();
    const pending = read(parent.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(transportSignal).toBeInstanceOf(AbortSignal);
    expect(transportSignal?.aborted).toBe(false);
    parent.abort();
    await rejection;
    expect(transportSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);
