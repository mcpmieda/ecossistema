import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('integração final da onda 18 — durabilidade, Conselho V2 e relatórios', () => {

  it('preserva o renderer compartilhado e aposenta o gerador em lote sem montagem', () => {
    expect(existsSync(join(root, 'src/features/gradebook/bulletins/pdf/bulletin-pdf-batch-actions-v1.ts'))).toBe(false);
    expect(source('src/features/gradebook/bulletins/pdf/bulletin-pdf-renderer-v2.ts')).toContain("from './bulletin-pdf-engine'");
  });

  it('não introduz storage acadêmico persistente no navegador nas novas superfícies', () => {
    const frontend = [
      'src/features/gradebook/council/relational-council-page-v3.tsx',
      'src/features/gradebook/council/relational-council-client-v3.ts',
      'src/platform/gradebook-council-surface.tsx',
      'src/platform/gradebook-workspace-shell.tsx',
    ]
      .map(source)
      .join('\n');

    expect(frontend).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.open/u);
  });
});
