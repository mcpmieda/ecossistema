import type {
  ImportFileId,
  SourceFileManifestId,
} from '../../../../../shared/gradebook-contracts/imports/import-ids-v1';
import type {
  AcademicPersistenceContextV1,
  AcademicEntityRecordV1,
  AcademicRecordStreamV1,
  AcademicRecordV1,
  AuditRecordStreamV1,
  AuditRecordV1,
  BatchPromotionTransactionPortV1,
  LogicalSourceIdV1,
  LogicalSourceRecordAssociationStreamV1,
  LogicalSourceRecordAssociationV1,
  PersistenceUnitOfWorkV1,
  VersionedRecordV1,
  VersionedWriteResultV1,
} from '../../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';
import type {
  ImportBootstrapTransactionPortV2,
  ImportBootstrapTransactionRequestV2,
} from '../../../../../src/gradebook-domain/ports/persistence/persistence-ports-v2';
import type {
  AssessmentComponentChangePlanV2,
  AssessmentComponentPlanItemV2,
  AssessmentImportChangePlanV2,
} from '../assessment-import-reconciliation-v2';
import {
  academicRecordStreamForV1,
  academicRecordStreamKeyV1,
  type ImportChangeCountsV1,
  type ImportChangePlanItemV1,
  type ImportChangePlanV1,
  type ImportFileChangePlanV1,
  type PlannedLogicalSourceRecordAssociationWriteV1,
} from '../import-reconciliation-v1';

export interface ImportChangeExecutionWriteCountsV1 {
  readonly academicEntityVersions?: number;
  readonly sourceFileVersions: number;
  readonly academicRecordVersions: number;
  readonly logicalSourceRecordAssociationVersions: number;
  readonly totalVersionWrites: number;
}

export interface AppliedSourceFileVersionV1 {
  readonly importFileId: ImportFileId;
  readonly sourceFileManifestId: SourceFileManifestId;
  readonly version: number;
}

export interface AppliedAcademicRecordVersionV1 {
  readonly importFileId: ImportFileId;
  readonly changeState: 'new' | 'changed';
  readonly stableKey: string;
  readonly recordKind: AcademicRecordV1['kind'];
  readonly version: number;
}

export interface AppliedLogicalSourceRecordAssociationVersionV1 {
  readonly importFileId: ImportFileId;
  readonly changeState: 'new' | 'changed';
  readonly logicalSourceId: LogicalSourceIdV1;
  readonly stableKey: string;
  readonly state: LogicalSourceRecordAssociationV1['state'];
  readonly sourceManifestId: SourceFileManifestId;
  readonly sourceManifestVersion: number;
  readonly version: number;
}

export interface AppliedImportChangeVersionsV1 {
  readonly academicEntities?: readonly AppliedAcademicEntityVersionV2[];
  readonly sourceFiles: readonly AppliedSourceFileVersionV1[];
  readonly academicRecords: readonly AppliedAcademicRecordVersionV1[];
  readonly logicalSourceRecordAssociations: readonly AppliedLogicalSourceRecordAssociationVersionV1[];
}

export interface AppliedAcademicEntityVersionV2 {
  readonly importFileId: ImportFileId;
  readonly changeState: 'new' | 'changed';
  readonly stableKey: string;
  readonly entityKind: 'assessment-component';
  readonly version: number;
}

export interface ImportChangeExecutionAuditAppendV1 {
  readonly stream: Extract<AuditRecordStreamV1, { readonly kind: 'occurrence' }>;
  readonly record: Extract<AuditRecordV1, { readonly kind: 'occurrence' }>;
  readonly expectedVersion: number | null;
}

export interface ImportChangeExecutionOptionsV1 {
  /**
   * Optional sanitized occurrence appended inside the same official promotion transaction. This
   * is deliberately narrower than a generic callback or arbitrary repository mutation.
   */
  readonly auditAppend?: ImportChangeExecutionAuditAppendV1;
}

export type ImportChangePlanValidationScopeV1 = 'plan' | 'file' | 'item';

export interface ImportChangePlanValidationIssueV1 {
  readonly code: string;
  readonly scope: ImportChangePlanValidationScopeV1;
  readonly message: string;
  readonly importFileId?: ImportFileId;
  readonly stableKey?: string;
}

export interface ImportChangeVersionConflictV1 {
  readonly scope:
    'source-file' | 'academic-entity' | 'academic-record' | 'logical-source-record-association';
  readonly importFileId: ImportFileId;
  readonly stableKey?: string;
  readonly expectedVersion: number | null;
  readonly currentVersion: number | null;
}

interface ImportChangeExecutionResultBaseV1 {
  readonly importBatchId: ImportChangePlanV1['importBatchId'];
  readonly academicYearId: ImportChangePlanV1['academicYearId'];
  readonly expectedBatchVersion: number;
  readonly transactionStarted: boolean;
  readonly transactionCommitted: boolean;
  readonly committedWrites: ImportChangeExecutionWriteCountsV1;
  readonly appliedVersions: AppliedImportChangeVersionsV1;
}

export type ImportChangeExecutionResultV1 =
  | (ImportChangeExecutionResultBaseV1 & {
      readonly status: 'applied';
      readonly transactionStarted: true;
      readonly transactionCommitted: true;
      readonly plannedWrites: ImportChangeExecutionWriteCountsV1;
    })
  | (ImportChangeExecutionResultBaseV1 & {
      readonly status: 'no-changes';
      readonly transactionStarted: false;
      readonly transactionCommitted: false;
      readonly plannedWrites: ImportChangeExecutionWriteCountsV1;
      readonly reason: 'no-promotable-writes';
    })
  | (ImportChangeExecutionResultBaseV1 & {
      readonly status: 'version-conflict';
      readonly transactionStarted: true;
      readonly transactionCommitted: false;
      readonly attemptedWritesBeforeRollback: ImportChangeExecutionWriteCountsV1;
      readonly conflict: ImportChangeVersionConflictV1;
    })
  | (ImportChangeExecutionResultBaseV1 & {
      readonly status: 'rejected-invalid-plan';
      readonly transactionCommitted: false;
      readonly attemptedWritesBeforeRollback: ImportChangeExecutionWriteCountsV1;
      readonly validationIssues: readonly ImportChangePlanValidationIssueV1[];
    })
  | (ImportChangeExecutionResultBaseV1 & {
      readonly status: 'transaction-failed';
      readonly transactionStarted: true;
      readonly transactionCommitted: false;
      readonly attemptedWritesBeforeRollback: ImportChangeExecutionWriteCountsV1;
      readonly failure: {
        readonly code: 'transaction-failed';
        readonly message: string;
      };
    });

interface PlanValidationResultV1 {
  readonly issues: readonly ImportChangePlanValidationIssueV1[];
  readonly readyFiles: readonly ImportFileChangePlanV1[];
  readonly plannedWrites: ImportChangeExecutionWriteCountsV1;
}

interface MutableAppliedVersionsV1 {
  academicEntities?: AppliedAcademicEntityVersionV2[];
  sourceFiles: AppliedSourceFileVersionV1[];
  academicRecords: AppliedAcademicRecordVersionV1[];
  logicalSourceRecordAssociations: AppliedLogicalSourceRecordAssociationVersionV1[];
}

class VersionConflictSignalV1 extends Error {
  readonly conflict: ImportChangeVersionConflictV1;

  constructor(conflict: ImportChangeVersionConflictV1) {
    super('version-conflict');
    this.name = 'VersionConflictSignalV1';
    this.conflict = conflict;
  }
}

class InvalidExecutionSignalV1 extends Error {
  readonly issue: ImportChangePlanValidationIssueV1;

  constructor(issue: ImportChangePlanValidationIssueV1) {
    super(issue.code);
    this.name = 'InvalidExecutionSignalV1';
    this.issue = issue;
  }
}

function zeroWriteCounts(includeAcademicEntities = false): ImportChangeExecutionWriteCountsV1 {
  return {
    ...(includeAcademicEntities ? { academicEntityVersions: 0 } : {}),
    sourceFileVersions: 0,
    academicRecordVersions: 0,
    logicalSourceRecordAssociationVersions: 0,
    totalVersionWrites: 0,
  };
}

function emptyAppliedVersions(includeAcademicEntities = false): AppliedImportChangeVersionsV1 {
  return {
    ...(includeAcademicEntities ? { academicEntities: [] } : {}),
    sourceFiles: [],
    academicRecords: [],
    logicalSourceRecordAssociations: [],
  };
}

function attemptedWriteCounts(
  applied: MutableAppliedVersionsV1,
): ImportChangeExecutionWriteCountsV1 {
  const academicEntityVersions = applied.academicEntities?.length ?? 0;
  return {
    ...(applied.academicEntities === undefined ? {} : { academicEntityVersions }),
    sourceFileVersions: applied.sourceFiles.length,
    academicRecordVersions: applied.academicRecords.length,
    logicalSourceRecordAssociationVersions: applied.logicalSourceRecordAssociations.length,
    totalVersionWrites:
      academicEntityVersions +
      applied.sourceFiles.length +
      applied.academicRecords.length +
      applied.logicalSourceRecordAssociations.length,
  };
}

function appliedVersions(applied: MutableAppliedVersionsV1): AppliedImportChangeVersionsV1 {
  return {
    ...(applied.academicEntities === undefined
      ? {}
      : { academicEntities: [...applied.academicEntities] }),
    sourceFiles: [...applied.sourceFiles],
    academicRecords: [...applied.academicRecords],
    logicalSourceRecordAssociations: [...applied.logicalSourceRecordAssociations],
  };
}

function validationIssue(
  input: ImportChangePlanValidationIssueV1,
): ImportChangePlanValidationIssueV1 {
  return input;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isVersionExpectation(value: number | null): boolean {
  return value === null || isPositiveInteger(value);
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (Number.isNaN(value)) return '"number:NaN"';
      if (value === Number.POSITIVE_INFINITY) return '"number:+Infinity"';
      if (value === Number.NEGATIVE_INFINITY) return '"number:-Infinity"';
      return JSON.stringify(value);
    case 'undefined':
      return '"undefined"';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
      }

      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return `{${entries
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
        .join(',')}}`;
    }
    default:
      return `"unsupported:${typeof value}"`;
  }
}

function sameStructure(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function countItems(items: readonly ImportChangePlanItemV1[]): ImportChangeCountsV1 {
  const counts: Record<ImportChangePlanItemV1['state'], number> = {
    unchanged: 0,
    new: 0,
    changed: 0,
    'missing-from-new-source': 0,
    blocked: 0,
  };

  for (const item of items) counts[item.state] += 1;
  return counts;
}

function sameChangeCounts(left: ImportChangeCountsV1, right: ImportChangeCountsV1): boolean {
  return (
    left.unchanged === right.unchanged &&
    left.new === right.new &&
    left.changed === right.changed &&
    left['missing-from-new-source'] === right['missing-from-new-source'] &&
    left.blocked === right.blocked
  );
}

function associationWritesForFile(file: ImportFileChangePlanV1): number {
  return file.items.reduce(
    (total, item) => total + (item.state === 'new' || item.state === 'changed' ? 1 : 0),
    0,
  );
}

function expectedFileWrites(file: ImportFileChangePlanV1): ImportChangeExecutionWriteCountsV1 {
  const sourceFileVersions = file.sourceFileWrite.kind === 'append-version' ? 1 : 0;
  const academicRecordVersions = file.counts.new + file.counts.changed;
  const logicalSourceRecordAssociationVersions = associationWritesForFile(file);
  return {
    sourceFileVersions,
    academicRecordVersions,
    logicalSourceRecordAssociationVersions,
    totalVersionWrites:
      sourceFileVersions + academicRecordVersions + logicalSourceRecordAssociationVersions,
  };
}

function derivedPlanStatus(files: readonly ImportFileChangePlanV1[]): ImportChangePlanV1['status'] {
  const hasReady = files.some((file) => file.status === 'ready-for-promotion');
  const hasReview = files.some((file) => file.status === 'review-required');
  const hasBlocked = files.some((file) => file.status === 'blocked');

  if (hasReady && (hasReview || hasBlocked)) return 'partially-ready';
  if (hasReady) return 'ready-for-promotion';
  if (hasReview) return 'review-required';
  if (hasBlocked) return 'blocked';
  return 'no-changes';
}

function recordAcademicYearId(
  record: AcademicRecordV1,
): AcademicPersistenceContextV1['academicYearId'] {
  return record.value.academicYearId;
}

function validateStreamAndRecord(input: {
  plan: ImportChangePlanV1;
  file: ImportFileChangePlanV1;
  item: Extract<ImportChangePlanItemV1, { readonly stream: AcademicRecordStreamV1 }>;
  record: AcademicRecordV1;
  recordLabel: 'incoming' | 'current';
  issues: ImportChangePlanValidationIssueV1[];
}): void {
  const expectedStableKey = academicRecordStreamKeyV1(input.item.stream);
  const recordStream = academicRecordStreamForV1(input.record);

  if (input.item.stableKey !== expectedStableKey) {
    input.issues.push(
      validationIssue({
        code: 'item-stable-key-mismatch',
        scope: 'item',
        message: 'A chave estável não corresponde ao stream acadêmico informado.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }

  if (academicRecordStreamKeyV1(recordStream) !== expectedStableKey) {
    input.issues.push(
      validationIssue({
        code: `${input.recordLabel}-record-stream-mismatch`,
        scope: 'item',
        message: 'O registro acadêmico não corresponde ao stream planejado.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }

  if (recordAcademicYearId(input.record) !== input.plan.academicYearId) {
    input.issues.push(
      validationIssue({
        code: `${input.recordLabel}-record-year-mismatch`,
        scope: 'item',
        message: 'O registro acadêmico não pertence ao ano letivo do plano.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }
}

function associationStreamMatchesItem(
  stream: LogicalSourceRecordAssociationStreamV1,
  item: Extract<ImportChangePlanItemV1, { readonly state: 'new' | 'changed' }>,
  logicalSourceId: LogicalSourceIdV1,
): boolean {
  return (
    stream.logicalSourceId === logicalSourceId &&
    stream.stableKey === item.stableKey &&
    academicRecordStreamKeyV1(stream.academicRecordStream) === item.stableKey &&
    sameStructure(stream.academicRecordStream, item.stream)
  );
}

function associationValueMatchesItem(
  plan: ImportChangePlanV1,
  item: Extract<ImportChangePlanItemV1, { readonly state: 'new' | 'changed' }>,
  logicalSourceId: LogicalSourceIdV1,
  value: LogicalSourceRecordAssociationV1,
): boolean {
  return (
    value.academicYearId === plan.academicYearId &&
    value.logicalSourceId === logicalSourceId &&
    value.stableKey === item.stableKey &&
    academicRecordStreamKeyV1(value.academicRecordStream) === item.stableKey &&
    sameStructure(value.academicRecordStream, item.stream)
  );
}

function validateCurrentAssociation(input: {
  plan: ImportChangePlanV1;
  file: ImportFileChangePlanV1;
  item: Extract<ImportChangePlanItemV1, { readonly state: 'new' | 'changed' }>;
  logicalSourceId: LogicalSourceIdV1;
  write: PlannedLogicalSourceRecordAssociationWriteV1;
  issues: ImportChangePlanValidationIssueV1[];
}): void {
  const current = input.write.currentAssociation;
  if (current === null) {
    if (input.write.expectedVersion !== null) {
      input.issues.push(
        validationIssue({
          code: 'association-version-expectation-invalid',
          scope: 'item',
          message: 'Uma associação sem versão corrente deve usar expectativa otimista nula.',
          importFileId: input.file.importFileId,
          stableKey: input.item.stableKey,
        }),
      );
    }
    return;
  }

  if (!isPositiveInteger(current.version) || input.write.expectedVersion !== current.version) {
    input.issues.push(
      validationIssue({
        code: 'association-version-expectation-invalid',
        scope: 'item',
        message: 'A expectativa otimista da associação não corresponde à versão corrente.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }

  if (!associationValueMatchesItem(input.plan, input.item, input.logicalSourceId, current.value)) {
    input.issues.push(
      validationIssue({
        code: 'current-association-stream-mismatch',
        scope: 'item',
        message: 'A associação corrente não corresponde à fonte lógica e ao stream planejados.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }
}

function validateAssociationWrite(input: {
  plan: ImportChangePlanV1;
  file: ImportFileChangePlanV1;
  item: Extract<ImportChangePlanItemV1, { readonly state: 'new' | 'changed' }>;
  issues: ImportChangePlanValidationIssueV1[];
}): void {
  const write = input.item.associationWrite;

  if (input.file.logicalSource.state !== 'confirmed') {
    input.issues.push(
      validationIssue({
        code: 'association-logical-source-unconfirmed',
        scope: 'item',
        message: 'Uma associação automática exige uma fonte lógica confirmada no arquivo.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
    return;
  }

  const logicalSourceId = input.file.logicalSource.logicalSourceId;
  if (
    !associationStreamMatchesItem(write.stream, input.item, logicalSourceId) ||
    !associationValueMatchesItem(input.plan, input.item, logicalSourceId, write.value)
  ) {
    input.issues.push(
      validationIssue({
        code: 'association-stream-mismatch',
        scope: 'item',
        message:
          'A associação não corresponde à fonte lógica, à chave e ao stream acadêmico do item.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }

  if (write.value.state !== 'active') {
    input.issues.push(
      validationIssue({
        code: 'association-state-invalid',
        scope: 'item',
        message: 'A promoção automática somente pode planejar uma associação ativa.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }

  if (!isPositiveInteger(write.value.sourceManifestVersion)) {
    input.issues.push(
      validationIssue({
        code: 'association-source-version-invalid',
        scope: 'item',
        message: 'A versão de origem da associação deve ser um inteiro positivo.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }

  if (input.file.sourceFileWrite.kind !== 'append-version') {
    input.issues.push(
      validationIssue({
        code: 'association-without-source-append',
        scope: 'item',
        message:
          'A associação planejada não possui a versão de fonte correspondente no mesmo arquivo.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  } else {
    const sourceWrite = input.file.sourceFileWrite;
    const expectedSourceVersion = (sourceWrite.expectedVersion ?? 0) + 1;
    if (
      input.file.sourceFileManifestId === null ||
      write.value.sourceManifestId !== input.file.sourceFileManifestId ||
      write.value.sourceManifestId !== sourceWrite.value.manifest.id ||
      write.value.sourceManifestVersion !== expectedSourceVersion
    ) {
      input.issues.push(
        validationIssue({
          code: 'association-source-provenance-mismatch',
          scope: 'item',
          message:
            'O manifesto ou a versão de origem da associação diverge do append de fonte planejado.',
          importFileId: input.file.importFileId,
          stableKey: input.item.stableKey,
        }),
      );
    }
  }

  if (!isVersionExpectation(write.expectedVersion)) {
    input.issues.push(
      validationIssue({
        code: 'association-version-expectation-invalid',
        scope: 'item',
        message: 'A expectativa otimista da associação é inválida.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }

  validateCurrentAssociation({
    ...input,
    logicalSourceId,
    write,
  });

  if (
    write.currentAssociation !== null &&
    sameStructure(write.currentAssociation.value, write.value)
  ) {
    input.issues.push(
      validationIssue({
        code: 'association-write-unnecessary',
        scope: 'item',
        message: 'Uma associação idêntica à versão corrente não deve gerar nova versão.',
        importFileId: input.file.importFileId,
        stableKey: input.item.stableKey,
      }),
    );
  }
}

/** A blocked item names its stream and stable key together, and the key matches the stream. */
function validateBlockedItemV1(
  input: { file: ImportFileChangePlanV1; issues: ImportChangePlanValidationIssueV1[] },
  item: Extract<ImportChangePlanItemV1, { state: 'blocked' }>,
): void {
  const hasStableKey = item.stableKey !== undefined;
  const hasStream = item.stream !== undefined;
  if (hasStableKey !== hasStream) {
    input.issues.push(
      validationIssue({
        code: 'blocked-item-reference-incomplete',
        scope: 'item',
        message: 'Um item bloqueado deve informar stream e chave estável juntos.',
        importFileId: input.file.importFileId,
        stableKey: item.stableKey,
      }),
    );
  } else if (item.stream && item.stableKey) {
    const expectedStableKey = academicRecordStreamKeyV1(item.stream);
    if (expectedStableKey !== item.stableKey) {
      input.issues.push(
        validationIssue({
          code: 'blocked-item-stable-key-mismatch',
          scope: 'item',
          message: 'A chave estável do item bloqueado não corresponde ao stream.',
          importFileId: input.file.importFileId,
          stableKey: item.stableKey,
        }),
      );
    }
  }
}

function validateItem(input: {
  plan: ImportChangePlanV1;
  file: ImportFileChangePlanV1;
  item: ImportChangePlanItemV1;
  issues: ImportChangePlanValidationIssueV1[];
}): void {
  if (input.item.importFileId !== input.file.importFileId) {
    input.issues.push(
      validationIssue({
        code: 'item-file-mismatch',
        scope: 'item',
        message: 'O item não pertence ao arquivo que o contém.',
        importFileId: input.file.importFileId,
        stableKey: 'stableKey' in input.item ? input.item.stableKey : undefined,
      }),
    );
  }

  switch (input.item.state) {
    case 'new': {
      validateStreamAndRecord({
        ...input,
        item: input.item,
        record: input.item.incomingRecord,
        recordLabel: 'incoming',
      });
      const newExpectedVersion: unknown = input.item.expectedVersion;
      if (newExpectedVersion !== null) {
        input.issues.push(
          validationIssue({
            code: 'new-item-version-expectation-invalid',
            scope: 'item',
            message: 'Um item novo deve esperar ausência de versão anterior.',
            importFileId: input.file.importFileId,
            stableKey: input.item.stableKey,
          }),
        );
      }
      validateAssociationWrite({ ...input, item: input.item });
      break;
    }
    case 'changed':
      validateStreamAndRecord({
        ...input,
        item: input.item,
        record: input.item.incomingRecord,
        recordLabel: 'incoming',
      });
      validateStreamAndRecord({
        ...input,
        item: input.item,
        record: input.item.currentRecord.value,
        recordLabel: 'current',
      });
      if (
        !isPositiveInteger(input.item.expectedVersion) ||
        input.item.expectedVersion !== input.item.currentRecord.version
      ) {
        input.issues.push(
          validationIssue({
            code: 'changed-item-version-expectation-invalid',
            scope: 'item',
            message: 'A expectativa de versão do item alterado não corresponde à versão atual.',
            importFileId: input.file.importFileId,
            stableKey: input.item.stableKey,
          }),
        );
      }
      validateAssociationWrite({ ...input, item: input.item });
      break;
    case 'unchanged':
      validateStreamAndRecord({
        ...input,
        item: input.item,
        record: input.item.incomingRecord,
        recordLabel: 'incoming',
      });
      if (input.item.currentVersion !== null && !isPositiveInteger(input.item.currentVersion)) {
        input.issues.push(
          validationIssue({
            code: 'unchanged-item-version-invalid',
            scope: 'item',
            message: 'A versão atual do item inalterado é inválida.',
            importFileId: input.file.importFileId,
            stableKey: input.item.stableKey,
          }),
        );
      }
      break;
    case 'missing-from-new-source':
      validateStreamAndRecord({
        ...input,
        item: input.item,
        record: input.item.currentRecord.value,
        recordLabel: 'current',
      });
      if (
        !isPositiveInteger(input.item.expectedVersion) ||
        input.item.expectedVersion !== input.item.currentRecord.version
      ) {
        input.issues.push(
          validationIssue({
            code: 'missing-item-version-expectation-invalid',
            scope: 'item',
            message: 'A expectativa de versão do item ausente não corresponde à versão atual.',
            importFileId: input.file.importFileId,
            stableKey: input.item.stableKey,
          }),
        );
      }
      break;
    case 'blocked':
      validateBlockedItemV1(input, input.item);
      break;
  }
}

type FileValidationInputV1 = {
  plan: ImportChangePlanV1;
  file: ImportFileChangePlanV1;
  issues: ImportChangePlanValidationIssueV1[];
  readyWriteKeys: Set<string>;
  readyAssociationKeys: Set<string>;
  readySourceManifestIds: Set<SourceFileManifestId>;
};
type FileWritesV1 = ReturnType<typeof expectedFileWrites>;

/** The file's counts and version estimate must match its planned items. */
function validateFileCountsV1(input: FileValidationInputV1, expectedWrites: FileWritesV1): void {
  const derivedCounts = countItems(input.file.items);
  if (!sameChangeCounts(input.file.counts, derivedCounts)) {
    input.issues.push(
      validationIssue({
        code: 'file-counts-mismatch',
        scope: 'file',
        message: 'As contagens do arquivo não correspondem aos itens planejados.',
        importFileId: input.file.importFileId,
      }),
    );
  }

  if (
    input.file.estimatedWrites.sourceFileVersions !== expectedWrites.sourceFileVersions ||
    input.file.estimatedWrites.academicRecordVersions !== expectedWrites.academicRecordVersions ||
    input.file.estimatedWrites.logicalSourceRecordAssociationVersions !==
      expectedWrites.logicalSourceRecordAssociationVersions ||
    input.file.estimatedWrites.totalPlannedVersionWrites !== expectedWrites.totalVersionWrites
  ) {
    input.issues.push(
      validationIssue({
        code: 'file-write-estimate-mismatch',
        scope: 'file',
        message: 'A estimativa de versões do arquivo diverge dos appends planejados.',
        importFileId: input.file.importFileId,
      }),
    );
  }
}

/** Each item, and one item per academic stream. */
function validateFileItemsV1(input: FileValidationInputV1): void {
  const itemKeys = new Set<string>();
  for (const item of input.file.items) {
    validateItem({
      plan: input.plan,
      file: input.file,
      item,
      issues: input.issues,
    });
    if ('stableKey' in item && item.stableKey !== undefined) {
      if (itemKeys.has(item.stableKey)) {
        input.issues.push(
          validationIssue({
            code: 'duplicate-file-stream',
            scope: 'item',
            message: 'O arquivo contém mais de um item para o mesmo stream acadêmico.',
            importFileId: input.file.importFileId,
            stableKey: item.stableKey,
          }),
        );
      }
      itemKeys.add(item.stableKey);
    }
  }
}

/** The source file's append: a valid expectation, this file's manifest, metadata and relation. */
function validateSourceWriteV1(input: FileValidationInputV1): void {
  if (input.file.sourceFileWrite.kind === 'append-version') {
    const sourceWrite = input.file.sourceFileWrite;
    if (!isVersionExpectation(sourceWrite.expectedVersion)) {
      input.issues.push(
        validationIssue({
          code: 'source-version-expectation-invalid',
          scope: 'file',
          message: 'A expectativa de versão do arquivo-fonte é inválida.',
          importFileId: input.file.importFileId,
        }),
      );
    }
    if (
      input.file.sourceFileManifestId === null ||
      sourceWrite.value.manifest.id !== input.file.sourceFileManifestId
    ) {
      input.issues.push(
        validationIssue({
          code: 'source-manifest-id-mismatch',
          scope: 'file',
          message: 'O manifesto do append não corresponde à identidade do arquivo planejado.',
          importFileId: input.file.importFileId,
        }),
      );
    }
    if (
      sourceWrite.value.manifest.fileName !== input.file.fileName ||
      sourceWrite.value.manifest.sha256 !== input.file.sha256
    ) {
      input.issues.push(
        validationIssue({
          code: 'source-manifest-metadata-mismatch',
          scope: 'file',
          message: 'Os metadados do manifesto divergem do arquivo planejado.',
          importFileId: input.file.importFileId,
        }),
      );
    }
    if (!sameStructure(sourceWrite.value.logicalSource, input.file.logicalSource)) {
      input.issues.push(
        validationIssue({
          code: 'source-logical-relation-mismatch',
          scope: 'file',
          message: 'A relação lógica do append diverge da relação revisada do arquivo.',
          importFileId: input.file.importFileId,
        }),
      );
    }
  }
}

/** A file ready for promotion: promotable, and no stream, association or manifest written twice. */
function validateReadyFileV1(input: FileValidationInputV1, expectedWrites: FileWritesV1): void {
  if (
    input.file.batchFileStatus !== 'approved' ||
    input.file.logicalSource.state !== 'confirmed' ||
    input.file.sourceFileManifestId === null ||
    expectedWrites.totalVersionWrites <= 0 ||
    input.file.items.some(
      (item) => item.state === 'missing-from-new-source' || item.state === 'blocked',
    )
  ) {
    input.issues.push(
      validationIssue({
        code: 'ready-file-not-promotable',
        scope: 'file',
        message: 'O arquivo marcado como pronto contém estado incompatível com promoção.',
        importFileId: input.file.importFileId,
      }),
    );
  }
  for (const item of input.file.items) {
    if (item.state !== 'new' && item.state !== 'changed') continue;
    if (input.readyWriteKeys.has(item.stableKey)) {
      input.issues.push(
        validationIssue({
          code: 'duplicate-promotion-stream',
          scope: 'item',
          message: 'A promoção contém mais de um append para o mesmo stream acadêmico.',
          importFileId: input.file.importFileId,
          stableKey: item.stableKey,
        }),
      );
    }
    input.readyWriteKeys.add(item.stableKey);

    const associationKey = `${item.associationWrite.stream.logicalSourceId}:${item.stableKey}`;
    if (input.readyAssociationKeys.has(associationKey)) {
      input.issues.push(
        validationIssue({
          code: 'duplicate-promotion-association',
          scope: 'item',
          message:
            'A promoção contém mais de um append para a mesma associação fonte lógica ↔ stream.',
          importFileId: input.file.importFileId,
          stableKey: item.stableKey,
        }),
      );
    }
    input.readyAssociationKeys.add(associationKey);
  }
  if (input.file.sourceFileWrite.kind === 'append-version') {
    const manifestId = input.file.sourceFileWrite.value.manifest.id;
    if (input.readySourceManifestIds.has(manifestId)) {
      input.issues.push(
        validationIssue({
          code: 'duplicate-promotion-source-manifest',
          scope: 'file',
          message: 'A promoção contém mais de um append para o mesmo manifesto.',
          importFileId: input.file.importFileId,
        }),
      );
    }
    input.readySourceManifestIds.add(manifestId);
  }
}

function validateFile(input: FileValidationInputV1): void {
  const expectedWrites = expectedFileWrites(input.file);
  validateFileCountsV1(input, expectedWrites);
  validateFileItemsV1(input);
  validateSourceWriteV1(input);
  switch (input.file.status) {
    case 'unchanged':
      if (
        input.file.sourceFileWrite.kind !== 'none' ||
        expectedWrites.totalVersionWrites !== 0 ||
        input.file.items.some((item) => item.state !== 'unchanged')
      ) {
        input.issues.push(
          validationIssue({
            code: 'unchanged-file-has-writes',
            scope: 'file',
            message: 'Um arquivo inalterado não pode conter appends planejados.',
            importFileId: input.file.importFileId,
          }),
        );
      }
      break;
    case 'ready-for-promotion':
      validateReadyFileV1(input, expectedWrites);
      break;
    case 'review-required':
      break;
    case 'blocked':
      if (expectedWrites.totalVersionWrites !== 0 || input.file.sourceFileWrite.kind !== 'none') {
        input.issues.push(
          validationIssue({
            code: 'blocked-file-has-writes',
            scope: 'file',
            message: 'Um arquivo bloqueado não pode conter appends planejados.',
            importFileId: input.file.importFileId,
          }),
        );
      }
      break;
  }
}

function validateImportChangePlan(plan: ImportChangePlanV1): PlanValidationResultV1 {
  const issues: ImportChangePlanValidationIssueV1[] = [];
  const readyWriteKeys = new Set<string>();
  const readyAssociationKeys = new Set<string>();
  const readySourceManifestIds = new Set<SourceFileManifestId>();

  if (!isPositiveInteger(plan.expectedBatchVersion)) {
    issues.push(
      validationIssue({
        code: 'batch-version-invalid',
        scope: 'plan',
        message: 'A versão esperada do lote deve ser um inteiro positivo.',
      }),
    );
  }

  if (
    plan.planningEvidence.writesPerformed !== 0 ||
    !plan.planningEvidence.repositoriesExposeReadOperationsOnly ||
    !plan.planningEvidence.deterministicWithoutClockNetworkOrGlobalEnvironment
  ) {
    issues.push(
      validationIssue({
        code: 'planning-evidence-invalid',
        scope: 'plan',
        message: 'As garantias de planejamento sem escrita não foram preservadas.',
      }),
    );
  }

  const fileIds = new Set<ImportFileId>();
  for (const file of plan.files) {
    if (fileIds.has(file.importFileId)) {
      issues.push(
        validationIssue({
          code: 'duplicate-plan-file',
          scope: 'file',
          message: 'O plano contém o mesmo arquivo mais de uma vez.',
          importFileId: file.importFileId,
        }),
      );
    }
    fileIds.add(file.importFileId);
    validateFile({
      plan,
      file,
      issues,
      readyWriteKeys,
      readyAssociationKeys,
      readySourceManifestIds,
    });
  }

  const flattenedItems = plan.files.flatMap((file) => file.items);
  if (!sameStructure(plan.items, flattenedItems)) {
    issues.push(
      validationIssue({
        code: 'plan-items-mismatch',
        scope: 'plan',
        message: 'A lista global de itens diverge dos itens dos arquivos.',
      }),
    );
  }

  const derivedCounts = countItems(flattenedItems);
  if (!sameChangeCounts(plan.counts, derivedCounts)) {
    issues.push(
      validationIssue({
        code: 'plan-counts-mismatch',
        scope: 'plan',
        message: 'As contagens globais divergem dos itens dos arquivos.',
      }),
    );
  }

  if (plan.status !== derivedPlanStatus(plan.files)) {
    issues.push(
      validationIssue({
        code: 'plan-status-mismatch',
        scope: 'plan',
        message: 'O estado global do plano diverge dos estados dos arquivos.',
      }),
    );
  }

  const readyFiles = plan.files.filter((file) => file.status === 'ready-for-promotion');
  const reviewFiles = plan.files.filter((file) => file.status === 'review-required');
  const blockedFiles = plan.files.filter((file) => file.status === 'blocked');
  const readyIds = readyFiles.map((file) => file.importFileId);
  const reviewIds = reviewFiles.map((file) => file.importFileId);
  const blockedIds = blockedFiles.map((file) => file.importFileId);

  if (
    plan.promotionRequest.importBatchId !== plan.importBatchId ||
    plan.promotionRequest.expectedBatchVersion !== plan.expectedBatchVersion ||
    !sameOrderedStrings(plan.promotionRequest.approvedImportFileIds, readyIds)
  ) {
    issues.push(
      validationIssue({
        code: 'promotion-request-mismatch',
        scope: 'plan',
        message: 'A requisição de promoção não corresponde exatamente aos arquivos prontos.',
      }),
    );
  }

  if (!sameOrderedStrings(plan.reviewRequiredImportFileIds, reviewIds)) {
    issues.push(
      validationIssue({
        code: 'review-file-list-mismatch',
        scope: 'plan',
        message: 'A lista de arquivos em revisão diverge dos estados do plano.',
      }),
    );
  }

  if (!sameOrderedStrings(plan.blockedImportFileIds, blockedIds)) {
    issues.push(
      validationIssue({
        code: 'blocked-file-list-mismatch',
        scope: 'plan',
        message: 'A lista de arquivos bloqueados diverge dos estados do plano.',
      }),
    );
  }

  const expectedAllSourceWrites = plan.files.filter(
    (file) => file.sourceFileWrite.kind === 'append-version',
  ).length;
  const expectedAllAcademicWrites = plan.files.reduce(
    (total, file) => total + file.counts.new + file.counts.changed,
    0,
  );
  const expectedAllAssociationWrites = plan.files.reduce(
    (total, file) => total + associationWritesForFile(file),
    0,
  );
  const expectedReadyWrites = readyFiles.reduce(
    (total, file) => total + expectedFileWrites(file).totalVersionWrites,
    0,
  );
  const expectedReviewWrites = reviewFiles.reduce(
    (total, file) => total + expectedFileWrites(file).totalVersionWrites,
    0,
  );

  if (
    plan.estimatedWrites.sourceFileVersions !== expectedAllSourceWrites ||
    plan.estimatedWrites.academicRecordVersions !== expectedAllAcademicWrites ||
    plan.estimatedWrites.logicalSourceRecordAssociationVersions !== expectedAllAssociationWrites ||
    plan.estimatedWrites.totalPlannedVersionWrites !==
      expectedAllSourceWrites + expectedAllAcademicWrites + expectedAllAssociationWrites ||
    plan.estimatedWrites.readyForPromotionVersionWrites !== expectedReadyWrites ||
    plan.estimatedWrites.pendingReviewVersionWrites !== expectedReviewWrites ||
    plan.estimatedWrites.exactCloudflareQuota !== false ||
    plan.estimatedWrites.basis !== 'planned-version-appends-only'
  ) {
    issues.push(
      validationIssue({
        code: 'plan-write-estimate-mismatch',
        scope: 'plan',
        message: 'A estimativa global diverge dos appends representados pelo plano.',
      }),
    );
  }

  const plannedWrites = readyFiles.reduce<ImportChangeExecutionWriteCountsV1>((counts, file) => {
    const fileWrites = expectedFileWrites(file);
    return {
      sourceFileVersions: counts.sourceFileVersions + fileWrites.sourceFileVersions,
      academicRecordVersions: counts.academicRecordVersions + fileWrites.academicRecordVersions,
      logicalSourceRecordAssociationVersions:
        counts.logicalSourceRecordAssociationVersions +
        fileWrites.logicalSourceRecordAssociationVersions,
      totalVersionWrites: counts.totalVersionWrites + fileWrites.totalVersionWrites,
    };
  }, zeroWriteCounts());

  return { issues, readyFiles, plannedWrites };
}

function validateAssessmentComponentPlanV2(
  plan: AssessmentImportChangePlanV2,
  componentPlan: AssessmentComponentChangePlanV2,
): readonly ImportChangePlanValidationIssueV1[] {
  const issues: ImportChangePlanValidationIssueV1[] = [];
  const fileIds = new Set(plan.files.map((file) => file.importFileId));
  const keys = new Set<string>();
  const counts = { unchanged: 0, new: 0, changed: 0, blocked: 0 };

  if (
    componentPlan.planningEvidence.writesPerformed !== 0 ||
    !componentPlan.planningEvidence.repositoryExposesGetOnly
  ) {
    issues.push(
      validationIssue({
        code: 'assessment-component-planning-evidence-invalid',
        scope: 'plan',
        message: 'As garantias do planejamento de componentes não foram preservadas.',
      }),
    );
  }

  for (const item of componentPlan.items) {
    counts[item.state] += 1;
    const key = `${item.importFileId}:${item.stableKey}`;
    if (!fileIds.has(item.importFileId) || item.stableKey.trim().length === 0 || keys.has(key)) {
      issues.push(
        validationIssue({
          code: 'assessment-component-plan-item-invalid',
          scope: 'item',
          message: 'O item de componente não corresponde univocamente a um arquivo do plano.',
          importFileId: item.importFileId,
          stableKey: item.stableKey,
        }),
      );
    }
    keys.add(key);

    if (item.state === 'new' || item.state === 'changed' || item.state === 'unchanged') {
      const record: AcademicEntityRecordV1 = item.incomingRecord;
      if (
        record.kind !== 'assessment-component' ||
        record.value.academicYearId !== plan.academicYearId ||
        !record.value.id.startsWith('assessment-component:v2:')
      ) {
        issues.push(
          validationIssue({
            code: 'assessment-component-write-invalid',
            scope: 'item',
            message: 'O componente planejado é incompatível com o contexto V2.',
            importFileId: item.importFileId,
            stableKey: item.stableKey,
          }),
        );
      }
    }
    if (
      (item.state === 'new' && item.expectedVersion !== null) ||
      (item.state === 'changed' && !isPositiveInteger(item.expectedVersion))
    ) {
      issues.push(
        validationIssue({
          code: 'assessment-component-version-expectation-invalid',
          scope: 'item',
          message: 'A expectativa CAS do componente é inválida.',
          importFileId: item.importFileId,
          stableKey: item.stableKey,
        }),
      );
    }
  }

  if (
    !sameStructure(componentPlan.counts, counts) ||
    componentPlan.plannedVersionWrites !== counts.new + counts.changed
  ) {
    issues.push(
      validationIssue({
        code: 'assessment-component-plan-counts-mismatch',
        scope: 'plan',
        message: 'As contagens do plano de componentes divergem de seus itens.',
      }),
    );
  }
  return issues;
}

async function applyAssessmentComponentItemsV2(input: {
  readonly context: AcademicPersistenceContextV1;
  readonly items: readonly AssessmentComponentPlanItemV2[];
  readonly unitOfWork: PersistenceUnitOfWorkV1;
  readonly applied: MutableAppliedVersionsV1;
}): Promise<void> {
  for (const item of input.items) {
    if (item.state !== 'new' && item.state !== 'changed') continue;
    const result = await input.unitOfWork.entities.appendVersion(
      input.context,
      item.incomingRecord,
      { expectedVersion: item.expectedVersion },
    );
    const record = assertWrittenRecord({
      result,
      expectedValue: item.incomingRecord,
      expectedVersion: item.expectedVersion,
      conflict: {
        scope: 'academic-entity',
        importFileId: item.importFileId,
        stableKey: item.stableKey,
        expectedVersion: item.expectedVersion,
        currentVersion: null,
      },
      mismatchIssue: validationIssue({
        code: 'assessment-component-write-result-mismatch',
        scope: 'item',
        message: 'O repositório retornou uma versão de componente incompatível com o append.',
        importFileId: item.importFileId,
        stableKey: item.stableKey,
      }),
    });
    input.applied.academicEntities?.push({
      importFileId: item.importFileId,
      changeState: item.state,
      stableKey: item.stableKey,
      entityKind: 'assessment-component',
      version: record.version,
    });
  }
}

function assertWrittenRecord<T>(input: {
  result: VersionedWriteResultV1<T>;
  expectedValue: T;
  expectedVersion: number | null;
  conflict: ImportChangeVersionConflictV1;
  mismatchIssue: ImportChangePlanValidationIssueV1;
}): VersionedRecordV1<T> {
  if (input.result.status === 'version-conflict') {
    throw new VersionConflictSignalV1({
      ...input.conflict,
      currentVersion: input.result.currentVersion,
    });
  }

  const expectedWrittenVersion = (input.expectedVersion ?? 0) + 1;
  if (
    input.result.record.version !== expectedWrittenVersion ||
    !sameStructure(input.result.record.value, input.expectedValue)
  ) {
    throw new InvalidExecutionSignalV1(input.mismatchIssue);
  }

  return input.result.record;
}

async function applySourceFileWrite(input: {
  context: AcademicPersistenceContextV1;
  file: ImportFileChangePlanV1;
  unitOfWork: PersistenceUnitOfWorkV1;
  applied: MutableAppliedVersionsV1;
}): Promise<void> {
  if (input.file.sourceFileWrite.kind === 'none') return;

  const sourceWrite = input.file.sourceFileWrite;
  const result = await input.unitOfWork.imports.appendSourceFileVersion(
    input.context,
    sourceWrite.value,
    { expectedVersion: sourceWrite.expectedVersion },
  );
  const record = assertWrittenRecord({
    result,
    expectedValue: sourceWrite.value,
    expectedVersion: sourceWrite.expectedVersion,
    conflict: {
      scope: 'source-file',
      importFileId: input.file.importFileId,
      expectedVersion: sourceWrite.expectedVersion,
      currentVersion: null,
    },
    mismatchIssue: validationIssue({
      code: 'source-write-result-mismatch',
      scope: 'file',
      message: 'O repositório retornou uma versão de arquivo incompatível com o append.',
      importFileId: input.file.importFileId,
    }),
  });

  input.applied.sourceFiles.push({
    importFileId: input.file.importFileId,
    sourceFileManifestId: sourceWrite.value.manifest.id,
    version: record.version,
  });
}

async function applyAcademicItem(input: {
  context: AcademicPersistenceContextV1;
  file: ImportFileChangePlanV1;
  item: Extract<ImportChangePlanItemV1, { readonly state: 'new' | 'changed' }>;
  unitOfWork: PersistenceUnitOfWorkV1;
  applied: MutableAppliedVersionsV1;
}): Promise<void> {
  const result = await input.unitOfWork.academicRecords.appendVersion(
    input.context,
    input.item.stream,
    input.item.incomingRecord,
    { expectedVersion: input.item.expectedVersion },
  );
  const record = assertWrittenRecord({
    result,
    expectedValue: input.item.incomingRecord,
    expectedVersion: input.item.expectedVersion,
    conflict: {
      scope: 'academic-record',
      importFileId: input.file.importFileId,
      stableKey: input.item.stableKey,
      expectedVersion: input.item.expectedVersion,
      currentVersion: null,
    },
    mismatchIssue: validationIssue({
      code: 'academic-write-result-mismatch',
      scope: 'item',
      message: 'O repositório retornou uma versão acadêmica incompatível com o append.',
      importFileId: input.file.importFileId,
      stableKey: input.item.stableKey,
    }),
  });

  input.applied.academicRecords.push({
    importFileId: input.file.importFileId,
    changeState: input.item.state,
    stableKey: input.item.stableKey,
    recordKind: input.item.incomingRecord.kind,
    version: record.version,
  });
}

async function applyAssociationWrite(input: {
  context: AcademicPersistenceContextV1;
  file: ImportFileChangePlanV1;
  item: Extract<ImportChangePlanItemV1, { readonly state: 'new' | 'changed' }>;
  unitOfWork: PersistenceUnitOfWorkV1;
  applied: MutableAppliedVersionsV1;
}): Promise<void> {
  const associationWrite = input.item.associationWrite;

  const result = await input.unitOfWork.logicalSourceRecords.appendVersion(
    input.context,
    associationWrite.stream,
    associationWrite.value,
    { expectedVersion: associationWrite.expectedVersion },
  );
  const record = assertWrittenRecord({
    result,
    expectedValue: associationWrite.value,
    expectedVersion: associationWrite.expectedVersion,
    conflict: {
      scope: 'logical-source-record-association',
      importFileId: input.file.importFileId,
      stableKey: input.item.stableKey,
      expectedVersion: associationWrite.expectedVersion,
      currentVersion: null,
    },
    mismatchIssue: validationIssue({
      code: 'association-write-result-mismatch',
      scope: 'item',
      message: 'O repositório retornou uma versão de associação incompatível com o append.',
      importFileId: input.file.importFileId,
      stableKey: input.item.stableKey,
    }),
  });

  input.applied.logicalSourceRecordAssociations.push({
    importFileId: input.file.importFileId,
    changeState: input.item.state,
    logicalSourceId: associationWrite.value.logicalSourceId,
    stableKey: input.item.stableKey,
    state: associationWrite.value.state,
    sourceManifestId: associationWrite.value.sourceManifestId,
    sourceManifestVersion: associationWrite.value.sourceManifestVersion,
    version: record.version,
  });
}

async function applyReadyFile(input: {
  context: AcademicPersistenceContextV1;
  file: ImportFileChangePlanV1;
  unitOfWork: PersistenceUnitOfWorkV1;
  applied: MutableAppliedVersionsV1;
}): Promise<void> {
  await applySourceFileWrite(input);
  await applyReadyFileAcademicWrites(input);
}

async function applyReadyFileAcademicWrites(input: {
  context: AcademicPersistenceContextV1;
  file: ImportFileChangePlanV1;
  unitOfWork: PersistenceUnitOfWorkV1;
  applied: MutableAppliedVersionsV1;
}): Promise<void> {
  for (const item of input.file.items) {
    switch (item.state) {
      case 'new':
      case 'changed':
        await applyAcademicItem({ ...input, item });
        await applyAssociationWrite({ ...input, item });
        break;
      case 'unchanged':
        break;
      case 'missing-from-new-source':
      case 'blocked':
        throw new InvalidExecutionSignalV1(
          validationIssue({
            code: 'non-writable-item-in-promotion',
            scope: 'item',
            message: 'A promoção contém um item que não pode gerar append automático.',
            importFileId: input.file.importFileId,
            stableKey: 'stableKey' in item ? item.stableKey : undefined,
          }),
        );
    }
  }
}

function baseResult(
  plan: ImportChangePlanV1,
): Pick<
  ImportChangeExecutionResultBaseV1,
  'importBatchId' | 'academicYearId' | 'expectedBatchVersion'
> {
  return {
    importBatchId: plan.importBatchId,
    academicYearId: plan.academicYearId,
    expectedBatchVersion: plan.expectedBatchVersion,
  };
}

export async function executeImportChangePlan(
  plan: ImportChangePlanV1 | AssessmentImportChangePlanV2,
  transactionPort: BatchPromotionTransactionPortV1,
  options: ImportChangeExecutionOptionsV1 = {},
): Promise<ImportChangeExecutionResultV1> {
  let validation: PlanValidationResultV1;
  const componentPlan = 'assessmentComponentPlanV2' in plan ? plan.assessmentComponentPlanV2 : null;
  const includeAcademicEntities = componentPlan !== null;
  let componentValidationIssues: readonly ImportChangePlanValidationIssueV1[] = [];
  try {
    validation = validateImportChangePlan(plan);
    if (componentPlan) {
      componentValidationIssues = validateAssessmentComponentPlanV2(
        plan as AssessmentImportChangePlanV2,
        componentPlan,
      );
    }
  } catch {
    return {
      ...baseResult(plan),
      status: 'rejected-invalid-plan',
      transactionStarted: false,
      transactionCommitted: false,
      attemptedWritesBeforeRollback: zeroWriteCounts(includeAcademicEntities),
      committedWrites: zeroWriteCounts(includeAcademicEntities),
      appliedVersions: emptyAppliedVersions(includeAcademicEntities),
      validationIssues: [
        validationIssue({
          code: 'invalid-plan-shape',
          scope: 'plan',
          message: 'A estrutura do plano não pôde ser validada.',
        }),
      ],
    };
  }

  const validationIssues = [...validation.issues, ...componentValidationIssues];
  if (validationIssues.length > 0) {
    return {
      ...baseResult(plan),
      status: 'rejected-invalid-plan',
      transactionStarted: false,
      transactionCommitted: false,
      attemptedWritesBeforeRollback: zeroWriteCounts(includeAcademicEntities),
      committedWrites: zeroWriteCounts(includeAcademicEntities),
      appliedVersions: emptyAppliedVersions(includeAcademicEntities),
      validationIssues,
    };
  }

  const readyFileIds = new Set(validation.readyFiles.map((file) => file.importFileId));
  const componentItems =
    componentPlan?.items.filter(
      (item) =>
        readyFileIds.has(item.importFileId) && (item.state === 'new' || item.state === 'changed'),
    ) ?? [];
  const plannedWrites: ImportChangeExecutionWriteCountsV1 = componentPlan
    ? {
        ...validation.plannedWrites,
        academicEntityVersions: componentItems.length,
        totalVersionWrites: validation.plannedWrites.totalVersionWrites + componentItems.length,
      }
    : validation.plannedWrites;

  if (plannedWrites.totalVersionWrites === 0) {
    return {
      ...baseResult(plan),
      status: 'no-changes',
      transactionStarted: false,
      transactionCommitted: false,
      plannedWrites,
      committedWrites: zeroWriteCounts(includeAcademicEntities),
      appliedVersions: emptyAppliedVersions(includeAcademicEntities),
      reason: 'no-promotable-writes',
    };
  }

  const context = {
    academicYearId: plan.academicYearId,
  } satisfies AcademicPersistenceContextV1;
  const applied: MutableAppliedVersionsV1 = {
    ...(componentPlan ? { academicEntities: [] } : {}),
    sourceFiles: [],
    academicRecords: [],
    logicalSourceRecordAssociations: [],
  };
  try {
    const committed = await transactionPort.runBatchPromotion(
      context,
      plan.promotionRequest,
      async (unitOfWork) => {
        if (componentPlan) {
          await applyAssessmentComponentItemsV2({
            context,
            items: componentItems,
            unitOfWork,
            applied,
          });
        }
        for (const file of validation.readyFiles) {
          await applyReadyFile({
            context,
            file,
            unitOfWork,
            applied,
          });
        }

        const actualWrites = attemptedWriteCounts(applied);
        if (
          actualWrites.academicEntityVersions !== plannedWrites.academicEntityVersions ||
          actualWrites.sourceFileVersions !== plannedWrites.sourceFileVersions ||
          actualWrites.academicRecordVersions !== plannedWrites.academicRecordVersions ||
          actualWrites.logicalSourceRecordAssociationVersions !==
            plannedWrites.logicalSourceRecordAssociationVersions ||
          actualWrites.totalVersionWrites !== plannedWrites.totalVersionWrites
        ) {
          throw new InvalidExecutionSignalV1(
            validationIssue({
              code: 'applied-write-count-mismatch',
              scope: 'plan',
              message: 'As contagens aplicadas divergem da estimativa validada do plano.',
            }),
          );
        }

        if (options.auditAppend) {
          const auditResult = await unitOfWork.audit.appendVersion(
            context,
            options.auditAppend.stream,
            options.auditAppend.record,
            { expectedVersion: options.auditAppend.expectedVersion },
          );
          if (auditResult.status === 'version-conflict') {
            throw new InvalidExecutionSignalV1(
              validationIssue({
                code: 'correction-audit-version-conflict',
                scope: 'plan',
                message: 'A ocorrência sanitizada da correção não pôde ser versionada.',
              }),
            );
          }
          const expectedAuditVersion = (options.auditAppend.expectedVersion ?? 0) + 1;
          if (
            auditResult.record.version !== expectedAuditVersion ||
            !sameStructure(auditResult.record.value, options.auditAppend.record)
          ) {
            throw new InvalidExecutionSignalV1(
              validationIssue({
                code: 'correction-audit-write-result-mismatch',
                scope: 'plan',
                message: 'A ocorrência sanitizada retornou uma versão incompatível.',
              }),
            );
          }
        }

        return {
          counts: actualWrites,
          versions: appliedVersions(applied),
        };
      },
    );

    return {
      ...baseResult(plan),
      status: 'applied',
      transactionStarted: true,
      transactionCommitted: true,
      plannedWrites,
      committedWrites: committed.counts,
      appliedVersions: committed.versions,
    };
  } catch (error: unknown) {
    const attemptedWritesBeforeRollback = attemptedWriteCounts(applied);

    if (error instanceof VersionConflictSignalV1) {
      return {
        ...baseResult(plan),
        status: 'version-conflict',
        transactionStarted: true,
        transactionCommitted: false,
        attemptedWritesBeforeRollback,
        committedWrites: zeroWriteCounts(includeAcademicEntities),
        appliedVersions: emptyAppliedVersions(includeAcademicEntities),
        conflict: error.conflict,
      };
    }

    if (error instanceof InvalidExecutionSignalV1) {
      return {
        ...baseResult(plan),
        status: 'rejected-invalid-plan',
        transactionStarted: true,
        transactionCommitted: false,
        attemptedWritesBeforeRollback,
        committedWrites: zeroWriteCounts(includeAcademicEntities),
        appliedVersions: emptyAppliedVersions(includeAcademicEntities),
        validationIssues: [error.issue],
      };
    }

    return {
      ...baseResult(plan),
      status: 'transaction-failed',
      transactionStarted: true,
      transactionCommitted: false,
      attemptedWritesBeforeRollback,
      committedWrites: zeroWriteCounts(includeAcademicEntities),
      appliedVersions: emptyAppliedVersions(includeAcademicEntities),
      failure: {
        code: 'transaction-failed',
        message: 'A promoção transacional falhou sem confirmar alterações.',
      },
    };
  }
}

export type ImportBootstrapChangePlanExecutionResultV2 =
  | {
      readonly status: 'applied';
      readonly logicalSourceVersions: 0 | 1;
      readonly importBatchVersions: 1;
      readonly plannedWrites: ImportChangeExecutionWriteCountsV1;
      readonly committedWrites: ImportChangeExecutionWriteCountsV1;
    }
  | {
      readonly status: 'version-conflict' | 'transaction-failed';
    }
  | {
      readonly status: 'rejected-invalid-plan';
      readonly validationIssues: readonly ImportChangePlanValidationIssueV1[];
    };

/**
 * V2 bootstrap orchestration over the same validation, append and CAS functions used above.
 * Only the transaction boundary and fixed phase ordering differ from the historical promotion.
 */
export async function executeImportBootstrapChangePlanV2(
  plan: AssessmentImportChangePlanV2,
  request: ImportBootstrapTransactionRequestV2,
  transactionPort: ImportBootstrapTransactionPortV2,
): Promise<ImportBootstrapChangePlanExecutionResultV2> {
  let validation: PlanValidationResultV1;
  let componentIssues: readonly ImportChangePlanValidationIssueV1[];
  try {
    validation = validateImportChangePlan(plan);
    componentIssues = validateAssessmentComponentPlanV2(plan, plan.assessmentComponentPlanV2);
  } catch {
    return {
      status: 'rejected-invalid-plan',
      validationIssues: [
        validationIssue({
          code: 'invalid-plan-shape',
          scope: 'plan',
          message: 'A estrutura do plano não pôde ser validada.',
        }),
      ],
    };
  }
  const validationIssues = [...validation.issues, ...componentIssues];
  if (validationIssues.length > 0) return { status: 'rejected-invalid-plan', validationIssues };

  const readyFileIds = new Set(validation.readyFiles.map((file) => file.importFileId));
  const componentItems = plan.assessmentComponentPlanV2.items.filter(
    (item) =>
      readyFileIds.has(item.importFileId) && (item.state === 'new' || item.state === 'changed'),
  );
  const plannedWrites: ImportChangeExecutionWriteCountsV1 = {
    ...validation.plannedWrites,
    academicEntityVersions: componentItems.length,
    totalVersionWrites: validation.plannedWrites.totalVersionWrites + componentItems.length,
  };
  const context = { academicYearId: plan.academicYearId } satisfies AcademicPersistenceContextV1;
  const applied: MutableAppliedVersionsV1 = {
    academicEntities: [],
    sourceFiles: [],
    academicRecords: [],
    logicalSourceRecordAssociations: [],
  };
  let logicalSourceVersions: 0 | 1 = 0;

  try {
    await transactionPort.runImportBootstrap(context, request, async (unitOfWork) => {
      if (request.logicalSource.kind === 'create') {
        const sourceResult = await unitOfWork.logicalSources.createInitial(
          context,
          request.logicalSource.value,
        );
        if (sourceResult.status === 'resolution-conflict')
          throw new VersionConflictSignalV1({
            scope: 'source-file',
            importFileId: plan.files[0]?.importFileId ?? request.batchWrite.value.files[0]!.id,
            expectedVersion: null,
            currentVersion: null,
          });
        logicalSourceVersions = sourceResult.status === 'created' ? 1 : 0;
      }
      for (const file of validation.readyFiles) {
        await applySourceFileWrite({ context, file, unitOfWork, applied });
      }
      const batchResult = await unitOfWork.imports.appendImportBatchVersion(
        context,
        request.batchWrite.value,
        { expectedVersion: request.batchWrite.expectedVersion },
      );
      if (batchResult.status === 'version-conflict')
        throw new VersionConflictSignalV1({
          scope: 'source-file',
          importFileId: request.batchWrite.value.files[0]!.id,
          expectedVersion: null,
          currentVersion: batchResult.currentVersion,
        });
      if (
        batchResult.record.version !== 1 ||
        !sameStructure(batchResult.record.value, request.batchWrite.value)
      ) {
        throw new InvalidExecutionSignalV1(
          validationIssue({
            code: 'batch-write-result-mismatch',
            scope: 'plan',
            message: 'O lote inicial retornou uma versão incompatível.',
          }),
        );
      }
      await applyAssessmentComponentItemsV2({
        context,
        items: componentItems,
        unitOfWork,
        applied,
      });
      for (const file of validation.readyFiles) {
        await applyReadyFileAcademicWrites({ context, file, unitOfWork, applied });
      }
      const actual = attemptedWriteCounts(applied);
      if (!sameStructure(actual, plannedWrites))
        throw new InvalidExecutionSignalV1(
          validationIssue({
            code: 'applied-write-count-mismatch',
            scope: 'plan',
            message: 'As contagens aplicadas divergem da estimativa validada do plano.',
          }),
        );
    });
    return {
      status: 'applied',
      logicalSourceVersions,
      importBatchVersions: 1,
      plannedWrites,
      committedWrites: attemptedWriteCounts(applied),
    };
  } catch (error) {
    if (error instanceof VersionConflictSignalV1) return { status: 'version-conflict' };
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'batch-version-conflict'
    ) {
      return { status: 'version-conflict' };
    }
    if (error instanceof InvalidExecutionSignalV1) {
      return { status: 'rejected-invalid-plan', validationIssues: [error.issue] };
    }
    return { status: 'transaction-failed' };
  }
}
