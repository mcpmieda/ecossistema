// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const path = (value: string) => resolve(root, value);

const CURRENT_IMPORT_FILES = [
  'functions/api/gradebook/import-persistence.ts',
  'src/features/gradebook/import/import-persistence-client-v9.ts',
  'server/gradebook/application/import/import-relational-service-v11.ts',
  'server/gradebook/persistence/postgres/relational-import-write-buffer-v11.ts',
] as const;

const RETIRED_RUNTIME_FILES = [
  'server/gradebook/http/import-known-content-routes-v1.ts',
  'server/gradebook/http/import-persistence-routes-v2.ts',
  'server/gradebook/http/import-staging-routes-v1.ts',
  'src/features/gradebook/import/import-persistence-client-v8.ts',
  'src/features/gradebook/import/compact-import-v8.ts',
  'src/features/gradebook/import/canonical-roster-v6.ts',
  'functions/api/gradebook/postgres-v8-shadow-benchmark.ts',
  'functions/api/gradebook/postgres-backfill.ts',
  'server/gradebook/persistence/shadow/postgres-shadow-apply-v1.ts',
] as const;

const ARCHIVE_FILES = [
  'Aprendizados/IMPORTADORES-LEGADOS/README.md',
  'Aprendizados/IMPORTADORES-LEGADOS/D1-V8/README.md',
  'Aprendizados/IMPORTADORES-LEGADOS/HYPERDRIVE-SHADOW/README.md',
] as const;

describe('legacy gradebook import archive', () => {
  it('keeps only the relational V9/V11 import path in the active runtime', () => {
    for (const file of CURRENT_IMPORT_FILES) expect(existsSync(path(file)), file).toBe(true);
    for (const file of RETIRED_RUNTIME_FILES) expect(existsSync(path(file)), file).toBe(false);

    const catchAll = readFileSync(path('functions/[[path]].ts'), 'utf8');
    expect(catchAll).not.toContain('handleGradebookImportKnownContentRequestV1');
    expect(catchAll).not.toContain('handleGradebookImportPersistenceRequestV2');
  });

  it('keeps the learning notes of the retired importers', () => {
    for (const file of ARCHIVE_FILES) expect(existsSync(path(file)), file).toBe(true);
  });
});
