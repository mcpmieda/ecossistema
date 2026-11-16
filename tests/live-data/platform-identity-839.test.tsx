// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePlatformIdentityV1 } from '../../src/platform/platform-identity-v1';

const now = Date.parse('2026-09-17T18:00:00.000Z');
const identity = (key = 'synthetic-session', expiry = now + 60_000) => ({
  authenticated: true,
  identityKey: key,
  expiresAt: new Date(expiry).toISOString(),
  capabilities: ['platform.snapshot.read', 'platform.settings.read'],
});
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const flush = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  fetcher = vi.fn<typeof fetch>(async () => Response.json(identity()));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  cleanup();
  await flush();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('rechecks on return without polling or repeated focus reads', async () => {
  const { result } = renderHook(usePlatformIdentityV1);
  await flush();
  expect(result.current.identity?.identityKey).toBe('synthetic-session');
  await advance(10_000);
  await act(async () => {
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('focus'));
  });
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await advance(10_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
});
it.each([401, 403])('clears an existing identity on authoritative %i', async (status) => {
  const { result } = renderHook(usePlatformIdentityV1);
  await flush();
  fetcher.mockResolvedValueOnce(new Response(null, { status }));
  act(() => result.current.recheck());
  await flush();
  expect(result.current.identity?.authenticated ?? false).toBe(false);
  expect(result.current.accessError).toBe(status === 403);
});
it('preserves a still-valid identity on transient failure, but not after its known expiry', async () => {
  const { result } = renderHook(usePlatformIdentityV1);
  await flush();
  const before = result.current.identity;
  fetcher.mockImplementation(async () => new Response(null, { status: 503 }));
  act(() => result.current.recheck());
  await flush();
  expect(result.current.identity).toBe(before);
  expect(result.current.accessError).toBe(false);
  await advance(60_000);
  await flush();
  expect(result.current.identity).toBeNull();
  expect(result.current.accessError).toBe(true);
});
it('removes expired content before awaiting the renewal response', async () => {
  const { result } = renderHook(usePlatformIdentityV1);
  await flush();
  fetcher.mockImplementation(() => new Promise<Response>(() => undefined));
  await advance(60_000);
  expect(result.current.identity).toBeNull();
  expect(result.current.accessError).toBe(false);
  await advance(15_000);
  expect(result.current.accessError).toBe(true);
});
it('bounds the full body read and ignores a late response after the deadline', async () => {
  let resolve!: (input: unknown) => void;
  const body = new Promise((done) => {
    resolve = done;
  });
  fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body } as Response);
  const { result } = renderHook(usePlatformIdentityV1);
  await flush();
  await advance(15_000);
  expect(result.current.accessError).toBe(true);
  await act(async () => resolve(identity()));
  await flush();
  expect(result.current.identity).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('clears pagehide content and rechecks before showing a restored page', async () => {
  const { result } = renderHook(usePlatformIdentityV1);
  await flush();
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect(result.current.identity).toBeNull();
  fetcher.mockResolvedValueOnce(Response.json(identity('synthetic-other-session')));
  await act(async () => window.dispatchEvent(new Event('pageshow')));
  await flush();
  expect(result.current.identity?.identityKey).toBe('synthetic-other-session');
});
it('ignores an obsolete initial response during StrictMode replay', async () => {
  let resolve!: (response: Response) => void;
  fetcher.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  const { result, unmount } = renderHook(usePlatformIdentityV1, { wrapper: StrictMode });
  await flush();
  expect(result.current.identity?.authenticated).toBe(true);
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json({ authenticated: false })));
  await flush();
  expect(result.current.identity?.authenticated).toBe(true);
  unmount();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
});
