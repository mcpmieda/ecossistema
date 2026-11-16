// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');
const cached = /new PhotoStorageV1\([\s\S]{0,400}?caches\?\.default,?\s*\)/u;

/** Owner decision #1473: the ADM's photo reads use the Worker's own cache, as the Portal's; writes never do. */
describe('student photo cache scope', () => {
  it('caches the ADM reads: the avatar batch and the catalog', () => {
    expect(source('server/student-photos/http/runtime-v1.ts')).toMatch(cached);
    expect(source('server/student-photos/catalog-service-v1.ts')).toMatch(cached);
    expect(source('server/student-portal/photos/http-v1.ts')).toMatch(cached);
  });

  it('never caches the write and publication paths', () => {
    expect(source('server/student-photos/runtime-service-v1.ts')).not.toContain('caches');
  });
});
