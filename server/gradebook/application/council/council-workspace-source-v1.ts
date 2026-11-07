import type {
  CouncilAnnualComponentViewV1,
  CouncilCalculatedProjectionV1,
  CouncilClassReferenceV1,
  CouncilCursorV1,
  CouncilQueueRequestV1,
  CouncilStudentReferenceV1,
  CouncilStudentRequestV1,
} from '../../../../shared/gradebook-contracts/council/council-workspace-contract-v1';
import type { AcademicYearId } from '../../../../shared/gradebook-contracts/entities';

type CouncilWorkspaceSourceFailureV1 =
  | 'invalid-cursor'
  | 'unavailable'
  | 'insufficient-data';

export class CouncilWorkspaceSourceErrorV1 extends Error {
  override readonly name = 'CouncilWorkspaceSourceErrorV1';

  constructor(readonly code: CouncilWorkspaceSourceFailureV1) {
    super(code);
  }
}

export interface CouncilWorkspaceSourceQueueItemV1 {
  readonly studentReference: CouncilStudentReferenceV1;
  readonly studentLabel: string;
  readonly calculated: CouncilCalculatedProjectionV1;
}

export interface CouncilWorkspaceSourcePageV1 {
  readonly items: readonly CouncilWorkspaceSourceQueueItemV1[];
  readonly nextCursor: CouncilCursorV1 | null;
}

export interface CouncilWorkspaceSourceStudentV1 {
  readonly academicYearId: AcademicYearId;
  readonly classReference: CouncilClassReferenceV1;
  readonly classLabel: string;
  readonly studentReference: CouncilStudentReferenceV1;
  readonly studentLabel: string;
  readonly calculated: CouncilCalculatedProjectionV1;
  readonly annualView: readonly CouncilAnnualComponentViewV1[];
}

/**
 * Council-specific read boundary. Implementations must project official resolved results and
 * eligibility; this port deliberately exposes no calculation callback and no per-row detail fetch.
 */
export interface CouncilWorkspaceSourceV1 {
  listQueue(request: CouncilQueueRequestV1): Promise<CouncilWorkspaceSourcePageV1>;
  getStudent(request: CouncilStudentRequestV1): Promise<CouncilWorkspaceSourceStudentV1 | null>;
}

interface LocalCouncilWorkspaceSourceDataV1 {
  readonly students: readonly CouncilWorkspaceSourceStudentV1[];
}

function cursorForOffset(offset: number): CouncilCursorV1 {
  return `council-local:${offset}` as CouncilCursorV1;
}

function offsetFromCursor(cursor: CouncilCursorV1 | null): number {
  if (cursor === null) return 0;
  const match = /^council-local:(\d+)$/u.exec(cursor);
  if (match === null) throw new CouncilWorkspaceSourceErrorV1('invalid-cursor');
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CouncilWorkspaceSourceErrorV1('invalid-cursor');
  }
  return value;
}

/**
 * Disposable local/preview source over already-resolved projections. It never computes grades,
 * recovery, annual results or Council eligibility; callers must supply those projections.
 */
export function createLocalCouncilWorkspaceSourceV1(
  data: LocalCouncilWorkspaceSourceDataV1,
): CouncilWorkspaceSourceV1 {
  return {
    async listQueue(request) {
      const classStudents = data.students.filter(
        (student) =>
          student.academicYearId === request.academicYearId &&
          student.classReference === request.classReference,
      );
      const offset = offsetFromCursor(request.page.cursor);
      if (offset > classStudents.length) {
        throw new CouncilWorkspaceSourceErrorV1('invalid-cursor');
      }
      const selected = classStudents.slice(offset, offset + request.page.limit);
      const nextOffset = offset + selected.length;
      return {
        items: selected.map((student) => ({
          studentReference: student.studentReference,
          studentLabel: student.studentLabel,
          calculated: student.calculated,
        })),
        nextCursor:
          nextOffset < classStudents.length && selected.length > 0 ? cursorForOffset(nextOffset) : null,
      };
    },

    async getStudent(request) {
      return (
        data.students.find(
          (student) =>
            student.academicYearId === request.academicYearId &&
            student.classReference === request.classReference &&
            student.studentReference === request.studentReference,
        ) ?? null
      );
    },
  };
}
