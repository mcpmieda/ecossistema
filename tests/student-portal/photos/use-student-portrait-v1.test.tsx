import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useStudentPortraitV1,
  type PortraitScopeV1,
} from '../../../src/features/student-portal/photos/use-student-portrait-v1';
import type {
  PortraitClientV1,
  PortraitObjectV1,
} from '../../../src/features/student-portal/photos/portrait-client-v1';
import { photoAccountV1, otherPhotoAccountV1 } from './fixture-v1';

const first: PortraitScopeV1 = {
  requestId: '60000000-0000-4000-8000-000000000001',
  profile: { accountId: photoAccountV1 },
};
const second: PortraitScopeV1 = {
  requestId: '60000000-0000-4000-8000-000000000002',
  profile: { accountId: otherPhotoAccountV1 },
};
const initialProps: { scope: PortraitScopeV1 | null } = { scope: first };
const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
const photo = (label: string): PortraitObjectV1 => ({
  src: 'blob:https://aluno.escolaieda.com/synthetic-' + label,
  dispose: vi.fn(),
});
afterEach(cleanup);

it('loads once under StrictMode and does not reload on focus, visibility or same-scope rerender', async () => {
  const image = photo('first');
  const client = vi.fn<PortraitClientV1>().mockResolvedValue(image);
  const hook = renderHook(
    ({ scope }: { scope: PortraitScopeV1 | null }) => useStudentPortraitV1(scope, client),
    { initialProps, wrapper },
  );
  await waitFor(() => expect(hook.result.current).toBe(image.src));
  expect(client).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  hook.rerender({ scope: { ...first, profile: { ...first.profile } } });
  expect(client).toHaveBeenCalledTimes(1);
  hook.unmount();
  expect(image.dispose).toHaveBeenCalledTimes(1);
});

it('immediately hides the old photo on account change and discards a late response from the previous account', async () => {
  const pending: ((value: PortraitObjectV1 | undefined) => void)[] = [];
  const signals: AbortSignal[] = [];
  const client = vi.fn<PortraitClientV1>().mockImplementation((_account, signal) => {
    signals.push(signal);
    return new Promise((resolve) => pending.push(resolve));
  });
  const hook = renderHook(
    ({ scope }: { scope: PortraitScopeV1 | null }) => useStudentPortraitV1(scope, client),
    { initialProps, wrapper },
  );
  await waitFor(() => expect(client).toHaveBeenCalledTimes(1));
  hook.rerender({ scope: second });
  expect(hook.result.current).toBeUndefined();
  expect(signals[0]!.aborted).toBe(true);
  await waitFor(() => expect(client).toHaveBeenCalledTimes(2));
  const old = photo('late-first'),
    next = photo('second');
  await act(async () => {
    pending[0]!(old);
  });
  expect(old.dispose).toHaveBeenCalledTimes(1);
  expect(hook.result.current).toBeUndefined();
  await act(async () => {
    pending[1]!(next);
  });
  expect(hook.result.current).toBe(next.src);
});

it('keeps the photo on screen while the same account is read again and hides it when the answer has none', async () => {
  const pending: ((value: PortraitObjectV1 | undefined) => void)[] = [];
  const client = vi
    .fn<PortraitClientV1>()
    .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const hook = renderHook(
    ({ scope }: { scope: PortraitScopeV1 | null }) => useStudentPortraitV1(scope, client),
    { initialProps, wrapper },
  );
  await waitFor(() => expect(client).toHaveBeenCalledTimes(1));
  const image = photo('first'),
    renewed = photo('renewed');
  await act(async () => {
    pending[0]!(image);
  });
  expect(hook.result.current).toBe(image.src);
  hook.rerender({ scope: { ...first, requestId: '60000000-0000-4000-8000-000000000003' } });
  await waitFor(() => expect(client).toHaveBeenCalledTimes(2));
  expect(hook.result.current).toBe(image.src);
  expect(image.dispose).not.toHaveBeenCalled();
  await act(async () => {
    pending[1]!(renewed);
  });
  expect(hook.result.current).toBe(renewed.src);
  expect(image.dispose).toHaveBeenCalledTimes(1);
  hook.rerender({ scope: { ...first, requestId: '60000000-0000-4000-8000-000000000004' } });
  await waitFor(() => expect(client).toHaveBeenCalledTimes(3));
  await act(async () => {
    pending[2]!(undefined);
  });
  expect(hook.result.current).toBeUndefined();
  expect(renewed.dispose).toHaveBeenCalledTimes(1);
});

it('clears a loaded image on logout and never reuses its revoked object after re-entry with the same self object', async () => {
  const image = photo('first');
  const client = vi
    .fn<PortraitClientV1>()
    .mockResolvedValueOnce(image)
    .mockResolvedValue(undefined);
  const hook = renderHook(
    ({ scope }: { scope: PortraitScopeV1 | null }) => useStudentPortraitV1(scope, client),
    { initialProps, wrapper },
  );
  await waitFor(() => expect(hook.result.current).toBe(image.src));
  hook.rerender({ scope: null });
  expect(hook.result.current).toBeUndefined();
  expect(image.dispose).toHaveBeenCalledTimes(1);
  hook.rerender({ scope: first });
  expect(hook.result.current).toBeUndefined();
  await waitFor(() => expect(client).toHaveBeenCalledTimes(2));
  expect(hook.result.current).toBeUndefined();
});

it('contains reader rejection and cleanup failures, without making the containing screen fail', async () => {
  const client = vi
    .fn<PortraitClientV1>()
    .mockRejectedValueOnce(new Error('synthetic-photo-outage'));
  const hook = renderHook(
    ({ scope }: { scope: PortraitScopeV1 | null }) => useStudentPortraitV1(scope, client),
    { initialProps, wrapper },
  );
  await waitFor(() => expect(client).toHaveBeenCalledTimes(1));
  expect(hook.result.current).toBeUndefined();
  client.mockResolvedValue({
    src: 'blob:https://aluno.escolaieda.com/synthetic-next',
    dispose: () => {
      throw new Error('synthetic-dispose');
    },
  });
  hook.rerender({ scope: second });
  await waitFor(() => expect(hook.result.current).toContain('synthetic-next'));
  expect(() => hook.rerender({ scope: null })).not.toThrow();
  expect(hook.result.current).toBeUndefined();
});
