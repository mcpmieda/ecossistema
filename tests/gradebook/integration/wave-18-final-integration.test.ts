import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('integração final da onda 18 — durabilidade, Conselho V2 e relatórios', () => {
  it('preserva durabilidade D1 na memória e snapshots PostgreSQL no handler atual', () => {
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const bulletin = source('server/gradebook/http/bulletin-routes-v1.ts');

    expect(runtime).toContain('createGradebookD1BulletinCouncilDurabilityV1');
    expect(runtime).toContain('bulletinSnapshotRepository()');
    expect(runtime).toContain('councilDecisionStore()');
    expect(runtime).toContain('decisions: this.durability.councilDecisions');
    expect(runtime).not.toContain('createLocalCouncilDecisionStoreV1');
    expect(bulletin).toContain('createRelationalBulletinSnapshotRepositoryV2(database)');
    expect(bulletin).not.toContain('runtime.bulletinSnapshotRepository()');
    expect(bulletin).not.toContain('createLocalBulletinSnapshotRepositoryV1');
  });

  it('monta Conselho relacional V3 no mesmo bridge, sem inventar identidade de diretor', () => {
    const functions = source('functions/[[path]].ts');
    const route = source('server/gradebook/http/council-routes-v1.ts');
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const surface = source('src/platform/gradebook-council-surface.tsx');

    expect(functions).toContain('handleCouncilWorkspaceRequestV1(request, env, afterCommit)');
    expect(functions).not.toContain('.councilInstitutionalWorkspace(');
    expect(route.split('/api/gradebook/council-workspace')).toHaveLength(2);
    expect(runtime).toContain('createCouncilInstitutionalWorkspaceV2');
    expect(surface).toContain('RelationalCouncilPageV3');
    expect(surface).not.toContain('CouncilInstitutionalPanelV2');
    expect(route).toContain('createRelationalCouncilV3');
    expect(route).not.toContain('ADMINISTRADOR == diretor');
    expect(route).not.toContain('directorRole');
  });

  it('preserva o renderer compartilhado e aposenta o gerador em lote sem montagem', () => {
    expect(existsSync(join(root, 'src/features/gradebook/bulletins/pdf/bulletin-pdf-batch-actions-v1.ts'))).toBe(false);
    expect(source('src/features/gradebook/bulletins/pdf/bulletin-pdf-renderer-v2.ts')).toContain("from './bulletin-pdf-engine'");
  });

  it('preserva o gate histórico e mantém a autoridade atual sem runtime D1', () => {
    const councilRoute = source('server/gradebook/http/council-routes-v1.ts');
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const context = source('docs/gradebook/ACADEMIC_CONTEXT.md');

    expect(councilRoute).not.toContain("env.RUNTIME_ENVIRONMENT === 'production'");
    expect(runtime).toContain("env.GRADEBOOK_PRODUCTION_ENABLED !== 'true'");
    expect(context).toContain('authorityMode: imported-source');
    expect(context).not.toContain('authorityMode: native-engine');
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
