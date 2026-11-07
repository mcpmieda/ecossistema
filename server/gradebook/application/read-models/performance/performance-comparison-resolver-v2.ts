import type {
  PerformanceComparisonConfigurationV1,
  PerformanceComparisonOperandV2,
  PerformanceComparisonProfileRefV2,
  PerformanceComparisonProjectionV2,
  PerformanceComparisonSelectionV2,
  PerformanceProfileCompatibilityV2,
} from '../../../../../shared/gradebook-contracts/performance/performance-comparison-contract-v2';
import { comparePerformancePercentagesV2 } from '../../../../../shared/gradebook-contracts/performance/performance-comparison-contract-v2';
const PERFORMANCE_PROFILE_COMPATIBILITY_RULE_V2 =
  'performance-profile-compatibility:v2' as const;

interface PerformanceDeclaredProfileCompatibilityV2 {
  readonly current: PerformanceComparisonProfileRefV2;
  readonly reference: PerformanceComparisonProfileRefV2;
  readonly ruleVersion: string;
}

function sameProfile(
  left: PerformanceComparisonProfileRefV2,
  right: PerformanceComparisonProfileRefV2,
): boolean {
  return (
    left.profileId === right.profileId &&
    left.profileVersion === right.profileVersion &&
    left.percentageSemanticsVersion === right.percentageSemanticsVersion
  );
}

function declaredPair(
  declaration: PerformanceDeclaredProfileCompatibilityV2,
  current: PerformanceComparisonProfileRefV2,
  reference: PerformanceComparisonProfileRefV2,
): boolean {
  return (
    (sameProfile(declaration.current, current) && sameProfile(declaration.reference, reference)) ||
    (sameProfile(declaration.current, reference) && sameProfile(declaration.reference, current))
  );
}

/**
 * Compatibility is closed by default. Exact, declared percentage semantics are compatible; a
 * cross-profile pair requires an explicit declaration supplied by the server composition root.
 */
export function resolvePerformanceProfileCompatibilityV2(input: {
  readonly current: PerformanceComparisonProfileRefV2;
  readonly reference: PerformanceComparisonProfileRefV2;
  readonly declarations?: readonly PerformanceDeclaredProfileCompatibilityV2[];
}): PerformanceProfileCompatibilityV2 {
  const base = {
    currentProfile: input.current,
    referenceProfile: input.reference,
  } as const;

  if (
    sameProfile(input.current, input.reference) &&
    input.current.percentageSemanticsVersion !== 'not-declared'
  ) {
    return {
      ...base,
      state: 'compatible',
      source: 'same-profile-semantics',
      ruleVersion: PERFORMANCE_PROFILE_COMPATIBILITY_RULE_V2,
    };
  }

  const declaration = input.declarations?.find((item) =>
    declaredPair(item, input.current, input.reference),
  );
  if (declaration !== undefined && declaration.ruleVersion.trim().length > 0) {
    return {
      ...base,
      state: 'compatible',
      source: 'declared-cross-profile-compatibility',
      ruleVersion: declaration.ruleVersion,
    };
  }

  return {
    ...base,
    state: 'not-compatible',
    reason: 'profile-semantics-not-declared-compatible',
    ruleVersion: null,
  };
}

export function resolvePerformanceComparisonProjectionV2(input: {
  readonly selection: PerformanceComparisonSelectionV2 | null;
  readonly configuration: PerformanceComparisonConfigurationV1;
  readonly current: PerformanceComparisonOperandV2 | null;
  readonly reference: PerformanceComparisonOperandV2 | null;
  readonly currentProfile: PerformanceComparisonProfileRefV2;
  readonly referenceProfile: PerformanceComparisonProfileRefV2;
  readonly declarations?: readonly PerformanceDeclaredProfileCompatibilityV2[];
}): PerformanceComparisonProjectionV2 {
  if (input.selection === null) {
    return { state: 'not-requested', configuration: input.configuration };
  }

  if (!input.configuration.enabled) {
    return {
      state: 'disabled',
      selection: input.selection,
      configuration: input.configuration,
    };
  }

  const absentOperand = (
    period: PerformanceComparisonSelectionV2['current'],
  ): PerformanceComparisonOperandV2 => ({
    period,
    percentage: { state: 'absent' },
    coverage: {
      state: 'insufficient-data',
      expectedItemCount: 1,
      resolvedItemCount: 0,
      missingItemCount: 1,
      reasons: ['official-result-absent'],
    },
  });

  const current = input.current ?? absentOperand(input.selection.current);
  const reference = input.reference ?? absentOperand(input.selection.reference);
  return {
    state: 'resolved',
    selection: input.selection,
    configuration: input.configuration,
    comparison: comparePerformancePercentagesV2({
      current,
      reference,
      compatibility: resolvePerformanceProfileCompatibilityV2({
        current: input.currentProfile,
        reference: input.referenceProfile,
        ...(input.declarations === undefined ? {} : { declarations: input.declarations }),
      }),
    }),
  };
}
