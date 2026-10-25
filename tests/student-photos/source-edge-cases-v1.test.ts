// @vitest-environment node
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { probePhotoSourceV1 } from '../../shared/student-photos/source-probe-v1';
import { initialPhotoCropV1, photoGeometryV1 } from '../../shared/student-photos/crop-v1';
import { loadPhotoSourceV1, type PhotoBrowserV1 } from '../../src/features/student-photos/browser-v1';

// Generated 60x80 RGB quadrants with EXIF orientation 6; no person or production data.
// The same fixture's Blob URL and createImageBitmap were checked in real Chromium.
const orientedPng = () => new Uint8Array(Buffer.from([
  'iVBORw0KGgoAAAANSUhEUgAAADwAAABQCAIAAADKqIEEAAAAGmVYSWZNTQAqAAAA',
  'CAABARIAAwAAAAEABgAAAAAAANZnS2kAAACOSURBVHic7dCxDYIAFEVRJFbU1tSM',
  'QO2QDOFCNg7jFP8kJPcM8HLzHr/9WGa8r21oeR3aHVW0UrRStFK0UrRStFK0UrRS',
  'tFK0UrRStFK0UrRStFK0UrRStFK08jxfn6Hp734OLd/y6aKVopWilaKVopWilaKV',
  'opWilaKVopWilaKVopWilaKVopWilaKVP9juBMljzAkBAAAAAElFTkSuQmCC',
].join(''), 'base64'));
const sourceBlob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes).buffer], { type: 'image/png' });
function browserFor(width: number, height: number) {
  const close = vi.fn(), create = vi.fn(() => 'blob:synthetic-oriented-png'), revoke = vi.fn();
  const bitmap = { width, height, close } as unknown as ImageBitmap;
  const browser: PhotoBrowserV1 = { decode: async () => bitmap, createObjectURL: create, revokeObjectURL: revoke,
    canvas() { throw new Error('This test exercises loading and geometry, not canvas rendering'); } };
  return { browser, close, create, revoke };
}
it('accepts native EXIF-swapped PNG dimensions and uses the oriented size for both crop previews', async () => {
  const bytes = orientedPng();
  expect(bytes).toHaveLength(237);
  expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width: 60, height: 80, orientation: 6 });
  expect(probePhotoSourceV1(bytes)).toMatchObject({ width: 60, height: 80, exifMetadata: true, privateMetadata: true });
  const test = browserFor(80, 60);
  const source = await loadPhotoSourceV1(sourceBlob(bytes), new AbortController().signal, test.browser);
  expect(source).toMatchObject({ width: 80, height: 60, src: 'blob:synthetic-oriented-png' });
  expect(photoGeometryV1(source, initialPhotoCropV1('portrait'), 'portrait').output).toEqual({ width: 45, height: 60 });
  expect(photoGeometryV1(source, initialPhotoCropV1('avatar'), 'avatar').output).toEqual({ width: 60, height: 60 });
  source.dispose(); expect(test.close).toHaveBeenCalledOnce(); expect(test.revoke).toHaveBeenCalledOnce();
});
it('keeps unrotated PNG support and rejects non-EXIF or unrelated dimension changes', async () => {
  const plain = new Uint8Array(await sharp(orientedPng()).png().toBuffer());
  expect(probePhotoSourceV1(plain).exifMetadata).not.toBe(true);
  const normal = browserFor(60, 80);
  const source = await loadPhotoSourceV1(sourceBlob(plain), new AbortController().signal, normal.browser);
  source.dispose();
  for (const [bytes, width, height] of [[plain, 80, 60], [orientedPng(), 81, 60], [orientedPng(), 80, 61]] as const) {
    const test = browserFor(width, height);
    await expect(loadPhotoSourceV1(sourceBlob(bytes), new AbortController().signal, test.browser)).rejects.toThrow('student-photo-dimensions');
    expect(test.close).toHaveBeenCalledOnce(); expect(test.create).not.toHaveBeenCalled();
  }
});
it('bounds JPEG markers without rejecting a normal image or a bounded metadata sequence', async () => {
  const jpeg = new Uint8Array(await sharp(orientedPng()).jpeg().toBuffer());
  const withMarkers = (count: number) => {
    const bytes = new Uint8Array(jpeg.length + count * 4); bytes.set(jpeg.subarray(0, 2));
    for (let index = 0; index < count; index++) bytes.set([0xff, 0xfe, 0, 2], 2 + index * 4);
    bytes.set(jpeg.subarray(2), 2 + count * 4); return bytes;
  };
  expect(probePhotoSourceV1(jpeg)).toMatchObject({ width: 60, height: 80 });
  expect(probePhotoSourceV1(withMarkers(100))).toMatchObject({ width: 60, height: 80 });
  expect(() => probePhotoSourceV1(withMarkers(8192))).toThrow('student-photo-format');
});
it('also bounds JPEG fill bytes instead of merely moving excessive scanning into the inner loop', async () => {
  const jpeg = new Uint8Array(await sharp(orientedPng()).jpeg().toBuffer());
  const withFill = (count: number) => {
    const bytes = new Uint8Array(jpeg.length + count); bytes.set(jpeg.subarray(0, 2));
    bytes.fill(0xff, 2, 2 + count); bytes.set(jpeg.subarray(2), 2 + count); return bytes;
  };
  expect(probePhotoSourceV1(withFill(100))).toMatchObject({ width: 60, height: 80 });
  expect(() => probePhotoSourceV1(withFill(8193))).toThrow('student-photo-format');
});
