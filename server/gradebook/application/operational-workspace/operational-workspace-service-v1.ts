import {
  OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
  type OperationalWorkspaceAcademicYearContextV1,
  type OperationalWorkspaceAcademicYearOptionV1,
} from '../../../../shared/gradebook-contracts/operational-workspace/operational-workspace-contract-v1';
import type {
  OperationalWorkspaceClassGroupCenterViewV1,
  OperationalWorkspaceClassGroupLinkV1,
  OperationalWorkspaceStudentCenterViewV1,
  OperationalWorkspaceStudentLinkV1,
  OperationalWorkspaceStudentStatusV1,
  OperationalWorkspaceSubjectCenterViewV1,
  OperationalWorkspaceSubjectLinkV1,
  OperationalWorkspaceTeacherCenterViewV1,
  OperationalWorkspaceTeacherLinkV1,
  OperationalWorkspaceTeachingAssignmentV1,
  OperationalWorkspaceTransportRequestV1,
  OperationalWorkspaceTransportResponseV1,
} from '../../../../shared/gradebook-contracts/operational-workspace/operational-workspace-transport-v1';
import type { AcademicPersistenceContextV1 } from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';
import type { ClassGroupCenterReadModelV1 } from '../read-models/class-group/class-group-center-read-model-v1';
import type { GradebookOperationalReadModelsV1 } from '../read-models/composition/operational-read-models-v1';
import type { StudentCenterReadModelV1 } from '../read-models/student/student-center-read-model-v1';
import type {
  SubjectCenterReadModelV1,
  TeacherCenterReadModelV1,
  TeachingCenterVersionedValueV1,
} from '../read-models/teaching/teaching-center-read-models-v1';
import type {
  ClassGroupV1,
  StudentStatusEventV1,
  StudentV1,
  SubjectV1,
  TeacherV1,
} from '../../../../shared/gradebook-contracts/entities';

export interface OperationalWorkspaceAcademicYearSourceV1 {
  list(): Promise<readonly OperationalWorkspaceAcademicYearOptionV1[]>;
}

export interface OperationalWorkspaceServiceDependenciesV1 {
  readonly academicYears: OperationalWorkspaceAcademicYearSourceV1;
  readonly readModels: GradebookOperationalReadModelsV1;
}

type NonEmptyAcademicYearOptionsV1 = readonly [
  OperationalWorkspaceAcademicYearOptionV1,
  ...OperationalWorkspaceAcademicYearOptionV1[],
];

function nonEmptyAcademicYears(
  years: readonly OperationalWorkspaceAcademicYearOptionV1[],
): NonEmptyAcademicYearOptionsV1 | null {
  const first = years[0];
  return first === undefined ? null : [first, ...years.slice(1)];
}

function contextFor(
  years: NonEmptyAcademicYearOptionsV1,
  academicYearId: string,
): OperationalWorkspaceAcademicYearContextV1 | null {
  const selected = years.find((year) => year.id === academicYearId);
  if (!selected) return null;
  return {
    selectedAcademicYearId: selected.id,
    availableAcademicYears: years,
  };
}

function studentLink(value: StudentV1): OperationalWorkspaceStudentLinkV1 {
  return { kind: 'student', id: value.id, label: value.displayName };
}

function classGroupLink(value: ClassGroupV1): OperationalWorkspaceClassGroupLinkV1 {
  return { kind: 'class-group', id: value.id, label: value.code };
}

function teacherLink(value: TeacherV1): OperationalWorkspaceTeacherLinkV1 {
  return { kind: 'teacher', id: value.id, label: value.displayName };
}

function subjectLink(value: SubjectV1): OperationalWorkspaceSubjectLinkV1 {
  return { kind: 'subject', id: value.id, label: value.displayName };
}

function projectStatus(
  value: StudentStatusEventV1,
): OperationalWorkspaceStudentStatusV1 {
  return value.occurredOn === undefined
    ? { id: value.id, status: value.status }
    : { id: value.id, status: value.status, occurredOn: value.occurredOn };
}

function projectStudent(model: StudentCenterReadModelV1): OperationalWorkspaceStudentCenterViewV1 {
  return {
    kind: 'student',
    id: model.student.value.id,
    displayName: model.student.value.displayName,
    enrollments: model.enrollments.map((entry) => ({
      id: entry.enrollment.value.id,
      position: entry.enrollment.value.position,
      classGroup: entry.classGroup === null ? null : classGroupLink(entry.classGroup.value),
      statusHistory: entry.statusHistory.map((status) => projectStatus(status.value)),
    })),
  };
}

function classGroupAssignment(
  entry: ClassGroupCenterReadModelV1['assignments'][number],
): OperationalWorkspaceTeachingAssignmentV1 {
  return {
    id: entry.assignment.value.id,
    teacher: entry.teacher === null ? null : teacherLink(entry.teacher.value),
    subject: entry.subject === null ? null : subjectLink(entry.subject.value),
  };
}

function projectClassGroup(
  model: ClassGroupCenterReadModelV1,
): OperationalWorkspaceClassGroupCenterViewV1 {
  const value = model.classGroup.value;
  return {
    kind: 'class-group',
    id: value.id,
    code: value.code,
    schoolGrade: value.grade,
    section: value.section,
    ...(value.shift === undefined ? {} : { shift: value.shift }),
    students: model.students.map((entry) => ({
      id: entry.enrollment.value.id,
      position: entry.enrollment.value.position,
      student: entry.student === null ? null : studentLink(entry.student.value),
      statusHistory: entry.statusHistory.map((status) => projectStatus(status.value)),
    })),
    assignments: model.assignments.map(classGroupAssignment),
  };
}

function optionalClassGroup(
  value: TeachingCenterVersionedValueV1<ClassGroupV1> | null,
): OperationalWorkspaceClassGroupLinkV1 | null {
  return value === null ? null : classGroupLink(value.value);
}

function optionalTeacher(
  value: TeachingCenterVersionedValueV1<TeacherV1> | null,
): OperationalWorkspaceTeacherLinkV1 | null {
  return value === null ? null : teacherLink(value.value);
}

function optionalSubject(
  value: TeachingCenterVersionedValueV1<SubjectV1> | null,
): OperationalWorkspaceSubjectLinkV1 | null {
  return value === null ? null : subjectLink(value.value);
}

function teacherAssignment(
  entry: TeacherCenterReadModelV1['assignments'][number],
): OperationalWorkspaceTeachingAssignmentV1 {
  return {
    id: entry.assignment.value.id,
    classGroup: optionalClassGroup(entry.classGroup),
    subject: optionalSubject(entry.subject),
  };
}

function subjectAssignment(
  entry: SubjectCenterReadModelV1['assignments'][number],
): OperationalWorkspaceTeachingAssignmentV1 {
  return {
    id: entry.assignment.value.id,
    classGroup: optionalClassGroup(entry.classGroup),
    teacher: optionalTeacher(entry.teacher),
  };
}

function projectTeacher(model: TeacherCenterReadModelV1): OperationalWorkspaceTeacherCenterViewV1 {
  return {
    kind: 'teacher',
    id: model.teacher.value.id,
    displayName: model.teacher.value.displayName,
    status: model.teacher.value.status,
    assignments: model.assignments.map(teacherAssignment),
  };
}

function projectSubject(model: SubjectCenterReadModelV1): OperationalWorkspaceSubjectCenterViewV1 {
  return {
    kind: 'subject',
    id: model.subject.value.id,
    code: model.subject.value.code,
    displayName: model.subject.value.displayName,
    shortName: model.subject.value.shortName,
    status: model.subject.value.status,
    assignments: model.assignments.map(subjectAssignment),
  };
}

type WorkspaceViewV1 = Extract<OperationalWorkspaceTransportResponseV1, { view: unknown }>['view'];

/** A record that is not in the year reads as empty; otherwise its projected view. */
function viewResponseV1<M>(
  context: NonNullable<ReturnType<typeof contextFor>>,
  model: M | null,
  project: (model: M) => WorkspaceViewV1,
): OperationalWorkspaceTransportResponseV1 {
  return model === null
    ? { contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1, state: 'empty', context }
    : {
        contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
        state: 'ready',
        context,
        view: project(model),
      };
}

function unavailable(): OperationalWorkspaceTransportResponseV1 {
  return { contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1, state: 'unavailable' };
}

export function createOperationalWorkspaceServiceV1(
  dependencies: OperationalWorkspaceServiceDependenciesV1,
) {
  return {
    async execute(
      request: OperationalWorkspaceTransportRequestV1,
    ): Promise<OperationalWorkspaceTransportResponseV1> {
      const available = await dependencies.academicYears.list();
      const years = nonEmptyAcademicYears(available);

      if (request.operation === 'bootstrap') {
        return years === null
          ? {
              contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
              state: 'empty',
              availableAcademicYears: [],
            }
          : {
              contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
              state: 'ready',
              availableAcademicYears: years,
            };
      }

      if (years === null) return unavailable();
      const selectedAcademicYearId =
        request.operation === 'search' ? request.request.academicYearId : request.academicYearId;
      const context = contextFor(years, selectedAcademicYearId);
      if (context === null) return unavailable();
      const persistenceContext: AcademicPersistenceContextV1 = {
        academicYearId: context.selectedAcademicYearId,
      };

      if (request.operation === 'student') {
        const model = await dependencies.readModels.students.get(persistenceContext, request.id);
        return viewResponseV1(context, model, projectStudent);
      }

      if (request.operation === 'class-group') {
        const model = await dependencies.readModels.classGroups.get(persistenceContext, request.id);
        return viewResponseV1(context, model, projectClassGroup);
      }

      if (request.operation === 'teacher') {
        const model = await dependencies.readModels.teachers.get(persistenceContext, request.id);
        return viewResponseV1(context, model, projectTeacher);
      }

      if (request.operation === 'subject') {
        const model = await dependencies.readModels.subjects.get(persistenceContext, request.id);
        return viewResponseV1(context, model, projectSubject);
      }

      const response = await dependencies.readModels.search.search(request.request);
      if (response.outcome === 'not-authorized') {
        return {
          contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
          state: 'not-authorized',
        };
      }
      if (response.outcome === 'results') {
        return {
          contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
          state: 'ready',
          context,
          search: response,
        };
      }
      if (response.outcome === 'empty-query' || response.outcome === 'no-results') {
        return {
          contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
          state: 'empty',
          context,
          search: response,
        };
      }
      return unavailable();
    },
  };
}
