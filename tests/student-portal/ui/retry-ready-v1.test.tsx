// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRetryReadyV1 } from '../../../src/features/student-portal-admin/shared/use-retry-ready-v1';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = async (milliseconds: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
};

// Issue #1490 (2): the retry button waits for `retryAt` with one timer, not a clock re-rendering
// the screen every second while the error stays open.
it('keeps the retry disabled until retryAt, enables it once and renders nothing more afterwards', async () => {
  let renders = 0;
  function RetryV1({ retryAt }: Readonly<{ retryAt: number }>) {
    renders += 1;
    const ready = useRetryReadyV1(retryAt);
    return <button disabled={!ready}>Tentar novamente</button>;
  }
  render(<RetryV1 retryAt={Date.now() + 5_000} />);
  const button = screen.getByRole('button', { name: 'Tentar novamente' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  await advance(4_999);
  expect(button.disabled).toBe(true);
  const before = renders;
  await advance(1);
  expect(button.disabled).toBe(false);
  expect(renders).toBe(before + 1);
  // The error stays on screen for another minute: no clock, no render.
  await advance(60_000);
  expect(renders).toBe(before + 1);
  expect(vi.getTimerCount()).toBe(0);
});

it('needs no timer without a wait or with a wait already over', () => {
  const none = renderHook(() => useRetryReadyV1(0));
  expect(none.result.current).toBe(true);
  const past = renderHook(() => useRetryReadyV1(Date.now() - 1));
  expect(past.result.current).toBe(true);
  // A wait that ends at this very moment (Retry-After 0) is over too.
  const now = renderHook(() => useRetryReadyV1(Date.now()));
  expect(now.result.current).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('waits again for a new failure, follows a shorter wait and drops its timer when closed', async () => {
  const view = renderHook(({ retryAt }) => useRetryReadyV1(retryAt), {
    initialProps: { retryAt: Date.now() + 1_000 },
  });
  await advance(1_000);
  expect(view.result.current).toBe(true);
  // Retried and failed again: a new wait.
  view.rerender({ retryAt: Date.now() + 30_000 });
  expect(view.result.current).toBe(false);
  // The next answer allows sooner: the shorter wait replaces the longer one.
  view.rerender({ retryAt: Date.now() + 2_000 });
  await advance(2_000);
  expect(view.result.current).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  // A success clears the wait at once.
  view.rerender({ retryAt: Date.now() + 10_000 });
  view.rerender({ retryAt: 0 });
  expect(view.result.current).toBe(true);
  view.rerender({ retryAt: Date.now() + 10_000 });
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
