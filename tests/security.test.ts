// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedBytes,
  readBoundedJson,
  SECURITY_HEADERS,
  withSecurityHeaders,
} from '../server/http/security';
import { testEnv } from './fixtures';

describe('HTTP security', () => {
  it('accepts the official production origin', () =>
    expect(() =>
      enforceOfficialOrigin(new Request(`${testEnv.OFFICIAL_ORIGIN}/api/health`), testEnv),
    ).not.toThrow());
  it('rejects pages.dev for production API', () =>
    expect(() =>
      enforceOfficialOrigin(
        new Request('https://ecossistema-escola.pages.dev/api/health'),
        testEnv,
      ),
    ).toThrow(HttpError));
  it('rejects a foreign write Origin', () =>
    expect(() =>
      enforceWriteOrigin(
        new Request(`${testEnv.OFFICIAL_ORIGIN}/x`, {
          method: 'POST',
          headers: { Origin: 'https://evil.test' },
        }),
        testEnv,
      ),
    ).toThrow(HttpError));
  it('rejects a null write Origin instead of weakening CSRF protection', () =>
    expect(() =>
      enforceWriteOrigin(
        new Request(`${testEnv.OFFICIAL_ORIGIN}/x`, {
          method: 'POST',
          headers: { Origin: 'null' },
        }),
        testEnv,
      ),
    ).toThrow(HttpError));
  it('accepts the exact write Origin', () =>
    expect(() =>
      enforceWriteOrigin(
        new Request(`${testEnv.OFFICIAL_ORIGIN}/x`, {
          method: 'POST',
          headers: { Origin: testEnv.OFFICIAL_ORIGIN },
        }),
        testEnv,
      ),
    ).not.toThrow());
  it('adds CSP and anti-framing headers', () => {
    const response = withSecurityHeaders(new Response('ok'));
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
  });
  it('permits local photo previews in static and API responses without widening scripts', () => {
    const staticPolicy = readFileSync('public/_headers', 'utf8');
    const apiPolicy = SECURITY_HEADERS['Content-Security-Policy'];
    for (const policy of [staticPolicy, apiPolicy]) {
      expect(policy).toContain("img-src 'self' data: blob:");
      expect(policy).not.toMatch(/script-src[^;]*blob:/u);
    }
  });
  it('allows only the one SheetJS file the loader requests, not the whole CDN', () => {
    const loader = readFileSync('src/features/gradebook/import/sheetjs-loader.ts', 'utf8');
    const source = /const SHEETJS_SRC = '([^']+)'/u.exec(loader)?.[1];
    expect(source).toMatch(/^https:\/\/cdn\.sheetjs\.com\/.+\.js$/u);
    for (const policy of [readFileSync('public/_headers', 'utf8'), SECURITY_HEADERS['Content-Security-Policy']]) {
      const scripts = /script-src ([^;\r\n]*)/u.exec(policy ?? '')?.[1];
      expect(scripts?.split(' ')).toEqual(["'self'", source]);
    }
  });
  it('lets browsers keep content-hashed static assets while HTML revalidates', () => {
    const rules = readFileSync('public/_headers', 'utf8').split(/\r?\n(?=\S)/u);
    const rule = (path: string) => rules.find((block) => block.split(/\r?\n/u)[0] === path) ?? '';
    expect(rule('/assets/*')).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(rule('/')).toContain('Cache-Control: no-cache');
    expect(rule('/index.html')).toContain('Cache-Control: no-cache');
  });
  it('marks protected responses no-store', () =>
    expect(withSecurityHeaders(new Response('ok'), true).headers.get('Cache-Control')).toContain(
      'no-store',
    ));
  it('preserves a runtime-owned WebSocket upgrade instead of reconstructing status 101', () => {
    const upgrade = new Response(null);
    Object.defineProperty(upgrade, 'status', { value: 101 });
    expect(withSecurityHeaders(upgrade, true)).toBe(upgrade);
  });
  it('requires application/json', async () =>
    await expect(
      readBoundedJson(
        new Request('https://x.test', {
          method: 'POST',
          body: '{}',
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    ).rejects.toMatchObject({ status: 415 }));
  it('rejects invalid JSON', async () =>
    await expect(
      readBoundedJson(
        new Request('https://x.test', {
          method: 'POST',
          body: '{',
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 }));
  it('rejects bodies above the limit by header', async () =>
    await expect(
      readBoundedJson(
        new Request('https://x.test', {
          method: 'POST',
          body: '{}',
          headers: { 'Content-Type': 'application/json', 'Content-Length': '20000' },
        }),
      ),
    ).rejects.toMatchObject({ status: 413 }));
  it('reads an allowed bounded binary body without converting it to text', async () => {
    const bytes = await readBoundedBytes(
      new Request('https://x.test', {
        method: 'POST',
        body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      }),
      {
        maxBytes: 16,
        allowedContentTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      },
    );
    expect(Array.from(bytes)).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
  it('rejects a binary upload with an unexpected media type', async () =>
    await expect(
      readBoundedBytes(
        new Request('https://x.test', {
          method: 'POST',
          body: new Uint8Array([1]),
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
        { allowedContentTypes: ['application/test'] },
      ),
    ).rejects.toMatchObject({ status: 415 }));
  it('rejects binary uploads above the configured limit', async () =>
    await expect(
      readBoundedBytes(
        new Request('https://x.test', {
          method: 'POST',
          body: new Uint8Array([1, 2, 3, 4]),
          headers: { 'Content-Type': 'application/test' },
        }),
        { maxBytes: 3, allowedContentTypes: ['application/test'] },
      ),
    ).rejects.toMatchObject({ status: 413 }));
  it('defines HSTS and a restrictive permissions policy', () => {
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(SECURITY_HEADERS['Permissions-Policy']).toContain('camera=()');
  });
});
