import {
  isImportCommitDiagnosticsV1,
  parseImportCommitDiagnosticsHeaderV1,
  serializeImportCommitDiagnosticsHeaderV1,
  type ImportCommitDiagnosticsV1,
} from '../../../../shared/gradebook-contracts/imports/import-commit-diagnostics-v1';
/** Browser-only, bounded diagnostics. Never accepts academic objects or free-form labels. */
export const IMPORT_TIMING_FILE_LIMIT_V1 = 50;
export const IMPORT_TIMING_TAIL_LIMIT_V1 = 50;
type Scalar = number | string | boolean | null;
export type ImportTimingEventV1 = Record<string, Scalar>;
export type ImportTimingRunKindV1 = 'initial' | 'resume';
export type ImportTimingStatusV1 = 'in-progress' | 'paused' | 'finished';
const numericKeys = [
  'version',
  'runOrdinal',
  'sourceFileIndex',
  'fileIndex',
  'current',
  'total',
  'index',
  'fileReadMs',
  'manifestMs',
  'yieldMs',
  'recognitionMs',
  'workbookReadMs',
  'xlsxReadMs',
  'masterRelationRecognitionMs',
  'recognizeWorkbookMs',
  'canonicalRostersMs',
  'totalMs',
  'sheetJsWaitMs',
  'recognitionCallMs',
  'recognitionFinishedAtMs',
  'postRecognitionToFirstDispatchMs',
  'fileCount',
  'recognizedCount',
  'failureCount',
  'diagnosticLocalMs',
  'canonicalBuildMs',
  'localPreparationMs',
  'preparationElapsedMs',
  'auditRequestMs',
  'blockingDiagnostics',
  'unavailableCells',
  'aboveMaximumWarnings',
  'diagnosticWarnings',
  'totalDiagnostics',
  'offerCount',
  'classCount',
  'queueWaitMs',
  'serializationMs',
  'payloadBytes',
  'persistRequestMs',
  'serverMs',
  'attempts',
  'batchElapsedMs',
  'firstPersistenceStartedMs',
  'firstConfirmedPersistenceMs',
  'maximumPreparedItems',
  'maximumPreparedRelations',
  'maximumPreparedTeacherItems',
  'maximumActiveYearLanes',
  'confirmedRequests',
  'processedItems',
] as const;
const enums: Record<string, readonly string[]> = {
  stage: [
    'batch-start',
    'library-wait',
    'recognition-batch',
    'recognition-file',
    'canonical-local',
    'canonical-file',
    'canonical-file-blocked',
    'canonical-file-failed',
    'audit-request',
    'persistence-dispatch',
    'academic-dispatch',
    'persist-request',
    'persistence-result',
    'batch-complete',
  ],
  runKind: ['initial', 'resume'],
  operation: ['persist-notas', 'persist-relacao'],
  phase: ['initial-observation', 'relation-follow-up'],
  mode: ['canonical-v9'],
  state: [
    'applied',
    'no-changes',
    'blocked',
    'conflict',
    'review-required',
    'invalid-request',
    'unavailable',
    'not-authorized',
    'confirmation-required',
  ],
  outcome: [
    'completed',
    'auth-required',
    'confirmation-required',
    'blocked',
    'failed',
    'recorded',
    'unavailable',
    'not-authorized',
    'invalid-request',
    'applied',
    'no-changes',
    'review-required',
    'conflict',
    'recognized',
  ],
  failureStage: [
    'library',
    'unsupported-format',
    'file-read',
    'manifest',
    'yield',
    'workbook-read',
    'relation-recognition',
    'workbook-recognition',
    'recognition',
    'runtime',
  ],
  kind: ['ready', 'blocked', 'failed'],
};

export function sanitizeImportTimingEventV1(value: unknown): ImportTimingEventV1 {
  const event: ImportTimingEventV1 = {};
  if (value === null || typeof value !== 'object') return event;
  const input = value as Record<string, unknown>;
  for (const key of numericKeys) {
    if (!(key in input)) continue;
    const number = input[key];
    event[key] =
      typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
  }
  for (const [key, choices] of Object.entries(enums)) {
    const candidate = input[key];
    if (candidate === null) event[key] = null;
    if (typeof candidate === 'string' && choices.includes(candidate)) event[key] = candidate;
  }
  return event;
}

export interface ImportTimingFileV1 {
  sourceFileIndex: number;
  recognition: ImportTimingEventV1 | null;
  preparation: ImportTimingEventV1 | null;
  canonical: ImportTimingEventV1 | null;
  auditInitial: ImportTimingEventV1 | null;
  auditFollowUp: ImportTimingEventV1 | null;
  queue: ImportTimingEventV1 | null;
  dispatch: ImportTimingEventV1 | null;
  http: ImportTimingEventV1 | null;
  persistence: ImportTimingEventV1 | null;
  commitDiagnostics: ImportCommitDiagnosticsV1 | null;
}
interface TimingRun {
  runOrdinal: number;
  runKind: ImportTimingRunKindV1;
  status: ImportTimingStatusV1;
  recognitionStatus: 'pending' | 'performed' | 'not-performed';
  start: ImportTimingEventV1;
  library: ImportTimingEventV1 | null;
  recognition: ImportTimingEventV1 | null;
  files: ImportTimingFileV1[];
  final: ImportTimingEventV1 | null;
  recentEvents: ImportTimingEventV1[];
  discardedEvents: number;
  diagnosticFailures: number;
}
export interface ImportTimingSummaryV1 {
  runOrdinal: number | null;
  status: ImportTimingStatusV1 | null;
  discardedEvents: number;
  omittedResumes: number;
  diagnosticFailures: number;
}

function position(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < IMPORT_TIMING_FILE_LIMIT_V1;
}

/** The file's event in its own slot: recognition, preparation, canonical request, audit, queue,
 * dispatch, HTTP (with its commit diagnostics) or persistence result. */
function attachFileEventV1(file: ImportTimingFileV1, event: ImportTimingEventV1, value: unknown) {
  switch (event.stage) {
    case 'recognition-file':
      file.recognition = event;
      break;
    case 'canonical-local':
      file.preparation = event;
      break;
    case 'canonical-file':
    case 'canonical-file-blocked':
    case 'canonical-file-failed':
      file.canonical = event;
      break;
    case 'audit-request':
      if (event.phase === 'relation-follow-up') file.auditFollowUp = event;
      else file.auditInitial = event;
      break;
    case 'persistence-dispatch':
      file.queue = event;
      break;
    case 'academic-dispatch':
      file.dispatch = event;
      break;
    case 'persist-request':
      file.http = event;
      {
        const diagnostic = (value as { commitDiagnostics?: unknown })?.commitDiagnostics;
        file.commitDiagnostics = isImportCommitDiagnosticsV1(diagnostic)
          ? parseImportCommitDiagnosticsHeaderV1(
              serializeImportCommitDiagnosticsHeaderV1(diagnostic),
            )
          : null;
      }
      break;
    case 'persistence-result':
      file.persistence = event;
      break;
  }
}

/** A batch that ended waiting for the user (authorization, confirmation, review) is paused. */
const PAUSED_OUTCOMES_V1: ReadonlySet<string> = new Set([
  'auth-required',
  'confirmation-required',
  'review-required',
]);

export class ImportTimingReportV1 {
  private initial: TimingRun | null = null;
  private latestResume: TimingRun | null = null;
  private omittedResumes = 0;

  clear(): void {
    this.initial = null;
    this.latestResume = null;
    this.omittedResumes = 0;
  }

  begin(runOrdinal: number, runKind: ImportTimingRunKindV1, participants: readonly number[]): void {
    if (runKind === 'initial') this.clear();
    else if (this.latestResume !== null) this.omittedResumes++;
    const files = [...new Set(participants.filter(position))]
      .slice(0, IMPORT_TIMING_FILE_LIMIT_V1)
      .sort((a, b) => a - b)
      .map((sourceFileIndex) => ({
        sourceFileIndex,
        recognition: null,
        preparation: null,
        canonical: null,
        auditInitial: null,
        auditFollowUp: null,
        queue: null,
        dispatch: null,
        http: null,
        persistence: null,
        commitDiagnostics: null,
      }));
    const run: TimingRun = {
      runOrdinal,
      runKind,
      status: 'in-progress',
      recognitionStatus: runKind === 'resume' ? 'not-performed' : 'pending',
      start: {
        stage: 'batch-start',
        runOrdinal,
        runKind,
        fileCount: files.length,
      },
      library: null,
      recognition: null,
      files,
      final: null,
      recentEvents: [],
      discardedEvents: 0,
      diagnosticFailures: 0,
    };
    if (runKind === 'initial') this.initial = run;
    else this.latestResume = run;
  }

  private current(runOrdinal: number): TimingRun | null {
    const current = this.latestResume ?? this.initial;
    return current?.runOrdinal === runOrdinal ? current : null;
  }

  failure(runOrdinal: number): void {
    const run = this.current(runOrdinal);
    if (run !== null) run.diagnosticFailures++;
  }

  /** A file's event goes to that file; only batch stages may come without one. False: no place. */
  private attach(run: TimingRun, event: ImportTimingEventV1, value: unknown): boolean {
    if (typeof event.sourceFileIndex !== 'number')
      return ['library-wait', 'recognition-batch', 'batch-complete'].includes(String(event.stage));
    const file = run.files.find((item) => item.sourceFileIndex === event.sourceFileIndex);
    if (!file) return false;
    attachFileEventV1(file, event, value);
    return true;
  }

  record(runOrdinal: number, value: unknown, sourceFileIndex?: number): ImportTimingEventV1 | null {
    const run = this.current(runOrdinal);
    if (run?.status !== 'in-progress') return null;
    const event = sanitizeImportTimingEventV1(value);
    if (sourceFileIndex !== undefined)
      event.sourceFileIndex = position(sourceFileIndex) ? sourceFileIndex : null;
    event.runOrdinal = runOrdinal;
    event.runKind = run.runKind;
    if (!event.stage && event.mode === 'canonical-v9') event.stage = 'persistence-result';
    if (!event.stage) {
      this.failure(runOrdinal);
      return null;
    }
    if (event.stage === 'library-wait') run.library = event;
    if (event.stage === 'recognition-batch') {
      run.recognition = event;
      run.recognitionStatus = 'performed';
    }
    if (!this.attach(run, event, value)) this.failure(runOrdinal);
    if (run.recentEvents.length === IMPORT_TIMING_TAIL_LIMIT_V1) {
      run.recentEvents.shift();
      run.discardedEvents++;
    }
    run.recentEvents.push(event);
    if (event.stage === 'batch-complete') {
      run.final = event;
      run.status = PAUSED_OUTCOMES_V1.has(String(event.outcome)) ? 'paused' : 'finished';
    }
    return event;
  }

  summary(): ImportTimingSummaryV1 {
    const runs = [this.initial, this.latestResume].filter((run) => run !== null);
    const current = this.latestResume ?? this.initial;
    return {
      runOrdinal: current?.runOrdinal ?? null,
      status: current?.status ?? null,
      omittedResumes: this.omittedResumes,
      discardedEvents: runs.reduce((sum, run) => sum + run.discardedEvents, 0),
      diagnosticFailures: runs.reduce((sum, run) => sum + run.diagnosticFailures, 0),
    };
  }

  snapshot() {
    // The detached snapshot is constructed only on request, never for every event/render.
    return {
      reportVersion: 1,
      retention: {
        maximumRuns: 2,
        maximumFilesPerRun: IMPORT_TIMING_FILE_LIMIT_V1,
        maximumRecentEventsPerRun: IMPORT_TIMING_TAIL_LIMIT_V1,
        omittedResumes: this.omittedResumes,
      },
      runs: [this.initial, this.latestResume]
        .filter((run) => run !== null)
        .map((run) => ({
          ...run,
          coverage: {
            selectedPositions: run.files.length,
            recognitionMeasured: run.files.filter((file) => file.recognition !== null).length,
            preparationMeasured: run.files.filter((file) => file.preparation !== null).length,
            auditInitialMeasured: run.files.filter((file) => file.auditInitial !== null).length,
            persistenceDispatched: run.files.filter((file) => file.dispatch !== null).length,
            httpMeasured: run.files.filter((file) => file.http !== null).length,
            commitDiagnosticsMeasured: run.files.filter((file) => file.commitDiagnostics !== null)
              .length,
            persistenceResults: run.files.filter((file) => file.persistence !== null).length,
            measurementStatus:
              run.diagnosticFailures > 0 ||
              (run.runKind === 'initial' && run.files.some((file) => file.recognition === null))
                ? 'partial'
                : 'available',
            unmeasuredStages: 'null',
            initialRecognitionAvailable: this.initial?.recognition != null,
          },
          start: { ...run.start },
          library: run.library && { ...run.library },
          recognition: run.recognition && { ...run.recognition },
          final: run.final && { ...run.final },
          files: run.files.map((file): ImportTimingFileV1 => ({
            sourceFileIndex: file.sourceFileIndex,
            recognition: file.recognition && { ...file.recognition },
            preparation: file.preparation && { ...file.preparation },
            canonical: file.canonical && { ...file.canonical },
            auditInitial: file.auditInitial && { ...file.auditInitial },
            auditFollowUp: file.auditFollowUp && { ...file.auditFollowUp },
            queue: file.queue && { ...file.queue },
            dispatch: file.dispatch && { ...file.dispatch },
            http: file.http && { ...file.http },
            persistence: file.persistence && { ...file.persistence },
            commitDiagnostics: file.commitDiagnostics
              ? parseImportCommitDiagnosticsHeaderV1(
                  serializeImportCommitDiagnosticsHeaderV1(file.commitDiagnostics),
                )
              : null,
          })),
          recentEvents: run.recentEvents.map((event) => ({ ...event })),
        })),
    };
  }

  exportText(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }
}
