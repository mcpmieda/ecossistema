import type { ReconciliationResultV1 } from '../../../../shared/gradebook-contracts/audit/audit-contract-v1';
import type {
  AcademicGradeValueV1,
  ImportedGradeValueV1,
  ResultCoverageV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';
import {
  resolveNativeAnnualOutcome,
  type NativeAnnualComponentOutcomeV1,
  type NativeAnnualOutcomeInputV1,
  type NativeAnnualOutcomeProfileV1,
  type NativeAnnualOutcomeV1,
} from '../annual-result/resolve-native-annual-outcome';

export const NATIVE_ANNUAL_EQUIVALENCE_RULE_VERSION_V1 = 'native-annual-equivalence-v1' as const;

type NativeAnnualEquivalenceClassificationV1 = ReconciliationResultV1['status'];

export const NATIVE_ANNUAL_EQUIVALENCE_FINDING_CODES_V1 = [
  'values-identical',
  'zero-origin-state-difference',
  'values-differ',
  'imported-value-absent',
  'imported-value-not-applicable',
  'imported-value-insufficient-data',
  'imported-coverage-partial',
  'imported-coverage-insufficient-data',
  'imported-coverage-not-applicable',
  'native-component-not-found',
  'native-component-unresolved',
  'native-value-absent',
  'native-value-not-applicable',
  'native-value-insufficient-data',
  'native-coverage-partial',
  'native-coverage-insufficient-data',
  'native-coverage-not-applicable',
] as const;
type NativeAnnualEquivalenceFindingCodeV1 =
  (typeof NATIVE_ANNUAL_EQUIVALENCE_FINDING_CODES_V1)[number];

export interface NativeAnnualEquivalenceInputV1 {
  readonly componentKey: string;
  readonly importedValue: ImportedGradeValueV1;
  readonly importedCoverage: ResultCoverageV1;
  readonly importedRuleVersion: string;
  readonly nativeAnnualInput: NativeAnnualOutcomeInputV1;
}

interface NativeAnnualEquivalenceFindingV1 {
  readonly code: NativeAnnualEquivalenceFindingCodeV1;
  readonly side: 'comparison' | 'imported' | 'native';
  readonly state?: AcademicGradeValueV1['state'] | ResultCoverageV1['state'];
  readonly message: string;
}

interface NativeAnnualEquivalenceCoverageV1 {
  readonly imported: ResultCoverageV1;
  readonly native: ResultCoverageV1;
  readonly comparable: boolean;
}

interface NativeAnnualEquivalenceVersionsV1 {
  readonly equivalenceRule: typeof NATIVE_ANNUAL_EQUIVALENCE_RULE_VERSION_V1;
  readonly importedRule: string;
  readonly nativeAnnualProfileVersion: 1;
  readonly nativeAcademicYearProfile: 2026;
}

interface NativeAnnualEquivalenceV1 {
  readonly authorityMode: 'imported-source';
  readonly componentKey: string;
  readonly importedValue: ImportedGradeValueV1;
  readonly nativeOutcome: NativeAnnualOutcomeV1;
  readonly nativeComponent: NativeAnnualComponentOutcomeV1 | null;
  readonly coverage: NativeAnnualEquivalenceCoverageV1;
  readonly classification: NativeAnnualEquivalenceClassificationV1;
  readonly difference: number | null;
  readonly reasons: readonly NativeAnnualEquivalenceFindingCodeV1[];
  readonly findings: readonly NativeAnnualEquivalenceFindingV1[];
  readonly versions: NativeAnnualEquivalenceVersionsV1;
}

type ComparableGradeStateV1 = 'numeric' | 'official-zero' | 'legacy-zero';

interface ComparableGradeV1 {
  readonly state: ComparableGradeStateV1;
  readonly value: number;
}

function validateInput(input: NativeAnnualEquivalenceInputV1): void {
  if (typeof input.componentKey !== 'string' || input.componentKey.trim() === '') {
    throw new RangeError('componentKey must be a non-empty string');
  }
  if (typeof input.importedRuleVersion !== 'string' || input.importedRuleVersion.trim() === '') {
    throw new RangeError('importedRuleVersion must be a non-empty string');
  }
}

function comparableGrade(
  grade: AcademicGradeValueV1,
  side: 'imported' | 'native',
): ComparableGradeV1 | null {
  switch (grade.state) {
    case 'numeric':
    case 'official-zero':
    case 'legacy-zero':
      if (!Number.isFinite(grade.value)) {
        throw new RangeError(`${side} annual value must be a finite number`);
      }
      return { state: grade.state, value: grade.value };
    case 'absent':
    case 'not-applicable':
    case 'insufficient-data':
      return null;
  }
}

function coverageFinding(
  coverage: ResultCoverageV1,
  side: 'imported' | 'native',
): NativeAnnualEquivalenceFindingV1 | null {
  if (coverage.state === 'complete') return null;

  const code = `${side}-coverage-${coverage.state}` as NativeAnnualEquivalenceFindingCodeV1;
  return {
    code,
    side,
    state: coverage.state,
    message: `${side} annual coverage is ${coverage.state}`,
  };
}

function unresolvedValueFinding(
  grade: AcademicGradeValueV1,
  side: 'imported' | 'native',
): NativeAnnualEquivalenceFindingV1 | null {
  if (
    grade.state === 'numeric' ||
    grade.state === 'official-zero' ||
    grade.state === 'legacy-zero'
  ) {
    return null;
  }

  return {
    code: `${side}-value-${grade.state}` as NativeAnnualEquivalenceFindingCodeV1,
    side,
    state: grade.state,
    message: `${side} annual value is ${grade.state}`,
  };
}

function compareResolvedValues(
  imported: ComparableGradeV1,
  native: ComparableGradeV1,
): {
  readonly classification: NativeAnnualEquivalenceClassificationV1;
  readonly difference: number;
  readonly finding: NativeAnnualEquivalenceFindingV1;
} {
  const difference = Math.abs(imported.value - native.value);

  if (imported.value !== native.value) {
    return {
      classification: 'mismatch',
      difference,
      finding: {
        code: 'values-differ',
        side: 'comparison',
        message: 'Imported and native annual values differ exactly.',
      },
    };
  }

  if (imported.state === native.state) {
    return {
      classification: 'match',
      difference,
      finding: {
        code: 'values-identical',
        side: 'comparison',
        state: imported.state,
        message: 'Imported and native annual values and states are identical.',
      },
    };
  }

  return {
    classification: 'expected-difference',
    difference,
    finding: {
      code: 'zero-origin-state-difference',
      side: 'comparison',
      message:
        'Imported and native annual values are both semantic zero, with distinct preserved origin states.',
    },
  };
}

/**
 * Compares one imported annual component value with the native annual outcome using exact
 * semantic equality. The imported source remains authoritative and both sides are preserved.
 */
export function compareImportedAndNativeAnnualOutcome(
  input: NativeAnnualEquivalenceInputV1,
  profile: NativeAnnualOutcomeProfileV1,
): NativeAnnualEquivalenceV1 {
  validateInput(input);

  const nativeOutcome = resolveNativeAnnualOutcome(input.nativeAnnualInput, profile);
  const nativeComponent =
    nativeOutcome.components.find((component) => component.componentKey === input.componentKey) ??
    null;
  const findings: NativeAnnualEquivalenceFindingV1[] = [];
  const importedCoverageFinding = coverageFinding(input.importedCoverage, 'imported');
  const nativeCoverageFinding = coverageFinding(nativeOutcome.coverage, 'native');
  if (importedCoverageFinding !== null) findings.push(importedCoverageFinding);
  if (nativeCoverageFinding !== null) findings.push(nativeCoverageFinding);

  const imported = comparableGrade(input.importedValue.value, 'imported');
  const importedValueFinding = unresolvedValueFinding(input.importedValue.value, 'imported');
  if (importedValueFinding !== null) findings.push(importedValueFinding);

  let native: ComparableGradeV1 | null = null;
  if (nativeComponent === null) {
    findings.push({
      code: 'native-component-not-found',
      side: 'native',
      message: `Native annual component was not found: ${input.componentKey}`,
    });
  } else {
    native = comparableGrade(nativeComponent.postRecoveryTotal, 'native');
    const nativeValueFinding = unresolvedValueFinding(nativeComponent.postRecoveryTotal, 'native');
    if (nativeValueFinding !== null) findings.push(nativeValueFinding);
    if (!nativeComponent.resolved) {
      findings.push({
        code: 'native-component-unresolved',
        side: 'native',
        message: `Native annual component is unresolved: ${input.componentKey}`,
      });
    }
  }

  const comparable =
    input.importedCoverage.state === 'complete' &&
    nativeOutcome.coverage.state === 'complete' &&
    nativeComponent?.resolved === true &&
    imported !== null &&
    native !== null;
  let classification: NativeAnnualEquivalenceClassificationV1 = 'not-comparable';
  let difference: number | null = null;

  if (comparable && imported !== null && native !== null) {
    const comparison = compareResolvedValues(imported, native);
    classification = comparison.classification;
    difference = comparison.difference;
    findings.push(comparison.finding);
  }

  return {
    authorityMode: 'imported-source',
    componentKey: input.componentKey,
    importedValue: input.importedValue,
    nativeOutcome,
    nativeComponent,
    coverage: {
      imported: input.importedCoverage,
      native: nativeOutcome.coverage,
      comparable,
    },
    classification,
    difference,
    reasons: findings.map((finding) => finding.code),
    findings,
    versions: {
      equivalenceRule: NATIVE_ANNUAL_EQUIVALENCE_RULE_VERSION_V1,
      importedRule: input.importedRuleVersion,
      nativeAnnualProfileVersion: profile.version,
      nativeAcademicYearProfile: profile.academicYear,
    },
  };
}
