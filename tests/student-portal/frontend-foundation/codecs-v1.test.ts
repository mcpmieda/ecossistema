// @vitest-environment node
import { expect, it } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PDFDocument } from 'pdf-lib';

it('round-trips a synthetic Portal QR with the installed generator and local image decoder', () => {
  const value = `https://aluno.escolaieda.com/access#v1.${'a'.repeat(43)}.1.${'b'.repeat(43)}`;
  const code = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const scale = 6;
  const width = (code.modules.size + 8) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < code.modules.size; y += 1) {
    for (let x = 0; x < code.modules.size; x += 1) {
      if (!code.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy += 1)
        for (let dx = 0; dx < scale; dx += 1) {
          const index = (((y + 4) * scale + dy) * width + (x + 4) * scale + dx) * 4;
          pixels[index] = 0;
          pixels[index + 1] = 0;
          pixels[index + 2] = 0;
        }
    }
  }
  expect(jsQR(pixels, width, width)?.data).toBe(value);
});

it('creates a local PDF using the installed library without a network renderer', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595.28, 841.89]).drawText('SYNTHETIC CODEC PROOF');
  const bytes = await pdf.save();
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
});
