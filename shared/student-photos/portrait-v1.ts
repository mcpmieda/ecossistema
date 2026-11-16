import { z } from 'zod';
import { portalIdV1 } from '../student-portal-contracts/core-v1';

export const STUDENT_PHOTO_META_PATH_V1 = '/api/student/photo';
export const STUDENT_PHOTO_CONTENT_PATH_V1 = '/api/student/photo/content';
export const STUDENT_PHOTO_MAX_BYTES_V1 = 128 * 1024;
export const STUDENT_PHOTO_MAX_WIDTH_V1 = 900;
export const STUDENT_PHOTO_MAX_HEIGHT_V1 = 1200;
export const photoRevisionV1 = z.uuid().transform((value) => value.toLowerCase());

/** Metadata only: no studentUid, storage locator, authorization document or image bytes. */
export const portraitMetadataV1 = z
  .object({
    contractVersion: z.literal(1),
    accountId: portalIdV1,
    revision: photoRevisionV1,
    width: z.number().int().positive().max(STUDENT_PHOTO_MAX_WIDTH_V1),
    height: z.number().int().positive().max(STUDENT_PHOTO_MAX_HEIGHT_V1),
  })
  .strict()
  .refine((value) => value.width * 4 === value.height * 3, 'Portrait must be 3 by 4');
export type PortraitMetadataV1 = z.infer<typeof portraitMetadataV1>;

/** Fixed same-origin route. A revision is a freshness check, never an access credential. */
export function portraitContentPathV1(revision: string): string {
  return `${STUDENT_PHOTO_CONTENT_PATH_V1}?v=${photoRevisionV1.parse(revision)}`;
}
