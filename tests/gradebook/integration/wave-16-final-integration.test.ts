import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('integração final da onda 16 — F6/F7/F8', () => {
  it('mantém exatamente um bridge por endpoint acadêmico ainda autorizado', () => {
    const functions = source('functions/[[path]].ts');
    const routes = [
      [
        'server/gradebook/http/operational-workspace-routes-v1.ts',
        '/api/gradebook/operational-workspace',
      ],
      ['server/gradebook/http/performance-routes-v1.ts', '/api/gradebook/performance'],
      ['server/gradebook/http/bulletin-routes-v1.ts', '/api/gradebook/bulletins'],
      ['server/gradebook/http/council-routes-v1.ts', '/api/gradebook/council-workspace'],
    ] as const;

    for (const [path, endpoint] of routes) {
      expect(source(path).split(endpoint)).toHaveLength(2);
    }
    expect(functions.match(/handleOperationalWorkspaceRequestV1/gu)).toHaveLength(2);
    expect(functions).not.toContain('handleAuditWorkspaceRequestV1');
    expect(functions).not.toContain('/api/gradebook/audit-workspace');
    expect(functions.match(/handlePerformanceRequestV1/gu)).toHaveLength(2);
    expect(functions.match(/handleBulletinRequestV1/gu)).toHaveLength(2);
    expect(functions.match(/handleCouncilWorkspaceRequestV1/gu)).toHaveLength(2);
  });

  it('preserva F8: mesma base canônica, lote isolado, snapshot histórico e PDF canônico snapshot-only', () => {
    const service = source('server/gradebook/application/bulletins/relational-bulletin-v2.ts');
    const snapshots = source(
      'server/gradebook/persistence/postgres/relational-bulletin-snapshot-v2.ts',
    );
    const page = source('src/features/gradebook/bulletins/relational-bulletin-page-v2.tsx');
    const pdfActions = source('src/features/gradebook/bulletins/pdf/bulletin-pdf-actions-v2.ts');

    expect(service).toContain('readMaterializations(tx, selections, now())');
    expect(service).toContain("request.operation === 'emit-batch'");
    expect(service).toContain("source: 'historical-snapshot'");
    expect(snapshots).toContain('snapshot_json AS payload_json');
    expect(page).toContain('emitido(s)');
    expect(page).toContain('O PDF usa somente a versão emitida acima');
    expect(page).toContain('Baixar PDF oficial');
    expect(page).toContain('Imprimir PDF oficial');
    expect(pdfActions).toContain("await import('./bulletin-pdf-renderer-v2')");
    expect(page).not.toContain('@react-pdf');
    expect(page).not.toContain('pdfkit');
    expect(page).not.toContain('jspdf');
  });

  it('preserva contexto explícito e estados acessíveis após mover F6/F7/F8 para o shell lazy', () => {
    const app = source('src/App.tsx');
    const notesPage = source('src/platform/notes-page.tsx');
    const workspacePage = source('src/platform/gradebook-workspace-page.tsx');
    const shell = source('src/platform/gradebook-workspace-shell.tsx');
    const councilSurface = source('src/platform/gradebook-council-surface.tsx');
    const councilPage = source('src/features/gradebook/council/relational-council-page-v3.tsx');
    const councilHook = source('src/features/gradebook/council/use-relational-council-v3.ts');

    expect(app).not.toMatch(/features\/gradebook\/(?:performance|bulletins|council)/u);
    expect(notesPage).toContain("import('./gradebook-workspace-page')");
    expect(workspacePage).toContain('<GradebookWorkspaceShell />');
    expect(shell).toContain(
      "import('../features/gradebook/performance/relational-performance-page-v2')",
    );
    expect(shell).toContain("import('../features/gradebook/bulletins/relational-bulletin-page-v2')");
    expect(shell).toContain("import('./gradebook-council-surface')");
    expect(councilSurface).toContain('RelationalCouncilPageV3');
    expect(councilSurface).not.toContain('requestOperationalWorkspaceV1');
    expect(councilHook).toContain("operation: 'classes', year");
    expect(councilHook).toContain('sequence.current');
    expect(councilHook).toContain('workspaceController.current?.abort()');
    expect(councilPage).toContain('aria-live="polite"');
    expect(councilPage).toContain('Linha do tempo');
    expect(councilPage).toContain('Fechamentos preservados');
  });

  it('sincroniza F1 como 7/7 e remove os marcadores históricos já satisfeitos da memória central', () => {
    const docs = [
      'docs/gradebook/README.md',
      'docs/gradebook/COMECE_AQUI.md',
      'docs/gradebook/ISSUE_MAP.md',
      'docs/gradebook/PROJECT_STATE.yaml',
      'docs/gradebook/ARCHITECTURE.md',
      'docs/gradebook/CONTRACTS.md',
      'docs/gradebook/D1_RUNTIME.md',
    ].map(source);
    const combined = docs.join('\n');

    expect(combined).not.toContain('synthetic-complete-private-real-validation-pending');
    expect(combined).not.toContain('controlled-real-corpus-validation-not-yet-recorded');
    expect(combined).not.toContain('complete-manifest-failure-smoke-not-yet-recorded');
    expect(combined).toContain('F1');
    expect(combined).toMatch(/7\s*(?:de\s*)?7|7\/7/u);
  });
});
