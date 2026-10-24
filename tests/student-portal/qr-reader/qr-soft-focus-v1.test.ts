// @vitest-environment node
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { qrSvgV1 } from '../../../src/features/student-portal-admin/credentials/qr-artifacts-v1';
import {
  decodeQrPixelsV1,
  sharpenQrPixelsV1,
} from '../../../src/features/student-portal/auth/qr-pixels-v1';

// Invented, unsigned credential-shaped payload: the size of a real printed card's QR.
const qr = `https://aluno.escolaieda.com/access#v1.${'Ab3_'.repeat(10)}Ab3.1.${'Zx9-'.repeat(10)}Zx9`;

/** A 1080p centre crop of a printed card held where the lens can focus, slightly soft. */
async function softFrame(qrPixels: number, blur: number) {
  const side = 810;
  const code = await sharp(Buffer.from(qrSvgV1(qr)))
    .resize(qrPixels, qrPixels)
    .png()
    .toBuffer();
  const framed = await sharp({
    create: { width: side, height: side, channels: 3, background: '#9aa4b0' },
  })
    .composite([{ input: code, left: (side - qrPixels) >> 1, top: (side - qrPixels) >> 1 }])
    .png()
    .toBuffer();
  const { data } = await sharp(framed)
    .blur(blur)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { pixels: new Uint8ClampedArray(data), side };
}

describe('soft-focus camera frames', () => {
  it('reads a slightly blurred printed QR only after sharpening', async () => {
    const { pixels, side } = await softFrame(160, 1.5);
    expect(decodeQrPixelsV1(pixels, side, side)).toEqual([]);
    expect(decodeQrPixelsV1(sharpenQrPixelsV1(pixels, side, side), side, side)).toEqual([qr]);
  });

  it('keeps sharp frames readable and leaves the input untouched', async () => {
    const { pixels, side } = await softFrame(220, 0.5);
    const before = pixels.slice();
    expect(decodeQrPixelsV1(sharpenQrPixelsV1(pixels, side, side), side, side)).toEqual([qr]);
    expect(pixels).toEqual(before);
    // A 220 px frame decoded twice: under a full parallel suite it can pass 20 s (24/10/2026).
  }, 60_000);
});
