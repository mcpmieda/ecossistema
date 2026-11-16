// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../../server/http/security';

/*
 * React Aria (under HeroUI) injects one <style> for pressable elements (it skips it under tests,
 * so the text is read from the installed source). Both apps keep style-src 'self' and allow
 * exactly that element by its sha256. If a library update changes the text, this fails:
 * update the hash in the three policies below.
 */
function pressableStyleTextV1() {
  const root = dirname(createRequire(import.meta.url).resolve('react-aria/package.json'));
  const source = readFileSync(join(root, 'dist/private/interactions/usePress.mjs'), 'utf8');
  const attribute = source.match(/PRESSABLE_ATTRIBUTE = ['"]([^'"]+)['"]/u)?.[1];
  const template = source.match(/style\.textContent = `([\s\S]*?)`\.trim\(\)/u)?.[1];
  expect(attribute, 'React Aria pressable attribute').toBe('data-react-aria-pressable');
  expect(template, 'React Aria pressable style').toBeTruthy();
  return template!.replace(/\$\{[^}]+\}/u, attribute!).trim();
}

it("allows React Aria's injected pressable style by its exact hash, and nothing inline beyond it", () => {
  const hash = `'sha256-${createHash('sha256').update(pressableStyleTextV1()).digest('base64')}'`;
  const portal = readFileSync('workers/student-portal/edge/[[path]].ts', 'utf8');
  const policies = {
    'public/_headers': readFileSync('public/_headers', 'utf8'),
    'server/http/security.ts': SECURITY_HEADERS['Content-Security-Policy']!,
    'Portal edge': portal.match(/'Content-Security-Policy', "([^"]+)"/u)?.[1] ?? '',
    // The Portal's hashed assets get the same policy from Pages (issue #1450, 17a).
    'Portal assets (build-edge.mjs)':
      readFileSync('workers/student-portal/build-edge.mjs', 'utf8').match(
        /const ASSET_CSP_V1 = "([^"]+)"/u,
      )?.[1] ?? '',
  };
  for (const [where, policy] of Object.entries(policies)) {
    expect(policy.match(/style-src ([^;]+)/u)?.[1], where).toBe(`'self' ${hash}`);
    expect(policy, where).not.toContain('unsafe-inline');
  }
});
