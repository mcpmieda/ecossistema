import type {
  ClassGroupV1,
  EnrollmentV1,
  StudentId,
  StudentStatusEventV1,
  StudentV1,
} from '../../../../../shared/gradebook-contracts/entities';
import type {
  AcademicEntityKindV1,
  AcademicEntityRecordV1,
  AcademicEntityRepositoryV1,
  AcademicPersistenceContextV1,
  VersionedRecordV1,
} from '../../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 100;

type StudentCenterReadModelErrorCodeV1 =
  'invalid-page-size' | 'incompatible-repository-result' | 'cursor-cycle';

const ERROR_MESSAGES: Record<StudentCenterReadModelErrorCodeV1, string> = {
  'invalid-page-size': 'A paginação interna da Central do Aluno é inválida.',
  'incompatible-repository-result':
    'A consulta da Central do Aluno recebeu um resultado incompatível.',
  'cursor-cycle': 'A consulta da Central do Aluno recebeu um cursor repetido.',
};

export class StudentCenterReadModelErrorV1 extends Error {
  readonly code: StudentCenterReadModelErrorCodeV1;

  constructor(code: StudentCenterReadModelErrorCodeV1) {
    super(ERROR_MESSAGES[code]);
    this.name = 'StudentCenterReadModelErrorV1';
    this.code = code;
  }
}

export interface StudentCenterVersionedValueV1<Value> {
  readonly value: Value;
  readonly version: number;
  readonly recordedAt: string;
}

export interface StudentCenterEnrollmentV1 {
  readonly enrollment: StudentCenterVersionedValueV1<EnrollmentV1>;
  readonly classGroup: StudentCenterVersionedValueV1<ClassGroupV1> | null;
  readonly statusHistory: readonly StudentCenterVersionedValueV1<StudentStatusEventV1>[];
}

export interface StudentCenterReadModelV1 {
  readonly academicYearId: AcademicPersistenceContextV1['academicYearId'];
  readonly student: StudentCenterVersionedValueV1<StudentV1>;
  readonly enrollments: readonly StudentCenterEnrollmentV1[];
}

export interface StudentCenterQueryV1 {
  get(
    context: AcademicPersistenceContextV1,
    studentId: StudentId,
  ): Promise<StudentCenterReadModelV1 | null>;
}

interface StudentCenterReadModelOptionsV1 {
  readonly pageSize?: number;
}

type EntityRecordOf<Kind extends AcademicEntityKindV1> = Extract<
  AcademicEntityRecordV1,
  { readonly kind: Kind }
>;

type VersionedEntityRecordOf<Kind extends AcademicEntityKindV1> = VersionedRecordV1<
  EntityRecordOf<Kind>
>;

function fail(code: StudentCenterReadModelErrorCodeV1): never {
  throw new StudentCenterReadModelErrorV1(code);
}

function pageSize(options: StudentCenterReadModelOptionsV1): number {
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
): StudentCenterVersionedValueV1<Record['value']> {
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

function byId<Value extends { readonly id: string }>(
  left: StudentCenterVersionedValueV1<Value>,
  right: StudentCenterVersionedValueV1<Value>,
): number {
  return left.value.id.localeCompare(right.value.id);
}

function byStatusHistory(
  left: StudentCenterVersionedValueV1<StudentStatusEventV1>,
  right: StudentCenterVersionedValueV1<StudentStatusEventV1>,
): number {
  const leftDate = left.value.occurredOn ?? '\uffff';
  const rightDate = right.value.occurredOn ?? '\uffff';
  return leftDate.localeCompare(rightDate) || byId(left, right);
}

function classGroupsById(
  records: readonly VersionedEntityRecordOf<'class-group'>[],
  context: AcademicPersistenceContextV1,
): ReadonlyMap<ClassGroupV1['id'], StudentCenterVersionedValueV1<ClassGroupV1>> {
  const result = new Map<ClassGroupV1['id'], StudentCenterVersionedValueV1<ClassGroupV1>>();
  for (const record of records) {
    const classGroup = valueOf(record);
    if (
      classGroup.value.academicYearId !== context.academicYearId ||
      result.has(classGroup.value.id)
    ) {
      return fail('incompatible-repository-result');
    }
    result.set(classGroup.value.id, classGroup);
  }
  return result;
}

export function createStudentCenterQueryV1(
  repository: AcademicEntityRepositoryV1,
  options: StudentCenterReadModelOptionsV1 = {},
): StudentCenterQueryV1 {
  const limit = pageSize(options);

  return {
    async get(context, studentId) {
      const studentRecord = await repository.get(context, { kind: 'student', id: studentId });
      if (studentRecord === null) return null;
      const student = requireKind(studentRecord, 'student');
      if (student.value.value.id !== studentId) {
        return fail('incompatible-repository-result');
      }

      const [allEnrollments, allStatusEvents, allClassGroups] = await Promise.all([
        listAll(repository, context, 'enrollment', limit),
        listAll(repository, context, 'student-status-event', limit),
        listAll(repository, context, 'class-group', limit),
      ]);
      const enrollments = allEnrollments
        .filter(
          ({ value }) =>
            value.value.academicYearId === context.academicYearId &&
            value.value.studentId === studentId,
        )
        .map(valueOf)
        .sort(byId);
      const enrollmentIds = new Set(enrollments.map(({ value }) => value.id));
      const classGroupIndex = classGroupsById(allClassGroups, context);
      const historyByEnrollment = new Map<
        EnrollmentV1['id'],
        StudentCenterVersionedValueV1<StudentStatusEventV1>[]
      >();

      for (const event of allStatusEvents) {
        if (
          event.value.value.academicYearId !== context.academicYearId ||
          !enrollmentIds.has(event.value.value.enrollmentId)
        ) {
          continue;
        }
        const history = historyByEnrollment.get(event.value.value.enrollmentId) ?? [];
        history.push(valueOf(event));
        historyByEnrollment.set(event.value.value.enrollmentId, history);
      }

      return {
        academicYearId: context.academicYearId,
        student: valueOf(student),
        enrollments: enrollments.map((enrollment) => ({
          enrollment,
          classGroup: classGroupIndex.get(enrollment.value.classGroupId) ?? null,
          statusHistory: (historyByEnrollment.get(enrollment.value.id) ?? []).sort(byStatusHistory),
        })),
      };
    },
  };
}
