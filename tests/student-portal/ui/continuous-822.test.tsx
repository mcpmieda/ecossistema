// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useContinuousReadV1 } from '../../../src/features/student-portal-admin/shared/continuous-read-v1';
import { setupOperationsDomV1 } from './overview/dom-v1';
const row = (id: number) => ({ id, name: `SYNTHETIC ${id}` });
function pages(total = 1005) {
  return vi.fn(async (cursor?: string) => {
    const offset = Number(cursor ?? 0);
    return {
      items: Array.from({ length: Math.min(100, total - offset) }, (_, index) =>
        row(offset + index + 1),
      ),
      nextCursor: offset + 100 >= total ? null : String(offset + 100),
    };
  });
}
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('makes the first 100 usable without waiting for the delayed continuation', async () => {
  let finish!: (value: { items: ReturnType<typeof row>[]; nextCursor: string | null }) => void;
  const page = vi.fn((cursor?: string) =>
    cursor
      ? new Promise<{ items: ReturnType<typeof row>[]; nextCursor: string | null }>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({
          items: Array.from({ length: 100 }, (_, i) => row(i + 1)),
          nextCursor: 'next',
        }),
  );
  const view = renderHook(() => useContinuousReadV1(page, 'id'));
  await waitFor(() => expect(view.result.current.state).toMatchObject({ state: 'ready' }));
  expect(page).toHaveBeenCalledTimes(1);
  expect(finish).toBeUndefined();
  const first = view.result.current.state;
  act(() => view.result.current.loadMore());
  expect(view.result.current.state).toMatchObject({ state: 'ready' });
  if (first.state !== 'ready' || view.result.current.state.state !== 'ready')
    throw new Error('Missing first page');
  expect(view.result.current.state.data).toBe(first.data);
  expect(view.result.current.refreshing).toBe(true);
  await act(async () =>
    finish({ items: Array.from({ length: 5 }, (_, i) => row(i + 101)), nextCursor: null }),
  );
  expect(
    view.result.current.state.state === 'ready' && view.result.current.state.data.items.length,
  ).toBe(105);
  expect(page).toHaveBeenCalledTimes(2);
});
it('reaches all 1005 rows through ten explicit continuations and revalidates without a 100-row flash', async () => {
  const page = pages();
  const view = renderHook(() => useContinuousReadV1(page, 'id'));
  await waitFor(() => expect(view.result.current.state.state).toBe('ready'));
  expect(page).toHaveBeenCalledTimes(1);
  for (let request = 2; request <= 11; request++) {
    act(() => view.result.current.loadMore());
    await waitFor(() => {
      const state = view.result.current.state;
      expect(state.state === 'ready' && state.data.items.length).toBe(
        Math.min(request * 100, 1005),
      );
      expect(view.result.current.refreshing).toBe(false);
    });
    expect(page).toHaveBeenCalledTimes(request);
  }
  const state = view.result.current.state;
  if (state.state !== 'ready') throw new Error('Missing complete result');
  expect(state.data.items.map((item) => item.id)).toEqual(
    Array.from({ length: 1005 }, (_, i) => i + 1),
  );
  expect(view.result.current.more).toBe(false);
  act(() => view.result.current.reload());
  expect(
    view.result.current.state.state === 'ready' && view.result.current.state.data.items.length,
  ).toBe(1005);
  await waitFor(() => expect(view.result.current.refreshing).toBe(false));
  expect(page).toHaveBeenCalledTimes(22);
  expect(
    view.result.current.state.state === 'ready' && view.result.current.state.data.items.length,
  ).toBe(1005);
});
it('yields after an empty filtered page and fails closed on a cursor cycle across later appends', async () => {
  const page = vi.fn(async (cursor?: string) =>
    !cursor
      ? { items: [] as ReturnType<typeof row>[], nextCursor: 'a' }
      : cursor === 'a'
        ? { items: [row(1)], nextCursor: 'b' }
        : { items: [row(2)], nextCursor: 'a' },
  );
  const view = renderHook(() => useContinuousReadV1(page, 'id'));
  await waitFor(() =>
    expect(view.result.current.state).toMatchObject({
      state: 'ready',
      data: { items: [], nextCursor: 'a' },
    }),
  );
  expect(page).toHaveBeenCalledTimes(1);
  expect(view.result.current.more).toBe(true);
  await act(async () => view.result.current.loadMore());
  expect(page).toHaveBeenCalledTimes(2);
  expect(view.result.current.state).toMatchObject({ state: 'ready', data: { items: [row(1)] } });
  await act(async () => view.result.current.loadMore());
  // Malformed data is not a transient network failure: the existing reader removes it.
  await waitFor(() =>
    expect(view.result.current.state).toMatchObject({
      state: 'error',
      error: { state: 'invalid-response' },
    }),
  );
  expect(page).toHaveBeenCalledTimes(3);
  expect('data' in view.result.current.state).toBe(false);
});
it('rebuilds an expired cursor from the start, preserving the loaded window and adding only one page', async () => {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const page = pages();
  const view = renderHook(() => useContinuousReadV1(page, 'id'));
  await waitFor(() => expect(view.result.current.state.state).toBe('ready'));
  await act(async () => view.result.current.loadMore());
  expect(page).toHaveBeenCalledTimes(2);
  now += 240_001;
  act(() => view.result.current.loadMore());
  expect(
    view.result.current.state.state === 'ready' && view.result.current.state.data.items.length,
  ).toBe(200);
  await waitFor(() => expect(view.result.current.refreshing).toBe(false));
  expect(page.mock.calls.slice(2).map(([cursor]) => cursor)).toEqual([undefined, '100', '200']);
  expect(
    view.result.current.state.state === 'ready' && view.result.current.state.data.items.length,
  ).toBe(300);
});
