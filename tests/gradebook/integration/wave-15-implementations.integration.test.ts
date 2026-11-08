// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
