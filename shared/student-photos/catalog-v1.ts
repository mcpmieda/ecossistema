import { z } from 'zod';
import { studentUidV1 } from '../student-identity/student-identity-v1';
import { photoAdminSubjectV1, type PhotoAdminSubjectV1 } from './admin-http-v1';

export const photoCatalogRequestV1 = z
  .object({ version: z.literal(1), subject: photoAdminSubjectV1 })
  .strict();
export const photoCatalogStateV1 = z
  .object({
    version: z.literal(1),
    studentUid: studentUidV1,
    revision: studentUidV1.nullable(),
    initialized: z.boolean(),
    hasPortrait: z.boolean(),
    hasAvatar: z.boolean(),
    pendingRequest: studentUidV1.nullable(),
    pendingKind: z.enum(['replace', 'avatar', 'remove']).nullable(),
    pendingStage: z.enum(['prepared', 'committed', 'complete']).nullable(),
    ownPending: z.boolean(),
    portalReady: z.boolean(),
  })
  .strict();
export type PhotoCatalogStateV1 = z.infer<typeof photoCatalogStateV1>;
export function photoSubjectKeyV1(subject: PhotoAdminSubjectV1): string {
  return [
    subject.source,
    subject.academicYear,
    subject.source === 'portal' ? subject.accountIds[0] : subject.studentIds[0],
  ].join(':');
}
export function photoImageUrlV1(
  subject: PhotoAdminSubjectV1,
  variant: 'portrait' | 'avatar',
  revision?: string | null,
): string {
  const value = photoAdminSubjectV1.parse(subject);
  const query = new URLSearchParams({
    source: value.source,
    year: String(value.academicYear),
    reference: String(value.source === 'portal' ? value.accountIds[0] : value.studentIds[0]),
    variant,
  });
  if (revision) query.set('v', studentUidV1.parse(revision));
  return '/api/student-photos/admin/image?' + query.toString();
}
