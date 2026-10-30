import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createStudentFrequencyClientV2,
  FrequencyClientErrorV2,
} from '../../../../src/features/student-portal/frequency/client-v2';
import { useFrequencyReadV2 } from '../../../../src/features/student-portal/frequency/use-frequency-read-v2';
import { setupOperationsDomV1 } from '../overview/dom-v1';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('reads the year from a private endpoint and rejects unknown payloads', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ contractVersion: 2, state: 'something-new' }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const client = createStudentFrequencyClientV2(fetcher);
  await expect(client.readYear(new AbortController().signal)).rejects.toMatchObject({
    state: 'unavailable',
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/student/frequency?year=2026');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
  });
});

it('pauses hidden reads, avoids overlap, backs off errors and fences late visibility responses', async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(() => useFrequencyReadV2(read, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(read).toHaveBeenCalledOnce();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => finish('PRIVATE INVENTED DATA'));
  expect(view.result.current.data).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(read).toHaveBeenCalledOnce();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
  const failing = vi.fn(async () => {
    throw new FrequencyClientErrorV2('unavailable');
  });
  renderHook(() => useFrequencyReadV2(failing, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(failing).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(failing).toHaveBeenCalledTimes(2);
});
