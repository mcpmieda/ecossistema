import { z } from 'zod';
import { studentUidV1, studentIdentityRequestV1 } from '../student-identity/student-identity-v1';
import { photoWriteCommandV1, PhotoWriteErrorV1 } from './write-v1';
import { photoPreviewApprovalV1, photoQualitiesV1, assertPhotoQualitiesV1,
  type PhotoPreviewApprovalV1 } from './preview-v1';
import { probePhotoSourceV1 } from './source-probe-v1';

export const PHOTO_ADMIN_BODY_BYTES_V1 = 288 * 1024;
export const PHOTO_ADMIN_PATHS_V1 = {
  preview: '/api/student-photos/admin/preview', save: '/api/student-photos/admin/save',
} as const;
export const photoAdminSubjectV1 = studentIdentityRequestV1.refine(value =>
  (value.source === 'portal' ? value.accountIds : value.studentIds).length === 1,
  'Exactly one academic or account reference is required');
export type PhotoAdminSubjectV1 = z.infer<typeof photoAdminSubjectV1>;
export interface PhotoByteImagesV1 { portrait: Uint8Array | null; avatar: Uint8Array | null }
export const photoWireImagesV1 = z.object({
  portrait: z.string().min(28).max(4 * Math.ceil(131072 / 3)).nullable(),
  avatar: z.string().min(28).max(4 * Math.ceil(65536 / 3)).nullable(),
}).strict();
export type PhotoWireImagesV1 = z.infer<typeof photoWireImagesV1>;
const requestFields = { version: z.literal(1), subject: photoAdminSubjectV1,
  command: photoWriteCommandV1, images: photoWireImagesV1 };
export const photoAdminPreviewRequestV1 = z.object({ ...requestFields, qualities: photoQualitiesV1 }).strict()
  .superRefine((value, ctx) => {
    try {
      if (value.command.kind === 'remove') throw new PhotoWriteErrorV1('invalid');
      assertPhotoQualitiesV1(value.command, value.qualities);
      assertPresence(value.command.kind, value.images);
    } catch { ctx.addIssue({ code: 'custom', message: 'Invalid preview request' }); }
  });
export const photoAdminSaveRequestV1 = z.object({ ...requestFields, approval: photoPreviewApprovalV1.nullable() }).strict()
  .superRefine((value, ctx) => {
    try {
      assertPresence(value.command.kind, value.images);
      if ((value.command.kind === 'remove') !== (value.approval === null)) throw new PhotoWriteErrorV1('invalid');
      if (value.approval && !sameCommand(value.command, value.approval.command)) throw new PhotoWriteErrorV1('conflict');
    } catch { ctx.addIssue({ code: 'custom', message: 'Invalid save request' }); }
  });
export type PhotoAdminPreviewRequestV1 = z.infer<typeof photoAdminPreviewRequestV1>;
export type PhotoAdminSaveRequestV1 = z.infer<typeof photoAdminSaveRequestV1>;

export const photoAdminFailureStateV1 = z.enum(['unauthenticated', 'forbidden', 'invalid', 'too-large',
  'timeout', 'cancelled', 'conflict', 'busy', 'not-found', 'unavailable', 'disabled']);
export type PhotoAdminFailureStateV1 = z.infer<typeof photoAdminFailureStateV1>;
const envelope = { version: z.literal(1), traceId: studentUidV1 };
export const photoAdminResponseV1 = z.discriminatedUnion('state', [
  z.object({ ...envelope, state: z.literal('preview'), approval: photoPreviewApprovalV1, images: photoWireImagesV1 }).strict(),
  z.object({ ...envelope, state: z.literal('pending'), requestId: studentUidV1, stage: z.enum(['upload', 'commit']) }).strict(),
  z.object({ ...envelope, state: z.literal('committed'), requestId: studentUidV1, revision: studentUidV1, cleanupPending: z.boolean() }).strict(),
  z.object({ ...envelope, state: photoAdminFailureStateV1 }).strict(),
]);
export type PhotoAdminResponseV1 = z.infer<typeof photoAdminResponseV1>;

export function sameCommand(a: z.infer<typeof photoWriteCommandV1>, b: z.infer<typeof photoWriteCommandV1>): boolean {
  return a.requestId === b.requestId && a.expectedRevision === b.expectedRevision && a.kind === b.kind;
}
function assertPresence(kind: string, images: PhotoWireImagesV1): void {
  if ((kind === 'replace') !== (images.portrait !== null) || (kind !== 'remove') !== (images.avatar !== null))
    throw new PhotoWriteErrorV1('invalid');
}
export function clearPhotoBytesV1(images: PhotoByteImagesV1): void {
  images.portrait?.fill(0); images.avatar?.fill(0);
}
function encode(bytes: Uint8Array, max: number): string {
  if (!(bytes instanceof Uint8Array) || bytes.length < 20 || bytes.length > max) throw new PhotoWriteErrorV1('invalid');
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCodePoint(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
export function encodePhotoBytesV1(images: PhotoByteImagesV1): PhotoWireImagesV1 {
  return { portrait: images.portrait === null ? null : encode(images.portrait, 131072),
    avatar: images.avatar === null ? null : encode(images.avatar, 65536) };
}
export function decodePhotoBytesV1(input: unknown): PhotoByteImagesV1 {
  const wire = photoWireImagesV1.parse(input);
  const result: PhotoByteImagesV1 = { portrait: null, avatar: null };
  try {
    for (const variant of ['portrait', 'avatar'] as const) {
      const encoded = wire[variant];
      if (encoded === null) continue;
      const text = atob(encoded), max = variant === 'portrait' ? 131072 : 65536;
      if (text.length < 20 || text.length > max || btoa(text) !== encoded) throw new PhotoWriteErrorV1('invalid');
      result[variant] = Uint8Array.from(text, value => value.codePointAt(0)!);
    }
    return result;
  } catch { clearPhotoBytesV1(result); throw new PhotoWriteErrorV1('invalid'); }
}

/** Transport consistency only. Pixel decoding remains the server codec's responsibility. */
export async function assertPhotoPreviewBytesV1(approval: PhotoPreviewApprovalV1, images: PhotoByteImagesV1): Promise<void> {
  for (const variant of ['portrait', 'avatar'] as const) {
    const bytes = images[variant], metadata = approval.output[variant];
    if ((bytes === null) !== (metadata === null)) throw new PhotoWriteErrorV1('conflict');
    if (!bytes || !metadata) continue;
    const probe = probePhotoSourceV1(bytes);
    if (probe.type !== 'image/webp' || bytes.length !== metadata.byteSize
      || probe.width !== metadata.width || probe.height !== metadata.height) throw new PhotoWriteErrorV1('conflict');
    const copy = new Uint8Array(bytes);
    try {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer)),
        byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== metadata.sha256) throw new PhotoWriteErrorV1('conflict');
    } finally { copy.fill(0); }
  }
}
