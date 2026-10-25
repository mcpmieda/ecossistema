import { assertPhotoSizeV1, PHOTO_SOURCE_MAX_BYTES_V1, PhotoPreparationErrorV1, type PhotoSizeV1 } from './crop-v1';
export interface PhotoProbeV1 extends PhotoSizeV1 {
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  privateMetadata: boolean;
  /** Presence only; the native decoder, not this header probe, interprets EXIF orientation. */
  exifMetadata?: boolean;
}
const invalid = (): never => { throw new PhotoPreparationErrorV1('format'); };
const tag = (bytes: Uint8Array, offset: number) => String.fromCodePoint(...bytes.subarray(offset, offset + 4));
const uint24 = (bytes: Uint8Array, offset: number) => bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536;
function webpCanvas(bytes: Uint8Array, body: number, length: number, offset: number, previous?: PhotoSizeV1): PhotoSizeV1 {
  if (previous || offset !== 12 || length !== 10 || (bytes[body]! & 2)) return invalid();
  return { width: uint24(bytes, body + 4) + 1, height: uint24(bytes, body + 7) + 1 };
}
function webpPixels(bytes: Uint8Array, view: DataView, kind: string, body: number, length: number): PhotoSizeV1 {
  if (kind === 'VP8 ') {
    if (length < 10 || bytes[body + 3] !== 0x9d || bytes[body + 4] !== 1 || bytes[body + 5] !== 0x2a) return invalid();
    return { width: view.getUint16(body + 6, true) & 0x3fff, height: view.getUint16(body + 8, true) & 0x3fff };
  }
  if (length < 5 || bytes[body] !== 0x2f) return invalid();
  const bits = view.getUint32(body + 1, true);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}
function webp(bytes: Uint8Array, view: DataView): PhotoProbeV1 {
  if (view.getUint32(4, true) + 8 !== bytes.length) return invalid();
  let canvas: PhotoSizeV1 | undefined, pixels: PhotoSizeV1 | undefined, privateMetadata = false;
  let offset = 12, count = 0;
  while (offset + 8 <= bytes.length && ++count <= 1024) {
    const kind = tag(bytes, offset), length = view.getUint32(offset + 4, true), body = offset + 8;
    const end = body + length + (length % 2);
    if (end > bytes.length || kind === 'ANIM' || kind === 'ANMF') return invalid();
    privateMetadata ||= kind === 'EXIF' || kind === 'XMP ';
    if (kind === 'VP8X') canvas = webpCanvas(bytes, body, length, offset, canvas);
    if (kind === 'VP8 ' || kind === 'VP8L') {
      if (pixels) return invalid();
      pixels = webpPixels(bytes, view, kind, body, length);
    }
    offset = end;
  }
  if (!pixels || offset !== bytes.length || (canvas && (canvas.width !== pixels.width || canvas.height !== pixels.height))) return invalid();
  return { ...pixels, type: 'image/webp', privateMetadata };
}
function png(bytes: Uint8Array, view: DataView): PhotoProbeV1 {
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a
    || view.getUint32(8) !== 13 || tag(bytes, 12) !== 'IHDR') return invalid();
  const result: PhotoProbeV1 = { width: view.getUint32(16), height: view.getUint32(20), type: 'image/png', privateMetadata: false };
  let offset = 8, count = 0;
  while (offset + 12 <= bytes.length && ++count <= 8192) {
    const length = view.getUint32(offset), kind = tag(bytes, offset + 4);
    const end = offset + 12 + length;
    if (end > bytes.length || kind === 'acTL') return invalid();
    if (['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(kind)) result.privateMetadata = true;
    if (kind === 'eXIf') result.exifMetadata = true;
    offset = end;
    if (kind === 'IEND') {
      if (length !== 0 || offset !== bytes.length) return invalid();
      return result;
    }
  }
  return invalid();
}
/** One JPEG segment after its marker: the frame header gives the size; any other segment is
 * skipped by its length (returned); an end, scan or truncated segment is invalid. */
function jpegSegmentV1(bytes: Uint8Array, view: DataView, marker: number | undefined, offset: number): PhotoProbeV1 | number {
  if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return invalid();
  const length = view.getUint16(offset);
  if (length < 2 || offset + length > bytes.length) return invalid();
  if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
    if (length < 8) return invalid();
    return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3), type: 'image/jpeg', privateMetadata: true };
  }
  return length;
}
function jpeg(bytes: Uint8Array, view: DataView): PhotoProbeV1 {
  let offset = 2, count = 0, fillBytes = 0;
  while (offset + 4 <= bytes.length && ++count <= 8192) {
    if (bytes[offset++] !== 0xff) return invalid();
    while (bytes[offset] === 0xff) {
      if (++fillBytes > 8192) return invalid();
      offset++;
    }
    const segment = jpegSegmentV1(bytes, view, bytes[offset++], offset);
    if (typeof segment !== 'number') return segment;
    offset += segment;
  }
  return invalid();
}
/** Bounded header preflight only. A real decoder is still mandatory, especially for server uploads. */
export function probePhotoSourceV1(bytes: Uint8Array): PhotoProbeV1 {
  if (bytes.length > PHOTO_SOURCE_MAX_BYTES_V1) throw new PhotoPreparationErrorV1('size');
  if (bytes.length < 20) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let result: PhotoProbeV1;
  if (tag(bytes, 0) === 'RIFF' && tag(bytes, 8) === 'WEBP') result = webp(bytes, view);
  else if (bytes[0] === 0x89) result = png(bytes, view);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) result = jpeg(bytes, view);
  else return invalid();
  assertPhotoSizeV1(result);
  return result;
}
