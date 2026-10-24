import type { AuthorityModeV1 } from '../../../shared/gradebook-contracts/results/results-contract-v1';

function readinessStatusOf(scopeViolations: number, missingEvidence: number) {
  if (scopeViolations > 0) return 'scope-violation';
  return missingEvidence > 0 ? 'incomplete' : GRADEBOOK_CONTROLLED_PRODUCTION_STATUS_V2;
}

export const GRADEBOOK_CONTROLLED_PRODUCTION_READINESS_VERSION_V2 = 2 as const;

export const GRADEBOOK_CONTROLLED_PRODUCTION_STATUS_V2 =
  'production-infrastructure-smoke-validated-awaiting-private-pilot' as const;

export const GRADEBOOK_CONTROLLED_PRODUCTION_EVIDENCE_V2 = [
  'production-resource-confirmed',
  'production-binding-confirmed',
  'remote-schema-v4-25-confirmed',
  'production-synthetic-smoke-confirmed',
  'synthetic-residue-zero-confirmed',
  'recovery-capability-confirmed',
] as const;

export type GradebookControlledProductionEvidenceIdV2 =
  (typeof GRADEBOOK_CONTROLLED_PRODUCTION_EVIDENCE_V2)[number];

export const GRADEBOOK_POST_WAVE_23_HARD_STOPS_V2 = [
  'private-real-pilot-authorization',
  'native-authority-separate-authorization',
] as const;

export type GradebookPostWave23HardStopIdV2 =
  (typeof GRADEBOOK_POST_WAVE_23_HARD_STOPS_V2)[number];

export interface GradebookControlledProductionReadinessInputV2 {
  readonly authorityMode: AuthorityModeV1;
  readonly productionD1ResourcePresent: boolean;
  readonly productionD1BindingPresent: boolean;
  readonly remoteMigrationsApplied: number;
  readonly schemaVersion: number;
  readonly tableCount: number;
  readonly pendingMigrations: number;
  readonly productionSyntheticSmokeCompleted: boolean;
  readonly syntheticResidueCount: number;
  readonly recoveryCapabilityConfirmed: boolean;
  readonly productionAcademicRuntimeEnabled: boolean;
  readonly realPilotExecuted: boolean;
  readonly nativeAuthorityEnabled: boolean;
}

export type GradebookControlledProductionScopeViolationV2 =
  | 'authority-mode-changed'
  | 'production-gate-left-open'
  | 'real-pilot-already-executed'
  | 'native-authority-enabled'
  | 'remote-schema-contract-mismatch'
  | 'synthetic-residue-present'
  | 'invalid-negative-count';

export interface GradebookControlledProductionReadinessResultV2 {
  readonly version: typeof GRADEBOOK_CONTROLLED_PRODUCTION_READINESS_VERSION_V2;
  readonly status:
    | 'incomplete'
    | typeof GRADEBOOK_CONTROLLED_PRODUCTION_STATUS_V2
    | 'scope-violation';
  readonly missingEvidence: readonly GradebookControlledProductionEvidenceIdV2[];
  readonly scopeViolations: readonly GradebookControlledProductionScopeViolationV2[];
  readonly hardStops: readonly GradebookPostWave23HardStopIdV2[];
}

function hasNegativeCount(input: GradebookControlledProductionReadinessInputV2): boolean {
  return [
    input.remoteMigrationsApplied,
    input.schemaVersion,
    input.tableCount,
    input.pendingMigrations,
    input.syntheticResidueCount,
  ].some((value) => !Number.isInteger(value) || value < 0);
}

function remoteSchemaIsConfirmed(input: GradebookControlledProductionReadinessInputV2): boolean {
  return (
    input.remoteMigrationsApplied === 4 &&
    input.schemaVersion === 4 &&
    input.tableCount === 25 &&
    input.pendingMigrations === 0
  );
}

/**
 * Represents the authorized Wave 23 closure without rewriting the historical V1 preparation model.
 * It is pure state evaluation: no network, Cloudflare, migration, smoke, pilot or authority action.
 */
export function evaluateGradebookControlledProductionReadinessV2(
  input: GradebookControlledProductionReadinessInputV2,
): GradebookControlledProductionReadinessResultV2 {
  const scopeViolations: GradebookControlledProductionScopeViolationV2[] = [];
  const missingEvidence: GradebookControlledProductionEvidenceIdV2[] = [];

  const negativeCount = hasNegativeCount(input);
  if (negativeCount) scopeViolations.push('invalid-negative-count');
  if (input.authorityMode !== 'imported-source') scopeViolations.push('authority-mode-changed');
  if (input.productionAcademicRuntimeEnabled) scopeViolations.push('production-gate-left-open');
  if (input.realPilotExecuted) scopeViolations.push('real-pilot-already-executed');
  if (input.nativeAuthorityEnabled) scopeViolations.push('native-authority-enabled');
  if (input.syntheticResidueCount > 0) scopeViolations.push('synthetic-residue-present');

  if (!input.productionD1ResourcePresent) missingEvidence.push('production-resource-confirmed');
  if (!input.productionD1BindingPresent) missingEvidence.push('production-binding-confirmed');

  if (!negativeCount && !remoteSchemaIsConfirmed(input)) {
    const schemaHasUnexpectedState =
      input.remoteMigrationsApplied > 4 ||
      input.schemaVersion > 4 ||
      input.tableCount > 0 ||
      input.pendingMigrations > 0;
    if (schemaHasUnexpectedState) scopeViolations.push('remote-schema-contract-mismatch');
    else missingEvidence.push('remote-schema-v4-25-confirmed');
  } else if (!negativeCount) {
    // Evidence is complete; nothing to add.
  }

  if (!input.productionSyntheticSmokeCompleted) {
    missingEvidence.push('production-synthetic-smoke-confirmed');
  }
  if (input.syntheticResidueCount !== 0 && input.syntheticResidueCount >= 0) {
    // Residue is a violation above, not merely missing evidence.
  } else if (input.syntheticResidueCount === 0) {
    // Zero residue is explicit evidence.
  } else {
    missingEvidence.push('synthetic-residue-zero-confirmed');
  }
  if (!input.recoveryCapabilityConfirmed) missingEvidence.push('recovery-capability-confirmed');

  return Object.freeze({
    version: GRADEBOOK_CONTROLLED_PRODUCTION_READINESS_VERSION_V2,
    status: readinessStatusOf(scopeViolations.length, missingEvidence.length),
    missingEvidence: Object.freeze(missingEvidence),
    scopeViolations: Object.freeze(scopeViolations),
    hardStops: GRADEBOOK_POST_WAVE_23_HARD_STOPS_V2,
  });
}
