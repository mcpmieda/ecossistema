import type { PhotoAdminSubjectV1 } from '../../shared/student-photos/admin-http-v1';
import type { PhotoAvatarBatchItemV1 } from '../../shared/student-photos/avatar-batch-v1';
import type { PhotoAssetV1 } from '../../shared/student-photos/write-v1';

/** The canonical person a subject points to and the image an avatar read shows for it. */
export interface AvatarBatchFamilyV1 {
  uid: string;
  asset: PhotoAssetV1 | null;
}
interface AvatarBatchPortsV1 {
  /** Fresh session and capability check; throws when access is no longer allowed. */
  authorize(): Promise<void>;
  /** One entry per subject, in order; null when the reference resolves to nobody. */
  families(subjects: readonly PhotoAdminSubjectV1[]): Promise<(AvatarBatchFamilyV1 | null)[]>;
  read(asset: PhotoAssetV1, signal: AbortSignal): Promise<Uint8Array>;
}
const sameFamilyV1 = (left: AvatarBatchFamilyV1 | null, right: AvatarBatchFamilyV1 | null) =>
  left !== null &&
  right !== null &&
  left.uid === right.uid &&
  left.asset?.itemId === right.asset?.itemId &&
  left.asset?.sha256 === right.asset?.sha256;

/**
 * The single image read for several students at once: access is checked before the catalog and
 * again after Storage, and an image is returned only for a student whose reference and current
 * photo did not change in between. One student's Storage failure never fails the others.
 */
export async function readAvatarBatchV1(
  subjects: readonly PhotoAdminSubjectV1[],
  ports: AvatarBatchPortsV1,
  signal: AbortSignal,
): Promise<PhotoAvatarBatchItemV1[]> {
  signal.throwIfAborted();
  await ports.authorize();
  signal.throwIfAborted();
  const before = await ports.families(subjects);
  if (before.length !== subjects.length) throw new Error('student-photo-batch-invalid');
  const images = await Promise.all(
    before.map(async (family): Promise<PhotoAvatarBatchItemV1> => {
      if (!family?.asset) return null;
      try {
        return await ports.read(family.asset, signal);
      } catch {
        return 'unavailable';
      }
    }),
  );
  const clear = () => {
    for (const image of images) if (image instanceof Uint8Array) image.fill(0);
  };
  try {
    signal.throwIfAborted();
    await ports.authorize();
    const after = await ports.families(subjects);
    signal.throwIfAborted();
    return images.map((image, index) => {
      if (!(image instanceof Uint8Array) || sameFamilyV1(before[index]!, after[index] ?? null))
        return image;
      image.fill(0);
      return 'unavailable';
    });
  } catch (error) {
    clear();
    throw error;
  }
}
