// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageEntry {
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly integrity?: string;
  readonly resolved?: string;
}
interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Readonly<Record<string, PackageEntry>>;
}
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly overrides: Readonly<Record<string, unknown>>;
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as Lockfile;

// Known advisory regression checks. These do not replace a fresh npm audit.
describe('security remediation #637', () => {
  it('keeps package declarations synchronized with the committed npm lock', () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages['']?.dependencies).toEqual(manifest.dependencies);
    expect(lock.packages['']?.devDependencies).toEqual(manifest.devDependencies);
  });

  it('pins the patched sharp only in the Miniflare dependency chain', () => {
    expect(manifest.overrides.miniflare).toEqual({ sharp: '0.35.4' });
    const entries = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/sharp$/u.test(path));
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      expect(entry.version, path).toBe('0.35.4');
      expect(entry.integrity, path).toMatch(/^sha512-/u);
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
    }
  });

  it('does not restore the unused manifest CLI or its vulnerable ZIP dependency', () => {
    expect(manifest.devDependencies).not.toHaveProperty('office-addin-manifest');
    expect(manifest.overrides).not.toHaveProperty('adm-zip');
    const removed = Object.keys(lock.packages).filter((path) => /(?:^|\/)node_modules\/(?:office-addin-manifest|adm-zip)$/u.test(path));
    expect(removed).toEqual([]);
  });

  it('preserves the application database driver', () => {
    expect(manifest.dependencies.postgres).toBe('3.4.9');
    expect(lock.packages['node_modules/postgres']?.version).toBe('3.4.9');
  });
});
