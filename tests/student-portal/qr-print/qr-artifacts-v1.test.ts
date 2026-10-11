// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import jsQR from 'jsqr';
import sharp from 'sharp';
import {
  qrMatrixV1,
  qrSvgV1,
  renderQrPdfV1,
  wrapQrLabelV1,
} from '../../../src/features/student-portal-admin/credentials/qr-artifacts-v1';
import {
  qrLayerPathsV1,
  qrShapePathV1,
  qrShapesV1,
} from '../../../src/features/student-portal-admin/credentials/qr-shapes-v1';
import { validatePrintCardsV1 } from '../../../src/features/student-portal-admin/credentials/qr-values-v1';
import { qrPrintCardsV1, qrPrintUrlV1 } from './fixtures-v1';

describe('private QR print artifacts', () => {
  it.each([200, 201, 300])('renders a complete %i-character report name without truncation', async (length) => {
    const name = 'W'.repeat(length);
    const [original] = qrPrintCardsV1(1, 'qr-name-class');
    const cards = validatePrintCardsV1([{ ...original, name }]);
    const card = cards[0];
    expect(card && card.mode !== 'qr-only' && card.name).toBe(name);
    expect(wrapQrLabelV1(name, 160, (text) => text.length * 9).join('')).toBe(name);
    const artifact = await renderQrPdfV1(cards, new AbortController().signal);
    expect(artifact).toMatchObject({ count: 1, pages: 1, format: 'pdf' });
    expect((await PDFDocument.load(await artifact.blob.arrayBuffer())).getPageCount()).toBe(1);
  });
  it.each(['qr-only', 'qr-name', 'qr-name-class'] as const)(
    'renders a real bounded PDF with %s and complete long labels',
    async (mode) => {
      const progress: number[] = [];
      const artifact = await renderQrPdfV1(
        qrPrintCardsV1(100, mode),
        new AbortController().signal,
        (count) => progress.push(count),
      );
      const pages = mode === 'qr-only' ? 6 : mode === 'qr-name' ? 7 : 8;
      expect(artifact).toMatchObject({ count: 100, pages, format: 'pdf' });
      expect(artifact.blob.type).toBe('application/pdf');
      const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getPageCount()).toBe(pages);
      expect(
        pdf.getPages().every((page) => page.getWidth() === 595.28 && page.getHeight() === 841.89),
      ).toBe(true);
      expect(progress).toEqual(Array.from({ length: 101 }, (_, n) => n));
      expect(new TextDecoder().decode(bytes)).not.toContain('https://aluno.escolaieda.com');
      expect(bytes.byteLength).toBeLessThan(5_000_000);
    },
    30_000,
  );
  it('decodes the same credential from a four-module quiet-zone bitmap inside a larger image', () => {
    const qr = qrPrintUrlV1(37),
      matrix = qrMatrixV1(qr),
      scale = 6,
      quiet = 4;
    const size = (matrix.size + quiet * 2) * scale,
      width = size + 220,
      height = size + 140;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let row = 0; row < matrix.size; row++)
      for (let col = 0; col < matrix.size; col++)
        if (matrix.get(row, col)) {
          for (let y = 0; y < scale; y++)
            for (let x = 0; x < scale; x++) {
              const offset =
                ((70 + (row + quiet) * scale + y) * width + 110 + (col + quiet) * scale + x) * 4;
              pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
            }
        }
    expect(jsQR(pixels, width, height)?.data).toBe(qr);
    expect([...qrMatrixV1(qr).data]).toEqual([...matrix.data]);
  });
  it.each([1, 37, 100])(
    'decodes the actual rounded SVG raster at print scale, credential %i',
    async (index) => {
      const qr = qrPrintUrlV1(index);
      const { data, info } = await sharp(Buffer.from(qrSvgV1(qr)))
        .resize(450, 450)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe(qr);
      const svg = qrSvgV1(qr);
      expect(svg).not.toContain(qr);
      expect(svg).toContain('Q');
    },
  );
  it('draws the same outline with merged row paths as with one path per module', async () => {
    const matrix = qrMatrixV1(qrPrintUrlV1(7));
    const size = matrix.size + 8;
    const svg = (paths: { path: string; dark: boolean }[]) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 12}" height="${size * 12}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="white"/>${paths
          .map(({ path, dark }) => `<path d="${path}" fill="${dark ? 'black' : 'white'}"/>`)
          .join('')}</svg>`,
      );
    const perModule = qrShapesV1(matrix).map((shape) => ({
      path: qrShapePathV1(shape),
      dark: shape.dark,
    }));
    const merged = qrLayerPathsV1(matrix);
    const [before, after] = await Promise.all(
      [perModule, merged].map((paths) => sharp(svg(paths)).greyscale().raw().toBuffer()),
    );
    let differing = 0;
    for (let index = 0; index < before!.length; index++)
      if (Math.abs(before![index]! - after![index]!) > 96) differing++;
    // Only anti-aliasing seams between formerly separate module paths may differ.
    expect(differing / before!.length).toBeLessThan(0.002);
    expect(merged.map(({ path }) => path).join('').length).toBeLessThan(
      perModule.map(({ path }) => path).join('').length * 0.9,
    );
  });
  it('rejects zero, 101, duplicate, mixed-mode and forbidden extra card fields', () => {
    const repeatedQr = qrPrintCardsV1(2);
    repeatedQr[1]!.qr = repeatedQr[0]!.qr;
    for (const cards of [
      [],
      repeatedQr,
      qrPrintCardsV1(101),
      [...qrPrintCardsV1(), ...qrPrintCardsV1()],
      [qrPrintCardsV1()[0], { ...qrPrintCardsV1(2, 'qr-only')[1] }],
      [{ ...qrPrintCardsV1()[0], pin: '0000' }],
    ])
      expect(() => validatePrintCardsV1(cards)).toThrow('invalid-cards');
    expect(() => qrMatrixV1('https://example.com/access#forged')).toThrow('invalid-cards');
  });
  it('cancels before the next card and never produces an artifact after cancellation', async () => {
    const controller = new AbortController(),
      progress: number[] = [];
    await expect(
      renderQrPdfV1(qrPrintCardsV1(100), controller.signal, (count) => {
        progress.push(count);
        if (count === 2) controller.abort();
      }),
    ).rejects.toThrow();
    expect(progress).toEqual([0, 1, 2]);
  });
  it('wraps whole names, unbroken words and graphemes without truncation', () => {
    const name = 'ÁLVARES ' + 'W'.repeat(200);
    const lines = wrapQrLabelV1(name, 24, (s) => Array.from(s).length);
    expect(lines.every((line) => line.length <= 24)).toBe(true);
    expect(lines.join('').replaceAll(' ', '')).toBe(name.replaceAll(' ', ''));
    expect(
      wrapQrLabelV1(
        'Á李',
        1,
        (s) => [...new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(s)].length,
      ),
    ).toEqual(['Á', '李']);
  });
});
