import { z } from 'zod';
import {
  photoCatalogRequestV1,
  photoCatalogStateV1,
  photoImageUrlV1,
  photoSubjectKeyV1,
  type PhotoCatalogStateV1,
} from '../../../shared/student-photos/catalog-v1';
import {
  photoAdminResponseV1,
  type PhotoAdminSubjectV1,
} from '../../../shared/student-photos/admin-http-v1';
import { readPhotoJsonV1 } from '../../../shared/student-photos/bounded-json-v1';
import { studentUidV1 } from '../../../shared/student-identity/student-identity-v1';
import { PhotoAdminClientErrorV1 } from './admin-client-v1';

const catalogResponse = z
  .object({
    version: z.literal(1),
    state: z.literal('catalog'),
    traceId: studentUidV1,
    canWrite: z.boolean(),
    catalog: photoCatalogStateV1,
  })
  .strict();
async function post(path: string, body: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Student-Photo-Request': '1' },
    body: JSON.stringify(body),
  });
  const headers = new Headers(response.headers);
  const encoding = headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  const result = await readPhotoJsonV1({ body: response.body, headers }, signal);
  if (response.status === 401) throw new PhotoAdminClientErrorV1('unauthenticated');
  if (response.status === 403) throw new PhotoAdminClientErrorV1('forbidden');
  if (!response.ok || response.redirected) throw new PhotoAdminClientErrorV1('unavailable');
  return result;
}
export async function readPhotoCatalogV1(
  subject: PhotoAdminSubjectV1,
  signal: AbortSignal,
  open = false,
) {
  const request = photoCatalogRequestV1.parse({ version: 1, subject });
  return catalogResponse.parse(
    await post('/api/student-photos/admin/' + (open ? 'open' : 'state'), request, signal),
  );
}
export async function recoverPhotoWriteV1(
  subject: PhotoAdminSubjectV1,
  requestId: string,
  signal: AbortSignal,
) {
  const id = studentUidV1.parse(requestId);
  const result = photoAdminResponseV1.parse(
    await post(
      '/api/student-photos/admin/recover',
      {
        ...photoCatalogRequestV1.parse({ version: 1, subject }),
        requestId: id,
      },
      signal,
    ),
  );
  if (
    (result.state !== 'pending' && result.state !== 'committed') ||
    result.requestId !== id ||
    (result.state === 'committed' && result.revision !== id)
  )
    throw new PhotoAdminClientErrorV1('unavailable');
  return result;
}
/** Read only the bounded current principal; do not put a private photo in persistent browser storage. */
export async function readCurrentPhotoV1(
  subject: PhotoAdminSubjectV1,
  revision: string | null,
  signal: AbortSignal,
): Promise<Blob | undefined> {
  const response = await fetch(photoImageUrlV1(subject, 'portrait', revision), {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  if (response.status === 401) throw new PhotoAdminClientErrorV1('unauthenticated');
  if (response.status === 403) throw new PhotoAdminClientErrorV1('forbidden');
  if (response.status === 404) return undefined;
  if (
    !response.ok ||
    response.headers.get('content-type')?.split(';', 1)[0] !== 'image/webp' ||
    !response.body
  )
    throw new PhotoAdminClientErrorV1('unavailable');
  const reader = response.body.getReader(),
    storage = new Uint8Array(131072);
  let length = 0,
    complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (value.length > storage.length - length) throw new PhotoAdminClientErrorV1('too-large');
      storage.set(value, length);
      length += value.length;
    }
    signal.throwIfAborted();
    if (length < 20) throw new PhotoAdminClientErrorV1('unavailable');
    return new Blob([storage.slice(0, length).buffer], { type: 'image/webp' });
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    storage.fill(0);
  }
}
export const PHOTO_CHANGED_EVENT_V1 = 'student-photo-changed-v1';
export interface PhotoChangedDetailV1 {
  subjectKey: string;
  studentUid: string;
  revision: string | null;
}
export function announcePhotoChangeV1(
  subject: PhotoAdminSubjectV1,
  catalog: PhotoCatalogStateV1,
): void {
  window.dispatchEvent(
    new CustomEvent<PhotoChangedDetailV1>(PHOTO_CHANGED_EVENT_V1, {
      detail: {
        subjectKey: photoSubjectKeyV1(subject),
        studentUid: catalog.studentUid,
        revision: catalog.revision,
      },
    }),
  );
}
