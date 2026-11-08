// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  compareCanonicalStringsV1,
  comparePtBrNumericLabelsV1,
} from '../../../shared/gradebook-contracts/string-order-v1';

const root = process.cwd();
const targets = [
  'server/gradebook/recovery/logical-backup-recovery-v2.ts',
  'Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/performance/d1-class-performance-source-v1.ts',
  'Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/audit-workspace/d1-audit-workspace-source-v1.ts',
  'Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/audit/d1-audit-repository-v1.ts',
  'Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/imports/d1-import-repository-extension-v1.ts',
  'Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/write/d1-write-adapter-v1.ts',
  'src/features/gradebook/import/spreadsheet-recognizer.ts',
] as const;

describe('BN string ordering reliability', () => {
  it('does not leave implicit string sort semantics in the Sonar S2871 target files', () => {
    for (const path of targets) {
      const source = readFileSync(join(root, path), 'utf8');
      expect(source, path).not.toMatch(/\.sort\(\s*\)/u);
    }
  });

  it('uses explicit locale-aware comparators for canonical and human-readable string order', () => {
    expect(['z:2', 'a:10', 'a:2'].sort(compareCanonicalStringsV1)).toEqual([
      'a:10',
      'a:2',
      'z:2',
    ]);
    expect(['10º', '2º', '1º'].sort(comparePtBrNumericLabelsV1)).toEqual([
      '1º',
      '2º',
      '10º',
    ]);
  });
});
