import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PERFORMANCE_COMPARISON_CONFIGURATION_V1,
  type PerformanceComparisonOperandV2,
  type PerformanceComparisonProfileRefV2,
} from '../../../shared/gradebook-contracts/performance/performance-comparison-contract-v2';
import {
  isDeterministicCorrectionProofV2,
  resolvePilotFlowStateV2,
  type ReconciliationResultV2,
} from '../../../shared/gradebook-contracts/audit/reconciliation-contract-v2';
import type { ReconciliationResultId } from '../../../shared/gradebook-contracts/audit/audit-contract-v1';
import type { GradeEntryId } from '../../../shared/gradebook-contracts/results/results-contract-v1';
import { resolvePerformanceComparisonProjectionV2 } from '../../../server/gradebook/application/read-models/performance/performance-comparison-resolver-v2';
import {
  evaluateGradebookProductionReadinessPreparationV1,
  GRADEBOOK_PRODUCTION_HARD_STOPS_V1,
  GRADEBOOK_READINESS_PREPARATION_EVIDENCE_V1,
} from '../../../server/gradebook/readiness/production-readiness-v1';

const root = process.cwd();
function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function operand(term: 1 | 2 | 3, percentage: number): PerformanceComparisonOperandV2 {
  return {
    period: { kind: 'term', term },
    percentage: { state: 'numeric', value: percentage },
    coverage: {
      state: 'complete', expectedItemCount: 1, resolvedItemCount: 1,
      missingItemCount: 0, reasons: [],
    },
  };
}

describe('integração final da onda 22 — comparação e correção determinística', () => {
  it('integra comparação percentual profile-aware sem tolerância ou máximo hard-coded', () => {
    const profile = {
      profileId: 'evaluation-profile:wave-22', profileVersion: '1',
      percentageSemanticsVersion: 'official-percentage:wave-22:v1',
    } satisfies PerformanceComparisonProfileRefV2;
    const projection = resolvePerformanceComparisonProjectionV2({
      selection: { current: { kind: 'term', term: 1 }, reference: { kind: 'term', term: 3 } },
      configuration: DEFAULT_PERFORMANCE_COMPARISON_CONFIGURATION_V1,
      current: operand(1, (24 / 30) * 100), reference: operand(3, (32 / 40) * 100),
      currentProfile: profile, referenceProfile: profile,
    });

    expect(projection).toMatchObject({
      state: 'resolved',
      comparison: { state: 'comparable', basis: 'percentage', relation: 'proportionally-equal' },
    });
    const resolver = source('server/gradebook/application/read-models/performance/performance-comparison-resolver-v2.ts');
    expect(resolver).not.toMatch(/30\s*\/\s*30\s*\/\s*40|tolerance|epsilon/u);
  });

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

  it('para impacto potencial e rejeita correção sem prova determinística fechada', () => {
    const divergence = {
      id: 'reconciliation-result:wave-22:synthetic' as ReconciliationResultId,
      target: { kind: 'grade-entry', id: 'grade-entry:wave-22:synthetic' as GradeEntryId },
      value: {
        imported: {
          value: { state: 'numeric', value: 7 },
          evidence: [{
            classification: 'manual-positive-number', rawValue: 7,
            provenance: {
              fileName: 'wave-22-synthetic.xlsx', fileSha256: 'a'.repeat(64),
              sheetName: 'Synthetic', cellAddress: 'R5',
            },
          }],
        },
        calculated: { value: { state: 'numeric', value: 8 } },
      },
      ruleVersion: 'reconciliation:wave-22:v2', status: 'mismatch', difference: 1,
    } satisfies ReconciliationResultV2;

    expect(resolvePilotFlowStateV2({
      divergence,
      academicImpact: {
        state: 'potentially-material', basis: 'fail-closed-unresolved',
        reason: 'Impacto sintético não resolvido.',
      },
      investigation: { state: 'required', reason: 'Investigação sintética obrigatória.' },
    })).toMatchObject({ state: 'stop', authorityMode: 'imported-source' });
    expect(isDeterministicCorrectionProofV2({
      candidateOperationCount: 2, requiresHumanJudgment: true, destination: 'source-document',
    })).toBe(false);

    const correction = source('server/gradebook/application/audit-workspace/deterministic-correction-v2.ts');
    expect(correction).toContain('planImportReconciliation(');
    expect(correction).toContain('executeImportChangePlan(');
    expect(correction).not.toContain('patchArbitrary');
  });

  it('preserva bridges atuais e autoridade/readiness/catálogo D1 0001–0006 históricos', () => {
    expect(readdirSync(join(root, 'Aprendizados/RUNTIME-D1-RETIRADO-1079/migrations/gradebook')).sort()).toEqual([
      '0001_gradebook_context_entities_imports_v1.sql',
      '0002_gradebook_records_audit_v1.sql',
      '0003_logical_source_record_catalog_v1.sql',
      '0004_bulletin_council_durability_v1.sql',
      '0005_council_session_durability_v2.sql',
      '0006_import_staging_v1.sql',
    ]);
    const readiness = evaluateGradebookProductionReadinessPreparationV1({
      authorityMode: 'imported-source', productionAcademicRuntimeEnabled: false,
      productionD1BindingPresent: false, remoteMigrationsApplied: false,
      realPilotExecuted: false, completedEvidence: GRADEBOOK_READINESS_PREPARATION_EVIDENCE_V1,
    });
    expect(readiness.status).toBe('prepared-for-manual-authorization');
    expect(readiness.hardStops).toEqual(GRADEBOOK_PRODUCTION_HARD_STOPS_V1);

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
