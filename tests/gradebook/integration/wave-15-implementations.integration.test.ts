// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BULLETIN_AUTHORITY_MODE_V1 } from '../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';
import { PERFORMANCE_AUTHORITY_MODE_V1 } from '../../../shared/gradebook-contracts/performance/class-performance-read-model-v1';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('integração da onda 15 F4/F5/F6/F8 após wiring da onda 16', () => {
  it('preserva o bridge Operational e mantém Audit V1/PDF fora do wiring central', () => {
    const functions = source('functions/[[path]].ts');
    const operationalRoute = source('server/gradebook/http/operational-workspace-routes-v1.ts');

    expect(operationalRoute.match(/'\/api\/gradebook\/operational-workspace'/gu)).toHaveLength(1);
    expect(functions).not.toContain('handleAuditWorkspaceRequestV1');
    expect(functions).not.toContain('/api/gradebook/audit-workspace');
    expect(functions.match(/handleOperationalWorkspaceRequestV1/gu)).toHaveLength(2);
    expect(functions).not.toMatch(/bulletin.*pdf|pdf.*bulletin/iu);
  });

  it('preserva a composição física de Desempenho e a autoridade imported-source', () => {
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const performanceSource = source(
      'Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/performance/d1-class-performance-source-v1.ts',
    );

    expect(runtime).toContain('createGradebookD1ClassPerformanceSourceV1');
    expect(runtime).toContain('createClassPerformanceReadModelV1');
    expect(runtime).toContain('classPerformanceReadModel()');
    expect(runtime).toContain('requireGradebookRuntimeAuthorizationV1(this.authorization)');
    expect(runtime).not.toContain('createBulletinEmissionServiceV1');
    expect(performanceSource).toContain('resolvePerformanceComparisonProjectionV2');
    expect(performanceSource).toContain("reasons: ['official-projection-unavailable']");
    expect(PERFORMANCE_AUTHORITY_MODE_V1).toBe('imported-source');
    expect(BULLETIN_AUTHORITY_MODE_V1).toBe('imported-source');
  });

  it('preserva hardening do Operational Workspace sem alterar seus limites físicos', () => {
    const yearProvider = source('src/platform/gradebook-year-provider.tsx');
    const performanceHook = source('src/features/gradebook/performance/use-relational-performance-v2.ts');
    const operationalGate = source(
      'src/features/gradebook/operational-workspace/operational-workspace-request-gate.ts',
    );

    expect(yearProvider).toContain('requestOperationalWorkspaceV2');
    expect(performanceHook).toContain('createOperationalWorkspaceRequestGate');
    expect(performanceHook).toContain('ticket.isCurrent()');
    expect(operationalGate).toContain('active?.controller.abort()');
  });

  it('mantém produção acadêmica fail-closed antes do binding', () => {
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const environmentGate = runtime.indexOf('const environment = runtimeEnvironment(env);');
    const bindingAccess = runtime.indexOf('const database = requireDatabase(env.GRADEBOOK_DATABASE ?? env.GRADEBOOK_D1);');

    expect(environmentGate).toBeGreaterThanOrEqual(0);
    expect(bindingAccess).toBeGreaterThan(environmentGate);
  });
});
