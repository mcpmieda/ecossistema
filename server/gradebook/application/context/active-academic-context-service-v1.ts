import type { AcademicYearId } from '../../../../shared/gradebook-contracts/entities';
import {
  AcademicContextErrorV1,
  createAcademicContext2026V1,
  type AcademicContext2026V1,
} from '../../../../src/gradebook-domain/context/academic-context-2026-v1';
import type {
  AcademicEntityRepositoryV1,
  AcademicPersistenceContextV1,
} from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';

export interface ActiveAcademicContextServiceDependenciesV1 {
  readonly academicYearId: AcademicYearId;
  readonly entities: AcademicEntityRepositoryV1;
}

export interface ActiveAcademicContextServiceV1 {
  getActiveContext(): Promise<AcademicContext2026V1>;
}

export function createActiveAcademicContextServiceV1(
  dependencies: ActiveAcademicContextServiceDependenciesV1,
): ActiveAcademicContextServiceV1 {
  const persistenceContext = Object.freeze({
    academicYearId: dependencies.academicYearId,
  }) satisfies AcademicPersistenceContextV1;

  return Object.freeze({
    async getActiveContext(): Promise<AcademicContext2026V1> {
      const page = await dependencies.entities.list(persistenceContext, 'academic-year', {
        limit: 2,
        cursor: null,
      });

      if (page.items.length === 0) {
        throw new AcademicContextErrorV1('context-missing');
      }
      if (page.items.length !== 1 || page.nextCursor !== null) {
        throw new AcademicContextErrorV1('context-duplicate');
      }

      const record = page.items[0];
      if (
        record?.value.kind !== 'academic-year' ||
        record.value.value.id !== dependencies.academicYearId
      ) {
        throw new AcademicContextErrorV1('context-incompatible');
      }

      return createAcademicContext2026V1(record.value.value);
    },
  });
}
