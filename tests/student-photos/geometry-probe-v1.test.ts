// @vitest-environment node
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  photoGeometryV1,
  photoFallbackHueV1,
  initialPhotoCropV1,
  PHOTO_SOURCE_MAX_BYTES_V1,
} from '../../shared/student-photos/crop-v1';
import { probePhotoSourceV1 } from '../../shared/student-photos/source-probe-v1';

const solid = () =>
  sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 31, g: 81, b: 137 } } });
describe('photo geometry without upscaling or background removal', () => {
  it('preserves exact 3x4 and square ratios inside every selected source', () => {
    for (const width of [73, 300, 901, 4000])
      for (const height of [99, 400, 1203, 5000])
        for (const kind of ['portrait', 'avatar'] as const)
          for (const zoom of [1, 1.05, 2, 4])
            for (const edge of [0, 0.5, 1]) {
              const { crop, output } = photoGeometryV1(
                { width, height },
                { x: edge, y: edge, zoom },
                kind,
              );
              expect(crop.x).toBeGreaterThanOrEqual(0);
              expect(crop.y).toBeGreaterThanOrEqual(0);
              expect(crop.x + crop.width).toBeLessThanOrEqual(width + 0.000001);
              expect(crop.y + crop.height).toBeLessThanOrEqual(height + 0.000001);
              expect(output.width).toBeLessThanOrEqual(crop.width);
              expect(output.height).toBeLessThanOrEqual(crop.height);
              expect(Number.isInteger(output.width)).toBe(true);
              expect(Number.isInteger(output.height)).toBe(true);
              expect(output.width * (kind === 'portrait' ? 4 : 1)).toBe(
                output.height * (kind === 'portrait' ? 3 : 1),
              );
            }
  });
  it('keeps a small photograph small, including zoom, and offers an explicit 600px alternative', () => {
    expect(
      photoGeometryV1({ width: 300, height: 400 }, initialPhotoCropV1('portrait'), 'portrait')
        .output,
    ).toEqual({ width: 300, height: 400 });
    expect(
      photoGeometryV1({ width: 300, height: 400 }, { x: 0, y: 1, zoom: 2 }, 'portrait').output,
    ).toEqual({ width: 150, height: 200 });
    expect(
      photoGeometryV1(
        { width: 1800, height: 2400 },
        initialPhotoCropV1('portrait'),
        'portrait',
        600,
      ).output,
    ).toEqual({ width: 600, height: 800 });
  });
  it.each([NaN, Infinity, -1, 5])(
    'rejects invalid zoom %s rather than drawing outside the source',
    (zoom) => {
      expect(() =>
        photoGeometryV1({ width: 300, height: 400 }, { x: 0.5, y: 0.5, zoom }, 'portrait'),
      ).toThrow();
    },
  );
  it('does not invent pixels for a source below the minimum ratio', () => {
    expect(() =>
      photoGeometryV1({ width: 1, height: 1 }, initialPhotoCropV1('portrait'), 'portrait'),
    ).toThrow();
  });
  it('derives stable fallback colors from the identity, independent of letter case', () => {
    expect(photoFallbackHueV1('SYNTHETIC-UID-A')).toBe(photoFallbackHueV1('synthetic-uid-a'));
    expect(photoFallbackHueV1('synthetic-uid-a')).not.toBe(photoFallbackHueV1('synthetic-uid-b'));
  });
});
describe('header preflight followed by a real decoder, not an upload validator', () => {
  it.each(['jpeg', 'png', 'webp'] as const)(
    'reads a real synthetic %s and rejects extension-only claims',
    async (format) => {
      const bytes = await solid()[format]().toBuffer();
      const probe = probePhotoSourceV1(bytes);
      expect(probe).toMatchObject({ width: 300, height: 400, type: 'image/' + format });
      expect((await sharp(bytes).metadata()).width).toBe(probe.width);
    },
  );
  it('handles VP8L and extended WebP rather than assuming every image is lossy VP8', async () => {
    for (const buffer of [
      await solid().webp({ lossless: true }).toBuffer(),
      await solid().ensureAlpha(0.5).webp().toBuffer(),
    ])
      expect(probePhotoSourceV1(buffer)).toMatchObject({
        type: 'image/webp',
        width: 300,
        height: 400,
      });
  });
  it('rejects corruption, oversized sources, SVG and decompression-bomb dimensions before decoding', async () => {
    expect(() => probePhotoSourceV1(new Uint8Array(PHOTO_SOURCE_MAX_BYTES_V1 + 1))).toThrow(
      'student-photo-size',
    );
    expect(() => probePhotoSourceV1(new TextEncoder().encode('<svg>not-a-photo</svg>'))).toThrow();
    const webp = new Uint8Array(await solid().webp().toBuffer());
    new DataView(webp.buffer).setUint32(4, 100, true);
    expect(() => probePhotoSourceV1(webp)).toThrow();
    const png = new Uint8Array(await solid().png().toBuffer());
    new DataView(png.buffer).setUint32(16, 100000);
    expect(() => probePhotoSourceV1(png)).toThrow('student-photo-dimensions');
  });
  it('detects private metadata and refuses animated WebP', async () => {
    const bytes = await solid()
      .withExif({ IFD0: { ImageDescription: 'SYNTHETIC METADATA' } })
      .webp()
      .toBuffer();
    expect(probePhotoSourceV1(bytes).privateMetadata).toBe(true);
    expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe('VP8X');
    bytes[20] = bytes[20]! | 2;
    expect(() => probePhotoSourceV1(bytes)).toThrow();
  });
});
