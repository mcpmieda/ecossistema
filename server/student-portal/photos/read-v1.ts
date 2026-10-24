import { createHash } from 'node:crypto';
import type { CryptoPortV1 } from '../../../shared/student-portal-contracts/ports-v1';
import { portalIdV1 } from '../../../shared/student-portal-contracts/core-v1';
import { portraitMetadataV1, photoRevisionV1, STUDENT_PHOTO_MAX_BYTES_V1,
  type PortraitMetadataV1 } from '../../../shared/student-photos/portrait-v1';
import { SessionServiceV1 } from '../auth/session-service-v1';
import type { StudentPortalPostgresQueryV1, StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';

export type PortraitReadV1 = { state: 'absent' }
  | { state: 'metadata'; metadata: PortraitMetadataV1 }
  | { state: 'content'; metadata: PortraitMetadataV1; bytes: Uint8Array };
export type PortraitStorageObjectV1 = { path: string; byteSize: number; sha256: string; width: number; height: number };
export type PortraitStorageReaderV1 = (object: PortraitStorageObjectV1) => Promise<Uint8Array>;

/** Integrity check for an already approved delivery, NOT a decoder or upload validator.
 * The administrative publisher must decode, re-encode and strip metadata before approval.
 */
export function storedPortraitBytesV1(value: unknown, checksum: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 20 || value.byteLength > STUDENT_PHOTO_MAX_BYTES_V1
    || typeof checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(checksum))
    throw new Error('student-photo-content-invalid');
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const tag = (offset: number) => String.fromCodePoint(...value.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== value.byteLength
    || !['VP8 ', 'VP8L', 'VP8X'].includes(tag(12))
    || createHash('sha256').update(value).digest('hex') !== checksum)
    throw new Error('student-photo-content-invalid');
  return new Uint8Array(value);
}

/** Internal only. The caller must already hold an authorized session snapshot.
 * Resolve the permanent UID from the actual account; never assume account.id == student_uid.
 */
export async function readPublishedPortraitV1(tx: StudentPortalPostgresQueryV1,
  accountId: string, revision: string | null, storageRead?: PortraitStorageReaderV1): Promise<PortraitReadV1> {
  const account = portalIdV1.parse(accountId).toLowerCase();
  const expected = revision === null ? null : photoRevisionV1.parse(revision);
  const rows = await tx.unsafe(`SELECT p.revision::text,p.width,p.height
    ${expected === null ? '' : ',p.storage_path,p.byte_size,p.portrait_sha256'}
    FROM student_portal.account a
    JOIN student_photos.portal_delivery_v1 p ON p.student_uid=a.student_uid
    WHERE a.id=$1::uuid AND p.image_use_authorized AND p.approved_at IS NOT NULL
      AND p.authorized_at <= statement_timestamp() AND p.approved_at <= statement_timestamp()
      AND p.approved_source_revision=p.source_revision AND p.revoked_at IS NULL
      AND p.storage_path IS NOT NULL ${expected === null ? '' : 'AND p.revision=$2::uuid'}
    LIMIT 2`, expected === null ? [account] : [account, expected]);
  if (rows.length === 0) return { state: 'absent' };
  if (rows.length !== 1) throw new Error('student-photo-identity-ambiguous');
  const row = rows[0]!;
  const metadata = portraitMetadataV1.parse({ contractVersion: 1, accountId: account,
    revision: row.revision, width: Number(row.width), height: Number(row.height) });
  if (expected === null) return { state: 'metadata', metadata };
  if (metadata.revision !== expected) throw new Error('student-photo-revision-mismatch');
  if (!storageRead || typeof row.storage_path !== 'string' || typeof row.portrait_sha256 !== 'string')
    throw new Error('student-photo-storage-unavailable');
  const bytes = await storageRead({ path: row.storage_path, byteSize: Number(row.byte_size),
    sha256: row.portrait_sha256, width: metadata.width, height: metadata.height });
  return { state: 'content', metadata, bytes: storedPortraitBytesV1(bytes, row.portrait_sha256) };
}

/** Fresh accessEnabled/calendar/block/security-version/session checks share the data snapshot. */
export async function readOwnPortraitV1(sql: StudentPortalPostgresSqlV1, cryptoPort: CryptoPortV1,
  token: string, revision: string | null, storageRead?: PortraitStorageReaderV1,
  onVerifiedAccount?: (accountId: string) => Promise<void>): Promise<PortraitReadV1 | null> {
  return new SessionServiceV1(sql, cryptoPort, undefined, true, onVerifiedAccount).withAuthorized(token,
    (context, tx) => readPublishedPortraitV1(tx, context.account.id, revision, storageRead));
}
