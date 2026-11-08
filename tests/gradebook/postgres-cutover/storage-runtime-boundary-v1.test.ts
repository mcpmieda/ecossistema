// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('official Gradebook storage boundary', () => {
  it('keeps production configured for PostgreSQL/Hyperdrive without a D1 binding', () => {
    const wrangler = source('wrangler.jsonc');

    expect(wrangler).toContain('"GRADEBOOK_STORAGE_PROVIDER": "postgres"');
    expect(wrangler).toContain('"binding": "PROD_DB"');
    expect(wrangler).not.toContain('"d1_databases"');
  });

  it('requires PostgreSQL in the official selector in every environment', () => {
    const official = source(
      'server/gradebook/persistence/postgres/official-gradebook-database-v1.ts',
    );

    expect(official).not.toContain("provider === 'd1'");
    expect(official).toContain("const configured = provider === 'postgres'");
    expect(official).toContain('gradebook-official-postgres-provider-required');
    expect(official).toContain('gradebook-official-postgres-binding-missing');
  });

  it('documents that only PostgreSQL remains', () => {
    const map = source('docs/gradebook/STORAGE_RUNTIME_MAP.md');
    const legacy = source('docs/gradebook/D1_RUNTIME.md');
    const cutover = source('docs/gradebook/postgres-cutover-runbook-v1.md');

    expect(map).toContain('somente PostgreSQL em todos os ambientes');
    expect(map).toContain('não existe fallback automático para D1 físico');
    expect(legacy).toContain('Documento histórico');
    expect(cutover).toContain('instruções de rollback D1 abaixo estão supersedidas');
  });
});
