import type {
  ClassGroupId,
  ClassGroupV1,
  EnrollmentV1,
  StudentStatusEventV1,
  StudentV1,
  SubjectV1,
  TeacherV1,
  TeachingAssignmentV1,
} from '../../../../../shared/gradebook-contracts/entities';
import type {
  AcademicEntityKindV1,
  AcademicEntityRecordV1,
  AcademicEntityRepositoryV1,
  AcademicPersistenceContextV1,
  VersionedRecordV1,
  PersistedAssessmentComponentV1,
} from '../../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 100;

type ClassGroupCenterReadModelErrorCodeV1 =
  'invalid-page-size' | 'incompatible-repository-result' | 'cursor-cycle';

const ERROR_MESSAGES: Record<ClassGroupCenterReadModelErrorCodeV1, string> = {
  'invalid-page-size': 'A paginação interna da Central da Turma é inválida.',
  'incompatible-repository-result':
    'A consulta da Central da Turma recebeu um resultado incompatível.',
  'cursor-cycle': 'A consulta da Central da Turma recebeu um cursor repetido.',
};

export class ClassGroupCenterReadModelErrorV1 extends Error {
  readonly code: ClassGroupCenterReadModelErrorCodeV1;

  constructor(code: ClassGroupCenterReadModelErrorCodeV1) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ClassGroupCenterReadModelErrorV1';
    this.code = code;
  }
}

export interface ClassGroupCenterVersionedValueV1<Value> {
  readonly value: Value;
  readonly version: number;
  readonly recordedAt: string;
}

export interface ClassGroupCenterStudentV1 {
  readonly enrollment: ClassGroupCenterVersionedValueV1<EnrollmentV1>;
  readonly student: ClassGroupCenterVersionedValueV1<StudentV1> | null;
  readonly statusHistory: readonly ClassGroupCenterVersionedValueV1<StudentStatusEventV1>[];
}

export interface ClassGroupCenterAssignmentV1 {
  readonly assignment: ClassGroupCenterVersionedValueV1<TeachingAssignmentV1>;
  readonly teacher: ClassGroupCenterVersionedValueV1<TeacherV1> | null;
  readonly subject: ClassGroupCenterVersionedValueV1<SubjectV1> | null;
  readonly assessmentComponents: readonly ClassGroupCenterVersionedValueV1<PersistedAssessmentComponentV1>[];
}

export interface ClassGroupCenterReadModelV1 {
  readonly academicYearId: AcademicPersistenceContextV1['academicYearId'];
  readonly classGroup: ClassGroupCenterVersionedValueV1<ClassGroupV1>;
  readonly students: readonly ClassGroupCenterStudentV1[];
  readonly assignments: readonly ClassGroupCenterAssignmentV1[];
}

export interface ClassGroupCenterQueryV1 {
  get(
    context: AcademicPersistenceContextV1,
    classGroupId: ClassGroupId,
  ): Promise<ClassGroupCenterReadModelV1 | null>;
}

interface ClassGroupCenterReadModelOptionsV1 {
  readonly pageSize?: number;
}

type EntityRecordOf<Kind extends AcademicEntityKindV1> = Extract<
  AcademicEntityRecordV1,
  { readonly kind: Kind }
>;

type VersionedEntityRecordOf<Kind extends AcademicEntityKindV1> = VersionedRecordV1<
  EntityRecordOf<Kind>
>;

function fail(code: ClassGroupCenterReadModelErrorCodeV1): never {
  throw new ClassGroupCenterReadModelErrorV1(code);
}

function pageSize(options: ClassGroupCenterReadModelOptionsV1): number {
  const value = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAXIMUM_PAGE_SIZE) {
    return fail('invalid-page-size');
  }
  return value;
}

function requireKind<Kind extends AcademicEntityKindV1>(
  record: VersionedRecordV1<AcademicEntityRecordV1>,
  kind: Kind,
): VersionedEntityRecordOf<Kind> {
  if (record.value.kind !== kind) return fail('incompatible-repository-result');
  return record as VersionedEntityRecordOf<Kind>;
}

function valueOf<Record extends AcademicEntityRecordV1>(
  record: VersionedRecordV1<Record>,
): ClassGroupCenterVersionedValueV1<Record['value']> {
  return {
    value: record.value.value,
    version: record.version,
    recordedAt: record.recordedAt,
  };
}

async function listAll<Kind extends AcademicEntityKindV1>(
  repository: AcademicEntityRepositoryV1,
  context: AcademicPersistenceContextV1,
  kind: Kind,
  limit: number,
): Promise<readonly VersionedEntityRecordOf<Kind>[]> {
  const records: VersionedEntityRecordOf<Kind>[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await repository.list(context, kind, { limit, cursor });
    records.push(...page.items.map((record) => requireKind(record, kind)));
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) return fail('cursor-cycle');
      seenCursors.add(cursor);
    }
  } while (cursor !== null);

  return records;
}

function indexById<Value extends { readonly id: string }>(
  records: readonly ClassGroupCenterVersionedValueV1<Value>[],
): ReadonlyMap<Value['id'], ClassGroupCenterVersionedValueV1<Value>> {
  const result = new Map<Value['id'], ClassGroupCenterVersionedValueV1<Value>>();
  for (const record of records) {
    if (result.has(record.value.id)) return fail('incompatible-repository-result');
    result.set(record.value.id, record);
  }
  return result;
}

function byId<Value extends { readonly id: string }>(
  left: ClassGroupCenterVersionedValueV1<Value>,
  right: ClassGroupCenterVersionedValueV1<Value>,
): number {
  return left.value.id.localeCompare(right.value.id);
}

function byStatusHistory(
  left: ClassGroupCenterVersionedValueV1<StudentStatusEventV1>,
  right: ClassGroupCenterVersionedValueV1<StudentStatusEventV1>,
): number {
  const leftDate = left.value.occurredOn ?? '\uffff';
  const rightDate = right.value.occurredOn ?? '\uffff';
  return leftDate.localeCompare(rightDate) || byId(left, right);
}

function byAssessmentComponent(
  left: ClassGroupCenterVersionedValueV1<PersistedAssessmentComponentV1>,
  right: ClassGroupCenterVersionedValueV1<PersistedAssessmentComponentV1>,
): number {
  return (
    left.value.term - right.value.term || left.value.order - right.value.order || byId(left, right)
  );
}

export function createClassGroupCenterQueryV1(
  repository: AcademicEntityRepositoryV1,
  options: ClassGroupCenterReadModelOptionsV1 = {},
): ClassGroupCenterQueryV1 {
  const limit = pageSize(options);

  return {
    async get(context, classGroupId) {
      const classGroupRecord = await repository.get(context, {
        kind: 'class-group',
        id: classGroupId,
      });
      if (classGroupRecord === null) return null;
      const classGroup = requireKind(classGroupRecord, 'class-group');
      if (
        classGroup.value.value.id !== classGroupId ||
        classGroup.value.value.academicYearId !== context.academicYearId
      ) {
        return fail('incompatible-repository-result');
      }

      const [
        allEnrollments,
        allStudents,
        allStatusEvents,
        allAssignments,
        allTeachers,
        allSubjects,
        allAssessmentComponents,
      ] = await Promise.all([
        listAll(repository, context, 'enrollment', limit),
        listAll(repository, context, 'student', limit),
        listAll(repository, context, 'student-status-event', limit),
        listAll(repository, context, 'teaching-assignment', limit),
        listAll(repository, context, 'teacher', limit),
        listAll(repository, context, 'subject', limit),
        listAll(repository, context, 'assessment-component', limit),
      ]);

      const enrollments = allEnrollments
        .filter(
          ({ value }) =>
            value.value.academicYearId === context.academicYearId &&
            value.value.classGroupId === classGroupId,
        )
        .map(valueOf)
        .sort(byId);
      const assignments = allAssignments
        .filter(
          ({ value }) =>
            value.value.academicYearId === context.academicYearId &&
            value.value.classGroupId === classGroupId,
        )
        .map(valueOf)
        .sort(byId);
      const enrollmentIds = new Set(enrollments.map(({ value }) => value.id));
      const assignmentIds = new Set(assignments.map(({ value }) => value.id));
      const studentIndex = indexById(allStudents.map(valueOf));
      const teacherIndex = indexById(allTeachers.map(valueOf));
      const subjectIndex = indexById(allSubjects.map(valueOf));
      const historyByEnrollment = new Map<
        EnrollmentV1['id'],
        ClassGroupCenterVersionedValueV1<StudentStatusEventV1>[]
      >();
      const componentsByAssignment = new Map<
        TeachingAssignmentV1['id'],
        ClassGroupCenterVersionedValueV1<PersistedAssessmentComponentV1>[]
      >();

      for (const eventRecord of allStatusEvents) {
        const event = valueOf(eventRecord);
        if (
          event.value.academicYearId !== context.academicYearId ||
          !enrollmentIds.has(event.value.enrollmentId)
        ) {
          continue;
        }
        const history = historyByEnrollment.get(event.value.enrollmentId) ?? [];
        history.push(event);
        historyByEnrollment.set(event.value.enrollmentId, history);
      }

      for (const componentRecord of allAssessmentComponents) {
        const component = valueOf(componentRecord);
        if (
          component.value.academicYearId !== context.academicYearId ||
          !assignmentIds.has(component.value.teachingAssignmentId)
        ) {
          continue;
        }
        const components = componentsByAssignment.get(component.value.teachingAssignmentId) ?? [];
        components.push(component);
        componentsByAssignment.set(component.value.teachingAssignmentId, components);
      }

      return {
        academicYearId: context.academicYearId,
        classGroup: valueOf(classGroup),
        students: enrollments.map((enrollment) => ({
          enrollment,
          student: studentIndex.get(enrollment.value.studentId) ?? null,
          statusHistory: (historyByEnrollment.get(enrollment.value.id) ?? []).sort(byStatusHistory),
        })),
        assignments: assignments.map((assignment) => ({
          assignment,
          teacher: teacherIndex.get(assignment.value.teacherId) ?? null,
          subject: subjectIndex.get(assignment.value.subjectId) ?? null,
          assessmentComponents: (componentsByAssignment.get(assignment.value.id) ?? []).sort(
            byAssessmentComponent,
          ),
        })),
      };
    },
  };
}
