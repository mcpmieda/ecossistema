import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

const retired = [
  'src/features/gradebook/operational-workspace/operational-workspace-page.tsx',
  'src/features/gradebook/operational-workspace/operational-workspace-client.ts',
  'src/features/gradebook/performance/performance-page.tsx',
  'src/features/gradebook/performance/performance-client.ts',
  'src/features/gradebook/performance/performance-official-charts.tsx',
  'src/features/gradebook/performance/performance-comparison-configuration-panel.tsx',
  'src/features/gradebook/performance/performance-request-gate.ts',
  'src/features/gradebook/performance/performance-analysis-client-v3.ts',
  'src/features/gradebook/performance/performance-term-comparison-client-v4.ts',
  'src/features/gradebook/council/council-workspace-page.tsx',
  'src/features/gradebook/council/council-workspace-client.ts',
  'src/features/gradebook/council/council-institutional-panel-v2.tsx',
  'src/features/gradebook/council/council-institutional-client-v2.ts',
  'src/features/gradebook/reports/institutional-reports-page.tsx',
  'src/features/gradebook/reports/institutional-reports-client.ts',
  'src/features/gradebook/bulletins/bulletin-client.ts',
  'src/features/gradebook/bulletins/pdf/bulletin-pdf-actions-v1.ts',
  'src/features/gradebook/bulletins/pdf/bulletin-pdf-batch-actions-v1.ts',
  'src/platform/gradebook-legacy-year.ts',
] as const;

describe('frontends antigos sem montagem aposentados na #666', () => {
  it('não mantém as árvores frontend órfãs', () => {
    for (const path of retired) expect(existsSync(join(root, path)), path).toBe(false);
  });

  it('mantém o shell ligado exclusivamente às superfícies relacionais atuais', () => {
    const shell = source('src/platform/gradebook-workspace-shell.tsx');
    const council = source('src/platform/gradebook-council-surface.tsx');
    const bulletins = source('src/features/gradebook/bulletins/relational-bulletin-page-v2.tsx');

    expect(shell).not.toContain('gradebook-operational-surface');
    expect(council).toContain('RelationalCouncilPageV3');
    expect(bulletins).toContain('RelationalBulletinPageV2');
    expect(shell).toContain("import('../features/gradebook/performance/relational-performance-page-v2')");
    expect(shell).not.toContain("import('../features/gradebook/reports/relational-institutional-reports-page-v2')");
    expect(shell).not.toContain("import('../features/gradebook/reports/institutional-reports-page')");
    expect(shell).not.toContain("import('../features/gradebook/performance/performance-page')");
  });

  it('preserva endpoints server-side e o renderer PDF compartilhado com V2', () => {
    const functions = source('functions/[[path]].ts');
    const rendererV2 = source(
      'src/features/gradebook/bulletins/pdf/bulletin-pdf-renderer-v2.ts',
    );

    for (const handler of [
      'handleOperationalWorkspaceRequestV1',
      'handlePerformanceRequestV1',
      'handleBulletinRequestV1',
      'handleCouncilWorkspaceRequestV1',
    ]) {
      expect(functions).toContain(handler);
    }
    expect(rendererV2).toContain("from './bulletin-pdf-engine'");
    expect(existsSync(join(
      root,
      'src/features/gradebook/bulletins/pdf/bulletin-pdf-engine.ts',
    ))).toBe(true);
  });
});
