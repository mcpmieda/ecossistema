import { z } from 'zod';
import {
  assertPhotoWritePlanV1, photoWriteCommandV1, photoWriteContextV1, photoWritePlanV1,
  type PhotoVariantMetadataV1, type PhotoWriteCommandV1, type PhotoWriteContextV1,
  PhotoWriteErrorV1,
} from './write-v1';

const photoQualityV1 = z.union([z.literal(92), z.literal(86), z.literal(80)]);
export const photoQualitiesV1 = z.object({
  portrait: photoQualityV1.nullable(), avatar: photoQualityV1.nullable(),
}).strict();

/** Echoed preview evidence, NOT a credential, permission or proof of parental consent.
 * The save boundary must resolve its own actor/person and recalculate every output. */
export const photoPreviewApprovalV1 = z.object({
  version: z.literal(1), codec: z.literal('student-webp-1.6.0-v1'),
  context: photoWriteContextV1, command: photoWriteCommandV1,
  qualities: photoQualitiesV1, source: photoWritePlanV1, output: photoWritePlanV1,
}).strict().superRefine((value, ctx) => {
  try {
    if (value.command.kind === 'remove') throw new PhotoWriteErrorV1('invalid');
    assertPhotoWritePlanV1(value.command, value.source);
    assertPhotoWritePlanV1(value.command, value.output);
    assertPhotoQualitiesV1(value.command, value.qualities);
    for (const variant of ['portrait', 'avatar'] as const) {
      const before = value.source[variant], after = value.output[variant];
      if (before && after && (before.width !== after.width || before.height !== after.height))
        throw new PhotoWriteErrorV1('invalid');
    }
  } catch { ctx.addIssue({ code: 'custom', message: 'Invalid photo preview contract' }); }
});
export type PhotoQualitiesV1 = z.infer<typeof photoQualitiesV1>;
export type PhotoPreviewApprovalV1 = z.infer<typeof photoPreviewApprovalV1>;

export function assertPhotoQualitiesV1(command: PhotoWriteCommandV1, qualities: PhotoQualitiesV1): void {
  if ((command.kind === 'replace') !== (qualities.portrait !== null)
    || (command.kind !== 'remove') !== (qualities.avatar !== null)) throw new PhotoWriteErrorV1('invalid');
}

export function samePhotoMetadataV1(a: PhotoVariantMetadataV1, b: PhotoVariantMetadataV1): boolean {
  return a.sha256 === b.sha256 && a.byteSize === b.byteSize && a.width === b.width && a.height === b.height;
}

/** Explicit comparison ignores property order but never ignores actor, person or base revision. */
export function assertPhotoPreviewContextV1(approval: PhotoPreviewApprovalV1,
  context: PhotoWriteContextV1, command: PhotoWriteCommandV1): void {
  if (approval.context.actorId !== context.actorId || approval.context.studentUid !== context.studentUid
    || approval.command.requestId !== command.requestId || approval.command.expectedRevision !== command.expectedRevision
    || approval.command.kind !== command.kind) throw new PhotoWriteErrorV1('conflict');
}
