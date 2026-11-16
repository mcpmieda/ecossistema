import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LinkedStudentPhotoAvatarV1 } from '../../src/features/student-photos/linked-student-photo-avatar-v1';
import {
  clearPhotoMemoryV1,
  primePhotoMemoryV1,
} from '../../src/features/student-photos/photo-memory-v1';
import { PHOTO_CHANGED_EVENT_V1 } from '../../src/features/student-photos/catalog-client-v1';
import { studentAvatarPhotoV1 } from '../../src/features/student-portal-admin/shared/student-avatar-v1';
import {
  PHOTO_AVATAR_BATCH_PATH_V1,
  PHOTO_AVATAR_BATCH_TYPE_V1,
  encodePhotoAvatarBatchV1,
  type PhotoAvatarBatchItemV1,
} from '../../shared/student-photos/avatar-batch-v1';
import type { PhotoAdminSubjectV1 } from '../../shared/student-photos/admin-http-v1';

const account = (n: number) => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const subject = (n: number) => ({
  source: 'portal' as const,
  academicYear: 2026,
  accountIds: [account(n)],
});
const webp = () => new Uint8Array(64).fill(7);
const image = () => new Response(webp(), { headers: { 'Content-Type': 'image/webp' } });
const images = (view: { container: HTMLElement }) =>
  [...view.container.querySelectorAll('img')].map((item) => item.getAttribute('src'));
/** The students of one joint read, by the last digits of their synthetic account. */
const asked = (init?: RequestInit) =>
  (JSON.parse(String(init?.body)) as { subjects: PhotoAdminSubjectV1[] }).subjects.map((item) =>
    Number((item.source === 'portal' ? item.accountIds[0]! : '').slice(-4)),
  );
const together = (items: PhotoAvatarBatchItemV1[]) => {
  const body = encodePhotoAvatarBatchV1(items);
  return new Response(body.buffer as ArrayBuffer, {
    headers: { 'Content-Type': PHOTO_AVATAR_BATCH_TYPE_V1 },
  });
};
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
let created: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
let revoked: ReturnType<typeof vi.fn<(src: string) => void>>;
beforeEach(() => {
  let next = 0;
  created = vi.fn(() => 'blob:synthetic-' + ++next);
  revoked = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: created });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoked });
});
afterEach(() => {
  cleanup();
  clearPhotoMemoryV1();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

it('reads the avatars mounted together in one request and shows a remounted list from memory', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    together(asked(init).map(webp)),
  );
  vi.stubGlobal('fetch', fetcher);
  const list = () => (
    <>
      <LinkedStudentPhotoAvatarV1 subject={subject(1)} />
      <LinkedStudentPhotoAvatarV1 subject={subject(1)} />
      <LinkedStudentPhotoAvatarV1 subject={subject(2)} />
    </>
  );
  const first = render(list());
  await waitFor(() => expect(images(first)).toHaveLength(3));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe(PHOTO_AVATAR_BATCH_PATH_V1);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'X-Student-Photo-Request': '1' },
  });
  // Each student once, however many rows show the same person.
  expect(asked(fetcher.mock.calls[0]?.[1]).sort((a, b) => a - b)).toEqual([1, 2]);
  expect(images(first)[0]).toBe(images(first)[1]);
  first.unmount();
  // A filter, a sort or another area mounts the same people again: the photo is already there.
  const second = render(list());
  expect(images(second)).toHaveLength(3);
  await settle();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(created).toHaveBeenCalledTimes(2);
});

it('keeps the fallback for a student without photo or with a failed read, without a request loop', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    together(asked(init).map((n) => (n === 3 ? null : 'unavailable'))),
  );
  vi.stubGlobal('fetch', fetcher);
  const list = () => (
    <>
      <LinkedStudentPhotoAvatarV1 subject={subject(3)} />
      <LinkedStudentPhotoAvatarV1 subject={subject(4)} />
    </>
  );
  const first = render(list());
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await settle();
  expect(images(first)).toHaveLength(0);
  expect(first.container.querySelectorAll('[data-slot="avatar-fallback"]')).toHaveLength(2);
  first.unmount();
  const second = render(list());
  await settle();
  expect(images(second)).toHaveLength(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(created).not.toHaveBeenCalled();
});

it('asks for at most sixteen students per request, the row near the screen first', async () => {
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  const pending: { students: number[]; answer(): void }[] = [];
  const fetcher = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        const students = asked(init);
        pending.push({ students, answer: () => resolve(together(students.map(webp))) });
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <>
      {Array.from({ length: 90 }, (_, index) => (
        <LinkedStudentPhotoAvatarV1 key={index} subject={subject(100 + index)} />
      ))}
    </>,
  );
  await settle();
  // Four requests in flight, sixteen students each, in list order.
  expect(pending.map((request) => request.students.length)).toEqual([16, 16, 16, 16]);
  expect(pending[0]!.students).toEqual(Array.from({ length: 16 }, (_, index) => 100 + index));
  expect(pending[3]!.students[15]).toBe(163);
  // The last row comes near the screen while 26 are still waiting: it leads the next request.
  await act(async () => {
    callbacks.at(-1)!(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
  await act(async () => {
    pending[0]!.answer();
  });
  await waitFor(() => expect(pending).toHaveLength(5));
  expect(pending[4]!.students[0]).toBe(189);
  expect(pending[4]!.students.slice(1, 4)).toEqual([164, 165, 166]);
  await act(async () => {
    for (const request of pending) request.answer();
  });
  await waitFor(() => expect(pending).toHaveLength(6));
  await act(async () => {
    for (const request of pending) request.answer();
  });
  await waitFor(() => expect(images(view)).toHaveLength(90));
  expect(pending.flatMap((request) => request.students).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 90 }, (_, index) => 100 + index),
  );
});

it('does not ask for the photo of a row that left the list before its turn', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  const requests: number[][] = [];
  const answers: (() => void)[] = [];
  const fetcher = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        const students = asked(init);
        requests.push(students);
        answers.push(() => resolve(together(students.map(webp))));
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const row = (index: number) => (
    <LinkedStudentPhotoAvatarV1 key={index} subject={subject(400 + index)} />
  );
  const view = render(<>{Array.from({ length: 70 }, (_, index) => row(index))}</>);
  await settle();
  expect(requests).toHaveLength(4);
  // A filter removes the six rows still waiting.
  view.rerender(<>{Array.from({ length: 64 }, (_, index) => row(index))}</>);
  await act(async () => {
    for (const answer of answers.splice(0)) answer();
  });
  await waitFor(() => expect(images(view)).toHaveLength(64));
  expect(requests).toHaveLength(4);
});

it('asks ahead for the first rows of a list so they mount with their photos', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    together(asked(init).map(webp)),
  );
  vi.stubGlobal('fetch', fetcher);
  primePhotoMemoryV1([5, 6, 7].map((n) => studentAvatarPhotoV1(account(n))));
  // The request leaves at once, without waiting for the screen to finish mounting.
  expect(fetcher).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(created).toHaveBeenCalledTimes(3));
  expect(asked(fetcher.mock.calls[0]?.[1])).toEqual([5, 6, 7]);
  const view = render(
    <>
      {[5, 6, 7].map((n) => (
        <LinkedStudentPhotoAvatarV1 key={n} subject={subject(n)} />
      ))}
    </>,
  );
  expect(images(view)).toHaveLength(3);
  await settle();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('falls back to one read per student when the server has no joint read, and reads a given revision alone', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    init?.method === 'POST' ? new Response('{}', { status: 404 }) : image(),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <>
      <LinkedStudentPhotoAvatarV1 subject={subject(8)} />
      <LinkedStudentPhotoAvatarV1 subject={subject(9)} />
    </>,
  );
  await waitFor(() => expect(images(view)).toHaveLength(2));
  const urls = fetcher.mock.calls.map(([url]) => String(url));
  expect(urls.filter((url) => url === PHOTO_AVATAR_BATCH_PATH_V1)).toHaveLength(1);
  expect(urls.filter((url) => url.startsWith('/api/student-photos/admin/image?'))).toHaveLength(2);
  view.unmount();
  fetcher.mockClear();
  const revision = '90000000-0000-4000-8000-000000000001';
  const versioned = render(<LinkedStudentPhotoAvatarV1 subject={subject(8)} revision={revision} />);
  await waitFor(() => expect(images(versioned)).toHaveLength(1));
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    expect.stringMatching(
      new RegExp('^/api/student-photos/admin/image\\?.*v=' + revision + '$', 'u'),
    ),
  ]);
});

it('releases every image when the page is left and revalidates what is on screen after a saved photo', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    together(asked(init).map(webp)),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(<LinkedStudentPhotoAvatarV1 subject={subject(5)} />);
  await waitFor(() => expect(images(view)).toEqual(['blob:synthetic-1']));
  act(() => {
    window.dispatchEvent(
      new CustomEvent(PHOTO_CHANGED_EVENT_V1, {
        detail: { subjectKey: 'other', studentUid: 'other', revision: null },
      }),
    );
  });
  // The current image stays until its replacement arrives.
  expect(images(view)).toEqual(['blob:synthetic-1']);
  await waitFor(() => expect(images(view)).toEqual(['blob:synthetic-2']));
  expect(revoked).toHaveBeenCalledWith('blob:synthetic-1');
  expect(fetcher).toHaveBeenCalledTimes(2);
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(images(view)).toHaveLength(0);
  expect(revoked).toHaveBeenCalledWith('blob:synthetic-2');
  await settle();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
