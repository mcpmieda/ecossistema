// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), dashboard: vi.fn(), clear: vi.fn() }));
vi.mock('../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ year: 2026, clearAuthorization: mocks.clear }),
}));
vi.mock('../../src/features/gradebook/performance/relational-performance-client-v2', () => ({
  requestRelationalPerformanceV2: mocks.read,
}));
vi.mock('../../src/features/gradebook/performance/performance-dashboard-client-v5', () => ({
  requestPerformanceDashboardV5: mocks.dashboard,
}));
// These tests isolate hook lifecycle; the existing native suites cover full academic DTOs.
vi.mock('../../shared/gradebook-contracts/performance/performance-dashboard-v5', () => ({
  dashboardAnalysisV5: (value: { analysis: unknown }) => value.analysis,
  dashboardComparisonV5: () => null,
}));
import { useRelationalPerformanceV2 } from '../../src/features/gradebook/performance/use-relational-performance-v2';
const snapshot = (at: string) => ({
  state: 'ready',
  analysis: { matrix: { offers: [], readAt: at } },
});
beforeEach(() => {
  mocks.read.mockReset();
  mocks.dashboard.mockReset();
  mocks.clear.mockReset();
  mocks.read.mockImplementation(async (request: { operation: string }) =>
    request.operation === 'classes'
      ? { state: 'ready', operation: 'classes', classes: [], nextOffset: null }
      : { state: 'ready', operation: request.operation },
  );
  mocks.dashboard.mockResolvedValue(snapshot('first'));
});
afterEach(cleanup);
it('retains dashboard and detail while the same context refreshes', async () => {
  const view = renderHook(() => useRelationalPerformanceV2());
  await waitFor(() => expect(view.result.current.classes).not.toBeNull());
  await act(() => view.result.current.select({ classId: 1 }));
  await act(() => view.result.current.open(1));
  const previous = view.result.current.dashboard,
    detail = view.result.current.detail;
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  mocks.dashboard.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let pending!: ReturnType<ReturnType<typeof useRelationalPerformanceV2>['refresh']>;
  act(() => {
    pending = view.result.current.refresh();
  });
  expect(view.result.current.dashboard).toBe(previous);
  expect(view.result.current.detail).toBe(detail);
  expect(view.result.current.detailOpen).toBe(true);
  await act(async () => {
    resolve(snapshot('second'));
    await pending;
  });
  expect(view.result.current.detailOpen).toBe(true);
  expect(view.result.current.filters.classId).toBe(1);
  expect(view.result.current.dashboard).not.toBe(previous);
});
it('does not reopen a detail closed while a dashboard refresh is in flight', async () => {
  const view = renderHook(() => useRelationalPerformanceV2());
  await waitFor(() => expect(view.result.current.classes).not.toBeNull());
  await act(() => view.result.current.select({ classId: 1 }));
  await act(() => view.result.current.open(1));
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  mocks.dashboard.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let pending!: ReturnType<ReturnType<typeof useRelationalPerformanceV2>['refresh']>;
  act(() => {
    pending = view.result.current.refresh();
  });
  act(() => view.result.current.closeDetail());
  await act(async () => {
    resolve(snapshot('second'));
    await pending;
  });
  expect(view.result.current.detailOpen).toBe(false);
  expect(view.result.current.detail).toBeNull();
});
it('clears protected content when background reading loses authorization', async () => {
  const view = renderHook(() => useRelationalPerformanceV2());
  await waitFor(() => expect(view.result.current.classes).not.toBeNull());
  await act(() => view.result.current.select({ classId: 1 }));
  mocks.dashboard.mockResolvedValueOnce({ state: 'not-authorized' });
  await act(() => view.result.current.refresh());
  expect(view.result.current.dashboard).toBeNull();
  expect(view.result.current.detailOpen).toBe(false);
  expect(mocks.clear).toHaveBeenCalledTimes(1);
});
