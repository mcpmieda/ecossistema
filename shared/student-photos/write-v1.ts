import { z } from 'zod';
import { studentUidV1 } from '../student-identity/student-identity-v1';

export const photoWriteContextV1 = z.object({ studentUid: studentUidV1, actorId: studentUidV1 }).strict();
export const photoWriteCommandV1 = z.object({
  requestId: studentUidV1,
  expectedRevision: studentUidV1.nullable(),
  kind: z.enum(['replace', 'avatar', 'remove']),
}).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const locator = z.string().min(1).max(256).regex(/^[A-Za-z0-9!_./-]+$/u);
export const photoVariantMetadataV1 = z.object({
  sha256: digest, byteSize: z.number().int().min(20).max(131072),
  width: z.number().int().min(1).max(900), height: z.number().int().min(1).max(1200),
}).strict();
export const photoAssetV1 = photoVariantMetadataV1.extend({
  driveId: locator, itemId: locator, etag: z.string().min(1).max(256).regex(/^[^\r\n]+$/u),
});
export const photoAssetsV1 = z.object({ portrait: photoAssetV1.nullable(), avatar: photoAssetV1.nullable() }).strict();
export const photoWritePlanV1 = z.object({
  portrait: photoVariantMetadataV1.nullable(), avatar: photoVariantMetadataV1.nullable(),
}).strict();
export const photoWriteReceiptV1 = z.object({
  requestId: studentUidV1, studentUid: studentUidV1, actorId: studentUidV1,
  expectedRevision: studentUidV1.nullable(), kind: photoWriteCommandV1.shape.kind,
  inputHash: digest, phase: z.enum(['prepared', 'committed', 'complete']),
  plan: photoWritePlanV1, previous: photoAssetsV1, assets: photoAssetsV1,
  cleanup: z.array(photoAssetV1).max(2),
}).strict();
export type PhotoWriteContextV1 = z.infer<typeof photoWriteContextV1>;
export type PhotoWriteCommandV1 = z.infer<typeof photoWriteCommandV1>;
export type PhotoVariantMetadataV1 = z.infer<typeof photoVariantMetadataV1>;
export type PhotoAssetV1 = z.infer<typeof photoAssetV1>;
export type PhotoAssetsV1 = z.infer<typeof photoAssetsV1>;
export type PhotoWritePlanV1 = z.infer<typeof photoWritePlanV1>;
export type PhotoWriteReceiptV1 = z.infer<typeof photoWriteReceiptV1>;

export class PhotoWriteErrorV1 extends Error {
  constructor(readonly code: 'conflict' | 'busy' | 'receipt-conflict' | 'invalid' | 'not-found') {
    super(`student-photo-write-${code}`);
  }
}
export function photoAssetKeyV1(asset: PhotoAssetV1): string { return `${asset.driveId}/${asset.itemId}`; }

/** Validates final variant budgets. This is NOT image decoding or authorization. */
export function assertPhotoWritePlanV1(command: PhotoWriteCommandV1, plan: PhotoWritePlanV1): void {
  if ((command.kind === 'replace') !== (plan.portrait !== null)
    || (command.kind !== 'remove') !== (plan.avatar !== null)) throw new PhotoWriteErrorV1('invalid');
  if (plan.portrait && plan.portrait.width * 4 !== plan.portrait.height * 3) throw new PhotoWriteErrorV1('invalid');
  if (plan.avatar && (plan.avatar.width !== plan.avatar.height || plan.avatar.width > 320
    || plan.avatar.byteSize > 65536)) throw new PhotoWriteErrorV1('invalid');
}

/** Order-independent JSON transport becomes one canonical fingerprint bound to actor, person and base revision. */
export async function photoWriteFingerprintV1(context: PhotoWriteContextV1, command: PhotoWriteCommandV1,
  plan: PhotoWritePlanV1): Promise<string> {
  const metadata = (value: PhotoVariantMetadataV1 | null) => value
    ? [value.sha256, value.byteSize, value.width, value.height] : null;
  const bytes = new TextEncoder().encode(JSON.stringify([1, context.actorId, context.studentUid,
    command.requestId, command.expectedRevision, command.kind, metadata(plan.portrait), metadata(plan.avatar)]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}

/** A changed reference must be a new immutable file with the exact validated bytes/geometry. */
export function assertPhotoUploadedAssetsV1(receipt: PhotoWriteReceiptV1, uploaded: PhotoAssetsV1): void {
  const used = new Set<string>();
  for (const variant of ['portrait', 'avatar'] as const) {
    const wanted = receipt.plan[variant], actual = uploaded[variant];
    if (!wanted) {
      if (actual) throw new PhotoWriteErrorV1('invalid');
      continue;
    }
    if (!actual || actual.sha256 !== wanted.sha256 || actual.byteSize !== wanted.byteSize
      || actual.width !== wanted.width || actual.height !== wanted.height) throw new PhotoWriteErrorV1('invalid');
    const key = photoAssetKeyV1(actual);
    if (used.has(key) || Object.values(receipt.previous).some(old => old && photoAssetKeyV1(old) === key))
      throw new PhotoWriteErrorV1('invalid');
    used.add(key);
  }
}
