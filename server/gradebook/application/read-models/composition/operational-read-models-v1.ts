import { createClassGroupCenterQueryV1 } from '../class-group/class-group-center-read-model-v1';
import {
  createAcademicGlobalSearchReadModelV1,
  type AcademicGlobalSearchReadModelV1,
} from '../search/academic-global-search-read-model-v1';
import { createStudentCenterQueryV1 } from '../student/student-center-read-model-v1';
import { createTeachingCenterQueriesV1 } from '../teaching/teaching-center-read-models-v1';
import type { ClassGroupCenterQueryV1 } from '../class-group/class-group-center-read-model-v1';
import type { StudentCenterQueryV1 } from '../student/student-center-read-model-v1';
import type {
  SubjectCenterQueryV1,
  TeacherCenterQueryV1,
} from '../teaching/teaching-center-read-models-v1';
import type { PersistenceUnitOfWorkV1 } from '../../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';

export interface GradebookOperationalReadModelsV1 {
  readonly students: StudentCenterQueryV1;
  readonly classGroups: ClassGroupCenterQueryV1;
  readonly teachers: TeacherCenterQueryV1;
  readonly subjects: SubjectCenterQueryV1;
  readonly search: AcademicGlobalSearchReadModelV1;
}

interface GradebookOperationalReadModelOptionsV1 {
  readonly pageSize?: number;
}

/**
 * Exposes the four operational centers and academic search through the entity repository already
 * selected by the UoW. The facade only composes existing queries; it does not add persistence access,
 * matching, authorization or academic rules.
 */
export function createGradebookOperationalReadModelsV1(
  unitOfWork: PersistenceUnitOfWorkV1,
  options: GradebookOperationalReadModelOptionsV1 = {},
): GradebookOperationalReadModelsV1 {
  const teaching = createTeachingCenterQueriesV1(unitOfWork.entities, options);
  const searchOptions =
    options.pageSize === undefined ? {} : { repositoryPageSize: options.pageSize };

  return {
    students: createStudentCenterQueryV1(unitOfWork.entities, options),
    classGroups: createClassGroupCenterQueryV1(unitOfWork.entities, options),
    teachers: teaching.teachers,
    subjects: teaching.subjects,
    search: createAcademicGlobalSearchReadModelV1(unitOfWork.entities, searchOptions),
  };
}
