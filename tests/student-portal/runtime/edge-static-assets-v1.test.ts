// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const build = readFileSync('workers/student-portal/build-edge.mjs', 'utf8');
const edge = readFileSync('workers/student-portal/edge/[[path]].ts', 'utf8');

describe('Portal hashed assets straight from Pages (issue #1426, 10)', () => {
  it('excludes only /assets/* from the Function: the page, the API and everything else stay on it', () => {
    const routes = /JSON\.stringify\((\{ version: 1, include: \['\/\*'\], exclude: \[[^\]]*\] \})\)/u.exec(build)?.[1];
    expect(routes).toBe("{ version: 1, include: ['/*'], exclude: ['/assets/*'] }");
  });

  it('gives the assets the same security headers the Function sets', () => {
    const functionCsp = /'Content-Security-Policy', "([^"]+)"/u.exec(edge)?.[1];
    const assetCsp = /const ASSET_CSP_V1 = "([^"]+)"/u.exec(build)?.[1];
    expect(functionCsp).toBeTruthy();
    expect(assetCsp).toBe(functionCsp);
    for (const header of ["Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
      "Referrer-Policy', 'no-referrer", "X-Content-Type-Options', 'nosniff", "X-Frame-Options', 'DENY",
      "Strict-Transport-Security', 'max-age=31536000; includeSubDomains"]) {
      expect(edge).toContain(header);
      const [name, value] = header.split("', '");
      expect(build).toContain(`  ${name}: ${value}`);
    }
    expect(build).toContain('  Cache-Control: public, max-age=31536000, immutable');
    // A missing asset stays a 404 instead of the page itself.
    expect(build).toContain('/404.html');
  });
});
