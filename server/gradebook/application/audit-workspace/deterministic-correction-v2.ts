import type { AcademicYearId } from '../../../../shared/gradebook-contracts/entities';
import type {
  AuditOccurrenceId,
  AuditOccurrenceV1,
  ReconciliationResultId,
  ReconciliationResultV1,
} from '../../../../shared/gradebook-contracts/audit/audit-contract-v1';
import {
  isDeterministicCorrectionProofV2,
  resolvePilotFlowStateV2,
  type AcademicImpactAssessmentV2,
  type AutomaticCorrectionEligibilityV2,
  type AutomaticCorrectionNotEligibleReasonV2,
  type DeterministicCorrectionProofV2,
  type ReconciliationCaseV2,
  type ReconciliationInvestigationV2,
  type ReconciliationResultV2,
} from '../../../../shared/gradebook-contracts/audit/reconciliation-contract-v2';
import type {
  AcademicPersistenceContextV1,
  AuditPersistenceRepositoryV1,
  BatchPromotionTransactionPortV1,
} from '../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';
import {
  planImportReconciliation,
  type ImportReconciliationInputV1,
  type ImportReconciliationRepositoriesV1,
} from '../import/import-reconciliation-v1';
import {
  executeImportChangePlan,
  type ImportChangeExecutionResultV1,
} from '../import/execution/execute-import-change-plan-v1';

export type DeterministicCorrectionCaseReferenceV2 = string & {
  readonly __deterministicCorrectionCaseReferenceV2: true;
};

export interface DeterministicCorrectionRecipeV2 {
  readonly reconciliationInput: ImportReconciliationInputV1;
  readonly importFileId: ImportReconciliationInputV1['files'][number]['importFileId'];
  readonly targetStableKey: string;
  readonly deterministicOutputReference: string;
  readonly verifiedInputVersionReferences: readonly string[];
  readonly postCorrectionReconciliation: ReconciliationResultV2;
}

export interface DeterministicCorrectionCaseRecordV2 {
  readonly reference: DeterministicCorrectionCaseReferenceV2;
  readonly academicYearId: AcademicYearId;
  readonly reconciliationId: ReconciliationResultId;
  readonly case: ReconciliationCaseV2;
  /** Server-only recipe. It is never part of the HTTP projection. */
  readonly recipe: DeterministicCorrectionRecipeV2 | null;
  readonly version: number;
  readonly recordedAt: string;
}

export type DeterministicCorrectionCaseWriteResultV2 =
  | { readonly status: 'written'; readonly record: DeterministicCorrectionCaseRecordV2 }
  | { readonly status: 'version-conflict'; readonly currentVersion: number | null };

export type DeterministicCorrectionClaimResultV2 =
  | { readonly status: 'claimed'; readonly record: DeterministicCorrectionCaseRecordV2 }
  | { readonly status: 'version-conflict'; readonly currentVersion: number | null }
  | { readonly status: 'already-claimed'; readonly currentVersion: number };

export interface DeterministicCorrectionCaseStoreV2 {
  getByReference(
    context: AcademicPersistenceContextV1,
    reference: DeterministicCorrectionCaseReferenceV2,
  ): Promise<DeterministicCorrectionCaseRecordV2 | null>;
  getByReconciliation(
    context: AcademicPersistenceContextV1,
    reconciliationId: ReconciliationResultId,
  ): Promise<DeterministicCorrectionCaseRecordV2 | null>;
  listVersions(
    context: AcademicPersistenceContextV1,
    reference: DeterministicCorrectionCaseReferenceV2,
  ): Promise<readonly DeterministicCorrectionCaseRecordV2[]>;
  append(
    input: Omit<DeterministicCorrectionCaseRecordV2, 'version' | 'recordedAt'>,
    expectedVersion: number | null,
  ): Promise<DeterministicCorrectionCaseWriteResultV2>;
  claim(
    context: AcademicPersistenceContextV1,
    reference: DeterministicCorrectionCaseReferenceV2,
    expectedVersion: number,
  ): Promise<DeterministicCorrectionClaimResultV2>;
  release(
    context: AcademicPersistenceContextV1,
    reference: DeterministicCorrectionCaseReferenceV2,
  ): Promise<void>;
}

function storeKey(
  context: AcademicPersistenceContextV1,
  reference: DeterministicCorrectionCaseReferenceV2,
): string {
  return `${context.academicYearId}:${reference}`;
}

export function createLocalDeterministicCorrectionCaseStoreV2(
  now: () => string = () => new Date().toISOString(),
): DeterministicCorrectionCaseStoreV2 {
  const histories = new Map<string, DeterministicCorrectionCaseRecordV2[]>();
  const reconciliationIndex = new Map<string, DeterministicCorrectionCaseReferenceV2>();
  const claims = new Set<string>();

  function current(key: string): DeterministicCorrectionCaseRecordV2 | null {
    return histories.get(key)?.at(-1) ?? null;
  }

  return {
    async getByReference(context, reference) {
      return current(storeKey(context, reference));
    },

    async getByReconciliation(context, reconciliationId) {
      const reference = reconciliationIndex.get(`${context.academicYearId}:${reconciliationId}`);
      return reference ? current(storeKey(context, reference)) : null;
    },

    async listVersions(context, reference) {
      return [...(histories.get(storeKey(context, reference)) ?? [])];
    },

    async append(input, expectedVersion) {
      const context = { academicYearId: input.academicYearId };
      const key = storeKey(context, input.reference);
      const existing = current(key);
      if ((existing?.version ?? null) !== expectedVersion) {
        return { status: 'version-conflict', currentVersion: existing?.version ?? null };
      }
      if (
        existing !== null &&
        (existing.reconciliationId !== input.reconciliationId ||
          existing.academicYearId !== input.academicYearId)
      ) {
        return { status: 'version-conflict', currentVersion: existing.version };
      }
      const record: DeterministicCorrectionCaseRecordV2 = {
        ...input,
        version: (expectedVersion ?? 0) + 1,
        recordedAt: now(),
      };
      histories.set(key, [...(histories.get(key) ?? []), record]);
      reconciliationIndex.set(`${input.academicYearId}:${input.reconciliationId}`, input.reference);
      claims.delete(key);
      return { status: 'written', record };
    },

    async claim(context, reference, expectedVersion) {
      const key = storeKey(context, reference);
      const existing = current(key);
      if (existing?.version !== expectedVersion) {
        return { status: 'version-conflict', currentVersion: existing?.version ?? null };
      }
      if (claims.has(key)) {
        return { status: 'already-claimed', currentVersion: existing.version };
      }
      claims.add(key);
      return { status: 'claimed', record: existing };
    },

    async release(context, reference) {
      claims.delete(storeKey(context, reference));
    },
  };
}

function toReconciliationV2(value: ReconciliationResultV1): ReconciliationResultV2 {
  const base = {
    id: value.id,
    target: value.target,
    value: value.value,
    ruleVersion: value.ruleVersion,
  };
  if (value.status === 'not-comparable') {
    return {
      ...base,
      status: value.status,
      difference: null,
      explanation: value.explanation,
    };
  }
  return {
    ...base,
    status: value.status,
    difference: value.difference,
    ...(value.explanation === undefined ? {} : { explanation: value.explanation }),
  };
}

function initialCaseReference(
  reconciliationId: ReconciliationResultId,
): DeterministicCorrectionCaseReferenceV2 {
  return `deterministic-correction:${reconciliationId}` as DeterministicCorrectionCaseReferenceV2;
}

/** Creates the safe default for a historical reconciliation when no investigation exists yet. */
export function createFailClosedReconciliationCaseV2(
  reconciliation: ReconciliationResultV1,
): ReconciliationCaseV2 {
  const divergence = toReconciliationV2(reconciliation);
  if (divergence.status === 'match' || divergence.status === 'expected-difference') {
    const investigation = { state: 'not-required' } as const;
    const academicImpact = {
      state: 'none',
      basis: 'official-domain-rule',
      ruleVersion: divergence.ruleVersion,
    } as const;
    return {
      contractVersion: 2,
      divergence,
      academicImpact,
      investigation,
      automaticCorrection: {
        state: 'not-eligible',
        reason: 'correction-not-required',
        explanation: 'A reconciliação oficial não exige correção automática.',
      },
      correctionOutcome: { state: 'not-run', reason: 'not-required' },
      institutionalRelease: { state: 'eligible' },
      pilotFlow: resolvePilotFlowStateV2({ divergence, academicImpact, investigation }),
    };
  }

  const investigation = {
    state: 'required',
    reason: 'A causa da divergência ainda não foi comprovada por evidência oficial suficiente.',
  } as const;
  const academicImpact = {
    state: 'potentially-material',
    basis: 'fail-closed-unresolved',
    reason: 'A materialidade acadêmica não pode ser reduzida com segurança.',
  } as const;
  return {
    contractVersion: 2,
    divergence,
    academicImpact,
    investigation,
    automaticCorrection: {
      state: 'not-eligible',
      reason: 'root-cause-not-identified',
      explanation: 'A investigação permanece bloqueada até identificar causa única e evidência.',
    },
    correctionOutcome: { state: 'not-run', reason: 'blocked' },
    institutionalRelease: { state: 'blocked', reason: 'investigation-required' },
    pilotFlow: resolvePilotFlowStateV2({ divergence, academicImpact, investigation }),
  };
}

export type DeterministicInvestigationFindingV2 =
  | {
      readonly state: 'eligible';
      readonly proof: DeterministicCorrectionProofV2;
      readonly investigationReference: string;
    }
  | {
      readonly state: 'not-eligible';
      readonly reason: AutomaticCorrectionNotEligibleReasonV2;
      readonly explanation: string;
      readonly investigationReference: string;
    };

/** Maps a proved technical finding onto the frozen V2 states without numeric heuristics. */
export function createInvestigatedReconciliationCaseV2(input: {
  readonly divergence: ReconciliationResultV2;
  readonly academicImpact: AcademicImpactAssessmentV2;
  readonly finding: DeterministicInvestigationFindingV2;
}): ReconciliationCaseV2 {
  const investigation: ReconciliationInvestigationV2 = {
    state: 'in-progress',
    investigationReference: input.finding.investigationReference,
  };
  let automaticCorrection: AutomaticCorrectionEligibilityV2;
  if (input.finding.state === 'eligible') {
    automaticCorrection = isDeterministicCorrectionProofV2(input.finding.proof)
      ? { state: 'eligible', proof: input.finding.proof }
      : {
          state: 'not-eligible',
          reason: 'official-evidence-insufficient',
          explanation: 'A prova recebida não satisfaz o contrato determinístico V2.',
        };
  } else {
    automaticCorrection = {
      state: 'not-eligible',
      reason: input.finding.reason,
      explanation: input.finding.explanation,
    };
  }
  return {
    contractVersion: 2,
    divergence: input.divergence,
    academicImpact: input.academicImpact,
    investigation,
    automaticCorrection,
    correctionOutcome: {
      state: 'not-run',
      reason: automaticCorrection.state === 'eligible' ? 'blocked' : 'not-eligible',
    },
    institutionalRelease: {
      state: 'blocked',
      reason:
        automaticCorrection.state === 'eligible'
          ? 'deterministic-correction-pending'
          : 'investigation-required',
    },
    pilotFlow: resolvePilotFlowStateV2({
      divergence: input.divergence,
      academicImpact: input.academicImpact,
      investigation,
    }),
  };
}

export type DeterministicCorrectionInspectionResultV2 =
  | { readonly outcome: 'case'; readonly record: DeterministicCorrectionCaseRecordV2 }
  | { readonly outcome: 'not-found' | 'not-authorized' | 'unavailable' };

export type DeterministicCorrectionExecutionResultV2 =
  | { readonly outcome: 'applied'; readonly record: DeterministicCorrectionCaseRecordV2 }
  | { readonly outcome: 'already-completed'; readonly record: DeterministicCorrectionCaseRecordV2 }
  | {
      readonly outcome: 'not-eligible' | 'blocked';
      readonly record: DeterministicCorrectionCaseRecordV2;
    }
  | { readonly outcome: 'version-conflict'; readonly currentVersion: number | null }
  | { readonly outcome: 'not-found' | 'not-authorized' | 'unavailable' };

export interface DeterministicCorrectionServerContextV2 {
  isAuthorized(): boolean;
  correctionIdentity(): { readonly actorId: string; readonly occurredAt: string };
}

export interface DeterministicCorrectionWorkspaceDependenciesV2 {
  readonly store: DeterministicCorrectionCaseStoreV2;
  readonly audit: Pick<AuditPersistenceRepositoryV1, 'getCurrent'>;
  readonly planningRepositories: ImportReconciliationRepositoriesV1;
  readonly transaction: BatchPromotionTransactionPortV1;
  readonly server: DeterministicCorrectionServerContextV2;
}

export interface DeterministicCorrectionWorkspaceV2 {
  inspect(input: {
    readonly academicYearId: AcademicYearId;
    readonly reconciliationId: ReconciliationResultId;
  }): Promise<DeterministicCorrectionInspectionResultV2>;
  register(input: {
    readonly academicYearId: AcademicYearId;
    readonly reconciliationId: ReconciliationResultId;
    readonly case: ReconciliationCaseV2;
    readonly recipe: DeterministicCorrectionRecipeV2 | null;
    readonly expectedVersion: number | null;
  }): Promise<DeterministicCorrectionCaseWriteResultV2>;
  execute(input: {
    readonly academicYearId: AcademicYearId;
    readonly reference: DeterministicCorrectionCaseReferenceV2;
    readonly expectedVersion: number;
  }): Promise<DeterministicCorrectionExecutionResultV2>;
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A case already corrected, or one never eligible, is answered without claiming it. */
function settledOutcomeV2(
  current: DeterministicCorrectionCaseRecordV2,
): DeterministicCorrectionExecutionResultV2 | null {
  if (current.case.correctionOutcome.state === 'completed') {
    return { outcome: 'already-completed', record: current };
  }
  if (current.case.automaticCorrection.state !== 'eligible') {
    return { outcome: 'not-eligible', record: current };
  }
  return null;
}

/** A plan that lost a version race reports the case's version; any other failure is unavailable. */
function failedExecutionOutcomeV2(status: string, version: number): DeterministicCorrectionExecutionResultV2 {
  return status === 'version-conflict'
    ? { outcome: 'version-conflict', currentVersion: version }
    : { outcome: 'unavailable' };
}

const completeIdentityV2 = (identity: { readonly actorId: string; readonly occurredAt: string }) =>
  nonEmpty(identity.actorId) && nonEmpty(identity.occurredAt);

function recipeMatchesProof(
  record: DeterministicCorrectionCaseRecordV2,
): record is DeterministicCorrectionCaseRecordV2 & {
  readonly recipe: DeterministicCorrectionRecipeV2;
  readonly case: ReconciliationCaseV2 & {
    readonly automaticCorrection: Extract<AutomaticCorrectionEligibilityV2, { state: 'eligible' }>;
  };
} {
  const automaticCorrection = record.case.automaticCorrection;
  const recipe = record.recipe;
  if (
    automaticCorrection.state !== 'eligible' ||
    recipe === null ||
    !isDeterministicCorrectionProofV2(automaticCorrection.proof)
  ) {
    return false;
  }
  const proof = automaticCorrection.proof;
  if (
    proof.operation.deterministicOutputReference !== recipe.deterministicOutputReference ||
    recipe.postCorrectionReconciliation.target.kind !== proof.operation.target.kind ||
    recipe.postCorrectionReconciliation.target.id !== proof.operation.target.id ||
    recipe.reconciliationInput.context.academicYearId !== record.academicYearId ||
    recipe.reconciliationInput.files.length !== 1 ||
    recipe.reconciliationInput.files[0]?.importFileId !== recipe.importFileId
  ) {
    return false;
  }
  if (proof.precondition.kind === 'immutable-input-set') {
    return sameStrings(
      proof.precondition.inputVersionReferences,
      recipe.verifiedInputVersionReferences,
    );
  }
  return true;
}

function targetItem(input: {
  readonly record: DeterministicCorrectionCaseRecordV2 & {
    readonly recipe: DeterministicCorrectionRecipeV2;
    readonly case: ReconciliationCaseV2 & {
      readonly automaticCorrection: Extract<
        AutomaticCorrectionEligibilityV2,
        { state: 'eligible' }
      >;
    };
  };
  readonly plan: Awaited<ReturnType<typeof planImportReconciliation>>;
}) {
  const file = input.plan.files[0];
  const writable = input.plan.items.filter((item) => item.state === 'changed');
  const unchanged = input.plan.items.filter((item) => item.state === 'unchanged');
  if (
    input.plan.files.length !== 1 ||
    !file ||
    file.importFileId !== input.record.recipe.importFileId ||
    file.contentIdentity.state !== 'known-identical' ||
    input.plan.counts.new !== 0 ||
    input.plan.counts['missing-from-new-source'] !== 0 ||
    input.plan.counts.blocked !== 0 ||
    writable.length + unchanged.length !== 1
  ) {
    return null;
  }
  const item = writable[0] ?? unchanged[0];
  if (
    !item ||
    item.importFileId !== input.record.recipe.importFileId ||
    item.stableKey !== input.record.recipe.targetStableKey
  ) {
    return null;
  }
  const proof = input.record.case.automaticCorrection.proof;
  const target = proof.operation.target;
  if (
    item.stream.kind !== target.kind ||
    item.incomingRecord.value.id !== target.id ||
    (item.state === 'changed' && item.currentRecord.value.value.id !== target.id)
  ) {
    return null;
  }
  if (
    proof.precondition.kind === 'cas' &&
    (item.state !== 'changed' || item.expectedVersion !== proof.precondition.expectedVersion)
  ) {
    return null;
  }
  return item;
}

function auditOccurrence(input: {
  readonly record: DeterministicCorrectionCaseRecordV2 & {
    readonly case: ReconciliationCaseV2 & {
      readonly automaticCorrection: Extract<
        AutomaticCorrectionEligibilityV2,
        { state: 'eligible' }
      >;
    };
  };
  readonly actorId: string;
  readonly occurredAt: string;
}): AuditOccurrenceV1 {
  const operation = input.record.case.automaticCorrection.proof.operation;
  const id =
    `audit-occurrence:automatic-data-repair:${input.record.reference}` as AuditOccurrenceId;
  return {
    id,
    severity: 'information',
    category: 'automatic-data-repair',
    entity: operation.target,
    message: `Correção determinística interna concluída por ${operation.kind}.`,
    recommendedAction: 'Revisar a nova versão e a reconciliação oficial pós-reprocessamento.',
    createdAt: input.occurredAt,
    state: 'resolved',
    stateHistory: [
      {
        previousState: 'open',
        nextState: 'resolved',
        actorId: input.actorId,
        occurredAt: input.occurredAt,
        justification: 'Correção elegível executada pelo planejador e executor oficiais.',
      },
    ],
  };
}

function completedCase(input: {
  readonly current: ReconciliationCaseV2;
  readonly postCorrection: ReconciliationResultV2;
  readonly previousVersionReference: string;
  readonly newVersionReference: string;
  readonly resolutionReference: string;
}): ReconciliationCaseV2 {
  const investigation = {
    state: 'reconciled',
    resolutionReference: input.resolutionReference,
  } as const;
  const academicImpact =
    input.postCorrection.status === 'match' || input.postCorrection.status === 'expected-difference'
      ? ({
          state: 'none',
          basis: 'official-domain-rule',
          ruleVersion: input.postCorrection.ruleVersion,
        } as const)
      : input.current.academicImpact;
  return {
    ...input.current,
    divergence: input.postCorrection,
    academicImpact,
    investigation,
    correctionOutcome: {
      state: 'completed',
      previousVersionReference: input.previousVersionReference,
      newVersionReference: input.newVersionReference,
      evidencePreserved: true,
    },
    institutionalRelease:
      input.postCorrection.status === 'match' ||
      input.postCorrection.status === 'expected-difference'
        ? { state: 'eligible' }
        : { state: 'blocked', reason: 'potential-academic-impact' },
    pilotFlow: resolvePilotFlowStateV2({
      divergence: input.postCorrection,
      academicImpact,
      investigation,
    }),
  };
}

function executionFailed(result: ImportChangeExecutionResultV1): boolean {
  return result.status !== 'applied';
}

export function createDeterministicCorrectionWorkspaceV2(
  dependencies: DeterministicCorrectionWorkspaceDependenciesV2,
): DeterministicCorrectionWorkspaceV2 {
  return {
    async inspect(input) {
      if (!dependencies.server.isAuthorized()) return { outcome: 'not-authorized' };
      const context = { academicYearId: input.academicYearId };
      try {
        const existing = await dependencies.store.getByReconciliation(
          context,
          input.reconciliationId,
        );
        if (existing) return { outcome: 'case', record: existing };
        const reconciliation = await dependencies.audit.getCurrent(context, {
          kind: 'reconciliation',
          id: input.reconciliationId,
        });
        if (reconciliation === null || reconciliation.value.kind !== 'reconciliation') {
          return { outcome: 'not-found' };
        }
        const written = await dependencies.store.append(
          {
            reference: initialCaseReference(input.reconciliationId),
            academicYearId: input.academicYearId,
            reconciliationId: input.reconciliationId,
            case: createFailClosedReconciliationCaseV2(reconciliation.value.value),
            recipe: null,
          },
          null,
        );
        return written.status === 'written'
          ? { outcome: 'case', record: written.record }
          : { outcome: 'unavailable' };
      } catch {
        return { outcome: 'unavailable' };
      }
    },

    async register(input) {
      const reference = initialCaseReference(input.reconciliationId);
      if (
        !dependencies.server.isAuthorized() ||
        input.case.contractVersion !== 2 ||
        input.case.divergence.id !== input.reconciliationId ||
        (input.case.automaticCorrection.state === 'eligible' && input.recipe === null) ||
        (input.recipe !== null && !nonEmpty(input.recipe.deterministicOutputReference))
      ) {
        const current = await dependencies.store.getByReference(
          { academicYearId: input.academicYearId },
          reference,
        );
        return { status: 'version-conflict', currentVersion: current?.version ?? null };
      }
      return dependencies.store.append(
        {
          reference,
          academicYearId: input.academicYearId,
          reconciliationId: input.reconciliationId,
          case: input.case,
          recipe: input.recipe,
        },
        input.expectedVersion,
      );
    },

    async execute(input) {
      if (!dependencies.server.isAuthorized()) return { outcome: 'not-authorized' };
      const context = { academicYearId: input.academicYearId };
      const current = await dependencies.store.getByReference(context, input.reference);
      if (!current) return { outcome: 'not-found' };
      const settled = settledOutcomeV2(current);
      if (settled) return settled;
      if (!recipeMatchesProof(current)) return { outcome: 'blocked', record: current };

      const claim = await dependencies.store.claim(context, input.reference, input.expectedVersion);
      if (claim.status !== 'claimed') {
        return {
          outcome: 'version-conflict',
          currentVersion: claim.currentVersion,
        };
      }

      try {
        const plan = await planImportReconciliation(
          current.recipe.reconciliationInput,
          dependencies.planningRepositories,
          {
            deterministicReprocess: {
              importFileId: current.recipe.importFileId,
              targetStableKey: current.recipe.targetStableKey,
              operationReference: current.recipe.deterministicOutputReference,
            },
          },
        );
        const item = targetItem({ record: current, plan });
        if (!item) {
          await dependencies.store.release(context, input.reference);
          return { outcome: 'blocked', record: current };
        }
        if (item.state === 'unchanged') {
          const reconciled = completedCase({
            current: current.case,
            postCorrection: current.recipe.postCorrectionReconciliation,
            previousVersionReference: `academic-record:${item.stableKey}:version:${item.currentVersion ?? 1}`,
            newVersionReference: `academic-record:${item.stableKey}:version:${item.currentVersion ?? 1}`,
            resolutionReference: 'deterministic-reprocess-idempotent-no-op',
          });
          const written = await dependencies.store.append(
            { ...current, case: reconciled, recipe: current.recipe },
            current.version,
          );
          return written.status === 'written'
            ? { outcome: 'already-completed', record: written.record }
            : { outcome: 'version-conflict', currentVersion: written.currentVersion };
        }

        const identity = dependencies.server.correctionIdentity();
        if (!completeIdentityV2(identity)) {
          await dependencies.store.release(context, input.reference);
          return { outcome: 'unavailable' };
        }
        const occurrence = auditOccurrence({
          record: current,
          actorId: identity.actorId,
          occurredAt: identity.occurredAt,
        });
        const execution = await executeImportChangePlan(plan, dependencies.transaction, {
          auditAppend: {
            stream: { kind: 'occurrence', id: occurrence.id },
            record: { kind: 'occurrence', value: occurrence },
            expectedVersion: null,
          },
        });
        if (executionFailed(execution)) {
          await dependencies.store.release(context, input.reference);
          return failedExecutionOutcomeV2(execution.status, current.version);
        }
        const applied = execution.appliedVersions.academicRecords.find(
          (entry) => entry.stableKey === current.recipe.targetStableKey,
        );
        if (!applied) {
          await dependencies.store.release(context, input.reference);
          return { outcome: 'unavailable' };
        }
        const completed = completedCase({
          current: current.case,
          postCorrection: current.recipe.postCorrectionReconciliation,
          previousVersionReference: `academic-record:${item.stableKey}:version:${item.expectedVersion}`,
          newVersionReference: `academic-record:${item.stableKey}:version:${applied.version}`,
          resolutionReference: occurrence.id,
        });
        const written = await dependencies.store.append(
          { ...current, case: completed, recipe: current.recipe },
          current.version,
        );
        return written.status === 'written'
          ? { outcome: 'applied', record: written.record }
          : { outcome: 'version-conflict', currentVersion: written.currentVersion };
      } catch {
        await dependencies.store.release(context, input.reference);
        return { outcome: 'unavailable' };
      }
    },
  };
}
