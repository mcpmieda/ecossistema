// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRelationalCouncilV3 } from '../../src/features/gradebook/council/use-relational-council-v3';
import { requestRelationalCouncilV3 } from '../../src/features/gradebook/council/relational-council-client-v3';
import { useRelationalPerformanceV2 } from '../../src/features/gradebook/performance/use-relational-performance-v2';
import { requestRelationalPerformanceV2 } from '../../src/features/gradebook/performance/relational-performance-client-v2';
import { requestPerformanceDashboardV5 } from '../../src/features/gradebook/performance/performance-dashboard-client-v5';
import { usePerformanceAnalyticsV6 } from '../../src/features/gradebook/performance/use-performance-analytics-v6';
import { requestPerformanceAnalyticsV6 } from '../../src/features/gradebook/performance/performance-analytics-client-v6';
import { performanceAnalyticsFixtureV6 } from './performance/performance-analytics-fixture-v6';
import { LiveRefreshScopeV1 } from '../../src/shared/live-data/live-refresh-scope-v1';
import { notifyLiveChangeV1 } from '../../src/shared/live-data/live-refresh-v1';
import { mockSecureJitterV1 } from '../live-data/secure-jitter-fixture';

vi.mock('../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ year: 2026 }),
}));
vi.mock('../../src/features/gradebook/council/relational-council-client-v3');
vi.mock('../../src/features/gradebook/performance/relational-performance-client-v2');
vi.mock('../../src/features/gradebook/performance/performance-dashboard-client-v5');
vi.mock('../../src/features/gradebook/performance/performance-analytics-client-v6');

const context = { year: 2026, minimumApprovalMilli: 60_000, maxCouncilComponents: 2 };
const councilCatalog = {
  contractVersion: 3,
  state: 'ready',
  operation: 'classes',
  year: 2026,
  classes: [
    { id: 10, label: '6A', name: 'Turma sintética', sessionState: 'not-opened', sessionVersion: 0 },
  ],
  nextOffset: null,
} satisfies Awaited<ReturnType<typeof requestRelationalCouncilV3>>;
const councilWorkspace = {
  contractVersion: 3,
  state: 'ready',
  operation: 'workspace',
  workspace: {
    context,
    classGroup: { id: 10, label: '6A', name: 'Turma sintética' },
    readAt: '2026-09-26T12:00:00.000Z',
    authority: 'calculated-eligibility-explicit-human-decision',
    session: {
      state: 'not-opened',
      version: 0,
      reviewReference: 'synthetic:0',
      closedAt: null,
      snapshotCount: 0,
    },
    summary: {
      total: 0,
      eligible: 0,
      decided: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      absence: 0,
      notEligible: 0,
    },
    students: [],
    timeline: [],
    closures: [],
  },
} satisfies Awaited<ReturnType<typeof requestRelationalCouncilV3>>;
let active = true;
const wrapper = ({ children }: { children: ReactNode }) => (
  <LiveRefreshScopeV1 active={active}>{children}</LiveRefreshScopeV1>
);
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const invalidate = async () => {
  await act(async () => {
    notifyLiveChangeV1('gradebook');
  });
  await advance(250);
};
beforeEach(() => {
  active = true;
  vi.useFakeTimers();
  vi.resetAllMocks();
  mockSecureJitterV1(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('backs off Council failures, stops dependent reads and preserves protected work while hidden', async () => {
  const send = vi.mocked(requestRelationalCouncilV3);
  send.mockImplementation(async (request) =>
    request.operation === 'classes' ? councilCatalog : councilWorkspace,
  );
  const hook = renderHook(() => useRelationalCouncilV3(), { wrapper });
  await act(async () => {});
  await act(async () => {
    await hook.result.current.selectClass(10);
  });
  expect(hook.result.current.workspace).toEqual(councilWorkspace.workspace);
  send.mockClear();
  send.mockResolvedValue({ contractVersion: 3, state: 'unavailable' });
  await invalidate();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0].operation).toBe('classes');
  expect(hook.result.current.stale).toBe(true);
  await invalidate();
  expect(send).toHaveBeenCalledTimes(1);
  await advance(29_750);
  expect(send).toHaveBeenCalledTimes(2);
  await advance(30_000);
  expect(send).toHaveBeenCalledTimes(2);
  active = false;
  hook.rerender();
  await advance(120_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(hook.result.current.workspace).toEqual(councilWorkspace.workspace);
  hook.result.current.protectDrafts(true);
  active = true;
  hook.rerender();
  await advance(2_000);
  expect(send).toHaveBeenCalledTimes(2);
  hook.result.current.protectDrafts(false);
  send.mockImplementation(async (request) =>
    request.operation === 'classes' ? councilCatalog : councilWorkspace,
  );
  await advance(1_000);
  expect(send.mock.calls.slice(2).map(([request]) => request.operation)).toEqual([
    'classes',
    'workspace',
  ]);
  expect(hook.result.current.stale).toBe(false);
});

it('does not reread a Council workspace removed by the refreshed catalog', async () => {
  const send = vi.mocked(requestRelationalCouncilV3);
  send.mockImplementation(async (request) =>
    request.operation === 'classes' ? councilCatalog : councilWorkspace,
  );
  const hook = renderHook(() => useRelationalCouncilV3(), { wrapper });
  await act(async () => {});
  await act(async () => {
    await hook.result.current.selectClass(10);
  });
  send.mockClear();
  send.mockResolvedValue({ ...councilCatalog, classes: [] });
  await invalidate();
  expect(send).toHaveBeenCalledTimes(1);
  expect(hook.result.current.classId).toBeNull();
  expect(hook.result.current.workspace).toBeNull();
});

it('reports failed performance reads to the clock instead of retrying every invalidation', async () => {
  const read = vi.mocked(requestRelationalPerformanceV2);
  read.mockResolvedValue({
    transportVersion: 2,
    state: 'ready',
    operation: 'classes',
    context,
    readAt: '2026-09-26T12:00:00.000Z',
    authority: 'calculated-preview',
    statusOptions: [],
    classes: [{ id: 10, label: '6A' }],
    nextOffset: null,
  });
  const dashboard = vi.mocked(requestPerformanceDashboardV5);
  dashboard.mockResolvedValue({ transportVersion: 5, state: 'unavailable' });
  const hook = renderHook(() => useRelationalPerformanceV2(), { wrapper });
  await act(async () => {});
  await act(async () => {
    await hook.result.current.select({ classId: 10 });
  });
  dashboard.mockClear();
  await invalidate();
  expect(dashboard).toHaveBeenCalledTimes(1);
  expect(hook.result.current.failure).toBe('unavailable');
  await invalidate();
  await advance(1_000);
  expect(dashboard).toHaveBeenCalledTimes(1);
  // Desempenho reads on the heavy cadence (120 s), and its failure cooldown follows it.
  await advance(118_750);
  expect(dashboard).toHaveBeenCalledTimes(2);
  await advance(120_000);
  expect(dashboard).toHaveBeenCalledTimes(2);
});

it('retains analytics cooldown across fast perspective switches and reads only a newly selected context', async () => {
  const send = vi.mocked(requestPerformanceAnalyticsV6);
  const snapshot = performanceAnalyticsFixtureV6();
  send.mockResolvedValue(snapshot);
  const hook = renderHook(
    ({ enabled, classId }) => usePerformanceAnalyticsV6(classId, 1, enabled),
    {
      initialProps: { enabled: true, classId: 10 },
      wrapper,
    },
  );
  await act(async () => {});
  expect(send).toHaveBeenCalledTimes(1);
  expect(hook.result.current.data).toEqual(snapshot);
  send.mockResolvedValue({ transportVersion: 6, state: 'unavailable' });
  await invalidate();
  expect(send).toHaveBeenCalledTimes(2);
  hook.rerender({ enabled: false, classId: 10 });
  await invalidate();
  hook.rerender({ enabled: true, classId: 10 });
  await advance(2_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(hook.result.current.data).toEqual(snapshot);
  await advance(118_000);
  expect(send).toHaveBeenCalledTimes(3);
  send.mockResolvedValue(performanceAnalyticsFixtureV6({ classId: 11 }));
  hook.rerender({ enabled: true, classId: 11 });
  await act(async () => {});
  expect(send).toHaveBeenCalledTimes(4);
  expect(send.mock.calls.at(-1)?.[0].classId).toBe(11);
});

it('loads an unvisited analytics perspective once and keeps pending reads bounded through hiding and key changes', async () => {
  const send = vi.mocked(requestPerformanceAnalyticsV6);
  let resolve!: (value: ReturnType<typeof performanceAnalyticsFixtureV6>) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const hook = renderHook(
    ({ enabled, classId }) => usePerformanceAnalyticsV6(classId, 1, enabled),
    {
      initialProps: { enabled: false, classId: 10 },
      wrapper,
    },
  );
  await advance(1_000);
  expect(send).not.toHaveBeenCalled();
  hook.rerender({ enabled: true, classId: 10 });
  await advance(250);
  expect(send).toHaveBeenCalledTimes(1);
  hook.rerender({ enabled: false, classId: 10 });
  await invalidate();
  await act(async () => {
    resolve(performanceAnalyticsFixtureV6());
  });
  expect(send).toHaveBeenCalledTimes(1);
  hook.rerender({ enabled: false, classId: 11 });
  send.mockResolvedValue(performanceAnalyticsFixtureV6({ classId: 11 }));
  hook.rerender({ enabled: true, classId: 11 });
  await advance(10_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(hook.result.current.data?.classGroup.id).toBe(11);
});
