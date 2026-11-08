// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BULLETIN_AUTHORITY_MODE_V1 } from '../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';
import { PERFORMANCE_AUTHORITY_MODE_V1 } from '../../../shared/gradebook-contracts/performance/class-performance-read-model-v1';
import { createClassPerformanceReadModelV1 } from '../../../server/gradebook/application/read-models/performance/class-performance-read-model-v1';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('integração da onda 14 F4/F5/F6/F8 após wiring da onda 16', () => {
  it('mantém as implementações provider-independent disponíveis com autoridade imported-source', () => {
    expect(createClassPerformanceReadModelV1).toBeTypeOf('function');
    expect(PERFORMANCE_AUTHORITY_MODE_V1).toBe('imported-source');
    expect(BULLETIN_AUTHORITY_MODE_V1).toBe('imported-source');
  });

  it('preserva a composição física original e reconhece somente os bridges ainda ativos', () => {
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const runtimeAuthorization = source(
      'server/gradebook/authorization-v1.ts',
    );
    const capabilities = source('server/auth/capabilities.ts');
    const functions = source('functions/[[path]].ts');

    expect(runtime).toContain('createAuditWorkspaceV1');
    expect(runtime).toContain('GradebookD1AuditWorkspaceSourceV1');
    expect(runtime).toContain('createClassPerformanceReadModelV1');
    expect(runtime).toContain('createGradebookD1ClassPerformanceSourceV1');
    expect(runtime).toContain('requireGradebookRuntimeAuthorizationV1(this.authorization)');
    expect(runtime).not.toContain('createBulletinEmissionServiceV1');

    expect(functions.match(/handleOperationalWorkspaceRequestV1/gu)).toHaveLength(2);
    expect(functions).not.toContain('handleAuditWorkspaceRequestV1');
    expect(functions.match(/handlePerformanceRequestV1/gu)).toHaveLength(2);
    expect(functions.match(/handleBulletinRequestV1/gu)).toHaveLength(2);
    expect(functions.match(/handleCouncilWorkspaceRequestV1/gu)).toHaveLength(2);
    expect(functions).not.toMatch(/bulletin.*pdf|pdf.*bulletin/iu);
    expect(runtimeAuthorization.match(/gradebook\.persistence\.admin/gu)).toHaveLength(1);
    expect(capabilities.match(/'gradebook\.persistence\.admin'/gu)).toHaveLength(1);
  });

  it('mantém bridges únicos e preserva a evidência do gate histórico antes do binding', () => {
    const runtime = source('Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts');
    const operationalRoute = source('server/gradebook/http/operational-workspace-routes-v1.ts');
    const performanceRoute = source('server/gradebook/http/performance-routes-v1.ts');
    const bulletinRoute = source('server/gradebook/http/bulletin-routes-v1.ts');
    const councilRoute = source('server/gradebook/http/council-routes-v1.ts');

    expect(operationalRoute.match(/'\/api\/gradebook\/operational-workspace'/gu)).toHaveLength(1);
    expect(performanceRoute.match(/'\/api\/gradebook\/performance'/gu)).toHaveLength(1);
    expect(bulletinRoute.match(/'\/api\/gradebook\/bulletins'/gu)).toHaveLength(1);
    expect(councilRoute.match(/'\/api\/gradebook\/council-workspace'/gu)).toHaveLength(1);

    const environmentGate = runtime.indexOf('const environment = runtimeEnvironment(env);');
    const bindingAccess = runtime.indexOf('const database = requireDatabase(env.GRADEBOOK_DATABASE ?? env.GRADEBOOK_D1);');
    expect(environmentGate).toBeGreaterThanOrEqual(0);
    expect(bindingAccess).toBeGreaterThan(environmentGate);
  });
});
