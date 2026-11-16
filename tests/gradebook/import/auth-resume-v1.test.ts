import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GradebookImportPersistenceResponseV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { BatchSuccess } from '../../../src/features/gradebook/import/import-batch';
import {
  isGradebookImportAuthorizationRequiredV1,
  selectPendingGradebookImportResultsV1,
  type ImportPersistenceStateV9,
} from '../../../src/features/gradebook/import/use-import-batch';

function result(id: string): BatchSuccess {
  return { id } as unknown as BatchSuccess;
}

describe('gradebook import auth resume V1', () => {
  it('pausa somente em not-authorized', () => {
    expect(
      isGradebookImportAuthorizationRequiredV1({
        transportVersion: 9,
        state: 'not-authorized',
      }),
    ).toBe(true);
    expect(
      isGradebookImportAuthorizationRequiredV1({
        transportVersion: 9,
        state: 'conflict',
        reason: 'synthetic-conflict',
      }),
    ).toBe(false);
  });

  it('retoma apenas auth-required e recognized, preservando concluídos e falhas', () => {
    const successes = [
      result('synthetic:1'),
      result('synthetic:2'),
      result('synthetic:3'),
      result('synthetic:4'),
    ];
    const persistence: Record<string, ImportPersistenceStateV9> = {
      'synthetic:1': {
        state: 'completed',
        response: {
          transportVersion: 9,
          state: 'conflict',
          reason: 'synthetic-conflict',
        } satisfies GradebookImportPersistenceResponseV9,
      },
      'synthetic:2': { state: 'auth-required' },
      'synthetic:3': { state: 'recognized' },
      'synthetic:4': { state: 'failed', message: 'synthetic-failure' },
    };

    expect(
      selectPendingGradebookImportResultsV1(successes, persistence).map((value) => value.id),
    ).toEqual(['synthetic:2', 'synthetic:3']);
  });

  it('integra pausa no primeiro 401/403 e renovação em outra aba sem storage acadêmico', () => {
    const root = process.cwd();
    const hook = readFileSync(
      join(root, 'src/features/gradebook/import/use-import-batch.ts'),
      'utf8',
    );
    const panel = readFileSync(
      join(root, 'src/features/gradebook/import/import-panel.tsx'),
      'utf8',
    );

    expect(hook).toContain("return 'auth-required'");
    expect(hook).toContain('markAuthorizationRequired(result)');
    expect(hook).toContain('selectPendingGradebookImportResultsV1(results, persistence)');
    expect(panel).toContain("globalThis.open('/auth/login', '_blank', 'noopener,noreferrer')");
    expect(panel).toContain('Retomar pendentes');
    expect(`${hook}\n${panel}`).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
  });
});
