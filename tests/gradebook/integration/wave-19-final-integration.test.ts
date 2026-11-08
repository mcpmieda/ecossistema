import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

// These assertions preserve the old planning checkpoint, not current production flags.
const historicalState = 'docs/gradebook/history/pre-final-1/PROJECT_STATE.yaml';
const historicalContext = 'docs/gradebook/history/pre-final-1/ACADEMIC_CONTEXT.md';

describe('integração final da onda 19 — fechamentos F4/F5/F6', () => {
  it('preserva a categoria livre do contrato de auditoria', () => {
    const auditContract = source('shared/gradebook-contracts/audit/audit-contract-v1.ts');
    expect(auditContract).toContain('readonly category: string;');
  });

  it('mantém a manutenção docente retirada e preserva as leituras operacionais compartilhadas', () => {
    const shell = source('src/platform/gradebook-workspace-shell.tsx');
    const yearProvider = source('src/platform/gradebook-year-provider.tsx');
    const accounts = source('src/features/student-portal-admin/accounts/accounts-client-v2.ts');

    expect(shell).not.toContain('gradebook-operational-surface');
    expect(shell).not.toContain("id: 'operational'");
    expect(yearProvider).toContain('requestOperationalWorkspaceV2');
    expect(yearProvider).toContain("operation: 'bootstrap'");
    expect(accounts).toContain('requestOperationalWorkspaceV2');
    expect(accounts).toContain("result.operation !== 'search'");
    expect(existsSync(join(root, 'src/features/gradebook/operational-workspace/teacher-assignment-maintenance-workspace.tsx'))).toBe(false);
    expect(existsSync(join(root, 'server/gradebook/application/operational-workspace/teacher-assignment-maintenance-v1.ts'))).toBe(false);
  });

  it('preserva bridges e browser storage e registra o catálogo do checkpoint histórico', () => {
    const functions = source('functions/[[path]].ts');
    const shell = source('src/platform/gradebook-workspace-shell.tsx');
    const f5Frontend = [
      'src/platform/gradebook-year-provider.tsx',
      'src/features/student-portal-admin/accounts/accounts-client-v2.ts',
      'src/features/gradebook/operational-workspace/operational-workspace-client-v2.ts',
      'src/features/gradebook/performance/performance-dashboard-widgets-v5.tsx',
    ].map(source).join('\n');

    expect(functions.match(/\/api\/gradebook\/operational-workspace/g) ?? []).toHaveLength(0);
    expect(shell).not.toContain("id: 'operational'");
    expect(f5Frontend).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.open|serviceWorker/u);
    expect(source(historicalState)).toContain('0004_bulletin_council_durability_v1.sql');
    expect(source(historicalState)).toContain('0005_council_session_durability_v2.sql');
  });

  it('preserva as flags históricas sem usá-las como prova da produção atual', () => {
    const projectState = source(historicalState);
    const academicContext = source(historicalContext);
    const route = source('server/gradebook/http/operational-workspace-routes-v1.ts');

    expect(projectState).toContain('academic_authority_mode: imported-source');
    expect(projectState).toContain('production_academic_runtime_enabled: false');
    expect(projectState).toContain('production_d1_binding_present: true');
    expect(projectState).toContain('production_gate_final: off');
    expect(academicContext).toContain('authorityMode: imported-source');
    expect(route).not.toContain('createGradebookD1RuntimeV1');
    expect(route).toContain('return retiredGradebookRequestV1(payload)');
  });

  it('não reinterpreta o checkpoint de autoridade F9/#347', () => {
    const projectState = source(historicalState);
    const context = source(historicalContext);

    expect(projectState).toContain('authority_transition_issue: 347');
    expect(projectState).toContain('authority_switch_completed: false');
    expect(context).not.toContain('authorityMode: native-engine');
  });
});
