import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('integração final da onda 17 — PDF canônico + F9', () => {
  it('abre resultados da busca diretamente na área correta sem criar nova rota de plataforma', () => {
    const contract = source('shared/platform-contract.ts');
    const notes = source('src/platform/notes-module.ts');
    const shell = source('src/platform/gradebook-workspace-shell.tsx');

    expect(contract).toContain('value.split(/[?#]/u)[0]');
    for (const area of ['audit', 'performance', 'bulletins', 'council']) {
      expect(notes).toContain(`notesAreaHref('${area}')`);
    }
    expect(notes).toContain("platformHref('banco-de-notas')");
    expect(notes).not.toContain("notesAreaHref('operational')");
    expect(shell).toContain('workspaceSurfaceFromHash');
    expect(shell).toContain("new URLSearchParams(query).get('area')");
    expect(shell).toContain("window.addEventListener('hashchange', onHashChange)");
    expect(shell).toContain('window.history.replaceState');
  });

  it('preserva PDF oficial exclusivamente sobre snapshot canônico e renderer sob demanda', () => {
    const page = source('src/features/gradebook/bulletins/relational-bulletin-page-v2.tsx');
    const actions = source('src/features/gradebook/bulletins/pdf/bulletin-pdf-actions-v2.ts');
    const renderer = source('src/features/gradebook/bulletins/pdf/bulletin-pdf-renderer-v2.ts');

    expect(page).toContain('Baixar PDF oficial');
    expect(page).toContain('Imprimir PDF oficial');
    expect(page).toContain("artifact.mode !== 'preview'");
    expect(actions).toContain("await import('./bulletin-pdf-renderer-v2')");
    expect(actions).not.toContain('/api/gradebook/');
    expect(renderer).toContain('RelationalBulletinSnapshotV2');
    expect(renderer).not.toMatch(/fetch\(|localStorage|sessionStorage|indexedDB|caches\.open/u);
  });

  it('mantém a rota e as superfícies acadêmicas atuais lazy e isoladas', () => {
    const notesPage = source('src/platform/notes-page.tsx');
    const shell = source('src/platform/gradebook-workspace-shell.tsx');

    expect(notesPage).toContain("import('./gradebook-workspace-page')");
    for (const imported of [
      'gradebook-audit-surface',
      'performance-page',
      'bulletin-page',
      'gradebook-council-surface',
    ]) {
      expect(shell).toContain(imported);
    }
    expect(shell).not.toContain('gradebook-operational-surface');
    expect(shell).toContain('class GradebookSurfaceBoundary');
    expect(shell).toContain('role="tablist"');
    expect(shell).toContain('aria-selected={selected}');
  });

  it('mantém os quatro bridges dedicados restantes, auth server-side e no-store', () => {
    const functions = source('functions/[[path]].ts');
    const handlers = [
      [
        'server/gradebook/http/operational-workspace-routes-v1.ts',
        '/api/gradebook/operational-workspace',
      ],
      ['server/gradebook/http/performance-routes-v1.ts', '/api/gradebook/performance'],
      ['server/gradebook/http/bulletin-routes-v1.ts', '/api/gradebook/bulletins'],
      ['server/gradebook/http/council-routes-v1.ts', '/api/gradebook/council-workspace'],
    ] as const;

    for (const [path, endpoint] of handlers) {
      const handler = source(path);
      expect(handler.split(endpoint)).toHaveLength(2);
      expect(handler).toContain('requireAuth');
      expect(handler).toContain('authorizeGradebookRuntimeV1');
      expect(handler).toContain('no-store');
    }
    expect(functions.match(/handleOperationalWorkspaceRequestV1/gu)).toHaveLength(2);
    expect(functions).not.toContain('handleAuditWorkspaceRequestV1');
    expect(functions).not.toContain('/api/gradebook/audit-workspace');
    expect(functions.match(/handlePerformanceRequestV1/gu)).toHaveLength(2);
    expect(functions.match(/handleBulletinRequestV1/gu)).toHaveLength(2);
    expect(functions.match(/handleCouncilWorkspaceRequestV1/gu)).toHaveLength(2);
  });

  it('não introduz persistência acadêmica no navegador nem retry silencioso de writes', () => {
    const frontend = [
      'src/platform/gradebook-year-provider.tsx',
      'src/features/gradebook/operational-workspace/operational-workspace-client-v2.ts',
      'src/features/student-portal-admin/accounts/accounts-client-v2.ts',
      'src/features/gradebook/audit-workspace/relational-current-audit-page-v2.tsx',
      'src/features/gradebook/performance/relational-performance-page-v2.tsx',
      'src/features/gradebook/bulletins/bulletin-page.tsx',
      'src/features/gradebook/council/relational-council-page-v3.tsx',
      'src/platform/gradebook-workspace-shell.tsx',
    ]
      .map(source)
      .join('\n');

    expect(frontend).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.open/u);
    expect(frontend).not.toMatch(/retryDecision|retryEmit|autoRetry/u);
  });

  it('mantém as invariantes acadêmicas da onda 16 intactas', () => {
    const performance = source(
      'Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/performance/d1-class-performance-source-v1.ts',
    );

    expect(performance).toContain('resolvePerformanceComparisonProjectionV2');
  });
});
