import type {
  AcademicYearId,
  ClassGroupId,
  EnrollmentId,
  EnrollmentPositionV1,
  StudentId,
} from '../entities';
import type { ResultCoverageV1 } from '../results/results-contract-v1';
import {
  BULLETIN_CONTRACT_VERSION_V1,
  hasForbiddenBulletinClientPayloadV1,
  inspectBulletinBatchEmissionRequestV1,
  inspectBulletinEmissionRequestV1,
  inspectBulletinReprintRequestV1,
  type BulletinBatchEmissionRequestV1,
  type BulletinBatchEmissionResultV1,
  type BulletinDataVersionV1,
  type BulletinEmissionReasonsV1,
  type BulletinEmissionRequestV1,
  type BulletinEmissionResultV1,
  type BulletinModelKindV1,
  type BulletinModelV1,
  type BulletinPeriodV1,
  type BulletinReprintRequestV1,
  type BulletinReprintResultV1,
  type BulletinSnapshotIdV1,
} from './bulletin-contract-v1';

export const BULLETIN_WORKSPACE_OPERATIONS_V1 = [
  'bootstrap',
  'class-groups',
  'students',
  'preview',
  'emit',
  'emit-batch',
  'history',
  'reprint',
] as const;

export type BulletinWorkspaceOperationV1 = (typeof BULLETIN_WORKSPACE_OPERATIONS_V1)[number];
export type BulletinWorkspaceStateV1 = 'ready' | 'empty' | 'unavailable' | 'not-authorized';

export interface BulletinAcademicYearOptionV1 {
  readonly id: AcademicYearId;
  readonly label: string;
}

export interface BulletinClassGroupOptionV1 {
  readonly id: ClassGroupId;
  readonly code: string;
}

export interface BulletinStudentOptionV1 {
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly displayName: string;
  readonly position: EnrollmentPositionV1;
}

export type BulletinPreviewResultV1 =
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

export interface BulletinSnapshotHistoryItemV1 {
  readonly snapshotId: BulletinSnapshotIdV1;
  readonly snapshotVersion: number;
  readonly modelVersion: number;
  readonly dataVersion: BulletinDataVersionV1;
  readonly emittedAt: string;
  readonly academicYearId: AcademicYearId;
  readonly classGroupId: ClassGroupId;
  readonly classGroupCode: string;
  readonly studentId: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly studentDisplayName: string;
  readonly period: BulletinPeriodV1;
  readonly modelKind: BulletinModelKindV1;
}

export type BulletinWorkspaceTransportRequestV1 =
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'bootstrap';
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'class-groups';
      readonly academicYearId: AcademicYearId;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'students';
      readonly academicYearId: AcademicYearId;
      readonly classGroupId: ClassGroupId;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'preview';
      readonly request: BulletinEmissionRequestV1;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'emit';
      readonly request: BulletinEmissionRequestV1;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'emit-batch';
      readonly request: BulletinBatchEmissionRequestV1;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'history';
      readonly academicYearId: AcademicYearId;
      readonly classGroupId: ClassGroupId;
      readonly studentIds?: readonly StudentId[];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'reprint';
      readonly request: BulletinReprintRequestV1;
    };

export type BulletinWorkspaceTransportResponseV1 =
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'bootstrap';
      readonly state: 'ready';
      readonly academicYears: readonly BulletinAcademicYearOptionV1[];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'bootstrap';
      readonly state: 'empty';
      readonly academicYears: readonly [];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'class-groups';
      readonly state: 'ready';
      readonly classGroups: readonly BulletinClassGroupOptionV1[];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'class-groups';
      readonly state: 'empty';
      readonly classGroups: readonly [];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'students';
      readonly state: 'ready';
      readonly students: readonly BulletinStudentOptionV1[];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'students';
      readonly state: 'empty';
      readonly students: readonly [];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'preview';
      readonly state: 'ready';
      readonly preview: BulletinPreviewResultV1;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'emit';
      readonly state: 'ready';
      readonly emission: BulletinEmissionResultV1;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'emit-batch';
      readonly state: 'ready';
      readonly batch: BulletinBatchEmissionResultV1;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'history';
      readonly state: 'ready';
      readonly items: readonly BulletinSnapshotHistoryItemV1[];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'history';
      readonly state: 'empty';
      readonly items: readonly [];
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: 'reprint';
      readonly state: 'ready';
      readonly reprint: BulletinReprintResultV1;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly operation: BulletinWorkspaceOperationV1;
      readonly state: 'unavailable' | 'not-authorized';
    };

export type BulletinWorkspaceTransportReadinessV1 =
  | 'ready'
  | 'invalid-request'
  | 'forbidden-client-payload';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function inspectHistory(value: Record<string, unknown>): BulletinWorkspaceTransportReadinessV1 {
  const expected = value.studentIds === undefined
    ? ['contractVersion', 'operation', 'academicYearId', 'classGroupId']
    : ['contractVersion', 'operation', 'academicYearId', 'classGroupId', 'studentIds'];
  if (
    !hasExactKeys(value, expected) ||
    !isNonEmptyString(value.academicYearId) ||
    !isNonEmptyString(value.classGroupId)
  ) {
    return 'invalid-request';
  }
  if (value.studentIds !== undefined) {
    if (
      !Array.isArray(value.studentIds) ||
      value.studentIds.length === 0 ||
      value.studentIds.some((id) => !isNonEmptyString(id))
    ) {
      return 'invalid-request';
    }
  }
  return 'ready';
}

const readyIfV1 = (valid: boolean): BulletinWorkspaceTransportReadinessV1 =>
  valid ? 'ready' : 'invalid-request';

export function inspectBulletinWorkspaceTransportRequestV1(
  value: unknown,
): BulletinWorkspaceTransportReadinessV1 {
  if (hasForbiddenBulletinClientPayloadV1(value)) return 'forbidden-client-payload';
  if (
    !isRecord(value) ||
    value.contractVersion !== BULLETIN_CONTRACT_VERSION_V1 ||
    !BULLETIN_WORKSPACE_OPERATIONS_V1.includes(value.operation as BulletinWorkspaceOperationV1)
  ) {
    return 'invalid-request';
  }

  switch (value.operation) {
    case 'bootstrap':
      return readyIfV1(hasExactKeys(value, ['contractVersion', 'operation']));
    case 'class-groups':
      return readyIfV1(
        hasExactKeys(value, ['contractVersion', 'operation', 'academicYearId']) &&
          isNonEmptyString(value.academicYearId),
      );
    case 'students':
      return readyIfV1(
        hasExactKeys(value, ['contractVersion', 'operation', 'academicYearId', 'classGroupId']) &&
          isNonEmptyString(value.academicYearId) &&
          isNonEmptyString(value.classGroupId),
      );
    case 'preview':
    case 'emit':
      return hasExactKeys(value, ['contractVersion', 'operation', 'request'])
        ? inspectBulletinEmissionRequestV1(value.request)
        : 'invalid-request';
    case 'emit-batch':
      return hasExactKeys(value, ['contractVersion', 'operation', 'request'])
        ? inspectBulletinBatchEmissionRequestV1(value.request)
        : 'invalid-request';
    case 'history':
      return inspectHistory(value);
    case 'reprint':
      return hasExactKeys(value, ['contractVersion', 'operation', 'request'])
        ? inspectBulletinReprintRequestV1(value.request)
        : 'invalid-request';
    default:
      return 'invalid-request';
  }
}
