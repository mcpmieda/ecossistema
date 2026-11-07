export const PHOTO_SOURCE_MAX_BYTES_V1 = 12 * 1024 * 1024;
const PHOTO_SOURCE_MAX_PIXELS_V1 = 24_000_000;
export const PHOTO_AVATAR_MAX_BYTES_V1 = 64 * 1024;
export type PhotoKindV1 = 'portrait' | 'avatar';
export interface PhotoSizeV1 { width: number; height: number }
export interface CropControlsV1 { x: number; y: number; zoom: number }
export interface PhotoCropV1 extends PhotoSizeV1 { x: number; y: number }
export interface PhotoGeometryV1 { crop: PhotoCropV1; output: PhotoSizeV1 }
type PhotoPreparationCodeV1 = 'format' | 'size' | 'dimensions' | 'decode' | 'encode' | 'budget' | 'unsupported';
export class PhotoPreparationErrorV1 extends Error {
  constructor(readonly code: PhotoPreparationCodeV1) { super('student-photo-' + code); }
}
export function assertPhotoSizeV1(size: PhotoSizeV1): void {
  if (![size.width, size.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192)
    || size.width * size.height > PHOTO_SOURCE_MAX_PIXELS_V1)
    throw new PhotoPreparationErrorV1('dimensions');
}
export function initialPhotoCropV1(kind: PhotoKindV1): CropControlsV1 {
  return { x: 0.5, y: kind === 'portrait' ? 0 : 0.16, zoom: 1 };
}
/** Coordinates describe the available travel, not CSS object-position or a face detector. */
export function photoGeometryV1(size: PhotoSizeV1, controls: CropControlsV1,
  kind: PhotoKindV1, portraitWidth: 600 | 900 = 900): PhotoGeometryV1 {
  assertPhotoSizeV1(size);
  if (![controls.x, controls.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    || !Number.isFinite(controls.zoom) || controls.zoom < 1 || controls.zoom > 4
    || ![600, 900].includes(portraitWidth)) throw new PhotoPreparationErrorV1('dimensions');
  const ratio = kind === 'portrait' ? 3 / 4 : 1;
  const width = Math.min(size.width, size.height * ratio) / controls.zoom;
  const height = width / ratio;
  const crop = { x: (size.width - width) * controls.x, y: (size.height - height) * controls.y, width, height };
  // Integer multiples preserve the exact aspect ratio without ever enlarging the selected crop.
  const unit = kind === 'portrait' ? Math.floor(Math.min(width / 3, height / 4, portraitWidth / 3))
    : Math.floor(Math.min(width, height, 320));
  if (unit < 1) throw new PhotoPreparationErrorV1('dimensions');
  return { crop, output: kind === 'portrait' ? { width: unit * 3, height: unit * 4 } : { width: unit, height: unit } };
}
/** Stable fallback across rerenders; use the permanent UID, never the student's name. */
export function photoFallbackHueV1(identityKey: string): number {
  let hash = 2166136261;
  for (const character of identityKey.toLowerCase()) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return (hash >>> 0) % 360;
}
