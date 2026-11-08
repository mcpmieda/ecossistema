import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BULLETIN_PDF_LIMITS_V1,
  BulletinPdfRendererErrorV1,
  assembleBulletinRasterPdfV1,
} from '../../../src/features/gradebook/bulletins/pdf/bulletin-pdf-engine';

const engineSource = () =>
  readFileSync(join(process.cwd(), 'src/features/gradebook/bulletins/pdf/bulletin-pdf-engine.ts'), 'utf8');
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe('Boletins PDF engine', () => {
  it('uses the bundled Geist font, never a remote or system font', () => {
    const source = engineSource();
    expect(source).toContain("const PDF_FONT_FAMILY = 'Geist Variable'");
    expect(source).toContain('document.fonts.load');
    expect(source).not.toContain('http://');
    expect(source).not.toContain('https://');
  });

  it('builds a raster PDF envelope without hidden metadata', () => {
    const page = { jpeg: jpeg(), widthPixels: 1191, heightPixels: 1684 };
    const binary = Buffer.from(assembleBulletinRasterPdfV1([page, page])).toString('latin1');
    expect(binary.startsWith('%PDF-1.4')).toBe(true);
    expect(binary).toContain('/Type /Catalog');
    expect(binary).toContain('/Count 2');
    expect(binary).toContain('/DCTDecode');
    expect(binary.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(binary).not.toContain('/Info');
  });

  it('refuses more pages than the limit', () => {
    expect(() =>
      assembleBulletinRasterPdfV1(
        Array.from({ length: BULLETIN_PDF_LIMITS_V1.maxPages + 1 }, () => ({
          jpeg: jpeg(),
          widthPixels: 1191,
          heightPixels: 1684,
        })),
      ),
    ).toThrowError(BulletinPdfRendererErrorV1);
  });

  it('holds no academic rule, HTTP read or browser storage', () => {
    const source = engineSource();
    for (const forbidden of ['maximum *', 'fetch(', '/api/gradebook/', 'localStorage', 'sessionStorage', 'indexedDB', 'caches.open']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
