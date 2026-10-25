import {
  BULLETIN_AUTHORITY_MODE_V1,
  BULLETIN_CONTRACT_VERSION_V1,
  BULLETIN_MODEL_VERSION_V1,
  type BulletinAnnualResultV1,
  type BulletinAssessmentEntryV1,
  type BulletinComparedApplicabilityV1,
  type BulletinComparedGradeValueV1,
  type BulletinCompositionSubjectV1,
  type BulletinDataVersionV1,
  type BulletinDetailedSubjectV1,
  type BulletinDetailedTermV1,
  type BulletinEmissionReasonsV1,
  type BulletinEmissionRequestV1,
  type BulletinModelV1,
  type BulletinStudentIdentityV1,
  type BulletinSyntheticSubjectV1,
  type BulletinTermCompositionV1,
  type BulletinTermSummaryV1,
} from '../../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';
import type { TeachingAssignmentV1 } from '../../../../shared/gradebook-contracts/entities';
import {
  ACADEMIC_TERMS_V1,
  type AcademicGradeValueV1,
  type AnnualFinalDecisionV1,
  type AnnualResultV1,
  type ApplicabilityV1,
  type ComparedApplicabilityV1,
  type ComparedGradeValueV1,
  type GradeEntryV1,
  type ResultCoverageV1,
  type TermResultV1,
} from '../../../../shared/gradebook-contracts/results/results-contract-v1';
import type {
  AcademicRecordRepositoryV1,
  AcademicRecordStreamV1,
  AcademicRecordV1,
  VersionedRecordV1,
} from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';
import type {
  ClassGroupCenterAssignmentV1,
  ClassGroupCenterQueryV1,
  ClassGroupCenterReadModelV1,
  ClassGroupCenterVersionedValueV1,
} from '../read-models/class-group/class-group-center-read-model-v1';

export const BULLETIN_MATERIALIZATION_REASONS_V1 = {
  academicDataUnavailable: 'academic-data-unavailable',
  classGroupTargetRequiresBatch: 'class-group-target-requires-batch',
  classGroupNotFound: 'class-group-not-found',
  studentTargetNotFound: 'student-target-not-found',
  subjectNotFound: 'subject-not-found',
  noSubjects: 'no-subjects-found',
  officialResultNotFound: 'official-result-not-found',
  incompatibleOfficialData: 'incompatible-official-data',
  nativeEngineRejected: 'native-engine-rejected',
  insufficientCoverage: 'insufficient-result-coverage',
} as const;

export type BulletinStudentEmissionRequestV1 = BulletinEmissionRequestV1 & {
  readonly target: Extract<BulletinEmissionRequestV1['target'], { readonly kind: 'student' }>;
};

export type BulletinModelMaterializationResultV1 =
  | {
      readonly status: 'ready';
      readonly model: BulletinModelV1;
      readonly dataVersion: BulletinDataVersionV1;
    }
  | {
      readonly status: 'blocked';
      readonly reasons: BulletinEmissionReasonsV1;
    }
  | {
      readonly status: 'insufficient-data';
      readonly coverage: ResultCoverageV1;
      readonly reasons: BulletinEmissionReasonsV1;
    };

export interface BulletinAggregateMaterializationItemV1 {
  /** Index of the original batch request. Class-group requests can produce multiple items. */
  readonly requestIndex: number;
  /** Null only when the class-group base cannot yield a valid student target. */
  readonly request: BulletinStudentEmissionRequestV1 | null;
  readonly materialization: BulletinModelMaterializationResultV1;
}

export interface BulletinModelMaterializerV1 {
  materialize(request: BulletinEmissionRequestV1): Promise<BulletinModelMaterializationResultV1>;
  /**
   * Materializes a batch against one cached ClassGroupCenter base per academic-year/class-group
   * pair. The cache lives only for this call and never persists academic data.
   */
  materializeBatch(
    requests: readonly BulletinEmissionRequestV1[],
  ): Promise<readonly BulletinAggregateMaterializationItemV1[]>;
}

export interface BulletinModelMaterializerDependenciesV1 {
  readonly classGroups: ClassGroupCenterQueryV1;
  readonly academicRecords: AcademicRecordRepositoryV1;
}

type MaterializationStoppedResult = Exclude<
  BulletinModelMaterializationResultV1,
  { readonly status: 'ready' }
>;

class MaterializationStopped extends Error {
  readonly result: MaterializationStoppedResult;

  constructor(result: MaterializationStoppedResult) {
    super(result.reasons[0]);
    this.name = 'MaterializationStopped';
    this.result = result;
  }
}

function reasons(reason: string): BulletinEmissionReasonsV1 {
  return [reason];
}

function block(reason: string): never {
  throw new MaterializationStopped({ status: 'blocked', reasons: reasons(reason) });
}

function copyCoverage(coverage: ResultCoverageV1): ResultCoverageV1 {
  return {
    state: coverage.state,
    expectedItemCount: coverage.expectedItemCount,
    resolvedItemCount: coverage.resolvedItemCount,
    missingItemCount: coverage.missingItemCount,
    reasons: [...coverage.reasons],
  };
}

function requireUsableCoverage(coverage: ResultCoverageV1): ResultCoverageV1 {
  const copied = copyCoverage(coverage);
  if (coverage.state === 'partial' || coverage.state === 'insufficient-data') {
    throw new MaterializationStopped({
      status: 'insufficient-data',
      coverage: copied,
      reasons: reasons(BULLETIN_MATERIALIZATION_REASONS_V1.insufficientCoverage),
    });
  }
  return copied;
}

function copyGradeValue(value: AcademicGradeValueV1): AcademicGradeValueV1 {
  if (value.state === 'numeric') return { state: value.state, value: value.value };
  if (value.state === 'official-zero') {
    return { state: value.state, value: value.value, sourceMarker: value.sourceMarker };
  }
  if (value.state === 'legacy-zero') return { state: value.state, value: value.value };
  if (value.state === 'not-applicable') {
    return value.reason === undefined
      ? { state: value.state }
      : { state: value.state, reason: value.reason };
  }
  if (value.state === 'insufficient-data') {
    return { state: value.state, reason: value.reason };
  }
  return { state: value.state };
}

function projectComparedGrade(value: ComparedGradeValueV1): BulletinComparedGradeValueV1 {
  return {
    imported: copyGradeValue(value.imported.value),
    calculated: copyGradeValue(value.calculated.value),
  };
}

function copyApplicability(value: ApplicabilityV1): ApplicabilityV1 {
  if (value.state === 'not-applicable') {
    return value.reason === undefined
      ? { state: value.state }
      : { state: value.state, reason: value.reason };
  }
  if (value.state === 'insufficient-data') {
    return { state: value.state, reason: value.reason };
  }
  return { state: value.state };
}

function projectComparedApplicability(
  value: ComparedApplicabilityV1,
): BulletinComparedApplicabilityV1 {
  return {
    imported: copyApplicability(value.imported.value),
    calculated: copyApplicability(value.calculated),
  };
}

function copyFinalDecision(value: AnnualFinalDecisionV1): AnnualFinalDecisionV1 {
  if (value.status === 'pending') return { status: value.status };
  return {
    status: value.status,
    outcome: value.outcome,
    basis: value.basis,
    resultingState: value.resultingState,
    ...(value.decidedAt === undefined ? {} : { decidedAt: value.decidedAt }),
    ...(value.reference === undefined ? {} : { reference: value.reference }),
  };
}

function codeUnitCompare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function versionToken(
  kind: string,
  value: ClassGroupCenterVersionedValueV1<{ readonly id: string }>,
): string {
  return `${kind}:${value.value.id}:${value.version}:${value.recordedAt}`;
}

function academicRecordToken(kind: string, record: VersionedRecordV1<AcademicRecordV1>): string {
  return `${kind}:${record.value.value.id}:${record.version}:${record.recordedAt}`;
}

function dataVersion(model: BulletinModelV1, tokens: readonly string[]): BulletinDataVersionV1 {
  const serialized = JSON.stringify({ model, tokens });
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index); // NOSONAR: UTF-16 code units on purpose, so the stored hash stays the same
    hash = Math.imul(hash, 0x01000193);
  }
  return `bulletin-data-v1:${(hash >>> 0).toString(16).padStart(8, '0')}:${tokens.length}` as BulletinDataVersionV1;
}

function requireImportedAuthority(authorityMode: string): void {
  if (authorityMode !== BULLETIN_AUTHORITY_MODE_V1) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.nativeEngineRejected);
  }
}

async function getAcademicRecord<Kind extends AcademicRecordV1['kind']>(
  repository: AcademicRecordRepositoryV1,
  academicYearId: BulletinStudentEmissionRequestV1['academicYearId'],
  stream: AcademicRecordStreamV1,
  kind: Kind,
): Promise<VersionedRecordV1<Extract<AcademicRecordV1, { readonly kind: Kind }>>> {
  const record = await repository.getCurrent({ academicYearId }, stream);
  if (record === null) block(BULLETIN_MATERIALIZATION_REASONS_V1.officialResultNotFound);
  if (record.value.kind !== kind) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData);
  }
  return record as VersionedRecordV1<Extract<AcademicRecordV1, { readonly kind: Kind }>>;
}

function validateTermResult(
  result: TermResultV1,
  request: BulletinStudentEmissionRequestV1,
  assignmentId: TeachingAssignmentV1['id'],
  term: TermResultV1['term'],
): void {
  if (
    result.academicYearId !== request.academicYearId ||
    result.studentId !== request.target.studentId ||
    result.enrollmentId !== request.target.enrollmentId ||
    result.teachingAssignmentId !== assignmentId ||
    result.term !== term
  ) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData);
  }
  requireImportedAuthority(result.authorityMode);
}

function validateAnnualResult(
  result: AnnualResultV1,
  request: BulletinStudentEmissionRequestV1,
  assignmentId: TeachingAssignmentV1['id'],
): void {
  if (
    result.academicYearId !== request.academicYearId ||
    result.studentId !== request.target.studentId ||
    result.enrollmentId !== request.target.enrollmentId ||
    result.teachingAssignmentId !== assignmentId
  ) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData);
  }
  requireImportedAuthority(result.authorityMode);
}

function validateGradeEntry(
  entry: GradeEntryV1,
  request: BulletinStudentEmissionRequestV1,
  assessmentComponentId: GradeEntryV1['assessmentComponentId'],
): void {
  if (
    entry.academicYearId !== request.academicYearId ||
    entry.studentId !== request.target.studentId ||
    entry.enrollmentId !== request.target.enrollmentId ||
    entry.assessmentComponentId !== assessmentComponentId
  ) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData);
  }
  requireImportedAuthority(entry.authorityMode);
}

async function loadTerm(
  repository: AcademicRecordRepositoryV1,
  request: BulletinStudentEmissionRequestV1,
  assignment: ClassGroupCenterAssignmentV1,
  term: TermResultV1['term'],
  tokens: string[],
): Promise<{
  readonly summary: BulletinTermSummaryV1;
  readonly composition: BulletinTermCompositionV1;
}> {
  const record = await getAcademicRecord(
    repository,
    request.academicYearId,
    {
      kind: 'term-result',
      studentId: request.target.studentId,
      enrollmentId: request.target.enrollmentId,
      teachingAssignmentId: assignment.assignment.value.id,
      term,
    },
    'term-result',
  );
  const result = record.value.value;
  validateTermResult(result, request, assignment.assignment.value.id, term);
  const coverage = requireUsableCoverage(result.coverage);
  tokens.push(academicRecordToken('term-result', record));

  const summary: BulletinTermSummaryV1 = {
    kind: 'term',
    termResultId: result.id,
    term: result.term,
    officialGrade: projectComparedGrade(result.officialGrade),
    percentage: projectComparedGrade(result.percentage),
    authorityMode: BULLETIN_AUTHORITY_MODE_V1,
    coverage,
  };
  return {
    summary,
    composition: {
      termResultId: result.id,
      term: result.term,
      quantitative: {
        original: projectComparedGrade(result.quantitative.original),
        parallelRecovery: projectComparedGrade(result.quantitative.parallelRecovery),
        parallelRecoveryApplicability: projectComparedApplicability(
          result.quantitative.parallelRecoveryApplicability,
        ),
        considered: projectComparedGrade(result.quantitative.considered),
      },
      qualitativeOperational: projectComparedGrade(result.qualitativeOperational),
      officialGrade: projectComparedGrade(result.officialGrade),
      percentage: projectComparedGrade(result.percentage),
      authorityMode: BULLETIN_AUTHORITY_MODE_V1,
      coverage,
    },
  };
}

async function loadAnnual(
  repository: AcademicRecordRepositoryV1,
  request: BulletinStudentEmissionRequestV1,
  assignment: ClassGroupCenterAssignmentV1,
  tokens: string[],
): Promise<BulletinAnnualResultV1> {
  const record = await getAcademicRecord(
    repository,
    request.academicYearId,
    {
      kind: 'annual-result',
      studentId: request.target.studentId,
      enrollmentId: request.target.enrollmentId,
      teachingAssignmentId: assignment.assignment.value.id,
    },
    'annual-result',
  );
  const result = record.value.value;
  validateAnnualResult(result, request, assignment.assignment.value.id);
  const coverage = requireUsableCoverage(result.coverage);
  tokens.push(academicRecordToken('annual-result', record));
  return {
    kind: 'annual',
    annualResultId: result.id,
    originalTotal: projectComparedGrade(result.originalTotal),
    postRecoveryTotal: projectComparedGrade(result.postRecoveryTotal),
    academicState: {
      imported: result.academicState.imported,
      calculated: result.academicState.calculated,
    },
    finalDecision: copyFinalDecision(result.finalDecision),
    authorityMode: BULLETIN_AUTHORITY_MODE_V1,
    coverage,
  };
}

async function loadAssessments(
  repository: AcademicRecordRepositoryV1,
  request: BulletinStudentEmissionRequestV1,
  assignment: ClassGroupCenterAssignmentV1,
  term: TermResultV1['term'],
  tokens: string[],
): Promise<readonly BulletinAssessmentEntryV1[]> {
  const components = [...assignment.assessmentComponents]
    .filter(({ value }) => value.term === term)
    .sort(
      (left, right) =>
        left.value.order - right.value.order || codeUnitCompare(left.value.id, right.value.id),
    );
  const assessments: BulletinAssessmentEntryV1[] = [];
  for (const component of components) {
    if (
      component.value.academicYearId !== request.academicYearId ||
      component.value.teachingAssignmentId !== assignment.assignment.value.id
    ) {
      block(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData);
    }
    const record = await getAcademicRecord(
      repository,
      request.academicYearId,
      {
        kind: 'grade-entry',
        studentId: request.target.studentId,
        enrollmentId: request.target.enrollmentId,
        assessmentComponentId: component.value.id,
      },
      'grade-entry',
    );
    const entry = record.value.value;
    validateGradeEntry(entry, request, component.value.id);
    tokens.push(
      versionToken('assessment-component', component),
      academicRecordToken('grade-entry', record),
    );
    assessments.push({
      assessmentComponentId: component.value.id,
      gradeEntryId: entry.id,
      type: component.value.type,
      name: component.value.name,
      applicability: copyApplicability(component.value.applicability),
      value: projectComparedGrade(entry.value),
      authorityMode: BULLETIN_AUTHORITY_MODE_V1,
    });
  }
  return assessments;
}

function requireStudentRequest(
  request: BulletinEmissionRequestV1,
): asserts request is BulletinStudentEmissionRequestV1 {
  if (request.target.kind !== 'student') {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.classGroupTargetRequiresBatch);
  }
}

function findStudent(
  classGroup: ClassGroupCenterReadModelV1,
  request: BulletinStudentEmissionRequestV1,
): {
  readonly student: BulletinStudentIdentityV1;
  readonly enrollmentVersion: ClassGroupCenterVersionedValueV1<{ readonly id: string }>;
  readonly studentVersion: ClassGroupCenterVersionedValueV1<{ readonly id: string }>;
} {
  const match = classGroup.students.find(
    ({ enrollment }) =>
      enrollment.value.id === request.target.enrollmentId &&
      enrollment.value.studentId === request.target.studentId &&
      enrollment.value.classGroupId === request.target.classGroupId &&
      enrollment.value.academicYearId === request.academicYearId,
  );
  if (match?.student === null || match === undefined) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.studentTargetNotFound);
  }
  if (match.student.value.id !== request.target.studentId) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData);
  }
  return {
    student: {
      id: match.student.value.id,
      enrollmentId: match.enrollment.value.id,
      displayName: match.student.value.displayName,
    },
    enrollmentVersion: match.enrollment,
    studentVersion: match.student,
  };
}

type BulletinAssignmentV1 = ClassGroupCenterReadModelV1['assignments'][number];
type BulletinTokensV1 = ReturnType<typeof versionToken>[];
type BulletinBuildV1 = {
  dependencies: BulletinModelMaterializerDependenciesV1;
  request: BulletinStudentEmissionRequestV1;
  assignments: readonly BulletinAssignmentV1[];
  tokens: BulletinTokensV1;
};

/** The class's teaching assignments, by subject name; each must belong to this class and year. */
function checkedAssignmentsV1(
  classGroup: ClassGroupCenterReadModelV1,
  request: BulletinStudentEmissionRequestV1,
) {
  const assignments = [...classGroup.assignments].sort((left, right) => {
    if (left.subject === null || right.subject === null) return 0;
    return (
      codeUnitCompare(left.subject.value.displayName, right.subject.value.displayName) ||
      codeUnitCompare(left.assignment.value.id, right.assignment.value.id)
    );
  });
  if (assignments.length === 0) block(BULLETIN_MATERIALIZATION_REASONS_V1.noSubjects);
  if (assignments.some(({ subject }) => subject === null)) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.subjectNotFound);
  }
  for (const assignment of assignments) {
    if (
      assignment.subject === null ||
      assignment.assignment.value.academicYearId !== request.academicYearId ||
      assignment.assignment.value.classGroupId !== request.target.classGroupId ||
      assignment.assignment.value.subjectId !== assignment.subject.value.id
    ) {
      block(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData);
    }
  }
  return assignments;
}

/** The subject of an assignment, with both versions recorded in the data version. */
function subjectOfV1(assignment: BulletinAssignmentV1, tokens: BulletinTokensV1) {
  if (assignment.subject === null) block(BULLETIN_MATERIALIZATION_REASONS_V1.subjectNotFound);
  tokens.push(
    versionToken('teaching-assignment', assignment.assignment),
    versionToken('subject', assignment.subject),
  );
  return {
    id: assignment.subject.value.id,
    teachingAssignmentId: assignment.assignment.value.id,
    displayName: assignment.subject.value.displayName,
  };
}

function requestedTermsV1(request: BulletinStudentEmissionRequestV1) {
  return request.period.kind === 'term' ? [request.period.term] : ACADEMIC_TERMS_V1;
}

async function annualResultV1(build: BulletinBuildV1, assignment: BulletinAssignmentV1) {
  return build.request.period.kind === 'annual'
    ? await loadAnnual(build.dependencies.academicRecords, build.request, assignment, build.tokens)
    : null;
}

async function syntheticSubjectsV1(build: BulletinBuildV1) {
  const { dependencies, request, tokens } = build;
  const subjects: BulletinSyntheticSubjectV1[] = [];
  for (const assignment of build.assignments) {
    const subject = subjectOfV1(assignment, tokens);
    const result =
      request.period.kind === 'term'
        ? (
            await loadTerm(
              dependencies.academicRecords,
              request,
              assignment,
              request.period.term,
              tokens,
            )
          ).summary
        : await loadAnnual(dependencies.academicRecords, request, assignment, tokens);
    subjects.push({ subject, result });
  }
  return subjects;
}

async function compositionSubjectsV1(build: BulletinBuildV1) {
  const { dependencies, request, tokens } = build;
  const subjects: BulletinCompositionSubjectV1[] = [];
  for (const assignment of build.assignments) {
    const subject = subjectOfV1(assignment, tokens);
    const terms: BulletinTermCompositionV1[] = [];
    for (const term of requestedTermsV1(request)) {
      terms.push(
        (await loadTerm(dependencies.academicRecords, request, assignment, term, tokens))
          .composition,
      );
    }
    subjects.push({ subject, terms, annualResult: await annualResultV1(build, assignment) });
  }
  return subjects;
}

async function detailedSubjectsV1(build: BulletinBuildV1) {
  const { dependencies, request, tokens } = build;
  const subjects: BulletinDetailedSubjectV1[] = [];
  for (const assignment of build.assignments) {
    const subject = subjectOfV1(assignment, tokens);
    const terms: BulletinDetailedTermV1[] = [];
    for (const term of requestedTermsV1(request)) {
      const loaded = await loadTerm(
        dependencies.academicRecords,
        request,
        assignment,
        term,
        tokens,
      );
      terms.push({
        ...loaded.composition,
        assessments: await loadAssessments(
          dependencies.academicRecords,
          request,
          assignment,
          term,
          tokens,
        ),
      });
    }
    subjects.push({ subject, terms, annualResult: await annualResultV1(build, assignment) });
  }
  return subjects;
}

async function materializeReady(
  dependencies: BulletinModelMaterializerDependenciesV1,
  request: BulletinStudentEmissionRequestV1,
  classGroup: ClassGroupCenterReadModelV1,
): Promise<Extract<BulletinModelMaterializationResultV1, { readonly status: 'ready' }>> {
  if (
    classGroup.academicYearId !== request.academicYearId ||
    classGroup.classGroup.value.id !== request.target.classGroupId ||
    classGroup.classGroup.value.academicYearId !== request.academicYearId
  ) {
    block(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData);
  }

  const student = findStudent(classGroup, request);
  const assignments = checkedAssignmentsV1(classGroup, request);

  const tokens = [
    versionToken('class-group', classGroup.classGroup),
    versionToken('enrollment', student.enrollmentVersion),
    versionToken('student', student.studentVersion),
  ];
  const base = {
    contractVersion: BULLETIN_CONTRACT_VERSION_V1,
    modelVersion: BULLETIN_MODEL_VERSION_V1,
    academicYearId: request.academicYearId,
    period: request.period,
    student: student.student,
    classGroup: {
      id: classGroup.classGroup.value.id,
      code: classGroup.classGroup.value.code,
    },
    authorityMode: BULLETIN_AUTHORITY_MODE_V1,
  } as const;
  const build: BulletinBuildV1 = { dependencies, request, assignments, tokens };

  let model: BulletinModelV1;
  if (request.model === 'synthetic') {
    model = { ...base, modelKind: request.model, subjects: await syntheticSubjectsV1(build) };
  } else if (request.model === 'composition') {
    model = { ...base, modelKind: request.model, subjects: await compositionSubjectsV1(build) };
  } else {
    model = { ...base, modelKind: request.model, subjects: await detailedSubjectsV1(build) };
  }

  return { status: 'ready', model, dataVersion: dataVersion(model, tokens) };
}

function stoppedMaterialization(error: unknown): MaterializationStoppedResult {
  if (error instanceof MaterializationStopped) return error.result;
  return {
    status: 'blocked',
    reasons: reasons(BULLETIN_MATERIALIZATION_REASONS_V1.academicDataUnavailable),
  };
}

function unavailableMaterialization(reason: string): MaterializationStoppedResult {
  return { status: 'blocked', reasons: reasons(reason) };
}

function materializationCacheKey(request: BulletinStudentEmissionRequestV1): string {
  return JSON.stringify({
    academicYearId: request.academicYearId,
    period: request.period,
    target: request.target,
    model: request.model,
  });
}

function classGroupCacheKey(request: BulletinEmissionRequestV1): string {
  return `${request.academicYearId}\u0000${request.target.classGroupId}`;
}

function studentRequestOrNull(
  request: BulletinEmissionRequestV1,
): BulletinStudentEmissionRequestV1 | null {
  return request.target.kind === 'student' ? (request as BulletinStudentEmissionRequestV1) : null;
}

/** A class read for another year or another class cannot back the request. */
function incompatibleClassGroupV1(
  classGroup: ClassGroupCenterReadModelV1,
  request: BulletinEmissionRequestV1,
) {
  return (
    classGroup.academicYearId !== request.academicYearId ||
    classGroup.classGroup.value.id !== request.target.classGroupId ||
    classGroup.classGroup.value.academicYearId !== request.academicYearId
  );
}

/** One student's request as is; a class request becomes one per enrolled student, in enrollment
 * order. An empty class or an enrollment of another class is reported in `results` instead. */
function studentRequestsV1(
  sourceRequest: BulletinEmissionRequestV1,
  classGroup: ClassGroupCenterReadModelV1,
  requestIndex: number,
  results: BulletinAggregateMaterializationItemV1[],
): BulletinStudentEmissionRequestV1[] {
  if (sourceRequest.target.kind === 'student') return [sourceRequest as BulletinStudentEmissionRequestV1];
  const students = [...classGroup.students].sort((left, right) =>
    codeUnitCompare(left.enrollment.value.id, right.enrollment.value.id),
  );
  if (students.length === 0) {
    results.push({
      requestIndex,
      request: null,
      materialization: unavailableMaterialization(
        BULLETIN_MATERIALIZATION_REASONS_V1.studentTargetNotFound,
      ),
    });
    return [];
  }
  const studentRequests: BulletinStudentEmissionRequestV1[] = [];
  for (const { enrollment } of students) {
    if (
      enrollment.value.academicYearId !== sourceRequest.academicYearId ||
      enrollment.value.classGroupId !== sourceRequest.target.classGroupId
    ) {
      results.push({
        requestIndex,
        request: null,
        materialization: unavailableMaterialization(
          BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData,
        ),
      });
      continue;
    }
    studentRequests.push({
      ...sourceRequest,
      target: {
        kind: 'student',
        classGroupId: enrollment.value.classGroupId,
        studentId: enrollment.value.studentId,
        enrollmentId: enrollment.value.id,
      },
    });
  }
  return studentRequests;
}

export function createBulletinModelMaterializerV1(
  dependencies: BulletinModelMaterializerDependenciesV1,
): BulletinModelMaterializerV1 {
  async function materializeStudent(
    request: BulletinStudentEmissionRequestV1,
    classGroup?: ClassGroupCenterReadModelV1,
  ): Promise<BulletinModelMaterializationResultV1> {
    try {
      const base =
        classGroup ??
        (await dependencies.classGroups.get(
          { academicYearId: request.academicYearId },
          request.target.classGroupId,
        ));
      if (base === null) {
        return unavailableMaterialization(BULLETIN_MATERIALIZATION_REASONS_V1.classGroupNotFound);
      }
      return await materializeReady(dependencies, request, base);
    } catch (error) {
      return stoppedMaterialization(error);
    }
  }

  return {
    async materialize(request) {
      try {
        requireStudentRequest(request);
        return await materializeStudent(request);
      } catch (error) {
        return stoppedMaterialization(error);
      }
    },

    async materializeBatch(requests) {
      const results: BulletinAggregateMaterializationItemV1[] = [];
      const classGroups = new Map<string, Promise<ClassGroupCenterReadModelV1 | null>>();
      const studentMaterializations = new Map<
        string,
        Promise<BulletinModelMaterializationResultV1>
      >();

      function loadClassGroup(
        request: BulletinEmissionRequestV1,
      ): Promise<ClassGroupCenterReadModelV1 | null> {
        const key = classGroupCacheKey(request);
        const cached = classGroups.get(key);
        if (cached !== undefined) return cached;
        const loaded = dependencies.classGroups.get(
          { academicYearId: request.academicYearId },
          request.target.classGroupId,
        );
        classGroups.set(key, loaded);
        return loaded;
      }

      function materializeShared(
        request: BulletinStudentEmissionRequestV1,
        classGroup: ClassGroupCenterReadModelV1,
      ): Promise<BulletinModelMaterializationResultV1> {
        const key = materializationCacheKey(request);
        const cached = studentMaterializations.get(key);
        if (cached !== undefined) return cached;
        const materialization = materializeStudent(request, classGroup);
        studentMaterializations.set(key, materialization);
        return materialization;
      }

      for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
        const sourceRequest = requests[requestIndex];
        if (sourceRequest === undefined) continue;

        let classGroup: ClassGroupCenterReadModelV1 | null;
        try {
          classGroup = await loadClassGroup(sourceRequest);
        } catch (error) {
          results.push({
            requestIndex,
            request: studentRequestOrNull(sourceRequest),
            materialization: stoppedMaterialization(error),
          });
          continue;
        }

        if (classGroup === null || incompatibleClassGroupV1(classGroup, sourceRequest)) {
          results.push({
            requestIndex,
            request: studentRequestOrNull(sourceRequest),
            materialization: unavailableMaterialization(
              classGroup === null
                ? BULLETIN_MATERIALIZATION_REASONS_V1.classGroupNotFound
                : BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData,
            ),
          });
          continue;
        }

        const studentRequests = studentRequestsV1(sourceRequest, classGroup, requestIndex, results);
        for (const studentRequest of studentRequests) {
          results.push({
            requestIndex,
            request: studentRequest,
            materialization: await materializeShared(studentRequest, classGroup),
          });
        }
      }
      return results;
    },
  };
}
