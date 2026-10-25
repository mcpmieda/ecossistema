import type {
  CouncilAnnualComponentViewV1,
  CouncilCalculatedProjectionV1,
  CouncilClassReferenceV1,
  CouncilComponentReferenceV1,
  CouncilCursorV1,
  CouncilOfficialPeriodResultV1,
  CouncilStudentReferenceV1,
} from '../../../../shared/gradebook-contracts/council/council-workspace-contract-v1';
import type {
  AcademicYearId,
  ClassGroupV1,
  EnrollmentV1,
  StudentV1,
  SubjectV1,
  TeachingAssignmentV1,
} from '../../../../shared/gradebook-contracts/entities';
import type {
  AcademicGradeValueV1,
  AcademicResultStateV1,
  AnnualFinalDecisionV1,
  AnnualResultV1,
  FinalRecoveryV1,
  ResultCoverageV1,
  TermResultV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';
import {
  NATIVE_ANNUAL_OUTCOME_PROFILE_2026_V1,
  resolveNativeAnnualOutcome,
  type NativeAnnualComponentInputV1,
  type NativeAnnualOutcomeV1,
} from '../../../../src/gradebook-domain/calculations/annual-result/resolve-native-annual-outcome';
import {
  CouncilWorkspaceSourceErrorV1,
  type CouncilWorkspaceSourcePageV1,
  type CouncilWorkspaceSourceStudentV1,
  type CouncilWorkspaceSourceV1,
} from './council-workspace-source-v1';

export const COUNCIL_OFFICIAL_PROJECTION_AUTHORITY_MODE_V1 = 'imported-source' as const;

export interface CouncilOfficialProjectionEnrollmentV1 {
  readonly enrollment: EnrollmentV1;
  readonly student: StudentV1;
}

export interface CouncilOfficialProjectionAssignmentV1 {
  readonly teachingAssignment: TeachingAssignmentV1;
  readonly subject: SubjectV1;
}

/** Provider-independent, read-only class snapshot consumed before Council Workspace. */
export interface CouncilOfficialProjectionClassSnapshotV1 {
  readonly academicYearId: AcademicYearId;
  readonly academicYearProfile: 2026;
  readonly classGroup: ClassGroupV1;
  readonly enrollments: readonly CouncilOfficialProjectionEnrollmentV1[];
  readonly assignments: readonly CouncilOfficialProjectionAssignmentV1[];
  readonly termResults: readonly TermResultV1[];
  readonly finalRecoveries: readonly FinalRecoveryV1[];
  readonly annualResults: readonly AnnualResultV1[];
}

export interface CouncilOfficialProjectionRecordsSourceV1 {
  loadClass(
    academicYearId: AcademicYearId,
    classReference: CouncilClassReferenceV1,
  ): Promise<CouncilOfficialProjectionClassSnapshotV1 | null>;
}

function technicalCoverage(reason: string): ResultCoverageV1 {
  return {
    state: 'insufficient-data',
    expectedItemCount: 1,
    resolvedItemCount: 0,
    missingItemCount: 1,
    reasons: [reason],
  };
}

function notApplicableRecoveryCoverage(): ResultCoverageV1 {
  return {
    state: 'not-applicable',
    expectedItemCount: 0,
    resolvedItemCount: 0,
    missingItemCount: 0,
    reasons: ['final-recovery-not-applicable'],
  };
}

function insufficientGrade(reason: string): AcademicGradeValueV1 {
  return { state: 'insufficient-data', reason };
}

function classReference(classGroup: ClassGroupV1): CouncilClassReferenceV1 {
  return classGroup.id as unknown as CouncilClassReferenceV1;
}

function studentReference(enrollment: EnrollmentV1): CouncilStudentReferenceV1 {
  return enrollment.id as unknown as CouncilStudentReferenceV1;
}

function componentReference(
  assignment: TeachingAssignmentV1,
): CouncilComponentReferenceV1 {
  return assignment.id as unknown as CouncilComponentReferenceV1;
}

function cursorForOffset(offset: number): CouncilCursorV1 {
  return `council-official:v1:${offset}` as CouncilCursorV1;
}

function offsetFromCursor(cursor: CouncilCursorV1 | null): number {
  if (cursor === null) return 0;
  const match = /^council-official:v1:(\d+)$/u.exec(cursor);
  if (match === null) throw new CouncilWorkspaceSourceErrorV1('invalid-cursor');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CouncilWorkspaceSourceErrorV1('invalid-cursor');
  }
  return offset;
}

function officialEvidence(
  kind: 'term-result' | 'final-recovery',
  recordId: string,
  label: string,
) {
  return [
    {
      label,
      reference: `council-official-record:v1:${kind}:${encodeURIComponent(recordId)}`,
    },
  ] as const;
}

function recordScopeMatches(
  record: TermResultV1 | FinalRecoveryV1 | AnnualResultV1,
  academicYearId: AcademicYearId,
  enrollment: EnrollmentV1,
  assignment: TeachingAssignmentV1,
): boolean {
  return (
    record.academicYearId === academicYearId &&
    record.studentId === enrollment.studentId &&
    record.enrollmentId === enrollment.id &&
    record.teachingAssignmentId === assignment.id
  );
}

function validOfficialRecord(
  record: TermResultV1 | FinalRecoveryV1 | AnnualResultV1,
  academicYearId: AcademicYearId,
  enrollment: EnrollmentV1,
  assignment: TeachingAssignmentV1,
): boolean {
  return (
    recordScopeMatches(record, academicYearId, enrollment, assignment) &&
    record.authorityMode === COUNCIL_OFFICIAL_PROJECTION_AUTHORITY_MODE_V1
  );
}

function termPeriod(
  academicYearId: AcademicYearId,
  enrollment: EnrollmentV1,
  assignment: TeachingAssignmentV1,
  term: 1 | 2 | 3,
  records: readonly TermResultV1[],
): CouncilOfficialPeriodResultV1 {
  const candidates = records.filter(
    (record) =>
      record.studentId === enrollment.studentId &&
      record.enrollmentId === enrollment.id &&
      record.teachingAssignmentId === assignment.id &&
      record.term === term,
  );
  const record = candidates.length === 1 ? candidates[0] : undefined;
  if (
    record === undefined ||
    !validOfficialRecord(record, academicYearId, enrollment, assignment)
  ) {
    let reason: 'official-term-result-ambiguous' | 'authority-mode-incompatible' | 'official-term-result-absent-or-incompatible';
    if (candidates.length > 1) {
      reason = 'official-term-result-ambiguous';
    } else if (record?.authorityMode !== undefined &&
            record.authorityMode !== COUNCIL_OFFICIAL_PROJECTION_AUTHORITY_MODE_V1) {
      reason = 'authority-mode-incompatible';
    } else {
      reason = 'official-term-result-absent-or-incompatible';
    }
    return {
      period: `T${term}`,
      value: insufficientGrade(reason),
      coverage: technicalCoverage(reason),
      evidence: [],
    };
  }
  return {
    period: `T${term}`,
    value: record.officialGrade.imported.value,
    coverage: record.coverage,
    evidence: officialEvidence('term-result', record.id, `Resultado oficial T${term}`),
  };
}

function recoveryPeriod(
  academicYearId: AcademicYearId,
  enrollment: EnrollmentV1,
  assignment: TeachingAssignmentV1,
  records: readonly FinalRecoveryV1[],
): CouncilOfficialPeriodResultV1 {
  const candidates = records.filter(
    (record) =>
      record.studentId === enrollment.studentId &&
      record.enrollmentId === enrollment.id &&
      record.teachingAssignmentId === assignment.id,
  );
  if (
    candidates.some(
      (record) => !validOfficialRecord(record, academicYearId, enrollment, assignment),
    )
  ) {
    const reason = 'final-recovery-incompatible';
    return {
      period: 'REC',
      value: insufficientGrade(reason),
      coverage: technicalCoverage(reason),
      evidence: [],
    };
  }
  if (
    candidates.some(
      (record) => record.applicability.imported.value.state === 'insufficient-data',
    )
  ) {
    const reason = 'final-recovery-applicability-insufficient';
    return {
      period: 'REC',
      value: insufficientGrade(reason),
      coverage: technicalCoverage(reason),
      evidence: [],
    };
  }
  const applicable = candidates.filter(
    (record) => record.applicability.imported.value.state === 'applicable',
  );
  if (applicable.length === 0) {
    return {
      period: 'REC',
      value: { state: 'not-applicable', reason: 'final-recovery-not-applicable' },
      coverage: notApplicableRecoveryCoverage(),
      evidence: [],
    };
  }
  if (applicable.length > 1) {
    const reason = 'final-recovery-ambiguous';
    return {
      period: 'REC',
      value: insufficientGrade(reason),
      coverage: technicalCoverage(reason),
      evidence: [],
    };
  }
  const record = applicable[0]!;
  return {
    period: 'REC',
    value: record.recoveryGrade.imported.value,
    coverage: record.coverage,
    evidence: officialEvidence('final-recovery', record.id, 'Recuperação final oficial'),
  };
}

interface AnnualComponentMaterializationV1 {
  readonly input: NativeAnnualComponentInputV1;
  readonly annualState: AcademicResultStateV1;
  readonly annualCoverage: ResultCoverageV1;
  readonly record: AnnualResultV1 | null;
}

function annualComponent(
  academicYearId: AcademicYearId,
  enrollment: EnrollmentV1,
  assignment: TeachingAssignmentV1,
  annualResults: readonly AnnualResultV1[],
): AnnualComponentMaterializationV1 {
  const candidates = annualResults.filter(
    (record) =>
      record.studentId === enrollment.studentId &&
      record.enrollmentId === enrollment.id &&
      record.teachingAssignmentId === assignment.id,
  );
  const record = candidates.length === 1 ? candidates[0] : undefined;
  if (
    record === undefined ||
    !validOfficialRecord(record, academicYearId, enrollment, assignment)
  ) {
    let reason: 'official-annual-result-ambiguous' | 'authority-mode-incompatible' | 'official-annual-result-absent-or-incompatible';
    if (candidates.length > 1) {
      reason = 'official-annual-result-ambiguous';
    } else if (record?.authorityMode !== undefined &&
            record.authorityMode !== COUNCIL_OFFICIAL_PROJECTION_AUTHORITY_MODE_V1) {
      reason = 'authority-mode-incompatible';
    } else {
      reason = 'official-annual-result-absent-or-incompatible';
    }
    const coverage = technicalCoverage(reason);
    return {
      input: {
        componentKey: assignment.id,
        originalTotal: insufficientGrade(reason),
        postRecoveryTotal: insufficientGrade(reason),
        coverage,
      },
      annualState: 'insufficient-data',
      annualCoverage: coverage,
      record: null,
    };
  }
  return {
    input: {
      componentKey: assignment.id,
      originalTotal: record.originalTotal.imported.value,
      postRecoveryTotal: record.postRecoveryTotal.imported.value,
      coverage: record.coverage,
    },
    annualState: record.academicState.imported,
    annualCoverage: record.coverage,
    record,
  };
}

type FormalDecisionStateV1 =
  | { readonly state: 'none' }
  | {
      readonly state: 'recorded';
      readonly decision: Extract<AnnualFinalDecisionV1, { readonly status: 'recorded' }>;
    }
  | { readonly state: 'inconsistent' };

function decisionToken(decision: AnnualFinalDecisionV1): string {
  if (decision.status === 'pending') return 'pending';
  return JSON.stringify([
    decision.outcome,
    decision.basis,
    decision.resultingState,
    decision.decidedAt ?? null,
    decision.reference ?? null,
  ]);
}

function formalDecisionState(
  components: readonly AnnualComponentMaterializationV1[],
): FormalDecisionStateV1 {
  const records = components.map((component) => component.record);
  const recorded = records.filter(
    (record): record is AnnualResultV1 & {
      readonly finalDecision: Extract<AnnualFinalDecisionV1, { readonly status: 'recorded' }>;
    } => record?.finalDecision.status === 'recorded',
  );
  if (recorded.length === 0) return { state: 'none' };
  if (
    records.some((record) => record?.finalDecision.status !== 'recorded') ||
    new Set(recorded.map((record) => decisionToken(record.finalDecision))).size !== 1
  ) {
    return { state: 'inconsistent' };
  }
  return { state: 'recorded', decision: recorded[0]!.finalDecision };
}

function outcomeReason(outcome: NativeAnnualOutcomeV1): string {
  return (
    outcome.councilEligibility.reasons[0] ??
    outcome.findings[0]?.code ??
    outcome.coverage.reasons[0] ??
    'native-annual-outcome-unresolved'
  );
}

function calculatedProjection(
  outcome: NativeAnnualOutcomeV1,
  formalDecision: FormalDecisionStateV1,
): CouncilCalculatedProjectionV1 {
  const failedComponentCount =
    outcome.coverage.state === 'complete' ? outcome.notApprovedComponentCount : null;
  if (formalDecision.state === 'inconsistent') {
    return {
      queueState: 'insufficient-data',
      officialAnnualState: 'insufficient-data',
      failedComponentCount,
      coverage: outcome.coverage,
      reason: 'formal-decision-inconsistent',
    };
  }
  if (formalDecision.state === 'recorded') {
    return {
      queueState: 'follows-official-annual-result',
      officialAnnualState: formalDecision.decision.resultingState,
      failedComponentCount,
      coverage: outcome.coverage,
      reason: 'formal-decision-recorded',
    };
  }

  switch (outcome.calculatedAcademicState) {
    case 'approved-direct':
    case 'approved-after-recovery':
      return {
        queueState: 'follows-official-annual-result',
        officialAnnualState: outcome.calculatedAcademicState,
        failedComponentCount,
        coverage: outcome.coverage,
        reason: outcomeReason(outcome),
      };
    case 'eligible-for-council':
      return {
        queueState: 'eligible-for-council',
        officialAnnualState: outcome.calculatedAcademicState,
        failedComponentCount,
        coverage: outcome.coverage,
        reason: outcomeReason(outcome),
      };
    case 'not-eligible-for-council':
      return {
        queueState: 'not-eligible-for-council',
        officialAnnualState: outcome.calculatedAcademicState,
        failedComponentCount,
        coverage: outcome.coverage,
        reason: outcomeReason(outcome),
      };
    case 'insufficient-data':
      return {
        queueState: 'insufficient-data',
        officialAnnualState: outcome.calculatedAcademicState,
        failedComponentCount: null,
        coverage: outcome.coverage,
        reason: outcomeReason(outcome),
      };
    default:
      return {
        queueState: 'insufficient-data',
        officialAnnualState: 'insufficient-data',
        failedComponentCount: null,
        coverage: outcome.coverage,
        reason: 'unexpected-native-annual-state',
      };
  }
}

function compareAssignments(
  left: CouncilOfficialProjectionAssignmentV1,
  right: CouncilOfficialProjectionAssignmentV1,
): number {
  return (
    left.subject.displayName.localeCompare(right.subject.displayName) ||
    left.teachingAssignment.id.localeCompare(right.teachingAssignment.id)
  );
}

function compareEnrollments(
  left: CouncilOfficialProjectionEnrollmentV1,
  right: CouncilOfficialProjectionEnrollmentV1,
): number {
  const leftPosition = left.enrollment.sourcePosition ?? Number.MAX_SAFE_INTEGER;
  const rightPosition = right.enrollment.sourcePosition ?? Number.MAX_SAFE_INTEGER;
  return (
    leftPosition - rightPosition ||
    left.student.displayName.localeCompare(right.student.displayName) ||
    left.enrollment.id.localeCompare(right.enrollment.id)
  );
}

function validateSnapshot(
  snapshot: CouncilOfficialProjectionClassSnapshotV1,
  academicYearId: AcademicYearId,
  requestedClassReference: CouncilClassReferenceV1,
): void {
  if (
    snapshot.academicYearId !== academicYearId ||
    snapshot.academicYearProfile !== NATIVE_ANNUAL_OUTCOME_PROFILE_2026_V1.academicYear ||
    snapshot.classGroup.academicYearId !== academicYearId ||
    classReference(snapshot.classGroup) !== requestedClassReference
  ) {
    throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
  }
  const enrollmentIds = new Set<string>();
  const enrollmentPairs = new Set<string>();
  for (const item of snapshot.enrollments) {
    if (
      item.enrollment.academicYearId !== academicYearId ||
      item.enrollment.classGroupId !== snapshot.classGroup.id ||
      item.enrollment.studentId !== item.student.id ||
      enrollmentIds.has(item.enrollment.id)
    ) {
      throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
    }
    enrollmentIds.add(item.enrollment.id);
    enrollmentPairs.add(JSON.stringify([item.student.id, item.enrollment.id]));
  }
  const assignmentIds = new Set<string>();
  for (const item of snapshot.assignments) {
    if (
      item.teachingAssignment.academicYearId !== academicYearId ||
      item.teachingAssignment.classGroupId !== snapshot.classGroup.id ||
      item.teachingAssignment.subjectId !== item.subject.id ||
      assignmentIds.has(item.teachingAssignment.id)
    ) {
      throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
    }
    assignmentIds.add(item.teachingAssignment.id);
  }
  for (const record of [
    ...snapshot.termResults,
    ...snapshot.finalRecoveries,
    ...snapshot.annualResults,
  ]) {
    if (
      record.academicYearId !== academicYearId ||
      !enrollmentPairs.has(JSON.stringify([record.studentId, record.enrollmentId])) ||
      !assignmentIds.has(record.teachingAssignmentId)
    ) {
      throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
    }
  }
}

function studentProjection(
  snapshot: CouncilOfficialProjectionClassSnapshotV1,
  enrollmentItem: CouncilOfficialProjectionEnrollmentV1,
  assignments: readonly CouncilOfficialProjectionAssignmentV1[],
): CouncilWorkspaceSourceStudentV1 {
  const annualComponents = assignments.map((item) =>
    annualComponent(
      snapshot.academicYearId,
      enrollmentItem.enrollment,
      item.teachingAssignment,
      snapshot.annualResults,
    ),
  );
  const outcome = resolveNativeAnnualOutcome(
    {
      components: annualComponents.map((component) => component.input),
      finalDecision: { status: 'pending' },
    },
    NATIVE_ANNUAL_OUTCOME_PROFILE_2026_V1,
  );
  const annualView = assignments.map((item, index): CouncilAnnualComponentViewV1 => {
    const annual = annualComponents[index]!;
    const periods: CouncilAnnualComponentViewV1['periods'] = [
      termPeriod(
        snapshot.academicYearId,
        enrollmentItem.enrollment,
        item.teachingAssignment,
        1,
        snapshot.termResults,
      ),
      termPeriod(
        snapshot.academicYearId,
        enrollmentItem.enrollment,
        item.teachingAssignment,
        2,
        snapshot.termResults,
      ),
      termPeriod(
        snapshot.academicYearId,
        enrollmentItem.enrollment,
        item.teachingAssignment,
        3,
        snapshot.termResults,
      ),
      recoveryPeriod(
        snapshot.academicYearId,
        enrollmentItem.enrollment,
        item.teachingAssignment,
        snapshot.finalRecoveries,
      ),
    ];
    return {
      componentReference: componentReference(item.teachingAssignment),
      componentLabel: item.subject.displayName,
      periods,
      annualState: annual.annualState,
      annualCoverage: annual.annualCoverage,
    };
  });
  return {
    academicYearId: snapshot.academicYearId,
    classReference: classReference(snapshot.classGroup),
    classLabel: snapshot.classGroup.code,
    studentReference: studentReference(enrollmentItem.enrollment),
    studentLabel: enrollmentItem.student.displayName,
    calculated: calculatedProjection(outcome, formalDecisionState(annualComponents)),
    annualView,
  };
}

function materializeStudents(
  snapshot: CouncilOfficialProjectionClassSnapshotV1,
  academicYearId: AcademicYearId,
  requestedClassReference: CouncilClassReferenceV1,
): readonly CouncilWorkspaceSourceStudentV1[] {
  validateSnapshot(snapshot, academicYearId, requestedClassReference);
  const assignments = [...snapshot.assignments].sort(compareAssignments);
  return [...snapshot.enrollments]
    .sort(compareEnrollments)
    .map((enrollment) => studentProjection(snapshot, enrollment, assignments));
}

export function createCouncilOfficialProjectionSourceV1(
  records: CouncilOfficialProjectionRecordsSourceV1,
): CouncilWorkspaceSourceV1 {
  async function load(
    academicYearId: AcademicYearId,
    requestedClassReference: CouncilClassReferenceV1,
  ): Promise<readonly CouncilWorkspaceSourceStudentV1[] | null> {
    try {
      const snapshot = await records.loadClass(academicYearId, requestedClassReference);
      return snapshot === null
        ? null
        : materializeStudents(snapshot, academicYearId, requestedClassReference);
    } catch (error) {
      if (error instanceof CouncilWorkspaceSourceErrorV1) throw error;
      throw new CouncilWorkspaceSourceErrorV1('unavailable');
    }
  }

  return {
    async listQueue(request): Promise<CouncilWorkspaceSourcePageV1> {
      const students = await load(request.academicYearId, request.classReference);
      if (students === null) return { items: [], nextCursor: null };
      const offset = offsetFromCursor(request.page.cursor);
      if (offset > students.length) throw new CouncilWorkspaceSourceErrorV1('invalid-cursor');
      const selected = students.slice(offset, offset + request.page.limit);
      const nextOffset = offset + selected.length;
      return {
        items: selected.map((student) => ({
          studentReference: student.studentReference,
          studentLabel: student.studentLabel,
          calculated: student.calculated,
        })),
        nextCursor:
          selected.length > 0 && nextOffset < students.length
            ? cursorForOffset(nextOffset)
            : null,
      };
    },

    async getStudent(request) {
      const students = await load(request.academicYearId, request.classReference);
      return (
        students?.find((student) => student.studentReference === request.studentReference) ??
        null
      );
    },
  };
}
