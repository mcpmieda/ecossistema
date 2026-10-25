import {
  PhotoWriteErrorV1, photoWriteContextV1, photoWriteCommandV1, photoVariantMetadataV1,
  type PhotoWriteContextV1, type PhotoWriteCommandV1, type PhotoWritePlanV1, type PhotoVariantMetadataV1,
} from '../../shared/student-photos/write-v1';
import {
  photoPreviewApprovalV1, photoQualitiesV1, assertPhotoQualitiesV1, assertPhotoPreviewContextV1,
  samePhotoMetadataV1, type PhotoPreviewApprovalV1,
} from '../../shared/student-photos/preview-v1';
import { probePhotoSourceV1 } from '../../shared/student-photos/source-probe-v1';
import { PhotoWriteCoordinatorV1, type PhotoWriteInputV1, type PhotoWritePortsV1, type PhotoWriteResultV1,
  type PhotoVariantV1, type ValidatedPhotoBytesV1 } from './write-coordinator-v1';
import type { PhotoWriteRepositoryV1 } from './write-repository-v1';
import { PhotoWriteGuardV1 } from './write-guard-v1';
import type { PhotoStorageActionV1 } from './storage-v1';
import type { StudentWebpCodecV1 } from './webp-codec-v1';

export interface PhotoPreviewResultV1 { approval: PhotoPreviewApprovalV1; images: PhotoWriteInputV1 }
export interface PhotoEditServiceOptionsV1 {
  codec: Pick<StudentWebpCodecV1, 'normalize'>;
  repository: Pick<PhotoWriteRepositoryV1, 'claim' | 'commit' | 'acknowledgeCleanup' | 'complete'>;
  guard: Pick<PhotoWriteGuardV1, 'assertInitialized' | 'assertTransfer'>;
  authorize(context: PhotoWriteContextV1): Promise<void>;
  storage(authorize: (action: PhotoStorageActionV1) => Promise<void>): Pick<PhotoWritePortsV1, 'upload' | 'remove'>;
  publish?: NonNullable<PhotoWritePortsV1['publish']>;
}
const variants = ['portrait', 'avatar'] as const;
const empty = (): PhotoWriteInputV1 => ({ portrait: null, avatar: null });
function clear(input: PhotoWriteInputV1): void { for (const variant of variants) input[variant]?.fill(0); }
function assertBudget(bytes: Uint8Array, variant: PhotoVariantV1): void {
  if (!(bytes instanceof Uint8Array) || bytes.length < 20 || bytes.length > (variant === 'portrait' ? 131072 : 65536))
    throw new PhotoWriteErrorV1('invalid');
}
/** Snapshot both variants before any asynchronous work. */
function snapshot(command: PhotoWriteCommandV1, input: PhotoWriteInputV1): PhotoWriteInputV1 {
  const copies = empty();
  try {
    for (const variant of variants) {
      const wanted = variant === 'portrait' ? command.kind === 'replace' : command.kind !== 'remove';
      const bytes = input[variant];
      if (wanted !== (bytes !== null)) throw new PhotoWriteErrorV1('invalid');
      if (bytes === null) continue;
      assertBudget(bytes, variant); copies[variant] = new Uint8Array(bytes);
    }
    return copies;
  } catch (error) { clear(copies); throw error; }
}
async function metadata(bytes: Uint8Array, width: number, height: number): Promise<PhotoVariantMetadataV1> {
  const copy = new Uint8Array(bytes);
  try {
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    return photoVariantMetadataV1.parse({ sha256, byteSize: bytes.length, width, height });
  } finally { copy.fill(0); }
}
async function sourceMetadata(bytes: Uint8Array): Promise<PhotoVariantMetadataV1> {
  const probe = probePhotoSourceV1(bytes);
  if (probe.type !== 'image/webp') throw new PhotoWriteErrorV1('invalid');
  return metadata(bytes, probe.width, probe.height);
}
/** Save recalculates from the original browser-prepared input, never preview output. */
export class PhotoEditServiceV1 {
  constructor(private readonly options: PhotoEditServiceOptionsV1) {}
  private async authorize(context: PhotoWriteContextV1, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await this.options.authorize(context); signal.throwIfAborted();
  }
  async preview(contextInput: PhotoWriteContextV1, commandInput: PhotoWriteCommandV1,
    qualitiesInput: unknown, input: PhotoWriteInputV1, signal: AbortSignal): Promise<PhotoPreviewResultV1> {
    const context = photoWriteContextV1.parse(contextInput), command = photoWriteCommandV1.parse(commandInput);
    const qualities = photoQualitiesV1.parse(qualitiesInput);
    if (command.kind === 'remove') throw new PhotoWriteErrorV1('invalid');
    assertPhotoQualitiesV1(command, qualities); signal.throwIfAborted();
    const copies = snapshot(command, input), images = empty();
    const source: PhotoWritePlanV1 = { portrait: null, avatar: null }, output: PhotoWritePlanV1 = { portrait: null, avatar: null };
    try {
      await this.authorize(context, signal); await this.options.guard.assertInitialized(context);
      for (const variant of variants) {
        const bytes = copies[variant], quality = qualities[variant]; if (!bytes || quality === null) continue;
        source[variant] = await sourceMetadata(bytes); signal.throwIfAborted();
        const value = await this.options.codec.normalize(bytes, variant, quality, signal);
        try {
          signal.throwIfAborted(); assertBudget(value.bytes, variant);
          output[variant] = await metadata(value.bytes, value.width, value.height); images[variant] = new Uint8Array(value.bytes);
        } finally { value.bytes.fill(0); }
      }
      const approval = photoPreviewApprovalV1.parse({ version: 1, codec: 'student-webp-1.6.0-v1',context,command,qualities,source,output });
      await this.authorize(context, signal); return { approval, images };
    } catch (error) { clear(images); throw error; } finally { clear(copies); }
  }
  private async normalizeApproved(bytes: Uint8Array, variant: PhotoVariantV1,
    approval: PhotoPreviewApprovalV1, signal: AbortSignal): Promise<ValidatedPhotoBytesV1> {
    const source = approval.source[variant], expected = approval.output[variant], quality = approval.qualities[variant];
    if (!source || !expected || quality === null || !samePhotoMetadataV1(await sourceMetadata(bytes), source)) throw new PhotoWriteErrorV1('conflict');
    signal.throwIfAborted();
    const value = await this.options.codec.normalize(bytes, variant, quality, signal);
    try {
      signal.throwIfAborted(); assertBudget(value.bytes, variant);
      if (!samePhotoMetadataV1(await metadata(value.bytes, value.width, value.height), expected)) throw new PhotoWriteErrorV1('conflict');
      signal.throwIfAborted(); return value;
    } catch (error) { value.bytes.fill(0); throw error; }
  }
  private transferGuard(context: PhotoWriteContextV1, command: PhotoWriteCommandV1, signal: AbortSignal) {
    return async (action: PhotoStorageActionV1): Promise<void> => {
      await this.authorize(context, signal);
      if (action.kind === 'upload') {
        if (action.context.actorId !== context.actorId || action.context.studentUid !== context.studentUid
          || action.requestId !== command.requestId) throw new PhotoWriteErrorV1('receipt-conflict');
        await this.options.guard.assertTransfer(context, command.requestId,{ kind:'upload',variant:action.variant,metadata:action.metadata });
      } else await this.options.guard.assertTransfer(context, command.requestId,{ kind:'remove',asset:action.asset });
      signal.throwIfAborted();
    };
  }
  async save(contextInput: PhotoWriteContextV1, commandInput: PhotoWriteCommandV1,
    approvalInput: unknown, input: PhotoWriteInputV1, signal: AbortSignal): Promise<PhotoWriteResultV1> {
    const context = photoWriteContextV1.parse(contextInput), command = photoWriteCommandV1.parse(commandInput);
    const approval = command.kind === 'remove' ? null : photoPreviewApprovalV1.parse(approvalInput);
    if (command.kind === 'remove' && approvalInput !== null) throw new PhotoWriteErrorV1('invalid');
    if (approval) assertPhotoPreviewContextV1(approval, context, command);
    signal.throwIfAborted(); const copies = snapshot(command, input);
    try {
      await this.authorize(context, signal); await this.options.guard.assertInitialized(context);
      const storage = this.options.storage(this.transferGuard(context, command, signal));
      const coordinator = new PhotoWriteCoordinatorV1(this.options.repository, {
        authorize: ctx => this.authorize(ctx, signal),
        validate: (bytes, variant, stageSignal) => {
          if (!approval) throw new PhotoWriteErrorV1('invalid');
          return this.normalizeApproved(bytes, variant, approval, stageSignal);
        },
        upload:data=>storage.upload(data),remove:(asset,stageSignal)=>storage.remove(asset,stageSignal),publish:this.options.publish,
      });
      return await coordinator.execute(context, command, copies, signal);
    } finally { clear(copies); }
  }
}
