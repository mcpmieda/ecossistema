import type { PlatformConfiguration } from '../../platform-contract';
import type {
  AcademicGradeValueV1,
  ResultCoverageV1,
} from '../results/results-contract-v1';
import {
  CLASS_PERFORMANCE_CONTRACT_V1,
  type PerformancePeriodV1,
} from './class-performance-read-model-v1';

export const PERFORMANCE_COMPARISON_CONTRACT_VERSION_V2 = 2 as const;
export const PERFORMANCE_COMPARISON_BASIS_V2 = 'percentage' as const;

export const PERFORMANCE_PROPORTIONAL_RELATIONS_V2 = [
  'proportionally-higher',
  'proportionally-equal',
  'proportionally-lower',
] as const;
export type PerformanceProportionalRelationV2 =
  (typeof PERFORMANCE_PROPORTIONAL_RELATIONS_V2)[number];

export const PERFORMANCE_COMPARISON_NOT_COMPARABLE_REASONS_V2 = [
  'profile-semantics-not-declared-compatible',
  'current-coverage-partial',
  'current-coverage-insufficient-data',
  'current-coverage-not-applicable',
  'reference-coverage-partial',
  'reference-coverage-insufficient-data',
  'reference-coverage-not-applicable',
  'current-percentage-absent',
  'current-percentage-not-applicable',
  'current-percentage-insufficient-data',
  'current-percentage-invalid',
  'reference-percentage-absent',
  'reference-percentage-not-applicable',
  'reference-percentage-insufficient-data',
  'reference-percentage-invalid',
] as const;
export type PerformanceComparisonNotComparableReasonV2 =
  (typeof PERFORMANCE_COMPARISON_NOT_COMPARABLE_REASONS_V2)[number];

export interface PerformanceComparisonProfileRefV2 {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly percentageSemanticsVersion: string;
}

export type PerformanceProfileCompatibilityV2 =
  | {
      readonly state: 'compatible';
      readonly source: 'same-profile-semantics' | 'declared-cross-profile-compatibility';
      readonly ruleVersion: string;
      readonly currentProfile: PerformanceComparisonProfileRefV2;
      readonly referenceProfile: PerformanceComparisonProfileRefV2;
    }
  | {
      readonly state: 'not-compatible';
      readonly reason: 'profile-semantics-not-declared-compatible';
      readonly ruleVersion: string | null;
      readonly currentProfile: PerformanceComparisonProfileRefV2;
      readonly referenceProfile: PerformanceComparisonProfileRefV2;
    };

export interface PerformanceComparisonOperandV2 {
  readonly period: PerformancePeriodV1;
  readonly percentage: AcademicGradeValueV1;
  readonly coverage: ResultCoverageV1;
}

export type PerformanceProportionalComparisonV2 =
  | {
      readonly state: 'comparable';
      readonly basis: typeof PERFORMANCE_COMPARISON_BASIS_V2;
      readonly relation: PerformanceProportionalRelationV2;
      readonly current: PerformanceComparisonOperandV2;
      readonly reference: PerformanceComparisonOperandV2;
      readonly compatibility: Extract<PerformanceProfileCompatibilityV2, { readonly state: 'compatible' }>;
    }
  | {
      readonly state: 'not-comparable';
      readonly basis: typeof PERFORMANCE_COMPARISON_BASIS_V2;
      readonly reason: PerformanceComparisonNotComparableReasonV2;
      readonly current: PerformanceComparisonOperandV2;
      readonly reference: PerformanceComparisonOperandV2;
      readonly compatibility: PerformanceProfileCompatibilityV2;
    };

export const PERFORMANCE_COMPARISON_CONFIGURATION_KEY_V1 =
  'gradebook.performance.proportional-comparison' as const;
export const PERFORMANCE_COMPARISON_CONFIGURATION_SCOPE_V1 = 'global' as const;
export const PERFORMANCE_COMPARISON_DEFAULT_ENABLED_V1 = true as const;

interface PerformanceComparisonConfigurationBaseV1 {
  readonly key: typeof PERFORMANCE_COMPARISON_CONFIGURATION_KEY_V1;
  readonly scope: typeof PERFORMANCE_COMPARISON_CONFIGURATION_SCOPE_V1;
}

export type PerformanceComparisonConfigurationV1 =
  | (PerformanceComparisonConfigurationBaseV1 & {
      readonly source: 'canonical-default';
      readonly enabled: true;
      readonly platformConfigurationId: null;
      readonly version: null;
      readonly effectiveFrom: null;
      readonly effectiveUntil: null;
      readonly updatedAt: null;
    })
  | (PerformanceComparisonConfigurationBaseV1 & {
      readonly source: 'platform-configuration';
      readonly enabled: true;
      readonly platformConfigurationId: string;
      readonly version: string;
      readonly effectiveFrom: string;
      readonly effectiveUntil: string;
      readonly updatedAt: string;
    })
  | (PerformanceComparisonConfigurationBaseV1 & {
      readonly source: 'platform-configuration';
      readonly enabled: false;
      readonly platformConfigurationId: string;
      readonly version: string;
      readonly effectiveFrom: string;
      readonly effectiveUntil: string;
      readonly updatedAt: string;
    });

export const DEFAULT_PERFORMANCE_COMPARISON_CONFIGURATION_V1 = {
  source: 'canonical-default',
  key: PERFORMANCE_COMPARISON_CONFIGURATION_KEY_V1,
  scope: PERFORMANCE_COMPARISON_CONFIGURATION_SCOPE_V1,
  enabled: PERFORMANCE_COMPARISON_DEFAULT_ENABLED_V1,
  platformConfigurationId: null,
  version: null,
  effectiveFrom: null,
  effectiveUntil: null,
  updatedAt: null,
} as const satisfies PerformanceComparisonConfigurationV1;

export interface PerformanceComparisonSelectionV2 {
  readonly current: PerformancePeriodV1;
  readonly reference: PerformancePeriodV1;
}

export type PerformanceComparisonProjectionV2 =
  | {
      readonly state: 'not-requested';
      readonly configuration: PerformanceComparisonConfigurationV1;
    }
  | {
      readonly state: 'disabled';
      readonly selection: PerformanceComparisonSelectionV2;
      readonly configuration: Extract<
        PerformanceComparisonConfigurationV1,
        { readonly enabled: false }
      >;
    }
  | {
      readonly state: 'resolved';
      readonly selection: PerformanceComparisonSelectionV2;
      readonly configuration: Extract<
        PerformanceComparisonConfigurationV1,
        { readonly enabled: true }
      >;
      readonly comparison: PerformanceProportionalComparisonV2;
    };

function unavailableCoverageReason(
  side: 'current' | 'reference',
  coverage: ResultCoverageV1,
): PerformanceComparisonNotComparableReasonV2 | null {
  switch (coverage.state) {
    case 'complete':
      return null;
    case 'partial':
      return `${side}-coverage-partial`;
    case 'insufficient-data':
      return `${side}-coverage-insufficient-data`;
    case 'not-applicable':
      return `${side}-coverage-not-applicable`;
  }
}

function comparablePercentage(
  side: 'current' | 'reference',
  value: AcademicGradeValueV1,
):
  | { readonly state: 'value'; readonly value: number }
  | {
      readonly state: 'not-comparable';
      readonly reason: PerformanceComparisonNotComparableReasonV2;
    } {
  switch (value.state) {
    case 'numeric':
      return Number.isFinite(value.value)
        ? { state: 'value', value: value.value }
        : { state: 'not-comparable', reason: `${side}-percentage-invalid` };
    case 'official-zero':
    case 'legacy-zero':
      return { state: 'value', value: 0 };
    case 'absent':
      return { state: 'not-comparable', reason: `${side}-percentage-absent` };
    case 'not-applicable':
      return { state: 'not-comparable', reason: `${side}-percentage-not-applicable` };
    case 'insufficient-data':
      return { state: 'not-comparable', reason: `${side}-percentage-insufficient-data` };
  }
}

/**
 * Contract-level comparison over percentages that were already resolved by the official academic
 * profile. It never selects a hidden reference period, recomputes a grade, or applies epsilon.
 */
export function comparePerformancePercentagesV2(input: {
  readonly current: PerformanceComparisonOperandV2;
  readonly reference: PerformanceComparisonOperandV2;
  readonly compatibility: PerformanceProfileCompatibilityV2;
}): PerformanceProportionalComparisonV2 {
  const base = {
    basis: PERFORMANCE_COMPARISON_BASIS_V2,
    current: input.current,
    reference: input.reference,
  } as const;

  if (input.compatibility.state !== 'compatible') {
    return {
      ...base,
      state: 'not-comparable',
      reason: 'profile-semantics-not-declared-compatible',
      compatibility: input.compatibility,
    };
  }

  const currentCoverageReason = unavailableCoverageReason('current', input.current.coverage);
  if (currentCoverageReason !== null) {
    return {
      ...base,
      state: 'not-comparable',
      reason: currentCoverageReason,
      compatibility: input.compatibility,
    };
  }

  const referenceCoverageReason = unavailableCoverageReason('reference', input.reference.coverage);
  if (referenceCoverageReason !== null) {
    return {
      ...base,
      state: 'not-comparable',
      reason: referenceCoverageReason,
      compatibility: input.compatibility,
    };
  }

  const current = comparablePercentage('current', input.current.percentage);
  if (current.state === 'not-comparable') {
    return {
      ...base,
      state: 'not-comparable',
      reason: current.reason,
      compatibility: input.compatibility,
    };
  }

  const reference = comparablePercentage('reference', input.reference.percentage);
  if (reference.state === 'not-comparable') {
    return {
      ...base,
      state: 'not-comparable',
      reason: reference.reason,
      compatibility: input.compatibility,
    };
  }

  let relation: PerformanceProportionalRelationV2;
  if (current.value === reference.value) {
    relation = 'proportionally-equal';
  } else if (current.value > reference.value) {
    relation = 'proportionally-higher';
  } else {
    relation = 'proportionally-lower';
  }

  return {
    ...base,
    state: 'comparable',
    relation,
    compatibility: input.compatibility,
  };
}

/**
 * Maps the existing server-side platform snapshot representation into the gradebook setting.
 * Temporal selection of the applicable platform row remains a server responsibility.
 */
export function resolvePerformanceComparisonConfigurationV1(
  configuration: PlatformConfiguration | null,
): PerformanceComparisonConfigurationV1 {
  if (configuration === null) return DEFAULT_PERFORMANCE_COMPARISON_CONFIGURATION_V1;
  if (
    configuration.key !== PERFORMANCE_COMPARISON_CONFIGURATION_KEY_V1 ||
    configuration.scope !== PERFORMANCE_COMPARISON_CONFIGURATION_SCOPE_V1 ||
    configuration.version.trim().length === 0
  ) {
    throw new Error('invalid-performance-comparison-platform-configuration');
  }

  const base = {
    source: 'platform-configuration' as const,
    key: PERFORMANCE_COMPARISON_CONFIGURATION_KEY_V1,
    scope: PERFORMANCE_COMPARISON_CONFIGURATION_SCOPE_V1,
    platformConfigurationId: configuration.id,
    version: configuration.version,
    effectiveFrom: configuration.effectiveFrom,
    effectiveUntil: configuration.effectiveUntil,
    updatedAt: configuration.updatedAt,
  };

  return configuration.active ? { ...base, enabled: true } : { ...base, enabled: false };
}

export const PERFORMANCE_COMPARISON_CONTRACT_V2 = {
  version: PERFORMANCE_COMPARISON_CONTRACT_VERSION_V2,
  predecessorVersion: CLASS_PERFORMANCE_CONTRACT_V1.version,
  compatibility: {
    reinterpretHistoricalV1: false,
  },
  basis: PERFORMANCE_COMPARISON_BASIS_V2,
  relations: PERFORMANCE_PROPORTIONAL_RELATIONS_V2,
  notComparableReasons: PERFORMANCE_COMPARISON_NOT_COMPARABLE_REASONS_V2,
  periodSelection: {
    current: 'explicit-request-period',
    reference: 'explicit-selected-comparison-period',
    hiddenReferenceSelection: 'forbidden',
  },
  profileCompatibility: {
    scaleOnlyDifferenceCanCompare: true,
    semanticCompatibilityMustBeExplicit: true,
    inferCompatibilityFromProfileIdentity: false,
  },
  configuration: {
    source: 'server-only',
    key: PERFORMANCE_COMPARISON_CONFIGURATION_KEY_V1,
    scope: PERFORMANCE_COMPARISON_CONFIGURATION_SCOPE_V1,
    defaultEnabled: PERFORMANCE_COMPARISON_DEFAULT_ENABLED_V1,
    platformReadCapability: 'platform.settings.read',
    browserPreference: 'forbidden',
    writePath: 'not-integrated-hard-stop',
  },
  tolerance: 'forbidden',
  derivedMetrics: 'forbidden',
} as const;

export type PerformanceComparisonContractV2 = typeof PERFORMANCE_COMPARISON_CONTRACT_V2;
