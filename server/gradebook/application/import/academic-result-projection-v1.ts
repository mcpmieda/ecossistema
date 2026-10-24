import type {
  AcademicYearId,
  ClassGroupId,
  EnrollmentV1,
  StudentId,
  EnrollmentId,
  TeachingAssignmentId,
  TeachingAssignmentV1,
} from '../../../../shared/gradebook-contracts/entities';
import type {
  AcademicGradeValueV1,
  AcademicTermV1,
  AnnualResultId,
  AnnualResultV1,
  FinalRecoveryId,
  FinalRecoveryV1,
  ImportedApplicabilityV1,
  ImportedGradeValueV1,
  ResultCoverageV1,
  SourceEvidenceSetV1,
  TermResultId,
  TermResultV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';
import type { SourceCellProvenanceV1 } from '../../../../shared/gradebook-contracts/source/source-contract-v1';
import {
  resolveGradebookImportRecoveryApplicabilityV3,
  type GradebookImportRecoveryApplicabilityObservationV3,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v3';
import {
  composeNativeTermOutcome,
  type NativeTermOutcomeInputV1,
  type NativeTermOutcomeProfileV1,
  type NativeTermOutcomeV1,
} from '../../../../src/gradebook-domain/calculations/term-result/compose-native-term-outcome';
import {
  resolveFinalRecoveryProjectionV1,
  resolveNativeFinalRecovery,
  type NativeFinalRecoveryInputV1,
  type NativeFinalRecoveryOutcomeV1,
  type NativeFinalRecoveryProfileV1,
} from '../../../../src/gradebook-domain/calculations/final-recovery/resolve-native-final-recovery';
import {
  resolveNativeAnnualOutcome,
  type NativeAnnualComponentInputV1,
  type NativeAnnualOutcomeProfileV1,
  type NativeAnnualOutcomeV1,
} from '../../../../src/gradebook-domain/calculations/annual-result/resolve-native-annual-outcome';

export const IMPORTED_RESULT_PROJECTION_RULE_VERSION_V1 =
  'gradebook-imported-result-projection:2026:v1' as const;
export const IMPORTED_RESULT_PROJECTION_RULE_VERSION_V2 =
  'gradebook-imported-result-projection:2026:v2' as const;
export const IMPORTED_RESULT_PROJECTION_RULE_VERSION_V3 =
  'gradebook-imported-result-projection:2026:v3' as const;
export const ANNUAL_CURRICULUM_PAGE_LIMIT_V1 = 100 as const;

export type ImportedRecoveryApplicabilityMaterializationV1 =
  | { readonly state: 'ready'; readonly value: ImportedApplicabilityV1 }
  | {
      readonly state: 'review-required';
      readonly applicability: ReturnType<typeof resolveGradebookImportRecoveryApplicabilityV3>;
    };

/** Numeric 1 is applicable; every other finite numeric marker is not applicable. */
export function materializeImportedRecoveryApplicabilityV1(input: {
  readonly observation: GradebookImportRecoveryApplicabilityObservationV3;
  readonly provenance: SourceCellProvenanceV1;
}): ImportedRecoveryApplicabilityMaterializationV1 {
  const applicability = resolveGradebookImportRecoveryApplicabilityV3(input.observation);
  if (input.observation.classification === 'empty') {
    return {
      state: 'ready',
      value: {
        value: { state: 'not-applicable', reason: 'source REC applicability is empty' },
        evidence: [
          {
            provenance: input.provenance,
            classification: 'empty',
            rawValue: input.observation.rawValue,
          },
        ],
      },
    };
  }
  if (input.observation.classification === 'formula') {
    if (
      input.observation.cachedValue === null &&
      input.observation.rawValue !== null &&
      input.observation.rawValue !== ''
    ) {
      return { state: 'review-required', applicability };
    }
    if (input.observation.cachedValue === null) {
      return {
        state: 'ready',
        value: {
          value: {
            state: 'not-applicable',
            reason: 'source REC formula has no visible or cached applicability marker',
          },
          evidence: [
            {
              provenance: input.provenance,
              classification: 'formula-error-or-missing-cache',
              rawValue: input.observation.rawValue,
              formula: input.observation.formula,
              cachedValue: null,
              sourceError: null,
            },
          ],
        },
      };
    }
    const authoritativeValue = input.observation.cachedValue;
    return {
      state: 'ready',
      value: {
        value:
          authoritativeValue !== 1
            ? {
                state: 'not-applicable',
                reason: 'source REC formula result is not the numeric applicability marker 1',
              }
            : { state: 'applicable' },
        evidence: [
          authoritativeValue === 0
            ? {
                provenance: input.provenance,
                classification: 'formula-zero',
                rawValue: input.observation.rawValue,
                formula: input.observation.formula,
                cachedValue: 0,
              }
            : {
                provenance: input.provenance,
                classification: 'formula-nonzero',
                rawValue: input.observation.rawValue,
                formula: input.observation.formula,
                cachedValue: authoritativeValue,
              },
        ],
      },
    };
  }
  if (input.observation.classification !== 'numeric') {
    return { state: 'review-required', applicability };
  }
  const authoritativeValue = input.observation.rawValue;
  let classification: 'not-applicable' | 'manual-negative-number' | 'manual-positive-number' =
    'manual-positive-number';
  if (authoritativeValue === 0) classification = 'not-applicable';
  else if (authoritativeValue < 0) classification = 'manual-negative-number';
  return {
    state: 'ready',
    value: {
      value:
        authoritativeValue === 1
          ? { state: 'applicable' }
          : {
              state: 'not-applicable',
              reason: 'source REC value is not the numeric applicability marker 1',
            },
      evidence: [
        {
          provenance: input.provenance,
          classification,
          rawValue: authoritativeValue === 0 ? 0 : authoritativeValue,
        },
      ],
    },
  };
}

interface ResultIdentityV1 {
  readonly academicYearId: AcademicYearId;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly teachingAssignmentId: TeachingAssignmentId;
}

function mergeEvidence(
  first: SourceEvidenceSetV1,
  ...rest: readonly SourceEvidenceSetV1[]
): SourceEvidenceSetV1 {
  return [first[0], ...first.slice(1), ...rest.flat()] as SourceEvidenceSetV1;
}

function importedDerived(
  value: AcademicGradeValueV1,
  evidence: SourceEvidenceSetV1,
): ImportedGradeValueV1 {
  return { value, evidence };
}

export interface ImportedTermProjectionInputV1 extends ResultIdentityV1 {
  readonly id: TermResultId;
  readonly term: AcademicTermV1;
  /** T, Z and AK are direct source observations. */
  readonly quantitativeTotal: ImportedGradeValueV1;
  readonly parallelAssessment: ImportedGradeValueV1;
  readonly qualitativeTotal: ImportedGradeValueV1;
  /** AM remains a direct source observation and is never replaced by an engine output. */
  readonly officialTermGrade: ImportedGradeValueV1;
  readonly calculatedInput: NativeTermOutcomeInputV1;
}

export interface ImportedTermProjectionV1 {
  readonly record: TermResultV1;
  readonly importedOutcome: NativeTermOutcomeV1;
  readonly calculatedOutcome: NativeTermOutcomeV1;
}

/** Runs the same official term core independently over imported and native inputs. */
export function projectImportedTermResultV1(
  input: ImportedTermProjectionInputV1,
  profile: NativeTermOutcomeProfileV1,
): ImportedTermProjectionV1 {
  if (input.calculatedInput.term !== input.term) {
    throw new RangeError('calculated term must match imported term identity');
  }
  const importedOutcome = composeNativeTermOutcome(
    {
      term: input.term,
      quantitativeOriginal: input.quantitativeTotal.value,
      parallelRecovery: input.parallelAssessment.value,
      qualitativeOperational: input.qualitativeTotal.value,
    },
    profile,
  );
  const calculatedOutcome = composeNativeTermOutcome(input.calculatedInput, profile);
  const parallelWasUsed =
    importedOutcome.parallelRecoveryResolution.quantitativeConsidered ===
    input.parallelAssessment.value;
  const consideredEvidence = parallelWasUsed
    ? mergeEvidence(input.quantitativeTotal.evidence, input.parallelAssessment.evidence)
    : input.quantitativeTotal.evidence;
  const percentageEvidence = mergeEvidence(consideredEvidence, input.qualitativeTotal.evidence);

  return {
    importedOutcome,
    calculatedOutcome,
    record: {
      id: input.id,
      academicYearId: input.academicYearId,
      studentId: input.studentId,
      enrollmentId: input.enrollmentId,
      teachingAssignmentId: input.teachingAssignmentId,
      term: input.term,
      maximum: importedOutcome.maximum,
      quantitative: {
        original: {
          imported: input.quantitativeTotal,
          calculated: { value: calculatedOutcome.inputs.quantitativeOriginal },
        },
        parallelRecovery: {
          imported: input.parallelAssessment,
          calculated: { value: calculatedOutcome.inputs.parallelRecovery },
        },
        parallelRecoveryApplicability: {
          imported: {
            value: importedOutcome.parallelRecoveryResolution.applicability,
            evidence: input.quantitativeTotal.evidence,
          },
          calculated: calculatedOutcome.parallelRecoveryResolution.applicability,
        },
        considered: {
          imported: importedDerived(
            importedOutcome.parallelRecoveryResolution.quantitativeConsidered,
            consideredEvidence,
          ),
          calculated: {
            value: calculatedOutcome.parallelRecoveryResolution.quantitativeConsidered,
          },
        },
      },
      qualitativeOperational: {
        imported: input.qualitativeTotal,
        calculated: { value: calculatedOutcome.inputs.qualitativeOperational },
      },
      officialGrade: {
        imported: input.officialTermGrade,
        calculated: { value: calculatedOutcome.nativeGrade },
      },
      percentage: {
        imported: importedDerived(importedOutcome.nativePercentage, percentageEvidence),
        calculated: { value: calculatedOutcome.nativePercentage },
      },
      authorityMode: 'imported-source',
      coverage: importedOutcome.coverage,
      ruleVersion: IMPORTED_RESULT_PROJECTION_RULE_VERSION_V3,
    },
  };
}

export interface ImportedTermGradeMapV1 {
  readonly 1: ImportedGradeValueV1;
  readonly 2: ImportedGradeValueV1;
  readonly 3: ImportedGradeValueV1;
}

export interface ImportedTermApplicabilityMapV1 {
  readonly 1: ImportedApplicabilityV1;
  readonly 2: ImportedApplicabilityV1;
  readonly 3: ImportedApplicabilityV1;
}

export interface FinalRecoveryRecordIdMapV1 {
  readonly 1: FinalRecoveryId;
  readonly 2: FinalRecoveryId;
  readonly 3: FinalRecoveryId;
}

export interface ImportedFinalRecoveryProjectionInputV1 extends ResultIdentityV1 {
  readonly ids: FinalRecoveryRecordIdMapV1;
  /** X/Y/AA, AC/AD/AE and R/S/T respectively. */
  readonly originalTermGrades: ImportedTermGradeMapV1;
  readonly applicability: ImportedTermApplicabilityMapV1;
  readonly recoveryGrades: ImportedTermGradeMapV1;
  readonly calculatedInput: NativeFinalRecoveryInputV1;
}

export interface ImportedFinalRecoveryProjectionV1 {
  readonly records: readonly [FinalRecoveryV1, FinalRecoveryV1, FinalRecoveryV1];
  readonly importedOutcome: NativeFinalRecoveryOutcomeV1;
  readonly calculatedOutcome: NativeFinalRecoveryOutcomeV1;
}

/** Runs the official final-recovery resolver twice with independent inputs. */
export function projectImportedFinalRecoveryV1(
  input: ImportedFinalRecoveryProjectionInputV1,
  profile: NativeFinalRecoveryProfileV1,
): ImportedFinalRecoveryProjectionV1 {
  const importedOutcome = resolveFinalRecoveryProjectionV1(
    {
      originalTermGrades: {
        1: input.originalTermGrades[1].value,
        2: input.originalTermGrades[2].value,
        3: input.originalTermGrades[3].value,
      },
      recoveryGrades: {
        1: input.recoveryGrades[1].value,
        2: input.recoveryGrades[2].value,
        3: input.recoveryGrades[3].value,
      },
      applicability: {
        mode: 'source-observed',
        terms: {
          1: input.applicability[1].value,
          2: input.applicability[2].value,
          3: input.applicability[3].value,
        },
      },
    },
    profile,
  );
  const calculatedOutcome = resolveNativeFinalRecovery(input.calculatedInput, profile);

  const record = (term: AcademicTermV1): FinalRecoveryV1 => {
    const importedTerm = importedOutcome.terms[term];
    const calculatedTerm = calculatedOutcome.terms[term];
    const replacementEvidence =
      importedTerm.applicability.state === 'applicable'
        ? mergeEvidence(
            input.originalTermGrades[term].evidence,
            input.applicability[term].evidence,
            input.recoveryGrades[term].evidence,
          )
        : mergeEvidence(
            input.originalTermGrades[term].evidence,
            input.applicability[term].evidence,
          );
    return {
      id: input.ids[term],
      academicYearId: input.academicYearId,
      studentId: input.studentId,
      enrollmentId: input.enrollmentId,
      teachingAssignmentId: input.teachingAssignmentId,
      recoveredTerm: term,
      originalTermGrade: {
        imported: input.originalTermGrades[term],
        calculated: { value: calculatedTerm.originalTermGrade },
      },
      applicability: {
        imported: input.applicability[term],
        calculated: calculatedTerm.applicability,
      },
      recoveryGrade: {
        imported: input.recoveryGrades[term],
        calculated: { value: calculatedTerm.recoveryGrade },
      },
      replacementTermGrade: {
        imported: importedDerived(importedTerm.replacementTermGrade, replacementEvidence),
        calculated: { value: calculatedTerm.replacementTermGrade },
      },
      authorityMode: 'imported-source',
      coverage: importedTerm.coverage,
      ruleVersion: IMPORTED_RESULT_PROJECTION_RULE_VERSION_V3,
    };
  };

  return {
    importedOutcome,
    calculatedOutcome,
    records: [record(1), record(2), record(3)],
  };
}

function comparableNumber(value: AcademicGradeValueV1): number | null {
  switch (value.state) {
    case 'numeric':
    case 'official-zero':
    case 'legacy-zero':
      return value.value;
    case 'absent':
    case 'not-applicable':
    case 'insufficient-data':
      return null;
  }
}

export type ImportedAnnualOriginalResolutionV1 =
  | {
      readonly state: 'resolved';
      readonly value: ImportedGradeValueV1;
      readonly source: 'term-3-an' | 'recovery-ab' | 'term-3-an-and-recovery-ab';
    }
  | {
      readonly state: 'review-required';
      readonly reason: 'term-3-an-and-recovery-ab-diverge';
    }
  | {
      readonly state: 'insufficient-data';
      readonly reason: 'final-annual-original-total-unavailable';
    };

/** T1/T2 AN are deliberately not accepted as final annual-total candidates. */
export function resolveImportedAnnualOriginalTotalV1(input: {
  readonly term3AnnualAccumulatedTotal: ImportedGradeValueV1 | null;
  readonly recoveryOriginalAnnual: ImportedGradeValueV1 | null;
}): ImportedAnnualOriginalResolutionV1 {
  const term3 = input.term3AnnualAccumulatedTotal;
  const recovery = input.recoveryOriginalAnnual;
  const term3Value = term3 ? comparableNumber(term3.value) : null;
  const recoveryValue = recovery ? comparableNumber(recovery.value) : null;

  if ((term3 && term3Value === null) || (recovery && recoveryValue === null)) {
    return { state: 'insufficient-data', reason: 'final-annual-original-total-unavailable' };
  }

  if (term3 && recovery && term3Value !== null && recoveryValue !== null) {
    if (term3Value !== recoveryValue) {
      return { state: 'review-required', reason: 'term-3-an-and-recovery-ab-diverge' };
    }
    return {
      state: 'resolved',
      source: 'term-3-an-and-recovery-ab',
      value: importedDerived(term3.value, mergeEvidence(term3.evidence, recovery.evidence)),
    };
  }
  if (term3Value !== null && term3) {
    return { state: 'resolved', source: 'term-3-an', value: term3 };
  }
  if (recoveryValue !== null && recovery) {
    return { state: 'resolved', source: 'recovery-ab', value: recovery };
  }
  return { state: 'insufficient-data', reason: 'final-annual-original-total-unavailable' };
}

export type ImportedPostRecoveryTotalResolutionV1 =
  | {
      readonly state: 'resolved';
      readonly value: ImportedGradeValueV1;
      readonly source: 'recovery-u' | 'official-resolver-not-applicable';
    }
  | { readonly state: 'insufficient-data'; readonly reason: string };

export function resolveImportedPostRecoveryTotalV1(input: {
  readonly recoveryTotalAfterRecovery: ImportedGradeValueV1 | null;
  readonly originalTotal: ImportedGradeValueV1;
  readonly applicabilityEvidence: SourceEvidenceSetV1;
  readonly importedFinalRecoveryOutcome: NativeFinalRecoveryOutcomeV1;
}): ImportedPostRecoveryTotalResolutionV1 {
  if (input.recoveryTotalAfterRecovery) {
    if (comparableNumber(input.recoveryTotalAfterRecovery.value) === null) {
      return {
        state: 'insufficient-data',
        reason: 'U is present but is not a comparable academic grade',
      };
    }
    return {
      state: 'resolved',
      source: 'recovery-u',
      value: input.recoveryTotalAfterRecovery,
    };
  }
  if (
    input.importedFinalRecoveryOutcome.annualApplicability.state === 'not-applicable' &&
    comparableNumber(input.originalTotal.value) !== null
  ) {
    return {
      state: 'resolved',
      source: 'official-resolver-not-applicable',
      value: importedDerived(
        input.originalTotal.value,
        mergeEvidence(input.originalTotal.evidence, input.applicabilityEvidence),
      ),
    };
  }
  return {
    state: 'insufficient-data',
    reason: 'U is absent and the official resolver did not prove final recovery non-applicable',
  };
}

export interface AnnualCurriculumPageV1 {
  readonly items: readonly TeachingAssignmentV1[];
  readonly nextCursor: string | null;
}

export interface AnnualCurriculumSourceV1 {
  listAssignments(input: {
    readonly academicYearId: AcademicYearId;
    readonly classGroupId: ClassGroupId;
    readonly limit: typeof ANNUAL_CURRICULUM_PAGE_LIMIT_V1;
    readonly cursor: string | null;
  }): Promise<AnnualCurriculumPageV1>;
}

/** Enumerates the official class/year curriculum independently from the import request. */
export async function loadOfficialAnnualCurriculumV1(
  source: AnnualCurriculumSourceV1,
  enrollment: EnrollmentV1,
): Promise<readonly TeachingAssignmentV1[]> {
  if (enrollment.position !== 'current') {
    throw new RangeError('annual curriculum requires the current enrollment');
  }
  const assignments: TeachingAssignmentV1[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const page = await source.listAssignments({
      academicYearId: enrollment.academicYearId,
      classGroupId: enrollment.classGroupId,
      limit: ANNUAL_CURRICULUM_PAGE_LIMIT_V1,
      cursor,
    });
    if (page.items.length > ANNUAL_CURRICULUM_PAGE_LIMIT_V1) {
      throw new RangeError('annual curriculum page exceeds the bounded limit');
    }
    for (const assignment of page.items) {
      if (
        assignment.academicYearId !== enrollment.academicYearId ||
        assignment.classGroupId !== enrollment.classGroupId ||
        ids.has(assignment.id)
      ) {
        throw new RangeError('annual curriculum returned an incompatible or duplicate assignment');
      }
      ids.add(assignment.id);
      assignments.push(assignment);
    }
    if (page.nextCursor === null) break;
    if (page.nextCursor.trim() === '' || cursors.has(page.nextCursor)) {
      throw new RangeError('annual curriculum returned an invalid cursor');
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  if (assignments.length === 0) throw new RangeError('annual curriculum is empty');
  return assignments;
}

export interface ImportedAnnualComponentV1 {
  readonly id: AnnualResultId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly originalTotal: ImportedGradeValueV1;
  readonly postRecoveryTotal: ImportedGradeValueV1;
  readonly coverage: ResultCoverageV1;
}

export interface CalculatedAnnualComponentV1 {
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly originalTotal: AcademicGradeValueV1;
  readonly postRecoveryTotal: AcademicGradeValueV1;
  readonly coverage: ResultCoverageV1;
}

export interface ImportedAnnualProjectionInputV1 {
  readonly academicYearId: AcademicYearId;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly curriculum: readonly TeachingAssignmentV1[];
  /** Must include official-state components outside the current request when they exist. */
  readonly importedComponents: readonly ImportedAnnualComponentV1[];
  readonly calculatedComponents: readonly CalculatedAnnualComponentV1[];
}

export interface ImportedAnnualProjectionV1 {
  readonly records: readonly AnnualResultV1[];
  readonly importedOutcome: NativeAnnualOutcomeV1;
  readonly calculatedOutcome: NativeAnnualOutcomeV1;
  readonly councilRelease: 'ready' | 'blocked-incomplete-coverage';
}

function missingAnnualComponent(componentKey: string): NativeAnnualComponentInputV1 {
  const coverage: ResultCoverageV1 = {
    state: 'insufficient-data',
    expectedItemCount: 2,
    resolvedItemCount: 0,
    missingItemCount: 2,
    reasons: ['official-curriculum-component-missing'],
  };
  return {
    componentKey,
    originalTotal: { state: 'insufficient-data', reason: 'official curriculum result is missing' },
    postRecoveryTotal: {
      state: 'insufficient-data',
      reason: 'official curriculum result is missing',
    },
    coverage,
  };
}

/** Annual imported/calculated states are independent executions over the complete curriculum. */
export function projectImportedAnnualResultsV1(
  input: ImportedAnnualProjectionInputV1,
  profile: NativeAnnualOutcomeProfileV1,
): ImportedAnnualProjectionV1 {
  const curriculumIds = new Set(input.curriculum.map((assignment) => assignment.id));
  if (curriculumIds.size !== input.curriculum.length || curriculumIds.size === 0) {
    throw new RangeError('annual curriculum must contain unique official assignments');
  }
  if (input.curriculum.some((assignment) => assignment.academicYearId !== input.academicYearId)) {
    throw new RangeError('annual curriculum assignment belongs to another academic year');
  }
  const importedById = new Map(
    input.importedComponents.map((value) => [value.teachingAssignmentId, value]),
  );
  const calculatedById = new Map(
    input.calculatedComponents.map((value) => [value.teachingAssignmentId, value]),
  );
  if (
    importedById.size !== input.importedComponents.length ||
    calculatedById.size !== input.calculatedComponents.length ||
    [...importedById.keys(), ...calculatedById.keys()].some((id) => !curriculumIds.has(id))
  ) {
    throw new RangeError('annual component must be unique and belong to the official curriculum');
  }

  const importedInputs = input.curriculum.map((assignment): NativeAnnualComponentInputV1 => {
    const component = importedById.get(assignment.id);
    return component
      ? {
          componentKey: assignment.id,
          originalTotal: component.originalTotal.value,
          postRecoveryTotal: component.postRecoveryTotal.value,
          coverage: component.coverage,
        }
      : missingAnnualComponent(assignment.id);
  });
  const calculatedInputs = input.curriculum.map((assignment): NativeAnnualComponentInputV1 => {
    const component = calculatedById.get(assignment.id);
    return component
      ? {
          componentKey: assignment.id,
          originalTotal: component.originalTotal,
          postRecoveryTotal: component.postRecoveryTotal,
          coverage: component.coverage,
        }
      : missingAnnualComponent(assignment.id);
  });
  const importedOutcome = resolveNativeAnnualOutcome(
    { components: importedInputs, finalDecision: { status: 'pending' } },
    profile,
  );
  const calculatedOutcome = resolveNativeAnnualOutcome(
    { components: calculatedInputs, finalDecision: { status: 'pending' } },
    profile,
  );
  const records = input.importedComponents.flatMap((component): readonly AnnualResultV1[] => {
    const calculated = calculatedById.get(component.teachingAssignmentId);
    if (!calculated) return [];
    return [
      {
        id: component.id,
        academicYearId: input.academicYearId,
        studentId: input.studentId,
        enrollmentId: input.enrollmentId,
        teachingAssignmentId: component.teachingAssignmentId,
        originalTotal: {
          imported: component.originalTotal,
          calculated: { value: calculated.originalTotal },
        },
        postRecoveryTotal: {
          imported: component.postRecoveryTotal,
          calculated: { value: calculated.postRecoveryTotal },
        },
        academicState: {
          imported: importedOutcome.calculatedAcademicState,
          calculated: calculatedOutcome.calculatedAcademicState,
        },
        finalDecision: { status: 'pending' },
        authorityMode: 'imported-source',
        coverage: importedOutcome.coverage,
        ruleVersion: IMPORTED_RESULT_PROJECTION_RULE_VERSION_V3,
      },
    ];
  });
  const councilRelease =
    importedOutcome.coverage.state === 'complete' && calculatedOutcome.coverage.state === 'complete'
      ? 'ready'
      : 'blocked-incomplete-coverage';
  return { records, importedOutcome, calculatedOutcome, councilRelease };
}
