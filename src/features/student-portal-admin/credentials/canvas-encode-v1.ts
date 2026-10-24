import { QrArtifactErrorV1 } from './qr-values-v1';

/** Synchronous canvas encoding for QR artifacts.
 * In the admin app, Chromium delivered every `toBlob` result about 1 s late while the main thread
 * was idle (measured 26/09/2026: 1000 ms for an 8 × 8 canvas, versus 13–26 ms for `toDataURL`),
 * which made batch cards wait ~2.8 s each. Encoding inline keeps the batch bound by real work.
 */
export function canvasBlobSyncV1(
  canvas: HTMLCanvasElement,
  type: 'image/png' | 'image/jpeg',
  quality?: number,
): Blob {
  const url = canvas.toDataURL(type, quality);
  const prefix = `data:${type};base64,`;
  // A browser that cannot encode the type silently returns PNG; never mislabel the bytes.
  if (!url.startsWith(prefix)) throw new QrArtifactErrorV1('render-unavailable');
  const binary = atob(url.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.codePointAt(index)!;
  return new Blob([bytes], { type });
}
