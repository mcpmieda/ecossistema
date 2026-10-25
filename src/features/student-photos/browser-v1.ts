import { PHOTO_AVATAR_MAX_BYTES_V1, PHOTO_SOURCE_MAX_BYTES_V1, PhotoPreparationErrorV1,
  photoGeometryV1, type CropControlsV1, type PhotoGeometryV1, type PhotoSizeV1 } from '../../../shared/student-photos/crop-v1';
import { probePhotoSourceV1, type PhotoProbeV1 } from '../../../shared/student-photos/source-probe-v1';
import { STUDENT_PHOTO_MAX_BYTES_V1 } from '../../../shared/student-photos/portrait-v1';

export interface PhotoSourceV1 extends PhotoSizeV1 { image: CanvasImageSource; src: string; dispose(): void }
export interface PhotoExportOptionsV1 { portrait: CropControlsV1; avatar: CropControlsV1; portraitWidth: 600 | 900; quality: number }
export interface PreparedPhotoV1 extends PhotoSizeV1 { blob: Blob; geometry: PhotoGeometryV1 }
export interface PhotoDraftV1 { portrait: PreparedPhotoV1; avatar: PreparedPhotoV1; quality: number }
export interface PhotoCanvasV1 {
  width: number; height: number;
  getContext(kind: '2d'): Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'drawImage' | 'imageSmoothingEnabled' | 'imageSmoothingQuality'> | null;
  toBlob(callback: BlobCallback, type: string, quality: number): void;
}
export interface PhotoBrowserV1 {
  decode(blob: Blob): Promise<ImageBitmap>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(src: string): void;
  canvas(): PhotoCanvasV1;
}
const defaultBrowser: PhotoBrowserV1 = {
  decode: blob => {
    if (typeof createImageBitmap !== 'function') throw new PhotoPreparationErrorV1('unsupported');
    return createImageBitmap(blob, { imageOrientation: 'from-image' });
  },
  createObjectURL: blob => URL.createObjectURL(blob), revokeObjectURL: src => URL.revokeObjectURL(src),
  canvas: () => document.createElement('canvas'),
};
function decodedSizeMatches(probe: PhotoProbeV1, decoded: PhotoSizeV1): boolean {
  if (decoded.width === probe.width && decoded.height === probe.height) return true;
  // PNG eXIf can rotate the native bitmap just like JPEG. Text/XMP alone does not permit a swap.
  const nativeOrientation = probe.type === 'image/jpeg' || (probe.type === 'image/png' && probe.exifMetadata === true);
  return nativeOrientation && decoded.width === probe.height && decoded.height === probe.width;
}
/** Native EXIF orientation is applied exactly once. No upload, persistence or external service. */
export async function loadPhotoSourceV1(file: Blob, signal: AbortSignal, browser: PhotoBrowserV1 = defaultBrowser): Promise<PhotoSourceV1> {
  signal.throwIfAborted();
  if (file.size > PHOTO_SOURCE_MAX_BYTES_V1) throw new PhotoPreparationErrorV1('size');
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const probe = probePhotoSourceV1(bytes);
  if (file.type && file.type.toLowerCase() !== probe.type) throw new PhotoPreparationErrorV1('format');
  const cleanType = new Blob([new Uint8Array(bytes).buffer], { type: probe.type });
  let image: ImageBitmap;
  try { image = await browser.decode(cleanType); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof PhotoPreparationErrorV1) throw error;
    throw new PhotoPreparationErrorV1('decode');
  }
  let src: string | undefined;
  try {
    signal.throwIfAborted();
    if (!decodedSizeMatches(probe, image)) throw new PhotoPreparationErrorV1('dimensions');
    src = browser.createObjectURL(cleanType);
    const preview = src;
    let disposed = false;
    return { image, src: preview, width: image.width, height: image.height,
      dispose() { if (!disposed) { disposed = true; image.close(); browser.revokeObjectURL(preview); } } };
  } catch (error) {
    image.close();
    if (src) browser.revokeObjectURL(src);
    throw error;
  }
}
function canvasBlob(canvas: PhotoCanvasV1, quality: number, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Photo preparation cancelled', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      canvas.toBlob(blob => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { abort(); return; }
        if (blob?.type !== 'image/webp') reject(new PhotoPreparationErrorV1('encode'));
        else resolve(blob);
      }, 'image/webp', quality);
    } catch { signal.removeEventListener('abort', abort); reject(new PhotoPreparationErrorV1('encode')); }
  });
}
async function exportVariant(source: PhotoSourceV1, geometry: PhotoGeometryV1, quality: number,
  limit: number, signal: AbortSignal, browser: PhotoBrowserV1): Promise<PreparedPhotoV1> {
  signal.throwIfAborted();
  const canvas = browser.canvas();
  canvas.width = geometry.output.width; canvas.height = geometry.output.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new PhotoPreparationErrorV1('unsupported');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    const crop = geometry.crop;
    context.drawImage(source.image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, quality, signal);
    if (blob.size > limit) throw new PhotoPreparationErrorV1('budget');
    const encoded = probePhotoSourceV1(new Uint8Array(await blob.arrayBuffer()));
    signal.throwIfAborted();
    if (encoded.type !== 'image/webp' || encoded.width !== canvas.width || encoded.height !== canvas.height || encoded.privateMetadata)
      throw new PhotoPreparationErrorV1('encode');
    return { ...geometry.output, blob, geometry };
  } finally { canvas.width = 0; canvas.height = 0; }
}
/** The avatar alone, for a portrait already saved; the same checks as the two-variant draft. */
export async function prepareAvatarDraftV1(source: PhotoSourceV1, controls: CropControlsV1, quality: number,
  signal: AbortSignal, browser: PhotoBrowserV1 = defaultBrowser): Promise<PreparedPhotoV1> {
  if (![0.92, 0.86, 0.8].includes(quality)) throw new PhotoPreparationErrorV1('encode');
  const avatar = await exportVariant(source, photoGeometryV1(source, controls, 'avatar'), quality,
    PHOTO_AVATAR_MAX_BYTES_V1, signal, browser);
  signal.throwIfAborted();
  return avatar;
}
/** Generates two drafts; success is NOT a server save or authorization for Portal publication. */
export async function preparePhotoDraftV1(source: PhotoSourceV1, options: PhotoExportOptionsV1,
  signal: AbortSignal, browser: PhotoBrowserV1 = defaultBrowser): Promise<PhotoDraftV1> {
  if (![0.92, 0.86, 0.8].includes(options.quality)) throw new PhotoPreparationErrorV1('encode');
  const portraitGeometry = photoGeometryV1(source, options.portrait, 'portrait', options.portraitWidth);
  const avatarGeometry = photoGeometryV1(source, options.avatar, 'avatar');
  const portrait = await exportVariant(source, portraitGeometry, options.quality, STUDENT_PHOTO_MAX_BYTES_V1, signal, browser);
  const avatar = await exportVariant(source, avatarGeometry, options.quality, PHOTO_AVATAR_MAX_BYTES_V1, signal, browser);
  signal.throwIfAborted();
  return { portrait, avatar, quality: options.quality };
}
