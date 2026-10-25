import {
  BULLETIN_CONTRACT_VERSION_V1,
  type BulletinIssuerIdV1,
  type BulletinSnapshotIdV1,
  type BulletinSnapshotV1,
} from '../../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';
import type {
  BulletinAcademicYearOptionV1,
  BulletinClassGroupOptionV1,
  BulletinSnapshotHistoryItemV1,
  BulletinStudentOptionV1,
  BulletinWorkspaceTransportRequestV1,
  BulletinWorkspaceTransportResponseV1,
} from '../../../../shared/gradebook-contracts/bulletins/bulletin-transport-v1';
import type {
  AcademicEntityRepositoryV1,
  AcademicRecordRepositoryV1,
} from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';
import type { ClassGroupCenterQueryV1 } from '../read-models/class-group/class-group-center-read-model-v1';
import {
  createBulletinEmissionServiceV1,
  type BulletinServerEmissionContextV1,
} from './bulletin-emission-service-v1';
import type {
  BulletinSnapshotRepositoryV1,
  BulletinSnapshotSeriesKeyV1,
} from './bulletin-snapshot-repository-v1';

const PAGE_SIZE = 100;

export interface BulletinAcademicYearSourceV1 {
  list(): Promise<readonly BulletinAcademicYearOptionV1[]>;
}

export interface BulletinWorkspaceServiceDependenciesV1 {
  readonly academicYears: BulletinAcademicYearSourceV1;
  readonly entities: AcademicEntityRepositoryV1;
  readonly classGroups: ClassGroupCenterQueryV1;
  readonly academicRecords: AcademicRecordRepositoryV1;
  readonly snapshots: BulletinSnapshotRepositoryV1;
  readonly now: () => string;
  readonly createSnapshotId: (seriesKey: BulletinSnapshotSeriesKeyV1) => BulletinSnapshotIdV1;
}

export interface BulletinWorkspaceServerContextV1 extends BulletinServerEmissionContextV1 {
  readonly issuerId: BulletinIssuerIdV1;
}

function unavailable(
  operation: BulletinWorkspaceTransportRequestV1['operation'],
): BulletinWorkspaceTransportResponseV1 {
  return { contractVersion: BULLETIN_CONTRACT_VERSION_V1, operation, state: 'unavailable' };
}

function byCode(left: BulletinClassGroupOptionV1, right: BulletinClassGroupOptionV1): number {
  return left.code.localeCompare(right.code) || left.id.localeCompare(right.id);
}

async function classGroupOptions(
  repository: AcademicEntityRepositoryV1,
  academicYearId: Extract<
    BulletinWorkspaceTransportRequestV1,
    { readonly operation: 'class-groups' }
  >['academicYearId'],
): Promise<readonly BulletinClassGroupOptionV1[]> {
  const result: BulletinClassGroupOptionV1[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await repository.list(
      { academicYearId },
      'class-group',
      { limit: PAGE_SIZE, cursor },
    );
    for (const record of page.items) {
      if (
        record.value.kind !== 'class-group' ||
        record.value.value.academicYearId !== academicYearId
      ) {
        throw new Error('incompatible-class-group-result');
      }
      result.push({ id: record.value.value.id, code: record.value.value.code });
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) throw new Error('class-group-cursor-cycle');
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return result.sort(byCode);
}

async function studentOptions(
  classGroups: ClassGroupCenterQueryV1,
  request: Extract<BulletinWorkspaceTransportRequestV1, { readonly operation: 'students' }>,
): Promise<readonly BulletinStudentOptionV1[] | null> {
  const model = await classGroups.get(
    { academicYearId: request.academicYearId },
    request.classGroupId,
  );
  if (model === null) return null;
  if (
    model.academicYearId !== request.academicYearId ||
    model.classGroup.value.id !== request.classGroupId
  ) {
    throw new Error('incompatible-class-group-result');
  }
  return model.students
    .flatMap(({ enrollment, student }) => {
      if (
        student === null ||
        enrollment.value.academicYearId !== request.academicYearId ||
        enrollment.value.classGroupId !== request.classGroupId ||
        enrollment.value.studentId !== student.value.id
      ) {
        return [];
      }
      return [{
        studentId: student.value.id,
        enrollmentId: enrollment.value.id,
        displayName: student.value.displayName,
        position: enrollment.value.position,
      } satisfies BulletinStudentOptionV1];
    })
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.enrollmentId.localeCompare(right.enrollmentId),
    );
}

function historyItem(snapshot: BulletinSnapshotV1): BulletinSnapshotHistoryItemV1 {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.snapshotVersion,
    modelVersion: snapshot.modelVersion,
    dataVersion: snapshot.dataVersion,
    emittedAt: snapshot.emittedAt,
    academicYearId: snapshot.model.academicYearId,
    classGroupId: snapshot.model.classGroup.id,
    classGroupCode: snapshot.model.classGroup.code,
    studentId: snapshot.model.student.id,
    enrollmentId: snapshot.model.student.enrollmentId,
    studentDisplayName: snapshot.model.student.displayName,
    period: snapshot.model.period,
    modelKind: snapshot.model.modelKind,
  };
}

export function createBulletinWorkspaceServiceV1(
  dependencies: BulletinWorkspaceServiceDependenciesV1,
) {
  const emission = createBulletinEmissionServiceV1({
    classGroups: dependencies.classGroups,
    academicRecords: dependencies.academicRecords,
    snapshots: dependencies.snapshots,
    now: dependencies.now,
    createSnapshotId: dependencies.createSnapshotId,
  });

  /** The class's emitted snapshots (optionally some students), or unavailable without history. */
  async function readHistory(
    request: Extract<BulletinWorkspaceTransportRequestV1, { readonly operation: 'history' }>,
  ): Promise<BulletinWorkspaceTransportResponseV1> {
    if (dependencies.snapshots.listHistory === undefined) return unavailable(request.operation);
    const snapshots = await dependencies.snapshots.listHistory({
      academicYearId: request.academicYearId,
      classGroupId: request.classGroupId,
      ...(request.studentIds === undefined ? {} : { studentIds: request.studentIds }),
    });
    const items = snapshots.map(historyItem);
    return items.length === 0
      ? {
          contractVersion: BULLETIN_CONTRACT_VERSION_V1,
          operation: request.operation,
          state: 'empty',
          items: [],
        }
      : {
          contractVersion: BULLETIN_CONTRACT_VERSION_V1,
          operation: request.operation,
          state: 'ready',
          items,
        };
  }

  return {
    async execute(
      request: BulletinWorkspaceTransportRequestV1,
      context: BulletinWorkspaceServerContextV1,
    ): Promise<BulletinWorkspaceTransportResponseV1> {
      try {
        if (request.operation === 'bootstrap') {
          const academicYears = await dependencies.academicYears.list();
          return academicYears.length === 0
            ? {
                contractVersion: BULLETIN_CONTRACT_VERSION_V1,
                operation: request.operation,
                state: 'empty',
                academicYears: [],
              }
            : {
                contractVersion: BULLETIN_CONTRACT_VERSION_V1,
                operation: request.operation,
                state: 'ready',
                academicYears,
              };
        }

        if (request.operation === 'class-groups') {
          const classGroups = await classGroupOptions(dependencies.entities, request.academicYearId);
          return classGroups.length === 0
            ? {
                contractVersion: BULLETIN_CONTRACT_VERSION_V1,
                operation: request.operation,
                state: 'empty',
                classGroups: [],
              }
            : {
                contractVersion: BULLETIN_CONTRACT_VERSION_V1,
                operation: request.operation,
                state: 'ready',
                classGroups,
              };
        }

        if (request.operation === 'students') {
          const students = await studentOptions(dependencies.classGroups, request);
          return students === null || students.length === 0
            ? {
                contractVersion: BULLETIN_CONTRACT_VERSION_V1,
                operation: request.operation,
                state: 'empty',
                students: [],
              }
            : {
                contractVersion: BULLETIN_CONTRACT_VERSION_V1,
                operation: request.operation,
                state: 'ready',
                students,
              };
        }

        if (request.operation === 'preview') {
          // Preview consumes the exact canonical BulletinModelV1 produced by the emission materializer.
          const preview = await emission.materialize(request.request, context);
          return {
            contractVersion: BULLETIN_CONTRACT_VERSION_V1,
            operation: request.operation,
            state: 'ready',
            preview,
          };
        }

        if (request.operation === 'emit') {
          return {
            contractVersion: BULLETIN_CONTRACT_VERSION_V1,
            operation: request.operation,
            state: 'ready',
            emission: await emission.emit(request.request, context),
          };
        }

        if (request.operation === 'emit-batch') {
          return {
            contractVersion: BULLETIN_CONTRACT_VERSION_V1,
            operation: request.operation,
            state: 'ready',
            batch: await emission.emitBatch(request.request, context),
          };
        }

        if (request.operation === 'history') return await readHistory(request);

        return {
          contractVersion: BULLETIN_CONTRACT_VERSION_V1,
          operation: request.operation,
          state: 'ready',
          reprint: await emission.reprint(request.request, context),
        };
      } catch {
        return unavailable(request.operation);
      }
    },
  };
}
