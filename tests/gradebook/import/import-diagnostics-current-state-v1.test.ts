// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replaceGradebookImportDiagnosticsSnapshotV1 } from '../../../server/gradebook/application/import/import-diagnostics-snapshot-v1';
import type { GradebookPostgresTransactionV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('current import diagnostics retention', () => {
  it('keeps an already empty unknown-year observation unchanged without writes or annual revisions', async () => {
    let transactions = 0;
    const calls: string[] = [];
    const transaction: GradebookPostgresTransactionV1 = {
      async query<Row extends Record<string, unknown>>(text: string) {
        calls.push(text);
        return [] as readonly Row[];
      },
      async executeNative<Row extends Record<string, unknown>>(text: string) {
        calls.push(text);
        return {
          rows: [{ previous_years_json: '[]', unchanged: 1 }] as unknown as readonly Row[],
          changes: 1,
        };
      },
    };
    const database = {
      query: async () => {
        throw new Error('read-outside-transaction');
      },
      executeNative: async () => {
        throw new Error('write-outside-transaction');
      },
      transaction: async <T>(
        operation: (database: GradebookPostgresTransactionV1) => Promise<T>,
      ) => {
        transactions++;
        return operation(transaction);
      },
    };
    expect(
      await replaceGradebookImportDiagnosticsSnapshotV1(database, {
        version: 1,
        academicYear: null,
        fileName: 'synthetic-empty.xlsx',
        sha256: 'a'.repeat(64),
        diagnostics: [],
      }),
    ).toBe(0);
    expect(transactions).toBe(1);
    expect(calls).toHaveLength(5);
    expect(calls.some((text) => /^(DELETE|INSERT|UPDATE) /u.test(text))).toBe(false);
    expect(
      calls.some(
        (text) =>
          text.includes('ensure_year_coordination') || text.includes('record_gradebook_change'),
      ),
    ).toBe(false);
  });

  it('routes complete observations through the atomic snapshot service', () => {
    const route = source('functions/api/gradebook/import-diagnostics.ts');
    const service = source('server/gradebook/application/import/import-diagnostics-snapshot-v1.ts');
    expect(route).toMatch(
      /replaceGradebookImportDiagnosticsSnapshotV1\(database,\s*\{\s*\.\.\.payload,\s*origin: 'manual',?\s*\}\)/u,
    );
    expect(service).toContain('.transaction(async (transaction)');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('ano IS NOT DISTINCT FROM $1 AND arquivo = $2');
    expect(service).toContain('recordChanges');
    expect(service).toContain('writtenCount !== rows.length');
    expect(route).not.toContain('DELETE FROM');
  });

  it('sends empty observations and prevents academic persistence from clearing diagnostics independently', () => {
    const hook = source('src/features/gradebook/import/use-import-batch.ts');
    const route = source('functions/api/gradebook/import-persistence.ts');
    expect(hook).not.toContain('if (diagnostics.length === 0) return;');
    expect(hook).toContain('await persistGradebookImportDiagnosticsAuditV1(request)');
    expect(hook).toContain('gradebookImportDiagnosticsAuditRequestV1(result, diagnostics)');
    expect(route).not.toContain('DELETE FROM gradebook.importacao_diagnostico');
    expect(route).not.toContain('clearStaleImportDiagnostics');
    expect(route).toContain('createGradebookImportService(');
    expect(route).toContain('observer.wrap(database)');
  });
});
