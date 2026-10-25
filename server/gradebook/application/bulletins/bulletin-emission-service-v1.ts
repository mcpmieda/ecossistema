import {
  BULLETIN_CONTRACT_VERSION_V1,
  BULLETIN_MODEL_VERSION_V1,
  freezeBulletinSnapshotV1,
  inspectBulletinBatchEmissionRequestV1,
  inspectBulletinEmissionRequestV1,
  inspectBulletinReprintRequestV1,
  isBulletinSnapshotCoherentV1,
  type BulletinBatchEmissionRequestV1,
  type BulletinBatchEmissionResultV1,
  type BulletinEmissionBlockedV1,
  type BulletinEmissionRequestV1,
  type BulletinEmissionResultV1,
  type BulletinIssuerIdV1,
  type BulletinReprintRequestV1,
  type BulletinReprintResultV1,
  type BulletinSnapshotIdV1,
  type BulletinSnapshotV1,
} from '../../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';
import type { AcademicRecordRepositoryV1 } from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';
import {
  BULLETIN_MATERIALIZATION_REASONS_V1,
  createBulletinModelMaterializerV1,
  type BulletinModelMaterializationResultV1,
  type BulletinStudentEmissionRequestV1,
} from './bulletin-model-materializer-v1';
import type { ClassGroupCenterQueryV1 } from '../read-models/class-group/class-group-center-read-model-v1';
import type {
  BulletinSnapshotRepositoryV1,
  BulletinSnapshotSeriesKeyV1,
} from './bulletin-snapshot-repository-v1';

export const BULLETIN_EMISSION_REASONS_V1 = {
  invalidRequest: 'invalid-request',
  forbiddenClientPayload: 'forbidden-client-payload',
  notAuthorized: 'not-authorized',
  invalidServerContext: 'invalid-server-context',
  incoherentHistoricalSnapshot: 'incoherent-historical-snapshot',
  historicalSnapshotNotFound: 'historical-snapshot-not-found',
  snapshotVersionConflict: 'snapshot-version-conflict',
  snapshotRejected: 'snapshot-rejected',
  classGroupDataUnavailable: 'class-group-data-unavailable',
} as const;

export interface BulletinServerAuthorizationV1 {
  readonly decision: 'allowed' | 'denied';
}

export interface BulletinServerEmissionContextV1 extends BulletinServerAuthorizationV1 {
  /** Opaque authenticated identity supplied by the server, never by the emission request. */
  readonly issuerId: BulletinIssuerIdV1;
}

export interface BulletinEmissionServiceDependenciesV1 {
  readonly classGroups: ClassGroupCenterQueryV1;
  readonly academicRecords: AcademicRecordRepositoryV1;
  readonly snapshots: BulletinSnapshotRepositoryV1;
  /** Server-owned clock. */
  readonly now: () => string;
  /** Server-owned opaque identifier factory. */
  readonly createSnapshotId: (seriesKey: BulletinSnapshotSeriesKeyV1) => BulletinSnapshotIdV1;
}

export interface BulletinEmissionServiceV1 {
  materialize(
    request: BulletinEmissionRequestV1,
    authorization: BulletinServerAuthorizationV1,
  ): Promise<BulletinModelMaterializationResultV1>;
  emit(
    request: BulletinEmissionRequestV1,
    context: BulletinServerEmissionContextV1,
  ): Promise<BulletinEmissionResultV1>;
  reprint(
    request: BulletinReprintRequestV1,
    authorization: BulletinServerAuthorizationV1,
  ): Promise<BulletinReprintResultV1>;
  emitBatch(
    request: BulletinBatchEmissionRequestV1,
    context: BulletinServerEmissionContextV1,
  ): Promise<BulletinBatchEmissionResultV1>;
}

function blocked(reason: string): BulletinEmissionBlockedV1 {
  return {
    contractVersion: BULLETIN_CONTRACT_VERSION_V1,
    status: 'blocked',
    reasons: [reason],
  };
}

function requestFailure(readiness: 'invalid-request' | 'forbidden-client-payload') {
  return blocked(
    readiness === 'forbidden-client-payload'
      ? BULLETIN_EMISSION_REASONS_V1.forbiddenClientPayload
      : BULLETIN_EMISSION_REASONS_V1.invalidRequest,
  );
}

function authorizationAllowed(context: BulletinServerAuthorizationV1): boolean {
  return context?.decision === 'allowed';
}

function validEmissionContext(context: BulletinServerEmissionContextV1): boolean {
  return (
    authorizationAllowed(context) &&
    typeof context.issuerId === 'string' &&
    context.issuerId.trim().length > 0
  );
}

function studentSeriesKey(request: BulletinStudentEmissionRequestV1): BulletinSnapshotSeriesKeyV1 {
  return JSON.stringify({
    contractVersion: request.contractVersion,
    academicYearId: request.academicYearId,
    period: request.period,
    target: request.target,
    model: request.model,
  }) as BulletinSnapshotSeriesKeyV1;
}

function samePrintedArtifact(
  snapshot: BulletinSnapshotV1,
  materialization: Extract<BulletinModelMaterializationResultV1, { readonly status: 'ready' }>,
  request: BulletinStudentEmissionRequestV1,
  issuerId: BulletinIssuerIdV1,
): boolean {
  return (
    snapshot.issuerId === issuerId &&
    JSON.stringify(snapshot.model) === JSON.stringify(materialization.model) &&
    JSON.stringify(snapshot.presentation) === JSON.stringify(request.presentation)
  );
}

function emissionFromMaterializationFailure(
  materialization: Exclude<BulletinModelMaterializationResultV1, { readonly status: 'ready' }>,
): BulletinEmissionResultV1 {
  if (materialization.status === 'blocked') {
    return {
      contractVersion: BULLETIN_CONTRACT_VERSION_V1,
      status: materialization.status,
      reasons: materialization.reasons,
    };
  }
  return {
    contractVersion: BULLETIN_CONTRACT_VERSION_V1,
    status: materialization.status,
    coverage: materialization.coverage,
    reasons: materialization.reasons,
  };
}

export function createBulletinEmissionServiceV1(
  dependencies: BulletinEmissionServiceDependenciesV1,
): BulletinEmissionServiceV1 {
  const materializer = createBulletinModelMaterializerV1(dependencies);

  async function materializeAuthorized(
    request: BulletinEmissionRequestV1,
    authorization: BulletinServerAuthorizationV1,
  ): Promise<BulletinModelMaterializationResultV1> {
    const readiness = inspectBulletinEmissionRequestV1(request);
    if (readiness !== 'ready') {
      return {
        status: 'blocked',
        reasons: requestFailure(readiness).reasons,
      };
    }
    if (!authorizationAllowed(authorization)) {
      return {
        status: 'blocked',
        reasons: [BULLETIN_EMISSION_REASONS_V1.notAuthorized],
      };
    }
    return materializer.materialize(request);
  }

  async function emitStudent(
    request: BulletinStudentEmissionRequestV1,
    context: BulletinServerEmissionContextV1,
  ): Promise<BulletinEmissionResultV1> {
    const materialization = await materializer.materialize(request);
    return emitStudentMaterialization(request, materialization, context);
  }

  async function emitStudentMaterialization(
    request: BulletinStudentEmissionRequestV1,
    materialization: BulletinModelMaterializationResultV1,
    context: BulletinServerEmissionContextV1,
  ): Promise<BulletinEmissionResultV1> {
    if (materialization.status !== 'ready') {
      return emissionFromMaterializationFailure(materialization);
    }

    const seriesKey = studentSeriesKey(request);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await dependencies.snapshots.getLatest(seriesKey);
      if (latest !== null && !isBulletinSnapshotCoherentV1(latest)) {
        return blocked(BULLETIN_EMISSION_REASONS_V1.incoherentHistoricalSnapshot);
      }
      if (
        latest !== null &&
        samePrintedArtifact(latest, materialization, request, context.issuerId)
      ) {
        return {
          contractVersion: BULLETIN_CONTRACT_VERSION_V1,
          status: 'ready',
          snapshot: latest,
        };
      }

      const snapshotVersion = (latest?.snapshotVersion ?? 0) + 1;
      const snapshotId = latest?.snapshotId ?? dependencies.createSnapshotId(seriesKey);
      const emittedAt = dependencies.now();
      if (
        typeof snapshotId !== 'string' ||
        snapshotId.trim().length === 0 ||
        typeof emittedAt !== 'string' ||
        emittedAt.trim().length === 0
      ) {
        return blocked(BULLETIN_EMISSION_REASONS_V1.invalidServerContext);
      }
      const snapshot = freezeBulletinSnapshotV1({
        contractVersion: BULLETIN_CONTRACT_VERSION_V1,
        snapshotId,
        snapshotVersion,
        modelVersion: BULLETIN_MODEL_VERSION_V1,
        dataVersion: materialization.dataVersion,
        emittedAt,
        issuerId: context.issuerId,
        presentation: {
          locale: request.presentation.locale,
          dateStyle: request.presentation.dateStyle,
        },
        model: materialization.model,
      });
      const append = await dependencies.snapshots.append(seriesKey, snapshot, snapshotVersion - 1);
      if (append.status === 'appended') {
        return {
          contractVersion: BULLETIN_CONTRACT_VERSION_V1,
          status: 'ready',
          snapshot: append.snapshot,
        };
      }
      if (append.status === 'incoherent-snapshot') {
        return blocked(BULLETIN_EMISSION_REASONS_V1.snapshotRejected);
      }
    }
    return blocked(BULLETIN_EMISSION_REASONS_V1.snapshotVersionConflict);
  }

  return {
    materialize: materializeAuthorized,

    async emit(request, context) {
      const readiness = inspectBulletinEmissionRequestV1(request);
      if (readiness !== 'ready') return requestFailure(readiness);
      if (!authorizationAllowed(context)) {
        return blocked(BULLETIN_EMISSION_REASONS_V1.notAuthorized);
      }
      if (!validEmissionContext(context)) {
        return blocked(BULLETIN_EMISSION_REASONS_V1.invalidServerContext);
      }
      if (request.target.kind !== 'student') {
        return blocked(BULLETIN_MATERIALIZATION_REASONS_V1.classGroupTargetRequiresBatch);
      }
      return emitStudent(request as BulletinStudentEmissionRequestV1, context);
    },

    async reprint(request, authorization) {
      const readiness = inspectBulletinReprintRequestV1(request);
      if (readiness !== 'ready') {
        return {
          ...requestFailure(readiness),
          source: 'historical-snapshot',
        };
      }
      if (!authorizationAllowed(authorization)) {
        return {
          ...blocked(BULLETIN_EMISSION_REASONS_V1.notAuthorized),
          source: 'historical-snapshot',
        };
      }
      const historical = await dependencies.snapshots.getHistorical(
        request.snapshotId,
        request.snapshotVersion,
      );
      if (
        historical?.snapshotId !== request.snapshotId ||
        historical.snapshotVersion !== request.snapshotVersion
      ) {
        return {
          ...blocked(BULLETIN_EMISSION_REASONS_V1.historicalSnapshotNotFound),
          source: 'historical-snapshot',
        };
      }
      if (!isBulletinSnapshotCoherentV1(historical)) {
        return {
          ...blocked(BULLETIN_EMISSION_REASONS_V1.incoherentHistoricalSnapshot),
          source: 'historical-snapshot',
        };
      }
      return {
        contractVersion: BULLETIN_CONTRACT_VERSION_V1,
        status: 'ready',
        source: 'historical-snapshot',
        snapshot: freezeBulletinSnapshotV1(historical),
      };
    },

    async emitBatch(request, context) {
      const ready: BulletinBatchEmissionResultV1['ready'][number][] = [];
      const blockedItems: BulletinBatchEmissionResultV1['blocked'][number][] = [];
      const readiness = inspectBulletinBatchEmissionRequestV1(request);

      if (
        readiness !== 'ready' ||
        !authorizationAllowed(context) ||
        !validEmissionContext(context)
      ) {
        let reason;
        if (readiness !== 'ready') {
          reason = requestFailure(readiness).reasons[0];
        } else if (!authorizationAllowed(context)) {
          reason = BULLETIN_EMISSION_REASONS_V1.notAuthorized;
        } else {
          reason = BULLETIN_EMISSION_REASONS_V1.invalidServerContext;
        }
        request.items.forEach((_, requestIndex) => {
          blockedItems.push({ requestIndex, emission: blocked(reason) });
        });
        return { contractVersion: BULLETIN_CONTRACT_VERSION_V1, ready, blocked: blockedItems };
      }

      async function collect(
        item: BulletinStudentEmissionRequestV1 | null,
        materialization: BulletinModelMaterializationResultV1,
        requestIndex: number,
      ): Promise<void> {
        let emission: BulletinEmissionResultV1;
        try {
          if (item === null) {
            emission =
              materialization.status === 'ready'
                ? blocked(BULLETIN_MATERIALIZATION_REASONS_V1.incompatibleOfficialData)
                : emissionFromMaterializationFailure(materialization);
          } else {
            emission = await emitStudentMaterialization(item, materialization, context);
          }
        } catch {
          emission = blocked(BULLETIN_EMISSION_REASONS_V1.snapshotRejected);
        }
        if (emission.status === 'ready') ready.push({ requestIndex, emission });
        else blockedItems.push({ requestIndex, emission });
      }

      const materializedItems = await materializer.materializeBatch(request.items);
      for (const item of materializedItems) {
        await collect(item.request, item.materialization, item.requestIndex);
      }
      return {
        contractVersion: BULLETIN_CONTRACT_VERSION_V1,
        ready,
        blocked: blockedItems,
      };
    },
  };
}
