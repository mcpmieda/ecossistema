import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
  GradebookRelationMovementConfirmationV9,
  GradebookRelationMovementReviewV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { GradebookImportDiagnosticsAuditRequestV1 } from '../../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import { isGradebookAcademicYearV2 } from '../../../../shared/gradebook-contracts/academic-year-v2';
import {
  countWorkbookOperationalClassesV1,
  importWorkbookBatch,
  validateBatchSize,
  type BatchFailureDetail,
  type BatchSuccess,
  type ImportWorkbookFileTimingV1,
} from './import-batch';
import { loadSheetJs, preloadSheetJs } from './sheetjs-loader';
import {
  createGradebookCanonicalImportRequestV9,
  unavailableCellsV9,
  type CanonicalImportWarningV9,
} from './canonical-import-v9';
import {
  blockingGradebookImportDiagnosticsV1,
  collectGradebookImportDiagnosticsV1,
  gradebookImportDiagnosticsAuditRequestV1,
  sourceUnavailableGradebookImportDiagnosticsV1,
  type GradebookImportDiagnosticV1,
} from './import-diagnostics-v1';
import { persistGradebookImportDiagnosticsAuditV1 } from './import-diagnostics-client-v1';
import { persistGradebookCanonicalImportV9 } from './import-persistence-client-v9';
import type { MasterRelationRecognitionV9 } from './master-relation-v9';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import {
  ImportTimingReportV1,
  type ImportTimingRunKindV1,
  type ImportTimingSummaryV1,
} from './import-timing-report-v1';

export type ImportPersistenceStateV9 =
  | { readonly state: 'recognized' | 'processing' | 'persisting' | 'auth-required' }
  | { readonly state: 'completed'; readonly response: GradebookImportPersistenceResponseV9 }
  | {
      readonly state: 'movement-review';
      readonly review: GradebookRelationMovementReviewV9 | null;
      readonly message: string;
      readonly cancelled: boolean;
    }
  | {
      readonly state: 'failed' | 'confirmation-required';
      readonly message: string;
      readonly kind?: 'validation' | 'runtime';
    };

export type ImportFlowProgressStageV9 =
  | 'preparing'
  | 'recognizing'
  | 'roster'
  | 'grades'
  | 'recovery'
  | 'compacting'
  | 'saving'
  | 'completed';

export interface ImportFlowProgressV9 {
  readonly current: number;
  readonly total: number;
  readonly fileName: string;
  readonly stage: ImportFlowProgressStageV9;
}

type ImportPersistenceRunResultV1 =
  'completed' | 'auth-required' | 'confirmation-required' | 'blocked' | 'review-required';
type LocalPreparationBaseV9 = {
  readonly result: BatchSuccess;
  readonly diagnostics: readonly GradebookImportDiagnosticV1[] | null;
  readonly auditRequest: GradebookImportDiagnosticsAuditRequestV1 | null;
  readonly startedAt: number;
  readonly readyAt: number;
  readonly localMs: number;
  readonly diagnosticLocalMs: number | null;
  readonly canonicalBuildMs: number | null;
  readonly unavailableCells: number;
  readonly maximumWarnings: readonly CanonicalImportWarningV9[];
};
type LocalPreparationV9 = LocalPreparationBaseV9 &
  (
    | { readonly kind: 'ready'; readonly request: GradebookImportPersistenceRequestV9 }
    | { readonly kind: 'blocked'; readonly blockingCount: number; readonly message: string }
    | { readonly kind: 'failed'; readonly message: string }
  );
type AuditedPreparationV9 = { readonly local: LocalPreparationV9; readonly auditMs: number };
type MovementReviewSessionV9 = {
  readonly prepared: AuditedPreparationV9;
  readonly review: GradebookRelationMovementReviewV9 | null;
};
type MovementReviewSubmissionV9 = {
  readonly resultId: string;
  readonly confirmation: GradebookRelationMovementConfirmationV9;
};
type RelationFollowUpV9 = {
  readonly result: BatchSuccess;
  readonly diagnostics: readonly GradebookImportDiagnosticV1[];
  readonly year: number;
};
type BatchObservationV1 = {
  readonly startedAt: number;
  readonly generation: number;
  readonly runOrdinal: number;
  readonly runKind: ImportTimingRunKindV1;
  sheetJsWaitMs: number | null;
  recognitionCallMs: number | null;
  recognitionFinishedAtMs: number | null;
  firstPersistenceStartedMs: number | null;
  firstConfirmedPersistenceMs: number | null;
  maximumPreparedItems: number;
  preparedRelations: number;
  preparedTeacherItems: number;
  maximumPreparedRelations: number;
  maximumPreparedTeacherItems: number;
  activeYearLanes: number;
  maximumActiveYearLanes: number;
  confirmedRequests: number;
  processedItems: number;
  stop: 'auth-required' | 'confirmation-required' | null;
  outcome: ImportPersistenceRunResultV1 | 'failed';
};

function batchObservation(
  generation: number,
  runOrdinal: number,
  runKind: ImportTimingRunKindV1,
): BatchObservationV1 {
  return {
    startedAt: nowMs(),
    generation,
    runOrdinal,
    runKind,
    sheetJsWaitMs: null,
    recognitionCallMs: null,
    recognitionFinishedAtMs: null,
    firstPersistenceStartedMs: null,
    firstConfirmedPersistenceMs: null,
    maximumPreparedItems: 0,
    preparedRelations: 0,
    preparedTeacherItems: 0,
    maximumPreparedRelations: 0,
    maximumPreparedTeacherItems: 0,
    activeYearLanes: 0,
    maximumActiveYearLanes: 0,
    confirmedRequests: 0,
    processedItems: 0,
    stop: null,
    outcome: 'failed',
  };
}

/** Purely local: collecting diagnostics and creating requests never dispatches fetch. */
function prepareLocalPersistenceV9(
  result: BatchSuccess,
  expectedTeacherYear?: number | null,
): LocalPreparationV9 {
  const started = nowMs();
  let diagnostics: readonly GradebookImportDiagnosticV1[] | null = null;
  let auditRequest: GradebookImportDiagnosticsAuditRequestV1 | null = null;
  let diagnosticLocalMs: number | null = null;
  let canonicalBuildMs: number | null = null;
  let unavailableCells = 0;
  const maximumWarnings: CanonicalImportWarningV9[] = [];
  const base = (): LocalPreparationBaseV9 => ({
    result,
    diagnostics,
    auditRequest,
    startedAt: started,
    readyAt: nowMs(),
    localMs: elapsedMs(started),
    diagnosticLocalMs,
    canonicalBuildMs,
    unavailableCells,
    maximumWarnings,
  });
  try {
    diagnostics = collectGradebookImportDiagnosticsV1(result);
    const blocking = blockingGradebookImportDiagnosticsV1(diagnostics);
    unavailableCells = sourceUnavailableGradebookImportDiagnosticsV1(diagnostics).length;
    auditRequest = gradebookImportDiagnosticsAuditRequestV1(result, diagnostics);
    diagnosticLocalMs = elapsedMs(started);
    if (blocking.length > 0)
      return {
        ...base(),
        kind: 'blocked',
        blockingCount: blocking.length,
        message: `${blocking.length} problema(s) precisam ser corrigidos antes de enviar esta planilha.`,
      };
    const canonicalStarted = nowMs();
    let request: GradebookImportPersistenceRequestV9;
    try {
      request = createGradebookCanonicalImportRequestV9(result, {
        onWarning: (warning) => maximumWarnings.push(warning),
      });
    } finally {
      canonicalBuildMs = elapsedMs(canonicalStarted);
    }
    if (
      expectedTeacherYear !== undefined &&
      (expectedTeacherYear === null ||
        request.operation !== 'persist-notas' ||
        request.ano !== expectedTeacherYear)
    ) {
      throw new Error('Ano letivo do pacote divergiu do ano reconhecido nesta planilha.');
    }
    unavailableCells = unavailableCellsV9(request);
    return { ...base(), kind: 'ready', request };
  } catch (cause) {
    return {
      ...base(),
      kind: 'failed',
      message: failureMessage(cause, 'Não foi possível preparar esta planilha.'),
    };
  }
}

type SummaryWithRelationV9 = BatchSuccess['summary'] & {
  readonly masterRelationV9?: MasterRelationRecognitionV9;
};

export const GRADEBOOK_IMPORT_FILE_CONCURRENCY_V1 = 4;

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function nowMs(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

// A property cannot be a type predicate target; callers read the summary as the relation one.
export function isMasterRelationResult(result: BatchSuccess): boolean /* NOSONAR */ {
  return Boolean((result.summary as SummaryWithRelationV9).masterRelationV9);
}

function blockTeacherFiles(
  setPersistence: React.Dispatch<React.SetStateAction<Record<string, ImportPersistenceStateV9>>>,
  results: readonly BatchSuccess[],
  message: string,
): void {
  setPersistence((current) => {
    const next = { ...current };
    for (const result of results) {
      if (!isMasterRelationResult(result)) {
        next[result.id] = { state: 'failed', message, kind: 'validation' };
      }
    }
    return next;
  });
}

export function isGradebookImportAuthorizationRequiredV1(
  response: GradebookImportPersistenceResponseV9,
): boolean {
  return response.state === 'not-authorized';
}

export function selectPendingGradebookImportResultsV1(
  successes: readonly BatchSuccess[],
  persistence: Readonly<Record<string, ImportPersistenceStateV9>>,
): readonly BatchSuccess[] {
  return successes.filter((result) => {
    const state = persistence[result.id];
    return (
      state?.state === 'recognized' ||
      state?.state === 'processing' ||
      state?.state === 'auth-required' ||
      state?.state === 'movement-review' ||
      state?.state === 'confirmation-required'
    );
  });
}

/** A Relação the server asks to review (or a conflict on an already reviewed one) goes back to review. */
function needsMovementReviewV1(
  request: Extract<LocalPreparationV9, { kind: 'ready' }>['request'],
  response: GradebookImportPersistenceResponseV9,
): response is Extract<
  GradebookImportPersistenceResponseV9,
  { state: 'blocked' | 'conflict' | 'review-required' }
> {
  return (
    request.operation === 'persist-relacao' &&
    ((response.state === 'review-required' && !!response.movementReview) ||
      (response.state === 'conflict' && !!request.movementReview))
  );
}

/** A refused file blocks the rest of the batch; anything else completed. */
function runResultOfV1(
  state: GradebookImportPersistenceResponseV9['state'],
): ImportPersistenceRunResultV1 {
  return state === 'review-required' ||
    state === 'blocked' ||
    state === 'conflict' ||
    state === 'invalid-request'
    ? 'blocked'
    : 'completed';
}

/** A Relação confirmed in the movement review is sent with that confirmation. */
function withMovementReviewV1(
  local: LocalPreparationV9,
  resultId: string,
  movementSubmission: MovementReviewSubmissionV9 | undefined,
): LocalPreparationV9 {
  if (
    movementSubmission?.resultId !== resultId ||
    local.kind !== 'ready' ||
    local.request.operation !== 'persist-relacao'
  )
    return local;
  return {
    ...local,
    request: { ...local.request, movementReview: movementSubmission.confirmation },
  };
}

/** Teacher files by academic year (each year is one lane), and those whose year is unknown. */
function teacherLanesV1(teacherResults: readonly BatchSuccess[], offset: number) {
  const lanes = new Map<
    number,
    Array<{ readonly result: BatchSuccess; readonly position: number }>
  >();
  const unknownYear: Array<{ readonly result: BatchSuccess; readonly position: number }> = [];
  for (const [position, result] of teacherResults.entries()) {
    // V9's producer uses precisely this validated recognition field for docente ano.
    // Each prepared canonical request is checked against its lane before any fetch.
    const year = result.summary.academicYear;
    const item = { result, position: offset + position };
    if (!isGradebookAcademicYearV2(year)) unknownYear.push(item);
    else {
      const lane = lanes.get(year) ?? [];
      lane.push(item);
      lanes.set(year, lane);
    }
  }
  return { lanes, unknownYear };
}

export function useImportBatch() {
  const academicContext = useGradebookYear();
  const inFlight = useRef(false);
  const generation = useRef(0);
  const batchTiming = useRef<BatchObservationV1 | null>(null);
  const runOrdinal = useRef(0);
  const sourcePositions = useRef(new Map<string, number>());
  const movementReviews = useRef(new Map<string, MovementReviewSessionV9>());
  const timingReport = useRef(new ImportTimingReportV1());
  const collectorFailures = useRef(0);
  const summaryFailed = useRef(false);
  const mounted = useRef(false);
  const timingStatus = useRef<ImportTimingSummaryV1['status']>(null);
  const [timingRevision, setTimingRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BatchSuccess[]>([]);
  const [failures, setFailures] = useState<BatchFailureDetail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportFlowProgressV9 | null>(null);
  const [persistence, setPersistence] = useState<Record<string, ImportPersistenceStateV9>>({});
  const [sourceValueWarnings, setSourceValueWarnings] = useState<Record<string, number>>({});
  const [sourceMaximumWarnings, setSourceMaximumWarnings] = useState<
    Record<string, readonly CanonicalImportWarningV9[]>
  >({});
  const [sourceDiagnostics, setSourceDiagnostics] = useState<
    Record<string, readonly GradebookImportDiagnosticV1[]>
  >({});
  const [diagnosticAuditFailures, setDiagnosticAuditFailures] = useState<Record<string, string>>(
    {},
  );
  const [auditAuthorizationRequired, setAuditAuthorizationRequired] = useState(false);
  const [pendingRelationFollowUps, setPendingRelationFollowUps] = useState<
    Record<string, RelationFollowUpV9>
  >({});

  useEffect(() => {
    mounted.current = true;
    preloadSheetJs();
    return () => {
      mounted.current = false;
      generation.current++;
      inFlight.current = false;
      batchTiming.current = null;
      timingReport.current.clear();
      sourcePositions.current.clear();
      movementReviews.current.clear();
    };
  }, []);

  function appendTiming(
    prefix: string,
    value: unknown,
    observation: BatchObservationV1,
    source?: BatchSuccess | number,
  ): void {
    if (!isCurrent(observation)) return;
    try {
      const sourceFileIndex =
        typeof source === 'number' ? source : source && sourcePositions.current.get(source.id);
      const event = timingReport.current.record(observation.runOrdinal, value, sourceFileIndex);
      if (event) console.info(prefix, JSON.stringify(event));
    } catch {
      timingReport.current.failure(observation.runOrdinal);
    }
    setTimingRevision((current) => current + 1);
  }

  function beginTiming(observation: BatchObservationV1, participants: readonly number[]): void {
    timingStatus.current = 'in-progress';
    try {
      if (observation.runKind === 'initial') timingReport.current.clear();
      timingReport.current.begin(observation.runOrdinal, observation.runKind, participants);
    } catch {
      collectorFailures.current++;
    }
    setTimingRevision((current) => current + 1);
  }

  function timingSummary(): ImportTimingSummaryV1 {
    try {
      const summary = timingReport.current.summary();
      return {
        ...summary,
        runOrdinal: runOrdinal.current || null,
        status: timingStatus.current,
        diagnosticFailures:
          summary.diagnosticFailures + collectorFailures.current + Number(summaryFailed.current),
      };
    } catch {
      summaryFailed.current = true;
      return {
        runOrdinal: runOrdinal.current || null,
        status: timingStatus.current,
        discardedEvents: 0,
        omittedResumes: 0,
        diagnosticFailures: collectorFailures.current + 1,
      };
    }
  }

  function getTimingReport(): string {
    try {
      const snapshot = timingReport.current.snapshot();
      return JSON.stringify(
        {
          ...snapshot,
          collectorFailures: collectorFailures.current + Number(summaryFailed.current),
          measurementStatus:
            collectorFailures.current ||
            summaryFailed.current ||
            snapshot.runs.some((run) => run.coverage.measurementStatus === 'partial')
              ? 'partial'
              : 'available',
        },
        null,
        2,
      );
    } catch {
      collectorFailures.current++;
      if (mounted.current) setTimingRevision((current) => current + 1);
      return JSON.stringify(
        {
          reportVersion: 1,
          measurementStatus: 'unavailable',
          collectorFailures: collectorFailures.current,
          runs: [],
        },
        null,
        2,
      );
    }
  }

  function finishBatchTiming(observation: BatchObservationV1): void {
    timingStatus.current = ['auth-required', 'confirmation-required', 'review-required'].includes(
      observation.outcome,
    )
      ? 'paused'
      : 'finished';
    appendTiming(
      '[gradebook-import-browser-timing]',
      {
        version: 2,
        stage: 'batch-complete',
        batchElapsedMs: elapsedMs(observation.startedAt),
        firstPersistenceStartedMs: observation.firstPersistenceStartedMs,
        firstConfirmedPersistenceMs: observation.firstConfirmedPersistenceMs,
        maximumPreparedItems: observation.maximumPreparedItems,
        maximumPreparedRelations: observation.maximumPreparedRelations,
        maximumPreparedTeacherItems: observation.maximumPreparedTeacherItems,
        maximumActiveYearLanes: observation.maximumActiveYearLanes,
        confirmedRequests: observation.confirmedRequests,
        processedItems: observation.processedItems,
        outcome: observation.outcome,
        sheetJsWaitMs: observation.sheetJsWaitMs,
        recognitionCallMs: observation.recognitionCallMs,
        recognitionFinishedAtMs: observation.recognitionFinishedAtMs,
        postRecognitionToFirstDispatchMs:
          observation.firstPersistenceStartedMs !== null &&
          observation.recognitionFinishedAtMs !== null
            ? Math.round(
                (observation.firstPersistenceStartedMs - observation.recognitionFinishedAtMs) * 10,
              ) / 10
            : null,
      },
      observation,
    );
    batchTiming.current = null;
  }

  const selectedResult = useMemo(
    () => results.find((result) => result.id === selectedId) ?? results[0] ?? null,
    [results, selectedId],
  );

  const totals = useMemo(
    () => ({
      classes: results.reduce((sum, result) => {
        const relation = (result.summary as SummaryWithRelationV9).masterRelationV9;
        return sum + (relation?.turmas.length ?? countWorkbookOperationalClassesV1(result.summary));
      }, 0),
      students: results.reduce((sum, result) => {
        const relation = (result.summary as SummaryWithRelationV9).masterRelationV9;
        return (
          sum +
          (relation
            ? relation.turmas.reduce((classSum, turma) => classSum + turma.alunos.length, 0)
            : result.summary.classes.reduce(
                (classSum, classroom) => classSum + classroom.students,
                0,
              ))
        );
      }, 0),
      gradeSheets: results.reduce((sum, result) => sum + result.summary.gradeSheets.length, 0),
    }),
    [results],
  );

  const authorizationRequired = useMemo(
    () =>
      auditAuthorizationRequired ||
      Object.values(persistence).some((value) => value.state === 'auth-required'),
    [persistence, auditAuthorizationRequired],
  );

  const pendingPersistenceCount = useMemo(
    () =>
      new Set([
        ...selectPendingGradebookImportResultsV1(results, persistence).map((value) => value.id),
        ...Object.keys(pendingRelationFollowUps),
      ]).size,
    [results, persistence, pendingRelationFollowUps],
  );

  function markAuthorizationRequired(result: BatchSuccess): void {
    setPersistence((current) => ({ ...current, [result.id]: { state: 'auth-required' } }));
    setProgress(null);
  }

  function isCurrent(observation: BatchObservationV1): boolean {
    return generation.current === observation.generation;
  }

  function stopDispatch(
    observation: BatchObservationV1,
    status: ImportPersistenceRunResultV1,
  ): void {
    // An uncertain write takes precedence when another active lane loses authorization.
    if (
      status === 'confirmation-required' ||
      (status === 'auth-required' && observation.stop === null)
    )
      observation.stop = status;
  }

  function retainPreparation(observation: BatchObservationV1, relation: boolean): void {
    if (relation) observation.preparedRelations++;
    else observation.preparedTeacherItems++;
    observation.maximumPreparedRelations = Math.max(
      observation.maximumPreparedRelations,
      observation.preparedRelations,
    );
    observation.maximumPreparedTeacherItems = Math.max(
      observation.maximumPreparedTeacherItems,
      observation.preparedTeacherItems,
    );
    observation.maximumPreparedItems = Math.max(
      observation.maximumPreparedItems,
      observation.preparedRelations + observation.preparedTeacherItems,
    );
  }

  // One counter per lane.
  function releaseRelationPreparation(observation: BatchObservationV1): void {
    observation.preparedRelations--;
  }
  function releaseTeacherPreparation(observation: BatchObservationV1): void {
    observation.preparedTeacherItems--;
  }

  function prepareLocal(
    result: BatchSuccess,
    observation: BatchObservationV1,
    expectedTeacherYear?: number | null,
  ): LocalPreparationV9 {
    if (isCurrent(observation))
      setPersistence((current) => ({ ...current, [result.id]: { state: 'processing' } }));
    const local = prepareLocalPersistenceV9(result, expectedTeacherYear);
    if (isCurrent(observation)) {
      appendTiming(
        '[gradebook-import-browser-timing]',
        {
          version: 2,
          stage: 'canonical-local',
          kind: local.kind,
          diagnosticLocalMs: local.diagnosticLocalMs,
          canonicalBuildMs: local.canonicalBuildMs,
          localPreparationMs: local.localMs,
        },
        observation,
        result,
      );
      if (local.diagnostics !== null)
        setSourceDiagnostics((current) => ({ ...current, [result.id]: local.diagnostics! }));
      setSourceValueWarnings((current) => ({ ...current, [result.id]: local.unavailableCells }));
      setSourceMaximumWarnings((current) => ({ ...current, [result.id]: local.maximumWarnings }));
    }
    return local;
  }

  async function auditDiagnostics(
    result: BatchSuccess,
    diagnostics: readonly GradebookImportDiagnosticV1[],
    observation: BatchObservationV1,
    request = gradebookImportDiagnosticsAuditRequestV1(result, diagnostics),
    preserveAcademicReceipt = false,
  ): Promise<{ readonly ms: number; readonly authorizationRequired: boolean }> {
    /** The audit's answer on screen: its failure note; a lost authorization stops the batch. */
    function showAuditResponse(state: typeof auditOutcome) {
      if (state !== 'recorded') {
        setDiagnosticAuditFailures((current) => ({
          ...current,
          [result.id]: 'A Auditoria não confirmou a atualização dos problemas desta planilha.',
        }));
      } else {
        setDiagnosticAuditFailures((current) => {
          const next = { ...current };
          delete next[result.id];
          return next;
        });
      }
      if (state === 'not-authorized') {
        setAuditAuthorizationRequired(true);
        if (!preserveAcademicReceipt) markAuthorizationRequired(result);
        else setProgress(null);
        stopDispatch(observation, 'auth-required');
      }
    }
    // Complete observations, including [], are exclusively owned by this endpoint.
    const auditStartedAt = nowMs();
    let auditOutcome: 'recorded' | 'unavailable' | 'failed' | 'not-authorized' | 'invalid-request' =
      'failed';
    if (!isCurrent(observation) || observation.stop !== null)
      return { ms: 0, authorizationRequired: false };
    try {
      const response = await persistGradebookImportDiagnosticsAuditV1(request);
      auditOutcome = response.state;
      if (isCurrent(observation)) showAuditResponse(response.state);
    } catch {
      if (isCurrent(observation))
        setDiagnosticAuditFailures((current) => ({
          ...current,
          [result.id]: 'A Auditoria não confirmou a atualização dos problemas desta planilha.',
        }));
    } finally {
      if (isCurrent(observation))
        appendTiming(
          '[gradebook-import-browser-timing]',
          {
            version: 2,
            stage: 'audit-request',
            phase: preserveAcademicReceipt ? 'relation-follow-up' : 'initial-observation',
            auditRequestMs: elapsedMs(auditStartedAt),
            outcome: auditOutcome,
          },
          observation,
          result,
        );
    }
    return {
      ms: elapsedMs(auditStartedAt),
      authorizationRequired: auditOutcome === 'not-authorized',
    };
  }

  async function completeRelationFollowUp(
    followUp: RelationFollowUpV9,
    observation: BatchObservationV1,
  ): Promise<void> {
    if (!isCurrent(observation) || observation.stop !== null) return;
    await auditDiagnostics(
      followUp.result,
      followUp.diagnostics,
      observation,
      gradebookImportDiagnosticsAuditRequestV1(followUp.result, followUp.diagnostics),
      true,
    );
    if (!isCurrent(observation) || observation.stop !== null) return;
    await academicContext?.refreshYears(followUp.year);
    if (!isCurrent(observation)) return;
    setPendingRelationFollowUps((current) => {
      const next = { ...current };
      delete next[followUp.result.id];
      return next;
    });
  }

  function recordLocalOutcome(
    local: LocalPreparationV9,
    auditMs: number,
    observation: BatchObservationV1,
  ): void {
    if (!isCurrent(observation)) return;
    const common = {
      version: 2,
      diagnosticLocalMs: local.diagnosticLocalMs,
      canonicalBuildMs: local.canonicalBuildMs,
      localPreparationMs: local.localMs,
      totalMs: Math.round((local.localMs + auditMs) * 10) / 10,
      preparationElapsedMs: elapsedMs(local.startedAt),
    };
    if (local.kind === 'ready') {
      appendTiming(
        '[gradebook-import-browser-timing]',
        {
          ...common,
          stage: 'canonical-file',
          operation: local.request.operation,
          unavailableCells: local.unavailableCells,
          aboveMaximumWarnings: local.maximumWarnings.length,
          diagnosticWarnings:
            local.diagnostics?.filter((value) => value.severity === 'warning').length ?? 0,
          offerCount:
            local.request.operation === 'persist-notas' ? local.request.ofertas.length : 0,
          classCount:
            local.request.operation === 'persist-relacao' ? local.request.turmas.length : 0,
        },
        observation,
        local.result,
      );
    } else {
      setSelectedId(local.result.id);
      setPersistence((current) => ({
        ...current,
        [local.result.id]: {
          state: 'failed',
          message: local.message,
          kind: local.kind === 'blocked' ? 'validation' : 'runtime',
        },
      }));
      appendTiming(
        '[gradebook-import-browser-timing]',
        {
          ...common,
          stage: local.kind === 'blocked' ? 'canonical-file-blocked' : 'canonical-file-failed',
          blockingDiagnostics: local.kind === 'blocked' ? local.blockingCount : null,
          unavailableCells: local.unavailableCells,
          totalDiagnostics: local.diagnostics?.length ?? null,
        },
        observation,
        local.result,
      );
    }
  }

  async function auditLocal(
    local: LocalPreparationV9,
    observation: BatchObservationV1,
  ): Promise<AuditedPreparationV9> {
    let auditMs = 0;
    // A prepared Relação has no remote side effects before the movement review.
    // Its complete diagnostic observation is already sent by the committed follow-up.
    const readyRelation = local.kind === 'ready' && local.request.operation === 'persist-relacao';
    if (!readyRelation && local.auditRequest !== null && local.diagnostics !== null) {
      const audited = await auditDiagnostics(
        local.result,
        local.diagnostics,
        observation,
        local.auditRequest,
      );
      auditMs = audited.ms;
    }
    if (isCurrent(observation) && observation.stop === null)
      recordLocalOutcome(local, auditMs, observation);
    return { local, auditMs };
  }

  async function persistPreparedSingle(
    prepared: AuditedPreparationV9,
    index: number,
    total: number,
    observation: BatchObservationV1,
  ): Promise<ImportPersistenceRunResultV1> {
    const { local, auditMs } = prepared;
    if (!isCurrent(observation)) return 'completed';
    if (observation.stop !== null) return observation.stop;
    if (local.kind !== 'ready') return 'blocked';
    const { result, request } = local;
    setPersistence((current) => ({ ...current, [result.id]: { state: 'persisting' } }));
    setProgress({
      current: observation.processedItems,
      total,
      fileName: result.manifest.fileName,
      stage: 'saving',
    });
    const startedAt = nowMs();
    appendTiming(
      '[gradebook-import-browser-timing]',
      {
        version: 2,
        stage: 'persistence-dispatch',
        queueWaitMs: Math.max(0, elapsedMs(local.readyAt) - auditMs),
        operation: request.operation,
      },
      observation,
      result,
    );
    function onRequestTiming(
      timing: Parameters<NonNullable<Parameters<typeof persistGradebookCanonicalImportV9>[1]>>[0],
    ) {
      if (isCurrent(observation))
        appendTiming(
          '[gradebook-import-client-timing]',
          {
            version: 2,
            stage: 'persist-request',
            ...timing,
          },
          observation,
          result,
        );
    }
    function onDispatch() {
      if (!isCurrent(observation)) return;
      observation.firstPersistenceStartedMs ??= elapsedMs(observation.startedAt);
      appendTiming(
        '[gradebook-import-browser-timing]',
        {
          version: 2,
          stage: 'academic-dispatch',
          operation: request.operation,
        },
        observation,
        result,
      );
    }
    /** A saved Relação's follow-up (its audit), kept pending until it completes. */
    async function followUpRelation(
      followUp: Parameters<typeof completeRelationFollowUp>[0],
    ): Promise<ImportPersistenceRunResultV1 | null> {
      setPendingRelationFollowUps((current) => ({ ...current, [followUp.result.id]: followUp }));
      await completeRelationFollowUp(followUp, observation);
      if (!isCurrent(observation)) return 'completed';
      return observation.stop;
    }
    let response: GradebookImportPersistenceResponseV9;
    try {
      const persisted = await persistGradebookCanonicalImportV9(
        request,
        onRequestTiming,
        onDispatch,
      );
      if (!isCurrent(observation)) return 'completed';
      response = persisted.response;
      if (response.state === 'applied' || response.state === 'no-changes') {
        observation.confirmedRequests++;
        observation.firstConfirmedPersistenceMs ??= elapsedMs(observation.startedAt);
      }
      appendTiming(
        '[gradebook-import-client-timing]',
        {
          version: 2,
          mode: 'canonical-v9',
          operation: request.operation,
          index,
          total,
          totalMs: elapsedMs(startedAt),
          serverMs: persisted.serverMs,
          state: response.state,
          attempts: 1,
        },
        observation,
        result,
      );
    } catch (cause) {
      if (!isCurrent(observation)) return 'completed';
      appendTiming(
        '[gradebook-import-client-timing]',
        {
          version: 2,
          stage: 'persistence-result',
          state: 'confirmation-required',
          attempts: 1,
        },
        observation,
        result,
      );
      setPersistence((current) => ({
        ...current,
        [result.id]: {
          state: 'confirmation-required',
          message: failureMessage(cause, 'Gravação sem confirmação.'),
          kind: 'runtime',
        },
      }));
      setProgress(null);
      stopDispatch(observation, 'confirmation-required');
      return 'confirmation-required';
    }
    if (isGradebookImportAuthorizationRequiredV1(response)) {
      markAuthorizationRequired(result);
      stopDispatch(observation, 'auth-required');
      return 'auth-required';
    }
    if (response.state === 'unavailable') {
      setPersistence((current) => ({
        ...current,
        [result.id]: {
          state: 'confirmation-required',
          message: 'Não foi possível confirmar a gravação desta planilha.',
          kind: 'runtime',
        },
      }));
      setProgress(null);
      stopDispatch(observation, 'confirmation-required');
      return 'confirmation-required';
    }
    if (needsMovementReviewV1(request, response)) {
      const review = response.movementReview ?? null;
      const original = movementReviews.current.get(result.id)?.prepared ?? prepared;
      movementReviews.current.set(result.id, { prepared: original, review });
      setSelectedId(result.id);
      setPersistence((current) => ({
        ...current,
        [result.id]: {
          state: 'movement-review',
          review,
          cancelled: false,
          message: review
            ? response.reason
            : `${response.reason} Confira novamente antes de aplicar a Relação.`,
        },
      }));
      setProgress(null);
      return 'review-required';
    }
    movementReviews.current.delete(result.id);
    setPersistence((current) => ({ ...current, [result.id]: { state: 'completed', response } }));
    if (
      request.operation === 'persist-relacao' &&
      (response.state === 'applied' || response.state === 'no-changes')
    ) {
      const stopped = await followUpRelation({
        result,
        diagnostics: local.diagnostics ?? [],
        year: request.ano,
      });
      if (stopped !== null) return stopped;
    }
    return runResultOfV1(response.state);
  }

  async function persistRecognizedFiles(
    successes: readonly BatchSuccess[],
    observation: BatchObservationV1,
    movementSubmission?: MovementReviewSubmissionV9,
  ): Promise<ImportPersistenceRunResultV1> {
    const relationResults = successes.filter(isMasterRelationResult);
    const teacherResults = successes.filter((result) => !isMasterRelationResult(result));
    const relations: AuditedPreparationV9[] = [];
    let processed = 0;
    /** One Relação's local plan and audit; a status ends the batch before any academic POST. */
    async function preflightRelation(
      result: BatchSuccess,
    ): Promise<ImportPersistenceRunResultV1 | AuditedPreparationV9> {
      if (!isCurrent(observation) || observation.stop !== null)
        return observation.stop ?? 'completed';
      const savedReview = movementReviews.current.get(result.id);
      const local = withMovementReviewV1(
        savedReview?.prepared.local ?? prepareLocal(result, observation),
        result.id,
        movementSubmission,
      );
      retainPreparation(observation, true);
      const audited = savedReview
        ? { local, auditMs: savedReview.prepared.auditMs }
        : await auditLocal(local, observation);
      if (!isCurrent(observation) || observation.stop !== null) {
        releaseRelationPreparation(observation);
        return observation.stop ?? 'completed';
      }
      if (local.kind !== 'ready') {
        releaseRelationPreparation(observation);
        blockTeacherFiles(
          setPersistence,
          teacherResults,
          'Não enviada porque a Relação do lote não pôde ser preparada.',
        );
        return 'blocked';
      }
      return audited;
    }
    /** The Relações, one at a time; a status other than completed ends the batch. */
    async function sendRelations(): Promise<ImportPersistenceRunResultV1 | null> {
      while (relations.length > 0) {
        const prepared = relations.shift()!;
        let status: ImportPersistenceRunResultV1;
        try {
          status = await persistPreparedSingle(prepared, processed, successes.length, observation);
        } finally {
          releaseRelationPreparation(observation);
        }
        if (!isCurrent(observation)) return 'completed';
        if (status === 'blocked') {
          blockTeacherFiles(
            setPersistence,
            teacherResults,
            'Não enviada porque a Relação do lote foi bloqueada.',
          );
          return status;
        }
        if (status !== 'completed') return status;
        processed++;
        observation.processedItems = processed;
      }
      return null;
    }
    /** Audit and save one prepared file; a stop is shared with every lane. */
    async function saveInLane(executing: LocalPreparationV9, position: number) {
      const audited = await auditLocal(executing, observation);
      const status = await persistPreparedSingle(audited, position, successes.length, observation);
      stopDispatch(observation, status);
      return status;
    }
    /** Yield between local builds, then build the next file; it has no remote side effects. */
    async function prefetchNext(result: BatchSuccess, year: number) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      if (!isCurrent(observation) || observation.stop !== null) return null;
      const next = prepareLocal(result, observation, year);
      retainPreparation(observation, false);
      return next;
    }
    /** One year's lane: the next file is built while the current one is saved. False ends the
     * worker (the batch stopped or asked for authorization); true takes the next lane. */
    async function runLane(
      year: number,
      items: ReadonlyArray<{ readonly result: BatchSuccess; readonly position: number }>,
    ): Promise<boolean> {
      observation.activeYearLanes++;
      observation.maximumActiveYearLanes = Math.max(
        observation.maximumActiveYearLanes,
        observation.activeYearLanes,
      );
      let current: LocalPreparationV9 | null = null;
      let next: LocalPreparationV9 | null = null;
      try {
        current = prepareLocal(items[0]!.result, observation, year);
        retainPreparation(observation, false);
        for (let position = 0; current !== null && position < items.length; position++) {
          if (!isCurrent(observation) || observation.stop !== null) return false;
          const executing = current;
          const remote = saveInLane(executing, items[position]!.position);
          if (position + 1 < items.length)
            next = await prefetchNext(items[position + 1]!.result, year);
          const status = await remote;
          releaseTeacherPreparation(observation);
          current = next;
          next = null;
          if (!isCurrent(observation) || observation.stop !== null) return false;
          processed++;
          observation.processedItems = processed;
          setProgress({
            current: processed,
            total: successes.length,
            fileName: executing.result.manifest.fileName,
            stage: 'saving',
          });
          if (current === null && position + 1 < items.length) {
            current = prepareLocal(items[position + 1]!.result, observation, year);
            retainPreparation(observation, false);
          }
          if (status === 'auth-required' || status === 'confirmation-required') return false;
        }
        return true;
      } finally {
        if (current !== null) releaseTeacherPreparation(observation);
        if (next !== null) releaseTeacherPreparation(observation);
        observation.activeYearLanes--;
      }
    }
    try {
      // Global preflight: no academic POST until every Relação has a valid local plan.
      for (const result of relationResults) {
        const step = await preflightRelation(result);
        if (typeof step === 'string') return step;
        relations.push(step);
      }
      const sent = await sendRelations();
      if (sent !== null) return sent;
    } finally {
      observation.preparedRelations -= relations.length;
      relations.length = 0;
    }
    if (!isCurrent(observation) || observation.stop !== null)
      return observation.stop ?? 'completed';

    const { lanes, unknownYear } = teacherLanesV1(teacherResults, relationResults.length);
    for (const item of unknownYear) {
      if (!isCurrent(observation) || observation.stop !== null)
        return observation.stop ?? 'completed';
      const local = prepareLocal(item.result, observation, null);
      retainPreparation(observation, false);
      try {
        await auditLocal(local, observation);
      } finally {
        releaseTeacherPreparation(observation);
      }
      processed++;
      observation.processedItems = processed;
    }
    const pendingLanes = [...lanes.entries()];
    let cursor = 0;
    /** Takes the next year's lane until none is left or the batch stops. */
    async function laneWorker() {
      while (isCurrent(observation) && observation.stop === null) {
        const entry = pendingLanes[cursor++];
        if (!entry) return;
        if (!(await runLane(...entry))) return;
      }
    }
    const workers = Array.from(
      { length: Math.min(GRADEBOOK_IMPORT_FILE_CONCURRENCY_V1, pendingLanes.length) },
      laneWorker,
    );
    // All operations already dispatched are drained, even after another lane stops.
    const settled = await Promise.allSettled(
      workers.map(async (worker) => {
        try {
          await worker;
        } catch (cause) {
          stopDispatch(observation, 'confirmation-required');
          throw cause;
        }
      }),
    );
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (isCurrent(observation) && observation.stop !== null) setProgress(null);
    return observation.stop ?? 'completed';
  }

  /** The batch's end on screen: done, an uncertain write to resume, or a blocked Relação. */
  function showBatchOutcome(
    outcome: ImportPersistenceRunResultV1,
    successes: readonly BatchSuccess[],
  ) {
    if (outcome === 'completed') {
      setProgress({
        current: successes.length,
        total: successes.length,
        fileName: successes.at(-1)?.manifest.fileName ?? '',
        stage: 'completed',
      });
    } else if (outcome === 'confirmation-required') {
      setProgress(null);
      setError('A resposta de uma gravação ficou incerta. Retome somente os pendentes nesta aba.');
    } else if (outcome === 'blocked') {
      setError(
        'A Relação do lote foi bloqueada; as planilhas de notas desse lote não foram enviadas.',
      );
    }
  }

  /** A batch that failed: the recognition timing when it failed there, and the message. */
  function batchFailed(
    cause: unknown,
    observation: BatchObservationV1,
    recognitionStartedAt: number | null,
    fileCount: number,
  ) {
    if (recognitionStartedAt !== null && observation.recognitionCallMs === null) {
      observation.recognitionCallMs = elapsedMs(recognitionStartedAt);
      appendTiming(
        '[gradebook-import-browser-timing]',
        {
          version: 2,
          stage: 'recognition-batch',
          outcome: 'failed',
          failureStage: 'recognition',
          recognitionCallMs: observation.recognitionCallMs,
          fileCount,
        },
        observation,
      );
    }
    setError(failureMessage(cause, 'Não foi possível concluir a importação.'));
  }

  async function handleFiles(files: FileList | readonly File[]) {
    if (inFlight.current) return;
    const selected = Array.from(files);
    const sizeError = validateBatchSize(selected);
    if (sizeError) {
      setError(sizeError);
      return;
    }
    if (selected.length === 0) return;

    inFlight.current = true;
    setLoading(true);
    setError(null);
    setResults([]);
    setFailures([]);
    setSelectedId(null);
    setPersistence({});
    setProgress(null);
    setSourceValueWarnings({});
    setSourceMaximumWarnings({});
    setSourceDiagnostics({});
    setDiagnosticAuditFailures({});
    setAuditAuthorizationRequired(false);
    setPendingRelationFollowUps({});
    movementReviews.current.clear();
    const observation = batchObservation(++generation.current, ++runOrdinal.current, 'initial');
    batchTiming.current = observation;
    sourcePositions.current.clear();
    collectorFailures.current = 0;
    summaryFailed.current = false;
    beginTiming(
      observation,
      selected.map((_, index) => index),
    );
    const batchStartedAt = observation.startedAt;
    let recognitionStartedAt: number | null = null;
    try {
      const libraryStartedAt = nowMs();
      let xlsx;
      try {
        xlsx = await loadSheetJs();
      } finally {
        observation.sheetJsWaitMs = elapsedMs(libraryStartedAt);
        appendTiming(
          '[gradebook-import-browser-timing]',
          {
            version: 2,
            stage: 'library-wait',
            sheetJsWaitMs: observation.sheetJsWaitMs,
            outcome: xlsx ? 'completed' : 'failed',
            failureStage: xlsx ? null : 'library',
          },
          observation,
        );
      }
      if (!isCurrent(observation)) return;
      recognitionStartedAt = nowMs();
      const result = await importWorkbookBatch(
        selected,
        xlsx,
        (value) => {
          if (isCurrent(observation)) setProgress({ ...value, fileName: value.fileName });
        },
        {
          captureValues: true,
          onFileTiming: (timing: ImportWorkbookFileTimingV1) => {
            if (isCurrent(observation))
              appendTiming(
                '[gradebook-import-browser-timing]',
                {
                  version: 2,
                  stage: 'recognition-file',
                  ...timing,
                },
                observation,
                timing.fileIndex,
              );
          },
        },
      );
      if (!isCurrent(observation)) return;
      observation.recognitionCallMs = elapsedMs(recognitionStartedAt);
      observation.recognitionFinishedAtMs = elapsedMs(observation.startedAt);
      // Recognition returns all positions in selection order, including failures.
      try {
        result.batch?.files
          .slice(0, 50)
          .forEach((file, index) => sourcePositions.current.set(file.id, index));
      } catch {
        collectorFailures.current++;
      }
      setResults(result.successes);
      setFailures(result.failureDetails);
      setSelectedId(result.successes[0]?.id ?? null);
      setPersistence(
        Object.fromEntries(
          result.successes.map((success) => [success.id, { state: 'recognized' } as const]),
        ),
      );
      appendTiming(
        '[gradebook-import-browser-timing]',
        {
          version: 2,
          stage: 'recognition-batch',
          totalMs: elapsedMs(batchStartedAt),
          fileCount: selected.length,
          recognizedCount: result.successes.length,
          failureCount: result.failureDetails.length,
          sheetJsWaitMs: observation.sheetJsWaitMs,
          recognitionCallMs: observation.recognitionCallMs,
          recognitionFinishedAtMs: observation.recognitionFinishedAtMs,
        },
        observation,
      );
      if (result.successes.length === 0) {
        setError('Nenhuma planilha pôde ser reconhecida.');
        return;
      }
      const persistenceResult = await persistRecognizedFiles(result.successes, observation);
      if (!isCurrent(observation)) return;
      observation.outcome = persistenceResult;
      showBatchOutcome(persistenceResult, result.successes);
    } catch (cause) {
      if (isCurrent(observation))
        batchFailed(cause, observation, recognitionStartedAt, selected.length);
    } finally {
      if (isCurrent(observation)) {
        finishBatchTiming(observation);
        setLoading(false);
        inFlight.current = false;
      }
    }
  }

  async function resumePendingPersistence(movementSubmission?: MovementReviewSubmissionV9) {
    if (inFlight.current) return;
    const pending = selectPendingGradebookImportResultsV1(results, persistence);
    const followUps = Object.values(pendingRelationFollowUps);
    if (pending.length === 0 && followUps.length === 0) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setAuditAuthorizationRequired(false);
    const observation = batchObservation(++generation.current, ++runOrdinal.current, 'resume');
    batchTiming.current = observation;
    beginTiming(observation, [
      ...new Set(
        [
          ...pending.map((file) => sourcePositions.current.get(file.id)),
          ...followUps.map((item) => sourcePositions.current.get(item.result.id)),
        ].filter((index): index is number => index !== undefined),
      ),
    ]);
    try {
      for (const followUp of followUps) {
        await completeRelationFollowUp(followUp, observation);
        if (!isCurrent(observation) || observation.stop !== null) break;
      }
      const outcome =
        observation.stop ??
        (await persistRecognizedFiles(pending, observation, movementSubmission));
      if (!isCurrent(observation)) return;
      observation.outcome = outcome;
      if (outcome === 'completed') {
        setProgress({
          current: pending.length + followUps.length,
          total: pending.length + followUps.length,
          fileName:
            pending.at(-1)?.manifest.fileName ?? followUps.at(-1)?.result.manifest.fileName ?? '',
          stage: 'completed',
        });
      } else if (outcome === 'confirmation-required') {
        setProgress(null);
        setError(
          'A resposta de uma gravação ficou incerta. Os pendentes continuam preservados nesta aba.',
        );
      } else if (outcome === 'blocked') {
        setError(
          'A Relação pendente continua bloqueada; as planilhas de notas não foram enviadas.',
        );
      }
    } catch (cause) {
      if (isCurrent(observation))
        setError(failureMessage(cause, 'Não foi possível retomar as importações pendentes.'));
    } finally {
      if (isCurrent(observation)) {
        finishBatchTiming(observation);
        setLoading(false);
        inFlight.current = false;
      }
    }
  }

  function cancelMovementReview(resultId: string): void {
    if (inFlight.current) return;
    const session = movementReviews.current.get(resultId);
    if (!session) return;
    movementReviews.current.set(resultId, { ...session, review: null });
    setPersistence((current) => ({
      ...current,
      [resultId]: {
        state: 'movement-review',
        review: null,
        cancelled: true,
        message: 'Conferência cancelada.',
      },
    }));
  }

  async function confirmMovementReview(
    resultId: string,
    confirmation: GradebookRelationMovementConfirmationV9,
  ): Promise<void> {
    const session = movementReviews.current.get(resultId);
    if (session?.review?.digest !== confirmation.digest) return;
    await resumePendingPersistence({ resultId, confirmation });
  }

  return {
    authorizationRequired,
    cancelMovementReview,
    confirmMovementReview,
    diagnosticAuditFailures,
    error,
    failures,
    handleFiles,
    loading,
    pendingPersistenceCount,
    progress,
    persistence,
    results,
    resumePendingPersistence,
    selectedId,
    selectedResult,
    setSelectedId,
    sourceDiagnostics,
    sourceMaximumWarnings,
    sourceValueWarnings,
    timingRevision,
    timingReportSummary: timingSummary(),
    getTimingReport,
    totals,
  };
}
