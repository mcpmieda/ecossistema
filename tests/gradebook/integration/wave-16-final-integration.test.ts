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

  it('usa a projeção oficial #332 upstream do Council Workspace sem cálculo no workspace/wiring', () => {
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const functions = source('functions/[[path]].ts');

    expect(runtime).toContain('createGradebookD1CouncilOfficialProjectionSourceV1(database)');
    expect(runtime).toContain('councilWorkspace(');
    expect(runtime).toContain('createGradebookD1BulletinCouncilDurabilityV1(database)');
    expect(runtime).toContain('decisions: this.durability.councilDecisions');
    expect(runtime).not.toContain('createLocalCouncilDecisionStoreV1');
    expect(functions).not.toContain('resolveNativeAnnualOutcome');
  });

  it('preserva F6: quatro lentes, recovery oficial, comparação canônica, paginação/drill-down e raw evidence fora do HTTP', () => {
    const page = source('src/features/gradebook/performance/relational-performance-page-v2.tsx');
    const hook = source('src/features/gradebook/performance/use-relational-performance-v2.ts');
    const matrix = source('src/features/gradebook/performance/performance-result-matrix-v2.tsx');
    const route = source('server/gradebook/http/performance-routes-v1.ts');
    const physicalSource = source(
      'Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/performance/d1-class-performance-source-v1.ts',
    );

    for (const label of ['Resultado', 'Quantitativo', 'Qualitativo', 'Avaliações']) {
      expect(page).toContain(label);
    }
    expect(page).toContain('<PerformanceStudentDetailV2');
    expect(page).toContain('<PerformanceResultMatrixV2');
    expect(page).toContain('<PerformanceTermComparisonPanelV4');
    expect(page).toContain('state.classes?.nextOffset');
    expect(hook).toContain('ticket.isCurrent()');
    expect(matrix).toContain('<PerformanceGridV2');
    expect(matrix).toContain('open={open}');
    expect(physicalSource).toContain("source: 'final-recovery'");
    expect(physicalSource).toContain('resolvePerformanceComparisonProjectionV2');
    expect(physicalSource).toContain('official-projection-unavailable');
    expect(route).not.toContain('officialRecords: detail.officialRecords');
    expect(route).not.toContain('rawSourceEvidence');
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
    expect(shell).toContain("import('../features/gradebook/bulletins/bulletin-page')");
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

  it('mantém auth opaca, capability existente, no-store e produção fail-closed antes do binding', () => {
    const functions = source('functions/[[path]].ts');
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const handlers = [
      source('server/gradebook/http/performance-routes-v1.ts'),
      source('server/gradebook/http/bulletin-routes-v1.ts'),
      source('server/gradebook/http/council-routes-v1.ts'),
    ];

    for (const handler of handlers) {
      expect(handler).toContain('requireAuth');
      expect(handler).toContain('authorizeGradebookRuntimeV1');
      expect(handler).toContain('no-store');
    }
    expect(functions).toContain('handleCouncilWorkspaceRequestV1(request, env, afterCommit)');
    expect(handlers[2]).toContain('authorizeGradebookRuntimeV1(session)');
    const environmentGate = runtime.indexOf('const environment = runtimeEnvironment(env);');
    const bindingAccess = runtime.indexOf('const database = requireDatabase(env.GRADEBOOK_DATABASE ?? env.GRADEBOOK_D1);');
    expect(environmentGate).toBeGreaterThanOrEqual(0);
    expect(bindingAccess).toBeGreaterThan(environmentGate);
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
