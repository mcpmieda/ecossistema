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

// The Council hook keeps the classes of each year while its module lives: its tests change the year.
const shared = vi.hoisted(() => ({ year: 2026 }));
vi.mock('../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ year: shared.year }),
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
    {
      id: 10,
      label: '6A',
      name: 'Turma sintética',
      sessionState: 'not-opened',
      tally: { approved: 0, rejected: 0, pending: 1 },
    },
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
    session: { state: 'not-opened' },
    // The hook reads only the summary: one eligible student, still pending.
    summary: {
      total: 1,
      eligible: 1,
      decided: 0,
      pending: 1,
      approved: 0,
      rejected: 0,
      absence: 0,
      notEligible: 0,
    },
    students: [],
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
  shared.year = 2026;
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

it('rereads only the open Council class, backs off its failures and keeps it while hidden', async () => {
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
  expect(send.mock.calls[0]?.[0]).toMatchObject({ operation: 'workspace', classId: 10 });
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
  send.mockImplementation(async (request) =>
    request.operation === 'classes' ? councilCatalog : councilWorkspace,
  );
  active = true;
  hook.rerender();
  await advance(3_000);
  // The classes are never asked for again in the background.
  expect(send.mock.calls.map(([request]) => request.operation)).toEqual([
    'workspace',
    'workspace',
    'workspace',
  ]);
  expect(hook.result.current.stale).toBe(false);
  expect(hook.result.current.classes.map((item) => item.id)).toEqual([10]);
});

it('reads nothing in the background while no Council class is open', async () => {
  shared.year = 2027;
  const send = vi.mocked(requestRelationalCouncilV3);
  send.mockResolvedValue({ ...councilCatalog, year: 2027 });
  const hook = renderHook(() => useRelationalCouncilV3(), { wrapper });
  await act(async () => {});
  expect(hook.result.current.classes.map((item) => item.id)).toEqual([10]);
  send.mockClear();
  await invalidate();
  await advance(120_000);
  expect(send).not.toHaveBeenCalled();
});

it('closes the open Council class when its background reading comes back with nobody eligible', async () => {
  shared.year = 2028;
  const send = vi.mocked(requestRelationalCouncilV3);
  send.mockImplementation(async (request) =>
    request.operation === 'classes' ? { ...councilCatalog, year: 2028 } : councilWorkspace,
  );
  const hook = renderHook(() => useRelationalCouncilV3(), { wrapper });
  await act(async () => {});
  await act(async () => {
    await hook.result.current.selectClass(10);
  });
  expect(hook.result.current.workspace).toEqual(councilWorkspace.workspace);
  send.mockClear();
  send.mockResolvedValue({
    ...councilWorkspace,
    workspace: {
      ...councilWorkspace.workspace,
      summary: { ...councilWorkspace.workspace.summary, eligible: 0, pending: 0, notEligible: 1 },
    },
  });
  await invalidate();
  expect(send.mock.calls.map(([request]) => request.operation)).toEqual(['workspace']);
  expect(hook.result.current.classes).toEqual([]);
  expect(hook.result.current.classId).toBeNull();
  expect(hook.result.current.workspace).toBeNull();
  expect(hook.result.current.stale).toBe(false);
  // With no class open, the next change reads nothing.
  await invalidate();
  expect(send).toHaveBeenCalledTimes(1);
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
