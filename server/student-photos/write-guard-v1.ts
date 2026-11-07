import { z } from 'zod';
import {
  photoAssetV1, photoAssetsV1, photoAssetKeyV1, photoVariantMetadataV1,
  photoWriteContextV1, photoWriteCommandV1, photoWriteReceiptV1, assertPhotoWritePlanV1,
  PhotoWriteErrorV1, type PhotoWriteContextV1,
} from '../../shared/student-photos/write-v1';
import { samePhotoMetadataV1 } from '../../shared/student-photos/preview-v1';
import type { PhotoWriteDatabaseV1, PhotoWriteQueryV1 } from './write-repository-v1';

const transferSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), variant: z.enum(['portrait', 'avatar']), metadata: photoVariantMetadataV1 }).strict(),
  z.object({ kind: z.literal('remove'), asset: photoAssetV1 }).strict(),
]);
type PhotoGuardTransferV1 = z.infer<typeof transferSchema>;

/** Read-only authorization evidence. The administrative permission check remains
 * mandatory and separate. No locks or database transaction are held during remote I/O. */
export class PhotoWriteGuardV1 {
  constructor(private readonly database: PhotoWriteDatabaseV1) {}

  private read<T>(work: (tx: PhotoWriteQueryV1) => Promise<T>): Promise<T> {
    return this.database.transaction(async tx => {
      await tx.query('SET LOCAL transaction_read_only=on');
      await tx.query("SET LOCAL statement_timeout='1500ms'");
      await tx.query("SET LOCAL lock_timeout='250ms'");
      return work(tx);
    });
  }

  /** Missing state is NOT an empty family. Legacy adoption or confirmed absence
   * must initialize the person through its own authorized workflow before editing. */
  async assertInitialized(contextInput: PhotoWriteContextV1): Promise<void> {
    const context = photoWriteContextV1.parse(contextInput);
    await this.read(async tx => {
      const rows = await tx.query('SELECT assets FROM student_photos.photo_family_v1 WHERE student_uid=$1::uuid', [context.studentUid]);
      if (rows.length !== 1) throw new PhotoWriteErrorV1('not-found');
      photoAssetsV1.parse(rows[0]!.assets);
    });
  }

  async assertTransfer(contextInput: PhotoWriteContextV1, requestIdInput: string,
    actionInput: PhotoGuardTransferV1): Promise<void> {
    const context = photoWriteContextV1.parse(contextInput);
    const requestId = photoWriteCommandV1.shape.requestId.parse(requestIdInput);
    const action = transferSchema.parse(actionInput);
    await this.read(async tx => {
      const rows = await tx.query(`SELECT f.revision::text,f.pending_request::text,f.assets,o.receipt
        FROM student_photos.photo_family_v1 f
        JOIN student_photos.write_operation_v1 o ON o.student_uid=f.student_uid
        WHERE f.student_uid=$1::uuid AND o.request_id=$2::uuid`, [context.studentUid, requestId]);
      if (rows.length !== 1) throw new PhotoWriteErrorV1('not-found');
      const row = rows[0]!, receipt = photoWriteReceiptV1.parse(row.receipt);
      const current = photoAssetsV1.parse(row.assets);
      const revision = photoWriteCommandV1.shape.expectedRevision.parse(row.revision);
      const pending = photoWriteCommandV1.shape.expectedRevision.parse(row.pending_request);
      if (receipt.actorId !== context.actorId || receipt.studentUid !== context.studentUid || receipt.requestId !== requestId)
        throw new PhotoWriteErrorV1('receipt-conflict');
      if (pending !== requestId) throw new PhotoWriteErrorV1('conflict');
      assertPhotoWritePlanV1(receipt, receipt.plan);
      if (action.kind === 'upload') {
        const wanted = receipt.plan[action.variant];
        if (receipt.phase !== 'prepared' || revision !== receipt.expectedRevision || !wanted
          || !samePhotoMetadataV1(wanted, action.metadata)) throw new PhotoWriteErrorV1('conflict');
      } else {
        const key = photoAssetKeyV1(action.asset);
        const retired = receipt.cleanup.find(item => photoAssetKeyV1(item) === key);
        if (receipt.phase !== 'committed' || revision !== requestId || !retired
          || retired.etag !== action.asset.etag || !samePhotoMetadataV1(retired, action.asset)
          || Object.values(current).some(item => item !== null && photoAssetKeyV1(item) === key))
          throw new PhotoWriteErrorV1('conflict');
      }
    });
  }
}
