import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('integração final da onda 22 — bridges e checkpoint', () => {
  it('mantém configuração server-side na área global e o write administrativo em hard stop', () => {
    const platformSnapshot = source('server/platform/snapshot.ts');
    const settingsPage = source('src/platform/pages.tsx');
    const comparisonPanel = source('src/features/gradebook/performance/performance-term-comparison-panel-v4.tsx');
    const performanceRoute = source('server/gradebook/http/performance-routes-v1.ts');

    expect(platformSnapshot).toContain("list: 'PLATAFORMA_CONFIGURACOES'");
    expect(settingsPage).toContain('snapshot.configurations.map');
    expect(settingsPage).toContain('Configurações institucionais');
    expect(performanceRoute).toContain("requireCapability(capabilities, 'platform.settings.read')");
    expect(comparisonPanel).toContain('não mede evolução pedagógica');
    expect(`${settingsPage}${comparisonPanel}`).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
  });

  it('preserva bridges atuais e catálogo D1 0001–0006 históricos', () => {
    expect(readdirSync(join(root, 'Aprendizados/RUNTIME-D1-RETIRADO-1079/migrations/gradebook')).sort()).toEqual([
      '0001_gradebook_context_entities_imports_v1.sql',
      '0002_gradebook_records_audit_v1.sql',
      '0003_logical_source_record_catalog_v1.sql',
      '0004_bulletin_council_durability_v1.sql',
      '0005_council_session_durability_v2.sql',
      '0006_import_staging_v1.sql',
    ]);

    const functions = source('functions/[[path]].ts');
    expect(functions).toContain('handlePerformanceRequestV1(request, env)');
    expect(functions).not.toContain('handleAuditWorkspaceRequestV1');
    expect(functions).not.toContain('/api/gradebook/audit-workspace');
    expect(source('server/gradebook/http/performance-routes-v1.ts')).toContain("GRADEBOOK_PERFORMANCE_ROUTE_V1 = '/api/gradebook/performance'");
    expect(source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts')).toContain('deterministicCorrectionWorkspace(');
  });

  it('preserva o checkpoint documental das ondas 22–24 sem impor flags antigas ao programa final', () => {
    const projectState = source('docs/gradebook/history/pre-final-1/PROJECT_STATE.yaml');
    const startHere = source('docs/gradebook/history/pre-final-1/COMECE_AQUI.md');
    const readiness = source('docs/gradebook/history/pre-final-1/PRODUCTION_READINESS.md');

    expect(projectState).toContain('current_wave: 24');
    expect(projectState).toContain('next_wave: 24');
    expect(projectState).toContain('academic_authority_mode: imported-source');
    expect(projectState).toContain('production_academic_runtime_enabled: false');
    expect(projectState).toContain('production_d1_binding_present: true');
    expect(projectState).toContain('remote_migration_applied: true');
    expect(projectState).toContain('production_gate_final: off');
    expect(startHere).toContain('Onda 24 — pré-piloto até schema 5');
    expect(readiness).toContain('production-infrastructure-smoke-validated-awaiting-private-pilot');
  });
});
