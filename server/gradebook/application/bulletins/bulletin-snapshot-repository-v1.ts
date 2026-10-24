import type { AcademicYearId, ClassGroupId, StudentId } from '../../../../shared/gradebook-contracts/entities';
import {
  freezeBulletinSnapshotV1,
  isBulletinSnapshotCoherentV1,
  type BulletinSnapshotIdV1,
  type BulletinSnapshotV1,
} from '../../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';

export type BulletinSnapshotSeriesKeyV1 = string & {
  readonly __bulletinSnapshotSeriesKeyV1: true;
};

export interface BulletinSnapshotHistoryQueryV1 {
  readonly academicYearId: AcademicYearId;
  readonly classGroupId: ClassGroupId;
  readonly studentIds?: readonly StudentId[];
}

export type BulletinSnapshotAppendResultV1 =
  | { readonly status: 'appended'; readonly snapshot: BulletinSnapshotV1 }
  | { readonly status: 'version-conflict' }
  | { readonly status: 'incoherent-snapshot' };

/**
 * Provider-independent, append-only snapshot boundary. Remote storage is deliberately absent from
 * this implementation issue; a later adapter can implement this port without changing emission.
 */
export interface BulletinSnapshotRepositoryV1 {
  getLatest(seriesKey: BulletinSnapshotSeriesKeyV1): Promise<BulletinSnapshotV1 | null>;
  getHistorical(
    snapshotId: BulletinSnapshotIdV1,
    snapshotVersion: number,
  ): Promise<BulletinSnapshotV1 | null>;
  append(
    seriesKey: BulletinSnapshotSeriesKeyV1,
    snapshot: BulletinSnapshotV1,
    expectedPreviousVersion: number,
  ): Promise<BulletinSnapshotAppendResultV1>;
  /** Optional until a durable provider is explicitly designed. The local/preview repository supports it. */
  listHistory?(
    query: BulletinSnapshotHistoryQueryV1,
  ): Promise<readonly BulletinSnapshotV1[]>;
}

function cloneSnapshot(snapshot: BulletinSnapshotV1): BulletinSnapshotV1 {
  function clone<Value>(value: Value): Value {
    if (Array.isArray(value)) return value.map((item) => clone(item)) as Value;
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) result[key] = clone(item);
      return result as Value;
    }
    return value;
  }

  return clone(snapshot);
}

function compareHistory(left: BulletinSnapshotV1, right: BulletinSnapshotV1): number {
  const instant = right.emittedAt.localeCompare(left.emittedAt);
  if (instant !== 0) return instant;
  const student = left.model.student.displayName.localeCompare(right.model.student.displayName);
  if (student !== 0) return student;
  const snapshot = left.snapshotId.localeCompare(right.snapshotId);
  if (snapshot !== 0) return snapshot;
  return right.snapshotVersion - left.snapshotVersion;
}

/**
 * Local/disposable snapshot storage. Every append owns a deep immutable copy; no object supplied by
 * the caller is retained, mutated or frozen through aliasing. It provisions no remote persistence
 * and deliberately does not promise durability across worker restarts or isolates.
 */
export function createLocalBulletinSnapshotRepositoryV1(): BulletinSnapshotRepositoryV1 {
  const bySeries = new Map<BulletinSnapshotSeriesKeyV1, BulletinSnapshotV1[]>();
  const byHistoricalIdentity = new Map<string, BulletinSnapshotV1>();

  function historicalKey(snapshotId: BulletinSnapshotIdV1, snapshotVersion: number): string {
    return `${snapshotId}\u0000${snapshotVersion}`;
  }

  return {
    async getLatest(seriesKey) {
      const snapshots = bySeries.get(seriesKey);
      return snapshots?.[snapshots.length - 1] ?? null;
    },

    async getHistorical(snapshotId, snapshotVersion) {
      return byHistoricalIdentity.get(historicalKey(snapshotId, snapshotVersion)) ?? null;
    },

    async append(seriesKey, candidate, expectedPreviousVersion) {
      if (!isBulletinSnapshotCoherentV1(candidate)) {
        return { status: 'incoherent-snapshot' };
      }

      const snapshots = bySeries.get(seriesKey) ?? [];
      const latest = snapshots.at(-1) ?? null;
      const currentVersion = latest?.snapshotVersion ?? 0;
      if (
        currentVersion !== expectedPreviousVersion ||
        candidate.snapshotVersion !== expectedPreviousVersion + 1 ||
        (latest !== null && latest.snapshotId !== candidate.snapshotId) ||
        byHistoricalIdentity.has(historicalKey(candidate.snapshotId, candidate.snapshotVersion))
      ) {
        return { status: 'version-conflict' };
      }

      const snapshot = freezeBulletinSnapshotV1(cloneSnapshot(candidate));
      snapshots.push(snapshot);
      bySeries.set(seriesKey, snapshots);
      byHistoricalIdentity.set(
        historicalKey(snapshot.snapshotId, snapshot.snapshotVersion),
        snapshot,
      );
      return { status: 'appended', snapshot };
    },

    async listHistory(query) {
      const studentIds = query.studentIds === undefined ? null : new Set(query.studentIds);
      return [...byHistoricalIdentity.values()]
        .filter(
          (snapshot) =>
            snapshot.model.academicYearId === query.academicYearId &&
            snapshot.model.classGroup.id === query.classGroupId &&
            (studentIds === null || studentIds.has(snapshot.model.student.id)),
        )
        .sort(compareHistory);
    },
  };
}

/** Backward-compatible name for the local/disposable implementation. */
export function createInMemoryBulletinSnapshotRepositoryV1(): BulletinSnapshotRepositoryV1 {
  return createLocalBulletinSnapshotRepositoryV1();
}
