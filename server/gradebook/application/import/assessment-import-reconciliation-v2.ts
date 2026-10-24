import {
  type ImportReconciliationPlanningOptionsV1,
  academicRecordStreamForV1,
  academicRecordStreamKeyV1,
  logicalSourceRecordAssociationStreamForV1,
  planImportReconciliation,
  type ImportChangePlanV1,
  type ImportReconciliationFileInputV1,
  type ImportReconciliationInputV1,
  type ImportReconciliationRepositoriesV1,
} from './import-reconciliation-v1';
import type { ImportFileId } from '../../../../shared/gradebook-contracts/imports/import-ids-v1';
import type { AssessmentComponentV2 } from '../../../../shared/gradebook-contracts/results/results-contract-v2';
import type { AssessmentComponentV3 } from '../../../../shared/gradebook-contracts/results/results-contract-v3';
import type {
  AcademicEntityRecordV1,
  AcademicEntityReferenceV1,
  AcademicEntityRepositoryV1,
  AcademicPersistenceContextV1,
  AcademicRecordStreamV1,
  AcademicRecordV1,
  LogicalSourceIdV1,
  LogicalSourceRecordAssociationStreamV1,
  LogicalSourceRecordAssociationV1,
  VersionedRecordV1,
} from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';
import type {
  AssessmentDefinitionMaterializationV2,
  BlockedAssessmentDefinitionV2,
  MaterializedAssessmentComponentV2,
} from '../../../../src/features/gradebook/import/assessment-definition-materializer-v2';
import type {
  BlockedAssessmentDefinitionV4,
  MaterializedAssessmentComponentV4,
} from '../../../../src/features/gradebook/import/assessment-definition-materializer-v4';

import {
  IMPORT_PLANNER_READ_CONCURRENCY_V1,
  mapWithBoundedConcurrencyV1,
} from './bounded-read-concurrency-v1';

export type AssessmentComponentChangeStateV2 = 'unchanged' | 'new' | 'changed' | 'blocked';

interface AssessmentComponentPlanItemBaseV2 {
  readonly importFileId: ImportFileId;
  readonly stableKey:
    MaterializedAssessmentComponentV2['stableKey'] | MaterializedAssessmentComponentV4['stableKey'];
}

export type AssessmentComponentPlanItemV2 =
  | (AssessmentComponentPlanItemBaseV2 & {
      readonly state: 'unchanged';
      readonly incomingRecord: Extract<
        AcademicEntityRecordV1,
        { readonly kind: 'assessment-component' }
      >;
      readonly currentRecord: VersionedRecordV1<AcademicEntityRecordV1>;
    })
  | (AssessmentComponentPlanItemBaseV2 & {
      readonly state: 'new';
      readonly incomingRecord: Extract<
        AcademicEntityRecordV1,
        { readonly kind: 'assessment-component' }
      >;
      readonly expectedVersion: null;
    })
  | (AssessmentComponentPlanItemBaseV2 & {
      readonly state: 'changed';
      readonly incomingRecord: Extract<
        AcademicEntityRecordV1,
        { readonly kind: 'assessment-component' }
      >;
      readonly currentRecord: VersionedRecordV1<AcademicEntityRecordV1>;
      readonly expectedVersion: number;
    })
  | (AssessmentComponentPlanItemBaseV2 & {
      readonly state: 'blocked';
      readonly reason:
        | BlockedAssessmentDefinitionV2['resolution']['reason']
        | BlockedAssessmentDefinitionV4['resolution']['reason']
        | 'persisted-component-incompatible'
        | 'duplicate-component-identity'
        | 'component-read-failed';
    });

export interface AssessmentComponentPlanCountsV2 {
  readonly unchanged: number;
  readonly new: number;
  readonly changed: number;
  readonly blocked: number;
}

export interface AssessmentComponentChangePlanV2 {
  readonly items: readonly AssessmentComponentPlanItemV2[];
  readonly counts: AssessmentComponentPlanCountsV2;
  readonly plannedVersionWrites: number;
  readonly planningEvidence: {
    readonly writesPerformed: 0;
    readonly repositoryExposesGetOnly: true;
  };
}

export type AssessmentImportChangePlanV2 = ImportChangePlanV1 & {
  readonly assessmentComponentPlanV2: AssessmentComponentChangePlanV2;
};

export interface AssessmentDefinitionMaterializationAcceptedV2 {
  readonly components: readonly (
    MaterializedAssessmentComponentV2 | MaterializedAssessmentComponentV4
  )[];
  readonly gradeEntries: AssessmentDefinitionMaterializationV2['gradeEntries'];
  readonly blockedDefinitions: readonly (
    BlockedAssessmentDefinitionV2 | BlockedAssessmentDefinitionV4
  )[];
}

export interface AssessmentImportReconciliationFileInputV2 extends Omit<
  ImportReconciliationFileInputV1,
  'records'
> {
  readonly materialization: AssessmentDefinitionMaterializationAcceptedV2;
  /**
   * Official records derived from the same recognized source file. GradeEntry records remain
   * materialized above so blocked AssessmentComponents can still suppress their dependents.
   */
  readonly additionalRecords?: readonly Exclude<
    AcademicRecordV1,
    { readonly kind: 'grade-entry' }
  >[];
}

export interface AssessmentImportReconciliationInputV2 extends Omit<
  ImportReconciliationInputV1,
  'files'
> {
  readonly files: readonly AssessmentImportReconciliationFileInputV2[];
}

type CurrentEntityV2 = VersionedRecordV1<AcademicEntityRecordV1> | null;
type CurrentRecordV2 = VersionedRecordV1<AcademicRecordV1> | null;
type CurrentAssociationV2 = VersionedRecordV1<LogicalSourceRecordAssociationV1> | null;

type AssessmentEntityPlanningRepositoryV2 = Pick<AcademicEntityRepositoryV1, 'get'> & {
  readonly getMany?: (
    context: AcademicPersistenceContextV1,
    references: readonly AcademicEntityReferenceV1[],
  ) => Promise<readonly CurrentEntityV2[]>;
};

type AcademicRecordPlanningRepositoryV2 = ImportReconciliationRepositoriesV1['academicRecords'] & {
  readonly getCurrentMany?: (
    context: AcademicPersistenceContextV1,
    streams: readonly AcademicRecordStreamV1[],
  ) => Promise<readonly CurrentRecordV2[]>;
};

type AssociationPlanningRepositoryV2 =
  ImportReconciliationRepositoriesV1['logicalSourceRecords'] & {
    readonly getCurrentMany?: (
      context: AcademicPersistenceContextV1,
      streams: readonly LogicalSourceRecordAssociationStreamV1[],
    ) => Promise<readonly CurrentAssociationV2[]>;
  };

export interface AssessmentImportReconciliationRepositoriesV2 extends ImportReconciliationRepositoriesV1 {
  readonly entities: AssessmentEntityPlanningRepositoryV2;
  readonly academicRecords: AcademicRecordPlanningRepositoryV2;
  readonly logicalSourceRecords: AssociationPlanningRepositoryV2;
}

const OPERATIONAL_COMPONENT_BLOCK_REASONS_V2 = new Set<
  Extract<AssessmentComponentPlanItemV2, { readonly state: 'blocked' }>['reason']
>(['persisted-component-incompatible', 'duplicate-component-identity', 'component-read-failed']);

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isCompatiblePersistedV2(
  record: VersionedRecordV1<AcademicEntityRecordV1>,
  incoming: AssessmentComponentV2 | AssessmentComponentV3,
): boolean {
  if (record.value.kind !== 'assessment-component') return false;
  const value = record.value.value;
  return (
    value.id === incoming.id &&
    value.id.startsWith('assessment-component:v2:') &&
    ['quantitative-assessment', 'qualitative-activity', 'parallel-recovery'].includes(value.type)
  );
}

function counts(items: readonly AssessmentComponentPlanItemV2[]): AssessmentComponentPlanCountsV2 {
  const result: Record<AssessmentComponentChangeStateV2, number> = {
    unchanged: 0,
    new: 0,
    changed: 0,
    blocked: 0,
  };
  for (const item of items) result[item.state] += 1;
  return result;
}

function componentItem(
  importFileId: ImportFileId,
  component: MaterializedAssessmentComponentV2 | MaterializedAssessmentComponentV4,
  current: CurrentEntityV2,
): AssessmentComponentPlanItemV2 {
  const incomingRecord = {
    kind: 'assessment-component',
    value: component.value,
  } as const satisfies AcademicEntityRecordV1;
  if (current === null) {
    return {
      importFileId,
      stableKey: component.stableKey,
      state: 'new',
      incomingRecord,
      expectedVersion: null,
    };
  }
  if (!isCompatiblePersistedV2(current, component.value)) {
    return {
      importFileId,
      stableKey: component.stableKey,
      state: 'blocked',
      reason: 'persisted-component-incompatible',
    };
  }
  if (stableSerialize(current.value) === stableSerialize(incomingRecord)) {
    return {
      importFileId,
      stableKey: component.stableKey,
      state: 'unchanged',
      incomingRecord,
      currentRecord: current,
    };
  }
  return {
    importFileId,
    stableKey: component.stableKey,
    state: 'changed',
    incomingRecord,
    currentRecord: current,
    expectedVersion: current.version,
  };
}

async function planComponents(
  input: AssessmentImportReconciliationInputV2,
  repository: AssessmentEntityPlanningRepositoryV2,
): Promise<AssessmentComponentChangePlanV2> {
  const items: AssessmentComponentPlanItemV2[] = [];
  const seenIds = new Set<string>();
  const pending: {
    readonly importFileId: ImportFileId;
    readonly component: MaterializedAssessmentComponentV2 | MaterializedAssessmentComponentV4;
  }[] = [];

  for (const file of [...input.files].sort((left, right) =>
    left.importFileId.localeCompare(right.importFileId),
  )) {
    for (const blocked of file.materialization.blockedDefinitions) {
      items.push({
        importFileId: file.importFileId,
        stableKey: blocked.stableKey,
        state: 'blocked',
        reason: blocked.resolution.reason,
      });
    }

    for (const component of file.materialization.components) {
      if (seenIds.has(component.value.id)) {
        items.push({
          importFileId: file.importFileId,
          stableKey: component.stableKey,
          state: 'blocked',
          reason: 'duplicate-component-identity',
        });
        continue;
      }
      seenIds.add(component.value.id);
      pending.push({ importFileId: file.importFileId, component });
    }
  }

  if (repository.getMany && pending.length > 0) {
    try {
      const current = await repository.getMany(
        input.context,
        pending.map(({ component }) => ({ kind: 'assessment-component', id: component.value.id })),
      );
      if (current.length !== pending.length) throw new Error('bulk-component-read-count-mismatch');
      items.push(
        ...pending.map(({ importFileId, component }, index) =>
          componentItem(importFileId, component, current[index] ?? null),
        ),
      );
    } catch {
      items.push(
        ...pending.map(({ importFileId, component }) => ({
          importFileId,
          stableKey: component.stableKey,
          state: 'blocked' as const,
          reason: 'component-read-failed' as const,
        })),
      );
    }
  } else {
    items.push(
      ...(await mapWithBoundedConcurrencyV1(
        pending,
        IMPORT_PLANNER_READ_CONCURRENCY_V1,
        async ({ importFileId, component }): Promise<AssessmentComponentPlanItemV2> => {
          let current: CurrentEntityV2;
          try {
            current = await repository.get(input.context, {
              kind: 'assessment-component',
              id: component.value.id,
            });
          } catch {
            return {
              importFileId,
              stableKey: component.stableKey,
              state: 'blocked',
              reason: 'component-read-failed',
            };
          }
          return componentItem(importFileId, component, current);
        },
      )),
    );
  }

  items.sort(
    (left, right) =>
      left.importFileId.localeCompare(right.importFileId) ||
      left.stableKey.localeCompare(right.stableKey) ||
      left.state.localeCompare(right.state),
  );
  const itemCounts = counts(items);
  return {
    items,
    counts: itemCounts,
    plannedVersionWrites: itemCounts.new + itemCounts.changed,
    planningEvidence: { writesPerformed: 0, repositoryExposesGetOnly: true },
  };
}

type CachedReadV2<T> =
  { readonly state: 'ready'; readonly value: T | null } | { readonly state: 'failed' };

function associationCacheKey(stream: LogicalSourceRecordAssociationStreamV1): string {
  return `${stream.logicalSourceId}\u0000${stream.stableKey}`;
}

function planningRepositoriesWithBulkPrefetch(
  input: ImportReconciliationInputV1,
  repositories: AssessmentImportReconciliationRepositoriesV2,
): ImportReconciliationRepositoriesV1 {
  const incomingBySource = new Map<LogicalSourceIdV1, Map<string, AcademicRecordStreamV1>>();
  for (const file of input.files) {
    if (file.logicalSource.state !== 'confirmed') continue;
    const source = incomingBySource.get(file.logicalSource.logicalSourceId) ?? new Map();
    for (const record of file.records) {
      const stream = academicRecordStreamForV1(record);
      source.set(academicRecordStreamKeyV1(stream), stream);
    }
    incomingBySource.set(file.logicalSource.logicalSourceId, source);
  }

  const recordCache = new Map<string, CachedReadV2<VersionedRecordV1<AcademicRecordV1>>>();
  const associationCache = new Map<
    string,
    CachedReadV2<VersionedRecordV1<LogicalSourceRecordAssociationV1>>
  >();
  const recordLoads = new Map<LogicalSourceIdV1, Promise<void>>();
  const associationLoads = new Map<LogicalSourceIdV1, Promise<void>>();

  const preloadRecords = (
    context: AcademicPersistenceContextV1,
    logicalSourceId: LogicalSourceIdV1,
    indexed: readonly AcademicRecordStreamV1[],
  ): Promise<void> => {
    if (!repositories.academicRecords.getCurrentMany) return Promise.resolve();
    const known = recordLoads.get(logicalSourceId);
    if (known) return known;
    const load = (async () => {
      const union = new Map<string, AcademicRecordStreamV1>();
      for (const stream of indexed) union.set(academicRecordStreamKeyV1(stream), stream);
      for (const [key, stream] of incomingBySource.get(logicalSourceId) ?? [])
        union.set(key, stream);
      const entries = [...union.entries()].filter(([key]) => !recordCache.has(key));
      if (entries.length === 0) return;
      try {
        const current = await repositories.academicRecords.getCurrentMany!(
          context,
          entries.map(([, stream]) => stream),
        );
        if (current.length !== entries.length) throw new Error('bulk-record-read-count-mismatch');
        entries.forEach(([key], index) =>
          recordCache.set(key, { state: 'ready', value: current[index] ?? null }),
        );
      } catch {
        for (const [key] of entries) recordCache.set(key, { state: 'failed' });
      }
    })();
    recordLoads.set(logicalSourceId, load);
    return load;
  };

  const preloadAssociations = (
    context: AcademicPersistenceContextV1,
    logicalSourceId: LogicalSourceIdV1,
  ): Promise<void> => {
    if (!repositories.logicalSourceRecords.getCurrentMany) return Promise.resolve();
    const known = associationLoads.get(logicalSourceId);
    if (known) return known;
    const load = (async () => {
      const streams = [...(incomingBySource.get(logicalSourceId)?.values() ?? [])].map((stream) =>
        logicalSourceRecordAssociationStreamForV1(logicalSourceId, stream),
      );
      if (streams.length === 0) return;
      try {
        const current = await repositories.logicalSourceRecords.getCurrentMany!(context, streams);
        if (current.length !== streams.length) {
          throw new Error('bulk-association-read-count-mismatch');
        }
        streams.forEach((stream, index) =>
          associationCache.set(associationCacheKey(stream), {
            state: 'ready',
            value: current[index] ?? null,
          }),
        );
      } catch {
        for (const stream of streams) {
          associationCache.set(associationCacheKey(stream), { state: 'failed' });
        }
      }
    })();
    associationLoads.set(logicalSourceId, load);
    return load;
  };

  return {
    imports: repositories.imports,
    academicRecords: {
      getCurrent: async (context, stream) => {
        const cached = recordCache.get(academicRecordStreamKeyV1(stream));
        if (cached?.state === 'ready') return cached.value;
        if (cached?.state === 'failed') throw new Error('bulk-academic-record-read-failed');
        return repositories.academicRecords.getCurrent(context, stream);
      },
    },
    logicalSourceRecords: {
      listCurrentStreams: async (context, logicalSourceId) => {
        const indexed = await repositories.logicalSourceRecords.listCurrentStreams(
          context,
          logicalSourceId,
        );
        await preloadRecords(context, logicalSourceId, indexed);
        return indexed;
      },
      getCurrent: async (context, stream) => {
        await preloadAssociations(context, stream.logicalSourceId);
        const cached = associationCache.get(associationCacheKey(stream));
        if (cached?.state === 'ready') return cached.value;
        if (cached?.state === 'failed') throw new Error('bulk-association-read-failed');
        return repositories.logicalSourceRecords.getCurrent(context, stream);
      },
    },
  };
}

export async function planAssessmentImportReconciliationV2(
  input: AssessmentImportReconciliationInputV2,
  repositories: AssessmentImportReconciliationRepositoriesV2,
  options: ImportReconciliationPlanningOptionsV1 = {},
): Promise<AssessmentImportChangePlanV2> {
  const assessmentComponentPlanV2 = await planComponents(input, repositories.entities);
  const blockedComponentKeys = new Set(
    assessmentComponentPlanV2.items
      .filter(
        (item): item is Extract<AssessmentComponentPlanItemV2, { readonly state: 'blocked' }> =>
          item.state === 'blocked' && OPERATIONAL_COMPONENT_BLOCK_REASONS_V2.has(item.reason),
      )
      .flatMap((item) => {
        const file = input.files.find((candidate) => candidate.importFileId === item.importFileId);
        const component = file?.materialization.components.find(
          (candidate) => candidate.stableKey === item.stableKey,
        );
        return component ? [`${item.importFileId}:${component.value.id}`] : [];
      }),
  );
  const recordsInput: ImportReconciliationInputV1 = {
    ...input,
    files: input.files.map((file) => ({
      importFileId: file.importFileId,
      logicalSource: file.logicalSource,
      records: [
        ...file.materialization.gradeEntries
          .filter(
            (value) =>
              !blockedComponentKeys.has(`${file.importFileId}:${value.assessmentComponentId}`),
          )
          .map((value) => ({
            kind: 'grade-entry' as const,
            value,
          })),
        ...(file.additionalRecords ?? []),
      ],
    })),
  };
  const recordPlan = await planImportReconciliation(
    recordsInput,
    planningRepositoriesWithBulkPrefetch(recordsInput, repositories),
    options,
  );
  return { ...recordPlan, assessmentComponentPlanV2 };
}
