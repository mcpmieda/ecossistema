import type { AuthorityModeV1 } from '../../../shared/gradebook-contracts/results/results-contract-v1';

function readinessStatusOf(scopeViolations: number, missingEvidence: number) {
  if (scopeViolations > 0) return 'scope-violation';
  return missingEvidence > 0 ? 'incomplete' : 'prepared-for-manual-authorization';
}

export const GRADEBOOK_READINESS_PREPARATION_EVIDENCE_V1 = [
  'final-sha-verify',
  'synthetic-critical-flow-rehearsal',
  'rollback-recovery-rehearsal',
  'security-privacy-regression',
  'private-pilot-protocol-review',
  'future-smoke-plan-review',
] as const;

export type GradebookReadinessPreparationEvidenceIdV1 =
  (typeof GRADEBOOK_READINESS_PREPARATION_EVIDENCE_V1)[number];

export const GRADEBOOK_PRODUCTION_HARD_STOPS_V1 = [
  'production-resource-and-binding-authorization',
  'remote-migration-authorization',
  'production-academic-smoke-authorization',
  'private-real-pilot-authorization',
  'native-authority-separate-authorization',
] as const;

export type GradebookProductionHardStopIdV1 = (typeof GRADEBOOK_PRODUCTION_HARD_STOPS_V1)[number];

export const GRADEBOOK_SYNTHETIC_READINESS_SCENARIOS_V1 = [
  {
    id: 'bounded-import-batch',
    scale: '50 synthetic workbooks',
    invariant: 'sequential processing and isolated file failure',
  },
  {
    id: 'local-schema-replay',
    scale: 'migrations 0001-0004 applied and replayed',
    invariant: 'idempotent schema at version 4 with 25 tables',
  },
  {
    id: 'durable-bulletin-history',
    scale: '30 synthetic students with two snapshots each',
    invariant: 'append-only history, bounded page and restart recovery',
  },
  {
    id: 'durable-council-queue',
    scale: '30 synthetic students plus one competing CAS pair',
    invariant: 'batched versions, one CAS winner and restart recovery',
  },
  {
    id: 'production-fail-closed',
    scale: 'production runtime with a binding probe',
    invariant: 'runtime rejects before touching the binding',
  },
] as const;

export type GradebookSyntheticReadinessScenarioIdV1 =
  (typeof GRADEBOOK_SYNTHETIC_READINESS_SCENARIOS_V1)[number]['id'];

export const GRADEBOOK_FUTURE_PRODUCTION_SMOKE_PLAN_V1 = [
  {
    id: 'public-shell',
    method: 'GET',
    path: '/',
    dataProfile: 'none',
    prerequisite: null,
  },
  {
    id: 'unauthenticated-non-disclosure',
    method: 'GET',
    path: '/api/gradebook/admin/persistence/status',
    dataProfile: 'none',
    prerequisite: null,
  },
  {
    id: 'authorized-schema-status',
    method: 'GET',
    path: '/api/gradebook/admin/persistence/status',
    dataProfile: 'aggregate-only',
    prerequisite: 'production-resource-and-binding-authorization',
  },
  {
    id: 'authorized-synthetic-academic-read',
    method: 'POST',
    path: '/api/gradebook/performance',
    dataProfile: 'synthetic-only',
    prerequisite: 'production-academic-smoke-authorization',
  },
  {
    id: 'authorized-synthetic-snapshot-write',
    method: 'POST',
    path: '/api/gradebook/bulletins',
    dataProfile: 'synthetic-only',
    prerequisite: 'production-academic-smoke-authorization',
  },
] as const satisfies readonly {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly dataProfile: 'none' | 'aggregate-only' | 'synthetic-only';
  readonly prerequisite: GradebookProductionHardStopIdV1 | null;
}[];

export interface GradebookProductionReadinessPreparationInputV1 {
  readonly authorityMode: AuthorityModeV1;
  readonly productionAcademicRuntimeEnabled: boolean;
  readonly productionD1BindingPresent: boolean;
  readonly remoteMigrationsApplied: boolean;
  readonly realPilotExecuted: boolean;
  readonly completedEvidence: readonly GradebookReadinessPreparationEvidenceIdV1[];
}

export type GradebookProductionReadinessScopeViolationV1 =
  | 'authority-mode-changed'
  | 'production-academic-runtime-enabled'
  | 'production-d1-binding-present'
  | 'remote-migrations-applied'
  | 'real-pilot-executed';

export interface GradebookProductionReadinessPreparationResultV1 {
  readonly status: 'incomplete' | 'prepared-for-manual-authorization' | 'scope-violation';
  readonly missingEvidence: readonly GradebookReadinessPreparationEvidenceIdV1[];
  readonly scopeViolations: readonly GradebookProductionReadinessScopeViolationV1[];
  readonly hardStops: readonly GradebookProductionHardStopIdV1[];
}

/**
 * Evaluates preparation only. It cannot authorize, provision, migrate, smoke or activate production.
 */
export function evaluateGradebookProductionReadinessPreparationV1(
  input: GradebookProductionReadinessPreparationInputV1,
): GradebookProductionReadinessPreparationResultV1 {
  const completed = new Set(input.completedEvidence);
  const missingEvidence = GRADEBOOK_READINESS_PREPARATION_EVIDENCE_V1.filter(
    (evidence) => !completed.has(evidence),
  );
  const scopeViolations: GradebookProductionReadinessScopeViolationV1[] = [];

  if (input.authorityMode !== 'imported-source') {
    scopeViolations.push('authority-mode-changed');
  }
  if (input.productionAcademicRuntimeEnabled) {
    scopeViolations.push('production-academic-runtime-enabled');
  }
  if (input.productionD1BindingPresent) {
    scopeViolations.push('production-d1-binding-present');
  }
  if (input.remoteMigrationsApplied) {
    scopeViolations.push('remote-migrations-applied');
  }
  if (input.realPilotExecuted) {
    scopeViolations.push('real-pilot-executed');
  }

  return Object.freeze({
    status: readinessStatusOf(scopeViolations.length, missingEvidence.length),
    missingEvidence: Object.freeze(missingEvidence),
    scopeViolations: Object.freeze(scopeViolations),
    hardStops: GRADEBOOK_PRODUCTION_HARD_STOPS_V1,
  });
}
