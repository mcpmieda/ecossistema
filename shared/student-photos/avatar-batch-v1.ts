import { z } from 'zod';
import { photoAdminSubjectV1 } from './admin-http-v1';
import { photoSubjectKeyV1 } from './catalog-v1';
import { STUDENT_PHOTO_MAX_BYTES_V1 } from './portrait-v1';

/**
 * Avatars of the rows on screen in one authorized read. It returns exactly what the single image
 * read returns for each student (the avatar, or the portrait while there is no avatar), under the
 * same session and capability; it only replaces many requests by one.
 */
export const PHOTO_AVATAR_BATCH_PATH_V1 = '/api/student-photos/admin/avatars';
export const PHOTO_AVATAR_BATCH_MAX_V1 = 16;
export const photoAvatarBatchRequestV1 = z
  .object({
    version: z.literal(1),
    subjects: z.array(photoAdminSubjectV1).min(1).max(PHOTO_AVATAR_BATCH_MAX_V1),
  })
  .strict()
  .refine(
    (value) => new Set(value.subjects.map(photoSubjectKeyV1)).size === value.subjects.length,
    'Each student once',
  );

/** The image, null when the student has no photo, or 'unavailable' when it could not be read now. */
export type PhotoAvatarBatchItemV1 = Uint8Array | null | 'unavailable';
const MAGIC_V1 = [0x53, 0x50, 0x41, 0x31]; // "SPA1"
const UNAVAILABLE_V1 = 0xffffffff;
const HEADER_BYTES_V1 = 5;
const ITEM_HEADER_BYTES_V1 = 4;
export const PHOTO_AVATAR_BATCH_TYPE_V1 = 'application/octet-stream';
const PHOTO_AVATAR_BATCH_MAX_BYTES_V1 =
  HEADER_BYTES_V1 + PHOTO_AVATAR_BATCH_MAX_V1 * (ITEM_HEADER_BYTES_V1 + STUDENT_PHOTO_MAX_BYTES_V1);

/** One entry per requested student, in request order. */
export function encodePhotoAvatarBatchV1(images: readonly PhotoAvatarBatchItemV1[]): Uint8Array {
  if (images.length < 1 || images.length > PHOTO_AVATAR_BATCH_MAX_V1)
    throw new Error('student-photo-batch-invalid');
  let size = HEADER_BYTES_V1;
  for (const image of images) {
    if (image instanceof Uint8Array && (image.length < 20 || image.length > STUDENT_PHOTO_MAX_BYTES_V1))
      throw new Error('student-photo-batch-invalid');
    size += ITEM_HEADER_BYTES_V1 + (image instanceof Uint8Array ? image.length : 0);
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC_V1, 0);
  view.setUint8(4, images.length);
  let offset = HEADER_BYTES_V1;
  for (const image of images) {
    view.setUint32(offset, image === 'unavailable' ? UNAVAILABLE_V1 : (image?.length ?? 0));
    offset += ITEM_HEADER_BYTES_V1;
    if (image instanceof Uint8Array) {
      bytes.set(image, offset);
      offset += image.length;
    }
  }
  return bytes;
}

/** Rejects anything that is not exactly `expected` complete items; never guesses a boundary. */
export function decodePhotoAvatarBatchV1(
  input: ArrayBuffer,
  expected: number,
): PhotoAvatarBatchItemV1[] {
  const bytes = new Uint8Array(input);
  if (
    bytes.length < HEADER_BYTES_V1 ||
    bytes.length > PHOTO_AVATAR_BATCH_MAX_BYTES_V1 ||
    MAGIC_V1.some((value, index) => bytes[index] !== value) ||
    bytes[4] !== expected
  )
    throw new Error('student-photo-batch-invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const images: PhotoAvatarBatchItemV1[] = [];
  let offset = HEADER_BYTES_V1;
  for (let index = 0; index < expected; index++) {
    if (offset + ITEM_HEADER_BYTES_V1 > bytes.length) throw new Error('student-photo-batch-invalid');
    const length = view.getUint32(offset);
    offset += ITEM_HEADER_BYTES_V1;
    if (length === 0 || length === UNAVAILABLE_V1) {
      images.push(length === 0 ? null : 'unavailable');
      continue;
    }
    if (length < 20 || length > STUDENT_PHOTO_MAX_BYTES_V1 || offset + length > bytes.length)
      throw new Error('student-photo-batch-invalid');
    images.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('student-photo-batch-invalid');
  return images;
}
