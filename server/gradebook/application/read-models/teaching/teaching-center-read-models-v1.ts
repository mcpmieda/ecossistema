import type {
  ClassGroupV1,
  SubjectId,
  SubjectV1,
  TeacherId,
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

type TeachingCenterReadModelErrorCodeV1 =
  'invalid-page-size' | 'incompatible-repository-result' | 'cursor-cycle';

const ERROR_MESSAGES: Record<TeachingCenterReadModelErrorCodeV1, string> = {
  'invalid-page-size': 'A paginação interna das Centrais de Ensino é inválida.',
  'incompatible-repository-result':
    'A consulta das Centrais de Ensino recebeu um resultado incompatível.',
  'cursor-cycle': 'A consulta das Centrais de Ensino recebeu um cursor repetido.',
};

export class TeachingCenterReadModelErrorV1 extends Error {
  readonly code: TeachingCenterReadModelErrorCodeV1;

  constructor(code: TeachingCenterReadModelErrorCodeV1) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TeachingCenterReadModelErrorV1';
    this.code = code;
  }
}

export interface TeachingCenterVersionedValueV1<Value> {
  readonly value: Value;
  readonly version: number;
  readonly recordedAt: string;
}

export interface TeacherCenterAssignmentV1 {
  readonly assignment: TeachingCenterVersionedValueV1<TeachingAssignmentV1>;
  readonly classGroup: TeachingCenterVersionedValueV1<ClassGroupV1> | null;
  readonly subject: TeachingCenterVersionedValueV1<SubjectV1> | null;
  readonly assessmentComponents: readonly TeachingCenterVersionedValueV1<PersistedAssessmentComponentV1>[];
}

export interface SubjectCenterAssignmentV1 {
  readonly assignment: TeachingCenterVersionedValueV1<TeachingAssignmentV1>;
  readonly classGroup: TeachingCenterVersionedValueV1<ClassGroupV1> | null;
  readonly teacher: TeachingCenterVersionedValueV1<TeacherV1> | null;
  readonly assessmentComponents: readonly TeachingCenterVersionedValueV1<PersistedAssessmentComponentV1>[];
}

export interface TeacherCenterReadModelV1 {
  readonly academicYearId: AcademicPersistenceContextV1['academicYearId'];
  readonly teacher: TeachingCenterVersionedValueV1<TeacherV1>;
  readonly assignments: readonly TeacherCenterAssignmentV1[];
}

export interface SubjectCenterReadModelV1 {
  readonly academicYearId: AcademicPersistenceContextV1['academicYearId'];
  readonly subject: TeachingCenterVersionedValueV1<SubjectV1>;
  readonly assignments: readonly SubjectCenterAssignmentV1[];
}

export interface TeacherCenterQueryV1 {
  get(
    context: AcademicPersistenceContextV1,
    teacherId: TeacherId,
  ): Promise<TeacherCenterReadModelV1 | null>;
}

export interface SubjectCenterQueryV1 {
  get(
    context: AcademicPersistenceContextV1,
    subjectId: SubjectId,
  ): Promise<SubjectCenterReadModelV1 | null>;
}

interface TeachingCenterQueriesV1 {
  readonly teachers: TeacherCenterQueryV1;
  readonly subjects: SubjectCenterQueryV1;
}

interface TeachingCenterReadModelOptionsV1 {
  readonly pageSize?: number;
}

type EntityRecordOf<Kind extends AcademicEntityKindV1> = Extract<
  AcademicEntityRecordV1,
  { readonly kind: Kind }
>;

type VersionedEntityRecordOf<Kind extends AcademicEntityKindV1> = VersionedRecordV1<
  EntityRecordOf<Kind>
>;

function fail(code: TeachingCenterReadModelErrorCodeV1): never {
  throw new TeachingCenterReadModelErrorV1(code);
}

function pageSize(options: TeachingCenterReadModelOptionsV1): number {
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
): TeachingCenterVersionedValueV1<Record['value']> {
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
  records: readonly TeachingCenterVersionedValueV1<Value>[],
): ReadonlyMap<Value['id'], TeachingCenterVersionedValueV1<Value>> {
  const result = new Map<Value['id'], TeachingCenterVersionedValueV1<Value>>();
  for (const record of records) {
    if (result.has(record.value.id)) return fail('incompatible-repository-result');
    result.set(record.value.id, record);
  }
  return result;
}

function byId<Value extends { readonly id: string }>(
  left: TeachingCenterVersionedValueV1<Value>,
  right: TeachingCenterVersionedValueV1<Value>,
): number {
  return left.value.id.localeCompare(right.value.id);
}

function byAssessmentComponent(
  left: TeachingCenterVersionedValueV1<PersistedAssessmentComponentV1>,
  right: TeachingCenterVersionedValueV1<PersistedAssessmentComponentV1>,
): number {
  return (
    left.value.term - right.value.term || left.value.order - right.value.order || byId(left, right)
  );
}

interface TeachingGraphV1 {
  readonly assignments: readonly TeachingCenterVersionedValueV1<TeachingAssignmentV1>[];
  readonly classGroups: ReadonlyMap<
    ClassGroupV1['id'],
    TeachingCenterVersionedValueV1<ClassGroupV1>
  >;
  readonly teachers: ReadonlyMap<TeacherV1['id'], TeachingCenterVersionedValueV1<TeacherV1>>;
  readonly subjects: ReadonlyMap<SubjectV1['id'], TeachingCenterVersionedValueV1<SubjectV1>>;
  readonly assessmentComponents: readonly TeachingCenterVersionedValueV1<PersistedAssessmentComponentV1>[];
}

async function loadTeachingGraph(
  repository: AcademicEntityRepositoryV1,
  context: AcademicPersistenceContextV1,
  limit: number,
): Promise<TeachingGraphV1> {
  const [assignments, classGroups, teachers, subjects, assessmentComponents] = await Promise.all([
    listAll(repository, context, 'teaching-assignment', limit),
    listAll(repository, context, 'class-group', limit),
    listAll(repository, context, 'teacher', limit),
    listAll(repository, context, 'subject', limit),
    listAll(repository, context, 'assessment-component', limit),
  ]);
  return {
    assignments: assignments
      .filter(({ value }) => value.value.academicYearId === context.academicYearId)
      .map(valueOf)
      .sort(byId),
    classGroups: indexById(
      classGroups
        .filter(({ value }) => value.value.academicYearId === context.academicYearId)
        .map(valueOf),
    ),
    teachers: indexById(teachers.map(valueOf)),
    subjects: indexById(subjects.map(valueOf)),
    assessmentComponents: assessmentComponents
      .filter(({ value }) => value.value.academicYearId === context.academicYearId)
      .map(valueOf),
  };
}

function componentsByAssignment(
  components: readonly TeachingCenterVersionedValueV1<PersistedAssessmentComponentV1>[],
  assignmentIds: ReadonlySet<TeachingAssignmentV1['id']>,
): ReadonlyMap<
  TeachingAssignmentV1['id'],
  readonly TeachingCenterVersionedValueV1<PersistedAssessmentComponentV1>[]
> {
  const result = new Map<
    TeachingAssignmentV1['id'],
    TeachingCenterVersionedValueV1<PersistedAssessmentComponentV1>[]
  >();
  for (const component of components) {
    if (!assignmentIds.has(component.value.teachingAssignmentId)) continue;
    const values = result.get(component.value.teachingAssignmentId) ?? [];
    values.push(component);
    result.set(component.value.teachingAssignmentId, values);
  }
  for (const values of result.values()) values.sort(byAssessmentComponent);
  return result;
}

export function createTeachingCenterQueriesV1(
  repository: AcademicEntityRepositoryV1,
  options: TeachingCenterReadModelOptionsV1 = {},
): TeachingCenterQueriesV1 {
  const limit = pageSize(options);

  return {
    teachers: {
      async get(context, teacherId) {
        const teacherRecord = await repository.get(context, { kind: 'teacher', id: teacherId });
        if (teacherRecord === null) return null;
        const teacher = requireKind(teacherRecord, 'teacher');
        if (teacher.value.value.id !== teacherId) {
          return fail('incompatible-repository-result');
        }

        const graph = await loadTeachingGraph(repository, context, limit);
        const assignments = graph.assignments.filter(({ value }) => value.teacherId === teacherId);
        const componentIndex = componentsByAssignment(
          graph.assessmentComponents,
          new Set(assignments.map(({ value }) => value.id)),
        );
        return {
          academicYearId: context.academicYearId,
          teacher: valueOf(teacher),
          assignments: assignments.map((assignment) => ({
            assignment,
            classGroup: graph.classGroups.get(assignment.value.classGroupId) ?? null,
            subject: graph.subjects.get(assignment.value.subjectId) ?? null,
            assessmentComponents: componentIndex.get(assignment.value.id) ?? [],
          })),
        };
      },
    },
    subjects: {
      async get(context, subjectId) {
        const subjectRecord = await repository.get(context, { kind: 'subject', id: subjectId });
        if (subjectRecord === null) return null;
        const subject = requireKind(subjectRecord, 'subject');
        if (subject.value.value.id !== subjectId) {
          return fail('incompatible-repository-result');
        }

        const graph = await loadTeachingGraph(repository, context, limit);
        const assignments = graph.assignments.filter(({ value }) => value.subjectId === subjectId);
        const componentIndex = componentsByAssignment(
          graph.assessmentComponents,
          new Set(assignments.map(({ value }) => value.id)),
        );
        return {
          academicYearId: context.academicYearId,
          subject: valueOf(subject),
          assignments: assignments.map((assignment) => ({
            assignment,
            classGroup: graph.classGroups.get(assignment.value.classGroupId) ?? null,
            teacher: graph.teachers.get(assignment.value.teacherId) ?? null,
            assessmentComponents: componentIndex.get(assignment.value.id) ?? [],
          })),
        };
      },
    },
  };
}
