// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const RETIRED_ACTIVE_PATHS = [
  'server/gradebook/persistence/d1/runtime/d1-benchmark-instrumentation-v1.ts',
  'shared/gradebook-contracts/current-academic-year-v1.ts',
  'shared/gradebook-contracts/imports/import-known-content-transport-v1.ts',
  'shared/gradebook-contracts/imports/import-persistence-transport-v7.ts',
] as const;

describe('Gradebook live code versus historical memory', () => {
  it('keeps proven orphaned historical modules out of the active tree', () => {
    for (const path of RETIRED_ACTIVE_PATHS) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });

  it('documents that Aprendizados is not an operational consumer', () => {
    const archive = readFileSync(join(root, 'Aprendizados/IMPORTADORES-LEGADOS/README.md'), 'utf8');

    expect(archive).toContain('exclua `Aprendizados/**` da busca');
    expect(archive).toContain('nome de arquivo e símbolos exportados');
  });

  it('preserves the V9/V10/V11 import authority statement', () => {
    const archive = readFileSync(join(root, 'Aprendizados/IMPORTADORES-LEGADOS/README.md'), 'utf8');

    expect(archive).toContain('import-relational-service-v11.ts');
    expect(archive).toContain('coordena V10/V9');
  });
});
