import { z } from 'zod';
import { studentUidV1 } from '../../shared/student-identity/student-identity-v1';
import { photoAdminSubjectV1, type PhotoAdminSubjectV1 } from '../../shared/student-photos/admin-http-v1';
import { photoAssetsV1, photoAssetV1, photoWriteReceiptV1, PhotoWriteErrorV1,
  type PhotoAssetV1, type PhotoWriteContextV1 } from '../../shared/student-photos/write-v1';
import { photoCatalogStateV1, type PhotoCatalogStateV1 } from '../../shared/student-photos/catalog-v1';
import { PHOTO_AVATAR_BATCH_MAX_V1 } from '../../shared/student-photos/avatar-batch-v1';
import type { PhotoWriteDatabaseV1, PhotoWriteQueryV1 } from './write-repository-v1';

const legacyPhotoSnapshotV1 = z.object({
  accountId: studentUidV1,driveId: z.string().min(1),itemId: z.string().min(1),etag: z.string().nullable(),
  byteSize: z.number().int().positive().max(5242880),version: z.number().int().positive(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
}).strict();
type LegacyPhotoSnapshotV1 = z.infer<typeof legacyPhotoSnapshotV1>;
const avatarSubjectsV1 = z.array(photoAdminSubjectV1).min(1).max(PHOTO_AVATAR_BATCH_MAX_V1);
export function photoBytesFromHexV1(input: unknown): Uint8Array {
  if (typeof input !== 'string' || input.length < 40 || input.length > 262144 || !/^(?:[a-f0-9]{2})+$/u.test(input))
    throw new PhotoWriteErrorV1('invalid');
  return Uint8Array.from(input.match(/../gu)!, byte => Number.parseInt(byte,16));
}
/** Internal catalog. All public callers must have a currently verified ADM session. */
export class PhotoCatalogRepositoryV1 {
  constructor(readonly database: PhotoWriteDatabaseV1) {}
  private transaction<T>(work: (tx: PhotoWriteQueryV1) => Promise<T>) {
    return this.database.transaction(async tx => {
      // Both transaction-local limits in one round trip.
      await tx.query("SELECT set_config('lock_timeout','3s',true),set_config('statement_timeout','10s',true)");
      return work(tx);
    });
  }
  async resolve(input: PhotoAdminSubjectV1): Promise<string> {
    const subject = photoAdminSubjectV1.parse(input);
    return this.transaction(async tx => {
      const rows = await tx.query('SELECT student_photos.resolve_student_v1($1,$2::integer,$3)::text AS uid',
        [subject.source,subject.academicYear,String(subject.source === 'portal' ? subject.accountIds[0] : subject.studentIds[0])]);
      if (!rows[0]?.uid) throw new PhotoWriteErrorV1('not-found');
      return studentUidV1.parse(rows[0].uid);
    });
  }
  /** Person and avatar image of each subject, in order, in one statement: the avatar, or the
   * portrait while there is none, exactly what the single image read chooses. */
  async avatarFamilies(input: readonly PhotoAdminSubjectV1[]): Promise<({ uid: string; asset: PhotoAssetV1 | null } | null)[]> {
    const subjects = avatarSubjectsV1.parse(input);
    return this.transaction(async tx => {
      const rows = await tx.query(`SELECT x.ord,u.uid::text AS uid,f.assets
        FROM jsonb_to_recordset($1::text::jsonb) AS x(ord integer,source text,year integer,reference text)
        CROSS JOIN LATERAL (SELECT student_photos.resolve_student_v1(x.source,x.year,x.reference) AS uid) u
        LEFT JOIN student_photos.photo_family_v1 f ON f.student_uid=u.uid ORDER BY x.ord`,
        [JSON.stringify(subjects.map((subject, ord) => ({ ord, source: subject.source, year: subject.academicYear,
          reference: String(subject.source === 'portal' ? subject.accountIds[0] : subject.studentIds[0]) })))]);
      if (rows.length !== subjects.length || rows.some((row, index) => Number(row.ord) !== index))
        throw new PhotoWriteErrorV1('invalid');
      return rows.map(row => {
        if (row.uid == null) return null;
        const assets = row.assets == null ? null : photoAssetsV1.parse(row.assets);
        return { uid: studentUidV1.parse(row.uid), asset: assets ? (assets.avatar ?? assets.portrait) : null };
      });
    });
  }
  async legacy(uid: string): Promise<LegacyPhotoSnapshotV1 | null> {
    return this.transaction(async tx => {
      const rows = await tx.query('SELECT student_photos.legacy_reference_v1($1::uuid) AS data',[studentUidV1.parse(uid)]);
      return rows[0]?.data == null ? null : legacyPhotoSnapshotV1.parse(rows[0].data);
    });
  }
  async family(uid: string) {
    return this.transaction(async tx => {
      const rows = await tx.query('SELECT revision::text,pending_request::text,assets FROM student_photos.photo_family_v1 WHERE student_uid=$1::uuid',[studentUidV1.parse(uid)]);
      if (!rows[0]) return null;
      return { revision: studentUidV1.nullable().parse(rows[0].revision),
        pending: studentUidV1.nullable().parse(rows[0].pending_request), assets: photoAssetsV1.parse(rows[0].assets) };
    });
  }
  async initialize(context: PhotoWriteContextV1, legacy: LegacyPhotoSnapshotV1 | null, asset: PhotoAssetV1 | null) {
    await this.transaction(async tx => {
      await tx.query('SELECT student_photos.initialize_family_v1($1::uuid,$2::uuid,$3::text::jsonb,$4::text::jsonb)',
        [context.studentUid,context.actorId,legacy === null ? null : JSON.stringify(legacy),asset === null ? null : JSON.stringify(photoAssetV1.parse(asset))]);
    });
  }
  async publish(context: PhotoWriteContextV1, variant: 'portrait' | 'avatar', asset: PhotoAssetV1) {
    await this.transaction(async tx => {
      await tx.query('SELECT student_photos.publish_storage_asset_v1($1::uuid,$2::uuid,$3,$4::text::jsonb)',
        [context.studentUid,context.actorId,variant,JSON.stringify(photoAssetV1.parse(asset))]);
    });
  }
  async state(context: PhotoWriteContextV1): Promise<PhotoCatalogStateV1> {
    const family = await this.family(context.studentUid);
    let pending = null;
    if (family?.pending) pending = await this.transaction(async tx => {
      const rows = await tx.query('SELECT receipt FROM student_photos.write_operation_v1 WHERE request_id=$1::uuid AND student_uid=$2::uuid',
        [family.pending,context.studentUid]);
      return rows[0] ? photoWriteReceiptV1.parse(rows[0].receipt) : null;
    });
    const legacy = family ? null : await this.legacy(context.studentUid);
    const rows = await this.transaction(tx => tx.query(`SELECT EXISTS(SELECT 1 FROM student_photos.asset_delivery_v1 d
      JOIN student_photos.photo_family_v1 f USING(student_uid) WHERE d.student_uid=$1::uuid AND d.variant='portrait'
      AND d.source_asset=f.assets->'portrait' AND d.storage_path IS NOT NULL)::integer AS ready`,[context.studentUid]));
    return photoCatalogStateV1.parse({ version:1,studentUid:context.studentUid,revision:family?.revision ?? null,
      initialized:!!family,hasPortrait:family ? !!family.assets.portrait : !!legacy,hasAvatar:!!family?.assets.avatar,
      pendingRequest:family?.pending ?? null,pendingKind:pending?.kind ?? null,pendingStage:pending?.phase ?? null,
      ownPending:pending?.actorId === context.actorId,portalReady:Number(rows[0]?.ready) === 1 });
  }
}
