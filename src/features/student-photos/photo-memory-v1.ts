import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { PhotoAdminSubjectV1 } from '../../../shared/student-photos/admin-http-v1';
import {
  PHOTO_AVATAR_BATCH_MAX_V1,
  PHOTO_AVATAR_BATCH_PATH_V1,
  PHOTO_AVATAR_BATCH_TYPE_V1,
  decodePhotoAvatarBatchV1,
  type PhotoAvatarBatchItemV1,
} from '../../../shared/student-photos/avatar-batch-v1';
import { STUDENT_PHOTO_MAX_BYTES_V1 } from '../../../shared/student-photos/portrait-v1';
import { PHOTO_CHANGED_EVENT_V1 } from './catalog-client-v1';

/**
 * Session memory for the small approved images shown beside names. One authenticated download per
 * image and document, shared by every list that shows the same student; nothing reaches persistent
 * browser storage and leaving the page releases it. The avatars of the rows mounted together are
 * asked for in one request.
 */
interface PhotoMemoryEntryV1 {
  state: 'idle' | 'queued' | 'loading' | 'ready' | 'absent';
  src?: string;
  /** Present for a current avatar: the student to ask for when several are read together. */
  subject?: PhotoAdminSubjectV1;
  loadedAt: number;
  retryAt: number;
  interest: number;
  listeners: Set<() => void>;
  controller?: AbortController;
}
type QueuedV1 = { url: string; entry: PhotoMemoryEntryV1 };
/** Requests in flight; a request of avatars read together carries several images. */
const MAX_PARALLEL_V1 = 4;
const FRESH_MS_V1 = 600_000;
const RETRY_MS_V1 = 30_000;
const entries = new Map<string, PhotoMemoryEntryV1>();
const queue: string[] = [];
let running = 0;
// Bumped when everything is forgotten: a download cancelled then no longer holds a slot.
let epoch = 0;
let listening = false;
let pumping = false;
// A server published before the joint read answers "not found": single reads then serve the page.
let together = true;

function entryV1(url: string) {
  let entry = entries.get(url);
  if (!entry) {
    entry = { state: 'idle', loadedAt: 0, retryAt: 0, interest: 0, listeners: new Set() };
    entries.set(url, entry);
  }
  return entry;
}
function notifyV1(entry: PhotoMemoryEntryV1) {
  for (const listener of entry.listeners) listener();
}
function releaseSrcV1(entry: PhotoMemoryEntryV1) {
  if (entry.src) URL.revokeObjectURL(entry.src);
  entry.src = undefined;
}
const typeOfV1 = (response: Response) =>
  response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
async function discardV1(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}
async function downloadV1(url: string, signal: AbortSignal): Promise<Uint8Array | null> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  // The server answers a student without photo with a plain colored shape, not a WebP.
  if (response.status === 404 || (response.ok && typeOfV1(response) !== 'image/webp')) {
    await discardV1(response);
    return null;
  }
  if (!response.ok) {
    await discardV1(response);
    throw new Error('student-photo-unavailable');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  if (bytes.byteLength < 20 || bytes.byteLength > STUDENT_PHOTO_MAX_BYTES_V1)
    throw new Error('student-photo-response-size');
  return bytes;
}
/** `undefined`: this server has no joint read. */
async function downloadTogetherV1(
  subjects: readonly PhotoAdminSubjectV1[],
  signal: AbortSignal,
): Promise<PhotoAvatarBatchItemV1[] | undefined> {
  const response = await fetch(PHOTO_AVATAR_BATCH_PATH_V1, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Student-Photo-Request': '1' },
    body: JSON.stringify({ version: 1, subjects }),
  });
  if (response.status === 404 || response.status === 405) {
    await discardV1(response);
    return undefined;
  }
  if (!response.ok || typeOfV1(response) !== PHOTO_AVATAR_BATCH_TYPE_V1) {
    await discardV1(response);
    throw new Error('student-photo-unavailable');
  }
  const images = decodePhotoAvatarBatchV1(await response.arrayBuffer(), subjects.length);
  signal.throwIfAborted();
  return images;
}
function showV1(entry: PhotoMemoryEntryV1, image: Uint8Array | null) {
  releaseSrcV1(entry);
  entry.src = image
    ? URL.createObjectURL(new Blob([new Uint8Array(image).buffer], { type: 'image/webp' }))
    : undefined;
  entry.state = image ? 'ready' : 'absent';
  entry.loadedAt = Date.now();
  notifyV1(entry);
}
/** Photos are optional: keep what is already shown and do not retry in a tight loop. */
function failV1(entry: PhotoMemoryEntryV1) {
  entry.state = entry.src ? 'ready' : 'idle';
  entry.retryAt = Date.now() + RETRY_MS_V1;
}
/** Back to the queue, each one for its own read, keeping its turn. */
function requeueV1(items: readonly QueuedV1[]) {
  for (const { url, entry } of [...items].reverse()) {
    entry.state = 'queued';
    queue.push(url);
  }
}
/** The entries still owned by this read (a newer read may have taken some). */
function ownedV1(items: readonly QueuedV1[], controller: AbortController) {
  return items.map(({ entry }) => entry).filter((entry) => entry.controller === controller);
}
async function loadV1(items: readonly QueuedV1[]) {
  const controller = new AbortController();
  const started = epoch;
  for (const { entry } of items) {
    entry.controller = controller;
    entry.state = 'loading';
  }
  running += 1;
  try {
    const first = items[0]!;
    if (items.length === 1 && !(together && first.entry.subject)) {
      const image = await downloadV1(first.url, controller.signal);
      if (controller.signal.aborted) return;
      try {
        showV1(first.entry, image);
      } finally {
        image?.fill(0);
      }
      return;
    }
    const images = await downloadTogetherV1(
      items.map(({ entry }) => entry.subject!),
      controller.signal,
    );
    if (controller.signal.aborted) return;
    if (!images) {
      together = false;
      requeueV1(items);
      return;
    }
    items.forEach(({ entry }, index) => {
      const image = images[index]!;
      if (image === 'unavailable') failV1(entry);
      else
        try {
          showV1(entry, image);
        } catch {
          failV1(entry);
        } finally {
          image?.fill(0);
        }
    });
  } catch {
    if (controller.signal.aborted) return;
    for (const entry of ownedV1(items, controller)) failV1(entry);
  } finally {
    for (const entry of ownedV1(items, controller)) entry.controller = undefined;
    if (started === epoch) {
      running -= 1;
      pumpV1();
    }
  }
}
/** The rows mounted in the same pass are known before the first request leaves. */
function scheduleV1() {
  if (pumping) return;
  pumping = true;
  queueMicrotask(() => {
    pumping = false;
    pumpV1();
  });
}
function pumpV1() {
  while (running < MAX_PARALLEL_V1 && queue.length) {
    // The end of the queue is what the person is looking at now.
    const url = queue.pop()!;
    const entry = entries.get(url);
    if (entry?.state !== 'queued') continue;
    const items: QueuedV1[] = [{ url, entry }];
    if (together && entry.subject)
      for (
        let index = queue.length - 1;
        index >= 0 && items.length < PHOTO_AVATAR_BATCH_MAX_V1;
        index--
      ) {
        const other = entries.get(queue[index]!);
        if (other?.state !== 'queued' || !other.subject) continue;
        items.push({ url: queue[index]!, entry: other });
        queue.splice(index, 1);
      }
    void loadV1(items);
  }
}
/** `urgent` is a photo near the screen; the others wait their turn behind it, in list order. */
function enqueueV1(url: string, entry: PhotoMemoryEntryV1, urgent: boolean) {
  const now = Date.now();
  if (entry.state === 'queued') {
    if (!urgent) return;
    const index = queue.lastIndexOf(url);
    if (index >= 0) queue.splice(index, 1);
    queue.push(url);
    return;
  }
  if (entry.state === 'loading' || now < entry.retryAt) return;
  if ((entry.state === 'ready' || entry.state === 'absent') && now - entry.loadedAt < FRESH_MS_V1)
    return;
  entry.state = 'queued';
  if (urgent) queue.push(url);
  else queue.unshift(url);
  scheduleV1();
}
/** Forgets every image. Mounted avatars ask again only when `reload` is set. */
export function clearPhotoMemoryV1(reload = false) {
  queue.length = 0;
  epoch += 1;
  running = 0;
  together = true;
  for (const [url, entry] of entries) {
    entry.controller?.abort();
    entry.controller = undefined;
    const shown = Boolean(entry.src);
    releaseSrcV1(entry);
    entry.state = 'idle';
    entry.loadedAt = 0;
    entry.retryAt = 0;
    if (shown) notifyV1(entry);
    if (!entry.interest && !entry.listeners.size) entries.delete(url);
  }
  if (reload)
    for (const [url, entry] of entries) if (entry.interest > 0) enqueueV1(url, entry, false);
}
/** A saved photo may be shown under another reference: revalidate what is on screen, keep it meanwhile. */
export function refreshPhotoMemoryV1() {
  for (const [url, entry] of entries) {
    entry.loadedAt = 0;
    entry.retryAt = 0;
    if (entry.interest > 0) enqueueV1(url, entry, false);
  }
}
function startV1() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pagehide', () => clearPhotoMemoryV1());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) clearPhotoMemoryV1(true);
  });
  window.addEventListener(PHOTO_CHANGED_EVENT_V1, refreshPhotoMemoryV1);
}
function retainV1(url: string, urgent: boolean, subject?: PhotoAdminSubjectV1) {
  startV1();
  const entry = entryV1(url);
  entry.subject ??= subject;
  entry.interest += 1;
  enqueueV1(url, entry, urgent);
  return () => {
    entry.interest -= 1;
    if (entry.interest > 0 || entry.state !== 'queued') return;
    // Left the list before its turn: an image nobody will see is not downloaded.
    const index = queue.lastIndexOf(url);
    if (index >= 0) queue.splice(index, 1);
    entry.state = entry.src ? 'ready' : 'idle';
  };
}

/** Asks for images about to be shown before their rows exist, so both arrive together. */
export function primePhotoMemoryV1(
  photos: readonly { url: string; subject?: PhotoAdminSubjectV1 }[],
) {
  startV1();
  // Reversed: the first of the list ends nearest the head of the queue.
  for (const photo of [...photos].reverse()) {
    const entry = entryV1(photo.url);
    entry.subject ??= photo.subject;
    enqueueV1(photo.url, entry, true);
  }
  // The whole group is known here: its requests leave now, not after the screen finishes mounting.
  pumpV1();
}

/** The in-memory image for an authenticated same-origin URL. Every mounted avatar asks for its
 * photo; the ones near the screen go first. `subject` marks a current avatar, which may be read
 * together with the others. */
export function usePhotoMemoryV1(
  url: string | undefined,
  near: boolean,
  subject?: PhotoAdminSubjectV1,
): string | undefined {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!url) return () => undefined;
      const entry = entryV1(url);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [url],
  );
  const src = useSyncExternalStore(subscribe, () => (url ? entries.get(url)?.src : undefined));
  // The subject is not a dependency: it is fully described by the URL it produced.
  useEffect(() => (url ? retainV1(url, near, subject) : undefined), [url, near]);
  return src;
}
