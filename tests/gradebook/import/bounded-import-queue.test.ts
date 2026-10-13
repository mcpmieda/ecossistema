import { emptyImportCommitAffectedRowsV1 } from '../../../shared/gradebook-contracts/imports/import-commit-diagnostics-v1';
import { act, createElement } from 'react';
import { appendFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRADEBOOK_IMPORT_FILE_CONCURRENCY_V1,
  useImportBatch,
} from '../../../src/features/gradebook/import/use-import-batch';
import type { BatchSuccess } from '../../../src/features/gradebook/import/import-batch';
import { TimingDiagnostics } from '../../../src/features/gradebook/import/import-panel';
import { ImportTimingReportV1 } from '../../../src/features/gradebook/import/import-timing-report-v1';
import type {
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
  GradebookRelationImportRequestV9,
  GradebookRelationMovementReviewV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  compact: vi.fn(),
  persist: vi.fn(),
  audit: vi.fn(),
  diagnostics: vi.fn(),
  blocking: vi.fn(),
  refreshYears: vi.fn(),
  load: vi.fn(),
}));
vi.mock('../../../src/features/gradebook/import/sheetjs-loader', () => ({
  loadSheetJs: mocks.load,
  preloadSheetJs: () => undefined,
}));
vi.mock('../../../src/features/gradebook/import/import-batch', () => ({
  importWorkbookBatch: mocks.read,
  countWorkbookOperationalClassesV1: () => 1,
  validateBatchSize: (files: readonly File[]) =>
    files.length > 50 ? 'Limite de 50 arquivos.' : null,
}));
vi.mock('../../../src/features/gradebook/import/canonical-import-v9', () => ({
  createGradebookCanonicalImportRequestV9: mocks.compact,
  unavailableCellsV9: () => 0,
}));
vi.mock('../../../src/features/gradebook/import/import-diagnostics-v1', () => ({
  collectGradebookImportDiagnosticsV1: mocks.diagnostics,
  blockingGradebookImportDiagnosticsV1: mocks.blocking,
  sourceUnavailableGradebookImportDiagnosticsV1: () => [],
  gradebookImportDiagnosticsAuditRequestV1: (
    result: BatchSuccess,
    diagnostics: readonly unknown[],
  ) => ({
    version: 1,
    academicYear: result.summary.academicYear ?? null,
    fileName: result.manifest.fileName,
    sha256: 'a'.repeat(64),
    diagnostics,
  }),
}));
vi.mock('../../../src/platform/gradebook-year-context', () => ({
  useGradebookYear: () => ({ refreshYears: mocks.refreshYears }),
}));
vi.mock('../../../src/features/gradebook/import/import-diagnostics-client-v1', () => ({
  persistGradebookImportDiagnosticsAuditV1: mocks.audit,
}));
vi.mock('../../../src/features/gradebook/import/import-persistence-client-v9', () => ({
  persistGradebookCanonicalImportV9: mocks.persist,
}));

const emptyWrites = {
  logicalSources: 0,
  sourceFileVersions: 0,
  importBatchVersions: 0,
  assessmentComponentVersions: 0,
  academicRecordVersions: 0,
  logicalSourceRecordAssociationVersions: 0,
  total: 0,
};
function confirmed(): {
  readonly response: GradebookImportPersistenceResponseV9;
  readonly serverMs: null;
} {
  return {
    response: {
      transportVersion: 9,
      state: 'no-changes',
      summary: {
        assessmentDefinitions: { total: 0, resolved: 0, blocked: 0 },
        assessmentComponents: { unchanged: 0, new: 0, changed: 0, blocked: 0 },
        academicRecords: {
          unchanged: 0,
          new: 0,
          changed: 0,
          missingFromNewSource: 0,
          blocked: 0,
        },
        plannedWrites: emptyWrites,
        committedWrites: emptyWrites,
      },
    },
    serverMs: null,
  };
}
function request(result: BatchSuccess): GradebookImportPersistenceRequestV9 {
  const term = (trimestre: 1 | 2 | 3) => ({
    trimestre,
    instrumentos: [[1, 10_000] as const],
    alunos: [[1, [null], null] as const],
  });
  return {
    transportVersion: 9,
    operation: 'persist-notas',
    manifest: {
      fileName: result.manifest.fileName,
      sha256: result.manifest.sha256,
      parserVersion: 'synthetic:canonical-v9',
    },
    ano: result.summary.academicYear ?? 2026,
    professor: 'Docente sintético',
    ofertas: [
      {
        turmaCodigo: '6A',
        disciplina: 'Componente sintético',
        trimestres: [term(1), term(2), term(3)],
        recuperacao: null,
      },
    ],
  };
}
function result(index: number, academicYear = 2026): BatchSuccess {
  return {
    id: `file:${index}`,
    manifest: {
      fileName: `sintetico-${index}.xlsb`,
      extension: 'xlsb',
      reportedMimeType: null,
      sizeBytes: 100,
      lastModifiedAt: null,
      sha256: index.toString(16).padStart(64, '0'),
      sourceContractVersion: 2,
      parserVersion: 'synthetic',
      readAt: '2026-09-01T00:00:00.000Z',
    },
    summary: {
      academicYear,
      teacherName: 'Docente sintético',
      classes: [{ students: 1 }],
      gradeSheets: [],
    },
  } as unknown as BatchSuccess;
}
function recognized(values: BatchSuccess[]) {
  return {
    successes: values,
    failureDetails: [],
    batch: { files: values.map((value) => ({ id: value.id })) },
  };
}
function report() {
  return JSON.parse(flow.getTimingReport()) as ReturnType<ImportTimingReportV1['snapshot']>;
}
function files(count: number): FileList {
  return Array.from(
    { length: count },
    (_, index) => new File(['synthetic'], `sintetico-${index}.xlsb`),
  ) as unknown as FileList;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
async function startBatch(count: number): Promise<{ done: Promise<void> }> {
  let done!: Promise<void>;
  await act(async () => {
    done = flow.handleFiles(files(count));
    await Promise.resolve();
  });
  return { done };
}
async function yieldLocalPreparation(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
function relationResult(index: number): BatchSuccess {
  const value = result(index);
  return {
    ...value,
    summary: { ...value.summary, masterRelationV9: { ano: 2026, turmas: [] } },
  } as unknown as BatchSuccess;
}
function relationRequest(value: BatchSuccess): GradebookImportPersistenceRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-relacao',
    ano: 2026,
    manifest: {
      fileName: value.manifest.fileName,
      sha256: value.manifest.sha256,
      parserVersion: 'synthetic',
    },
    turmas: [],
  };
}
const movementReview: GradebookRelationMovementReviewV9 = {
  digest: 'a'.repeat(64),
  groups: [
    {
      origins: [
        { classCode: '6A', number: 1, name: 'ANA SINTETICA' },
        { classCode: '6A', number: 2, name: 'BRUNA SINTETICA' },
      ],
      destinations: [
        { classCode: '6B', number: 3, name: 'ANA CORRIGIDA' },
        { classCode: '6B', number: 4, name: 'BRUNA CORRIGIDA' },
      ],
    },
  ],
};
const movementConfirmation = {
  digest: movementReview.digest,
  pairs: [
    { origin: { classCode: '6A', number: 1 }, destination: { classCode: '6B', number: 3 } },
    { origin: { classCode: '6A', number: 2 }, destination: { classCode: '6B', number: 4 } },
  ],
};
function reviewReply(review = movementReview) {
  return {
    response: {
      transportVersion: 9,
      state: 'review-required',
      reason: 'Confira os pares de movimentação.',
      movementReview: review,
    },
    serverMs: null,
  } as const;
}
function prepareMovementBatch(): GradebookRelationImportRequestV9 {
  const original: GradebookRelationImportRequestV9 = {
    ...(relationRequest(relationResult(0)) as GradebookRelationImportRequestV9),
    turmas: [
      {
        codigo: '6A',
        nome: '6A',
        etapa: 6,
        turno: 'M',
        alunos: [
          [1, 'ANA SINTETICA', 6, '6B'],
          [2, 'BRUNA SINTETICA', 6, '6B'],
          [9, 'INDEPENDENTE CORRIGIDA', 0],
        ],
      },
      {
        codigo: '6B',
        nome: '6B',
        etapa: 6,
        turno: 'M',
        alunos: [
          [3, 'ANA CORRIGIDA', 7, '6A'],
          [4, 'BRUNA CORRIGIDA', 7, '6A'],
        ],
      },
    ],
  };
  mocks.read.mockResolvedValue(recognized([relationResult(0), result(1)]));
  mocks.compact.mockImplementation((value) => (value.id === 'file:0' ? original : request(value)));
  mocks.persist.mockResolvedValueOnce(reviewReply());
  return original;
}
function lastBatchTiming(): Record<string, unknown> {
  return vi
    .mocked(console.info)
    .mock.calls.map((call) => JSON.parse(String(call[1])) as Record<string, unknown>)
    .filter((value) => value.stage === 'batch-complete')
    .at(-1)!;
}
let root: Root;
let host: HTMLDivElement;
let flow: ReturnType<typeof useImportBatch>;
let sequence: string[];
let probeRenders = 0;
function Probe({ showTiming = false }: { showTiming?: boolean }) {
  probeRenders++;
  flow = useImportBatch();
  return showTiming
    ? createElement(TimingDiagnostics, {
        visible: true,
        summary: flow.timingReportSummary,
        getReport: flow.getTimingReport,
      })
    : null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  sequence = [];
  probeRenders = 0;
  mocks.diagnostics.mockReturnValue([]);
  mocks.blocking.mockReturnValue([]);
  mocks.refreshYears.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue({ version: '0.20.3' });
  mocks.read.mockImplementation(async (input: readonly File[], _xlsx, _progress, runtime) => {
    input.forEach((_, index) =>
      runtime.onFileTiming({ fileIndex: index, fileReadMs: 1, outcome: 'recognized' }),
    );
    return recognized(input.map((_, index) => result(index)));
  });
  mocks.compact.mockImplementation((input: BatchSuccess) => {
    sequence.push(`compact:${input.id}`);
    return request(input);
  });
  mocks.persist.mockImplementation(
    async (value: GradebookImportPersistenceRequestV9, onTiming, onDispatch) => {
      sequence.push(`send:${value.manifest.fileName}`);
      onDispatch?.();
      await Promise.resolve();
      onTiming?.({
        serializationMs: 0,
        payloadBytes: 100,
        persistRequestMs: 1,
        outcome: 'no-changes',
      });
      return confirmed();
    },
  );
  mocks.audit.mockResolvedValue({ version: 1, state: 'recorded', affected: 0 });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Bounded per-file canonical queue (V9)', () => {
  it('holds the entire relation and teacher queue for explicit movement selection without auditing', async () => {
    const original = prepareMovementBatch();
    await act(async () => flow.handleFiles(files(2)));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.persist.mock.calls[0]![0]).toEqual(original);
    expect(flow.persistence['file:0']).toMatchObject({
      state: 'movement-review',
      review: movementReview,
      cancelled: false,
    });
    expect(flow.persistence['file:1']).toEqual({ state: 'recognized' });
    expect(flow.pendingPersistenceCount).toBe(2);
    expect(report().runs[0]!.status).toBe('paused');
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.refreshYears).not.toHaveBeenCalled();
    expect(flow.getTimingReport()).not.toContain('ANA SINTETICA');
  });

  it('applies the exact original relation including independent updates, then follows up and releases teachers', async () => {
    const original = prepareMovementBatch();
    await act(async () => flow.handleFiles(files(2)));
    await act(async () => flow.confirmMovementReview('file:0', movementConfirmation));
    expect(mocks.persist.mock.calls.map(([value]) => value)).toEqual([
      original,
      { ...original, movementReview: movementConfirmation },
      request(result(1)),
    ]);
    expect(original).not.toHaveProperty('movementReview');
    expect(mocks.compact).toHaveBeenCalledTimes(2);
    expect(mocks.audit.mock.calls.map(([value]) => value.fileName)).toEqual([
      'sintetico-0.xlsb',
      'sintetico-1.xlsb',
    ]);
    expect(mocks.refreshYears).toHaveBeenCalledExactlyOnceWith(2026);
    expect(flow.pendingPersistenceCount).toBe(0);
  });

  it('cancels locally, rejects a retained confirmation, and reopens with a fresh preview and no choices', async () => {
    const original = prepareMovementBatch();
    await act(async () => flow.handleFiles(files(2)));
    await act(async () => flow.cancelMovementReview('file:0'));
    await act(async () => flow.confirmMovementReview('file:0', movementConfirmation));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(flow.persistence['file:0']).toMatchObject({
      state: 'movement-review',
      review: null,
      cancelled: true,
    });
    const fresh = { ...movementReview, digest: 'b'.repeat(64) };
    mocks.persist.mockResolvedValueOnce(reviewReply(fresh));
    await act(async () => flow.resumePendingPersistence());
    expect(mocks.persist.mock.calls[1]![0]).toEqual(original);
    expect(flow.persistence['file:0']).toMatchObject({
      state: 'movement-review',
      review: fresh,
      cancelled: false,
    });
    expect(mocks.persist).toHaveBeenCalledTimes(2);
  });

  it('requires another preview after a stale confirmation without automatically sending either request', async () => {
    const original = prepareMovementBatch();
    await act(async () => flow.handleFiles(files(2)));
    mocks.persist.mockResolvedValueOnce({
      response: {
        transportVersion: 9,
        state: 'conflict',
        reason: 'Conferência obsoleta.',
      },
      serverMs: null,
    });
    await act(async () => flow.confirmMovementReview('file:0', movementConfirmation));
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(flow.persistence['file:0']).toMatchObject({
      state: 'movement-review',
      review: null,
      cancelled: false,
    });
    expect(mocks.audit).not.toHaveBeenCalled();
    await act(async () => flow.confirmMovementReview('file:0', movementConfirmation));
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    const fresh = { ...movementReview, digest: 'c'.repeat(64) };
    mocks.persist.mockResolvedValueOnce(reviewReply(fresh));
    await act(async () => flow.resumePendingPersistence());
    expect(mocks.persist.mock.calls[2]![0]).toEqual(original);
    expect(flow.persistence['file:0']).toMatchObject({ review: fresh });
    expect(flow.persistence['file:1']).toEqual({ state: 'recognized' });
  });

  it.each(['lost-response', 'not-authorized'] as const)(
    'returns safely to review after %s without replaying choices',
    async (failure) => {
      const original = prepareMovementBatch();
      await act(async () => flow.handleFiles(files(2)));
      if (failure === 'lost-response')
        mocks.persist.mockRejectedValueOnce(new TypeError('synthetic lost reply'));
      else
        mocks.persist.mockResolvedValueOnce({
          response: { transportVersion: 9, state: 'not-authorized' },
          serverMs: null,
        });
      await act(async () => flow.confirmMovementReview('file:0', movementConfirmation));
      expect(mocks.persist).toHaveBeenCalledTimes(2);
      expect(flow.persistence['file:0']?.state).toBe(
        failure === 'lost-response' ? 'confirmation-required' : 'auth-required',
      );
      mocks.persist.mockResolvedValueOnce(reviewReply());
      await act(async () => flow.resumePendingPersistence());
      expect(mocks.persist.mock.calls[2]![0]).toEqual(original);
      expect(flow.persistence['file:0']).toMatchObject({
        state: 'movement-review',
        review: movementReview,
      });
      expect(mocks.persist).toHaveBeenCalledTimes(3);
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );

  it('ignores an old digest and prevents duplicate confirmation dispatch while one is pending', async () => {
    prepareMovementBatch();
    await act(async () => flow.handleFiles(files(2)));
    await act(async () =>
      flow.confirmMovementReview('file:0', { ...movementConfirmation, digest: 'd'.repeat(64) }),
    );
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    const reply = deferred<ReturnType<typeof confirmed>>();
    mocks.persist.mockReturnValueOnce(reply.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = flow.confirmMovementReview('file:0', movementConfirmation);
      await flow.confirmMovementReview('file:0', movementConfirmation);
    });
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    await act(async () => {
      reply.resolve(confirmed());
      await pending;
    });
    expect(mocks.persist).toHaveBeenCalledTimes(3);
  });

  it('discards a late movement preview after unmount and a newly mounted batch', async () => {
    prepareMovementBatch();
    const reply = deferred<ReturnType<typeof reviewReply>>();
    mocks.persist.mockReset().mockReturnValueOnce(reply.promise).mockResolvedValue(confirmed());
    const { done } = await startBatch(2);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    mocks.read.mockResolvedValue(recognized([result(3)]));
    await act(async () => flow.handleFiles(files(1)));
    await act(async () => {
      reply.resolve(reviewReply());
      await done;
    });
    expect(flow.results.map((item) => item.id)).toEqual(['file:3']);
    expect(flow.persistence['file:0']).toBeUndefined();
    expect(flow.persistence['file:3']?.state).toBe('completed');
  });

  it('preserves failure positions before the sole recognized file instead of indexing filtered successes', async () => {
    mocks.read.mockImplementation(async (_input, _xlsx, _progress, runtime) => {
      for (const index of [0, 1, 2])
        runtime.onFileTiming({
          fileIndex: index,
          outcome: index === 2 ? 'recognized' : 'failed',
          failureStage: index === 2 ? null : 'file-read',
          fileReadMs: 1,
          recognitionMs: index === 2 ? 1 : null,
        });
      return {
        successes: [result(2)],
        failureDetails: [{ id: 'failure-0' }, { id: 'failure-1' }],
        batch: { files: [{ id: 'failure-0' }, { id: 'failure-1' }, { id: result(2).id }] },
      };
    });
    await act(async () => flow.handleFiles(files(3)));
    const run = report().runs[0]!;
    expect(run.files.map((file) => file.sourceFileIndex)).toEqual([0, 1, 2]);
    expect(run.files[0]!.recognition!.outcome).toBe('failed');
    expect(run.files[1]!.http).toBeNull();
    expect(run.files[2]!.persistence).toMatchObject({ sourceFileIndex: 2, index: 0 });
    expect(mocks.persist).toHaveBeenCalledOnce();
  });
  it.each([18, 50])(
    'G6 measures bounded observability for %i equivalent synthetic files',
    async (count) => {
      const stringify = vi.spyOn(JSON, 'stringify');
      await act(async () => flow.handleFiles(files(count)));
      const fullCount = () =>
        stringify.mock.calls.filter(([value]) => value?.reportVersion === 1).length;
      const eventSerializations = stringify.mock.calls.filter(
        ([value]) => value?.version === 2,
      ).length;
      expect(fullCount()).toBe(0);
      const startedAt = performance.now();
      const legacyTail = (flow as unknown as { timingDiagnostics?: string[] }).timingDiagnostics;
      const text = legacyTail ? legacyTail.join('\n') : flow.getTimingReport();
      const exportMs = performance.now() - startedAt;
      const copied = legacyTail
        ? null
        : (JSON.parse(text) as ReturnType<ImportTimingReportV1['snapshot']>);
      if (copied) {
        expect(fullCount()).toBe(1);
        expect(copied.runs[0]!.files).toHaveLength(count);
      }
      expect(mocks.persist).toHaveBeenCalledTimes(count);
      expect(mocks.audit).toHaveBeenCalledTimes(count);
      expect(mocks.persist.mock.calls.map(([value]) => value)).toEqual(
        Array.from({ length: count }, (_, i) => request(result(i))),
      );
      expect(
        Object.values(flow.persistence).every(
          (value) => value.state === 'completed' && value.response.state === 'no-changes',
        ),
      ).toBe(true);
      const measurement = JSON.stringify({
        scenario: 'G6-observability',
        files: count,
        n: 1,
        implementation: legacyTail ? 'baseline' : 'candidate',
        reports: copied?.runs.length ?? 0,
        essentialPositions: copied?.runs[0]!.files.length ?? 0,
        recentEvents: copied?.runs[0]!.recentEvents.length ?? legacyTail!.length,
        exportBytes: new TextEncoder().encode(text).byteLength,
        eventSerializations,
        fullSerializationsBeforeCopy: 0,
        fullSerializationsAfterCopy: fullCount(),
        exportMs: Math.round(exportMs * 1000) / 1000,
        probeRenders,
        auditCalls: mocks.audit.mock.calls.length,
        persistenceCalls: mocks.persist.mock.calls.length,
      });
      console.log(measurement);
      if (process.env.IMPORT_TIMING_MEASUREMENT_PATH_V1)
        appendFileSync(process.env.IMPORT_TIMING_MEASUREMENT_PATH_V1, measurement + '\n');
    },
  );

  it.each(['begin', 'summary', 'snapshot'] as const)(
    'G-T15 isolates a throwing collector %s from academic state',
    async (method) => {
      vi.spyOn(ImportTimingReportV1.prototype, method).mockImplementation(() => {
        throw new Error('SYNTHETIC PRIVATE COLLECTOR ERROR');
      });
      await act(async () => flow.handleFiles(files(3)));
      expect(mocks.persist).toHaveBeenCalledTimes(3);
      expect(mocks.audit).toHaveBeenCalledTimes(3);
      expect(flow.loading).toBe(false);
      expect(flow.error).toBeNull();
      expect(Object.values(flow.persistence).every((value) => value.state === 'completed')).toBe(
        true,
      );
      let text!: string;
      await act(async () => {
        text = flow.getTimingReport();
      });
      expect(text).not.toContain('PRIVATE');
      if (method === 'summary') expect(JSON.parse(text).measurementStatus).toBe('partial');
      if (method === 'snapshot') expect(JSON.parse(text).measurementStatus).toBe('unavailable');
    },
  );
  it.each([18, 50])(
    'G0/G-T01–04 preserves initial recognition in the text actually copied after %i files',
    async (count) => {
      mocks.read.mockImplementation(async (input, _xlsx, _progress, runtime) => {
        input.forEach((_: File, index: number) =>
          runtime.onFileTiming({
            fileIndex: index,
            current: index + 1,
            total: input.length,
            fileReadMs: 1,
            manifestMs: 1,
            yieldMs: 1,
            recognitionMs: 1,
          }),
        );
        return recognized(input.map((_: File, index: number) => result(index)));
      });
      await act(async () => flow.handleFiles(files(count)));
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      await act(async () => root.render(createElement(Probe, { showTiming: true })));
      await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
      expect(writeText).toHaveBeenCalledOnce();
      const copied = writeText.mock.calls[0]![0];
      expect(copied).toContain('batch-complete');
      expect(copied).toContain('recognition-batch');
      const copiedReport = JSON.parse(copied) as ReturnType<ImportTimingReportV1['snapshot']>;
      expect(copiedReport.runs[0]!.files).toHaveLength(count);
      expect(copiedReport.runs[0]!.files[0]!.recognition!.fileIndex).toBe(0);
      expect(
        copiedReport.runs[0]!.files.every(
          (file) => file.http && file.persistence && file.auditInitial,
        ),
      ).toBe(true);
      expect(copiedReport.runs[0]!.recentEvents).toHaveLength(50);
      expect(copiedReport.runs[0]!.discardedEvents).toBeGreaterThan(0);
    },
  );
  it('G-T11 retains initial and latest of four resumes and never resends an already confirmed position', async () => {
    let attempt = 0;
    mocks.persist.mockImplementation(async (value, _timing, onDispatch) => {
      onDispatch?.();
      if (value.manifest.fileName === 'sintetico-0.xlsb') return confirmed();
      attempt++;
      return attempt < 5
        ? { response: { transportVersion: 9, state: 'unavailable' }, serverMs: null }
        : confirmed();
    });
    await act(async () => flow.handleFiles(files(3)));
    for (let index = 0; index < 4; index++) await act(async () => flow.resumePendingPersistence());
    const snapshot = report();
    expect(snapshot.runs.map((run) => run.runOrdinal)).toEqual([1, 5]);
    expect(snapshot.retention.omittedResumes).toBe(3);
    expect(snapshot.runs[0]!.status).toBe('paused');
    expect(snapshot.runs[1]!.status).toBe('finished');
    expect(snapshot.runs[1]!.recognitionStatus).toBe('not-performed');
    expect(snapshot.runs[1]!.final!.recognitionCallMs).toBeNull();
    expect(snapshot.runs[1]!.files.map((file) => file.sourceFileIndex)).toEqual([1, 2]);
    expect(
      mocks.persist.mock.calls.filter(([value]) => value.manifest.fileName === 'sintetico-0.xlsb'),
    ).toHaveLength(1);
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it('G-T12 replaces a batch and ignores its late recognition and HTTP observers', async () => {
    let lateRecognition!: (value: unknown) => void;
    let lateHttp!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(async (_input, _xlsx, _progress, runtime) => {
      lateRecognition = runtime.onFileTiming;
      return recognized([result(0)]);
    });
    mocks.persist.mockImplementationOnce(async (_value, onTiming) => {
      lateHttp = onTiming;
      return confirmed();
    });
    await act(async () => flow.handleFiles(files(1)));
    await act(async () => flow.handleFiles(files(2)));
    const before = flow.getTimingReport();
    await act(async () => {
      lateRecognition({ fileIndex: 0, recognitionMs: 999999 });
      lateHttp({ persistRequestMs: 999999 });
    });
    expect(flow.getTimingReport()).toBe(before);
    expect(report().runs.map((run) => run.runOrdinal)).toEqual([2]);
    expect(report().runs[0]!.files).toHaveLength(2);
  });

  it.each(['library', 'zero-recognized'] as const)(
    'G-T14 finalizes %s without inventing dispatch or measurements',
    async (kind) => {
      if (kind === 'library')
        mocks.load.mockRejectedValueOnce(new Error('SYNTHETIC PRIVATE LIBRARY ERROR'));
      else
        mocks.read.mockResolvedValueOnce({
          successes: [],
          failureDetails: [],
          batch: { files: [] },
        });
      await act(async () => flow.handleFiles(files(2)));
      const run = report().runs[0]!;
      expect(run.status).toBe('finished');
      expect(run.final).toMatchObject({
        outcome: 'failed',
        firstPersistenceStartedMs: null,
        firstConfirmedPersistenceMs: null,
      });
      expect(run.files).toHaveLength(2);
      expect(run.files.every((file) => file.dispatch === null && file.http === null)).toBe(true);
      expect(run.final!.recognitionCallMs === null).toBe(kind === 'library');
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(flow.getTimingReport()).not.toContain('PRIVATE');
    },
  );

  it('G-T16 separates library wait, recognition and pre-dispatch offsets on one deterministic clock', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    mocks.load.mockImplementation(async () => {
      clock += 7;
      return { version: '0.20.3' };
    });
    mocks.read.mockImplementation(async (_input, _xlsx, _progress, runtime) => {
      clock += 11;
      runtime.onFileTiming({ fileIndex: 0, recognitionMs: 11, outcome: 'recognized' });
      return recognized([result(0)]);
    });
    mocks.compact.mockImplementation((value) => {
      clock += 3;
      return request(value);
    });
    mocks.audit.mockImplementation(async () => {
      clock += 80;
      return { state: 'recorded' };
    });
    mocks.persist.mockImplementation(async (_value, onTiming, onDispatch) => {
      expect(report().runs[0]!.final).toBeNull();
      expect(report().runs[0]!.files[0]!.dispatch).toBeNull();
      clock += 2; // serialization before the actual callback-controlled dispatch
      onDispatch();
      clock += 5;
      onTiming({ serializationMs: 2, persistRequestMs: 5, outcome: 'no-changes' });
      return confirmed();
    });
    await act(async () => flow.handleFiles(files(1)));
    const run = report().runs[0]!;
    expect(run.recognition).toMatchObject({
      sheetJsWaitMs: 7,
      recognitionCallMs: 11,
      recognitionFinishedAtMs: 18,
      totalMs: 18,
    });
    expect(run.final).toMatchObject({
      firstPersistenceStartedMs: 103,
      firstConfirmedPersistenceMs: 108,
      postRecognitionToFirstDispatchMs: 85,
      batchElapsedMs: 108,
    });
    expect(run.files[0]!.canonical).toMatchObject({ localPreparationMs: 3, totalMs: 83 });
  });
  it('reports a comparable 18-file same-year fixture with injected local/audit/persistence costs', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    mocks.compact.mockImplementation((value) => {
      clock += 3;
      return request(value);
    });
    mocks.audit.mockImplementation(async () => {
      clock += 80;
      return { version: 1, state: 'recorded', affected: 0 };
    });
    mocks.persist.mockImplementation(async (_request, _timing, onDispatch) => {
      onDispatch?.();
      clock += 5;
      return confirmed();
    });
    await act(async () => flow.handleFiles(files(18)));
    const measured = lastBatchTiming();
    expect(measured).toMatchObject({ confirmedRequests: 18, batchElapsedMs: 1584 });
    expect(flow.pendingPersistenceCount).toBe(0);
    expect(mocks.persist.mock.calls.map(([value]) => value.manifest.fileName)).toEqual(
      Array.from({ length: 18 }, (_, index) => `sintetico-${index}.xlsb`),
    );
    // This controlled clock proves scheduling under equal injected costs, not real network latency.
    console.log(
      JSON.stringify({
        scenario: 'M07-browser-controlled-clock',
        executions: 1,
        localCostMs: 3,
        auditCostMs: 80,
        persistenceCostMs: 5,
        ...measured,
      }),
    );
  });

  it('recognizes the entire selection before dispatch and overlaps only one local next item with the first write', async () => {
    vi.useFakeTimers();
    const recognition = deferred<{ successes: BatchSuccess[]; failureDetails: [] }>();
    const firstWrite = deferred<ReturnType<typeof confirmed>>();
    mocks.read.mockReturnValue(recognition.promise);
    mocks.audit.mockImplementation(async (value) => {
      sequence.push(`audit:${value.fileName}`);
      return { version: 1, state: 'recorded', affected: 0 };
    });
    mocks.persist.mockImplementation(async (value, _timing, onDispatch) => {
      onDispatch?.();
      sequence.push(`persist:${value.manifest.fileName}`);
      if (value.manifest.fileName === 'sintetico-0.xlsb') return firstWrite.promise;
      return confirmed();
    });
    const { done } = await startBatch(3);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.compact).not.toHaveBeenCalled();
    await act(async () => {
      recognition.resolve({ successes: [result(0), result(1), result(2)], failureDetails: [] });
    });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    await yieldLocalPreparation();
    expect(mocks.compact).toHaveBeenCalledTimes(2);
    expect(sequence).toContain('compact:file:1');
    expect(sequence).not.toContain('audit:sintetico-1.xlsb');
    expect(sequence).not.toContain('persist:sintetico-1.xlsb');
    expect(mocks.audit.mock.calls[0]![0].diagnostics).toEqual([]);
    await act(async () => {
      firstWrite.resolve(confirmed());
      await vi.runAllTimersAsync();
      await done;
    });
    expect(sequence.indexOf('persist:sintetico-0.xlsb')).toBeLessThan(
      sequence.indexOf('audit:sintetico-1.xlsb'),
    );
    expect(lastBatchTiming()).toMatchObject({
      maximumPreparedTeacherItems: 2,
      maximumPreparedRelations: 0,
      maximumActiveYearLanes: 1,
      confirmedRequests: 3,
    });
    expect(flow.diagnosticAuditFailures).toEqual({});
  });

  it('does not audit or write a prepared next item after the current write becomes uncertain and resumes only pendings', async () => {
    vi.useFakeTimers();
    const firstWrite = deferred<ReturnType<typeof confirmed>>();
    mocks.persist.mockReturnValueOnce(firstWrite.promise);
    const { done } = await startBatch(3);
    await yieldLocalPreparation();
    expect(mocks.compact).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstWrite.resolve({
        response: { transportVersion: 9, state: 'unavailable' },
        serverMs: null,
      } as ReturnType<typeof confirmed>);
      await done;
    });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(flow.persistence['file:0']?.state).toBe('confirmation-required');
    expect(flow.persistence['file:1']?.state).toBe('processing');
    expect(flow.persistence['file:2']?.state).toBe('recognized');
    mocks.persist.mockClear().mockResolvedValue(confirmed());
    await act(async () => {
      const resumed = flow.resumePendingPersistence();
      await vi.runAllTimersAsync();
      await resumed;
    });
    expect(mocks.persist).toHaveBeenCalledTimes(3);
    expect(flow.pendingPersistenceCount).toBe(0);
  });

  it('retains at most eight teacher preparations and four active years, serializing audit and persistence per year', async () => {
    vi.useFakeTimers();
    const values = Array.from({ length: 12 }, (_, index) =>
      result(index, 2026 + Math.floor(index / 2)),
    );
    mocks.read.mockResolvedValue(recognized(values));
    const firstWrites = Array.from({ length: 4 }, () => deferred<ReturnType<typeof confirmed>>());
    const active = new Map<number, number>();
    let maximumSameYear = 0;
    const enter = (year: number) => {
      const count = (active.get(year) ?? 0) + 1;
      active.set(year, count);
      maximumSameYear = Math.max(maximumSameYear, count);
    };
    const leave = (year: number) => active.set(year, active.get(year)! - 1);
    mocks.audit.mockImplementation(async (value) => {
      enter(value.academicYear);
      await Promise.resolve();
      leave(value.academicYear);
      return { version: 1, state: 'recorded', affected: 0 };
    });
    mocks.persist.mockImplementation(async (value, onTiming, onDispatch) => {
      onDispatch?.();
      enter(value.ano);
      if (
        value.ano < 2030 &&
        Number(value.manifest.fileName.split('-')[1]!.split('.')[0]) % 2 === 0
      )
        await firstWrites[value.ano - 2026]!.promise;
      leave(value.ano);
      onTiming?.({ persistRequestMs: value.ano, outcome: 'no-changes' });
      return { ...confirmed(), serverMs: value.ano };
    });
    const { done } = await startBatch(12);
    await yieldLocalPreparation();
    expect(mocks.persist).toHaveBeenCalledTimes(4);
    expect(mocks.compact).toHaveBeenCalledTimes(8);
    expect(mocks.audit).toHaveBeenCalledTimes(4);
    expect(mocks.persist.mock.calls.map(([value]) => value.ano)).toEqual([2026, 2027, 2028, 2029]);
    await act(async () => {
      for (const index of [3, 1, 2, 0]) firstWrites[index]!.resolve(confirmed());
      await vi.runAllTimersAsync();
      await done;
    });
    expect(mocks.persist).toHaveBeenCalledTimes(12);
    expect(maximumSameYear).toBe(1);
    expect(lastBatchTiming()).toMatchObject({
      maximumPreparedTeacherItems: 8,
      maximumPreparedItems: 8,
      maximumActiveYearLanes: 4,
      confirmedRequests: 12,
    });
    expect(flow.pendingPersistenceCount).toBe(0);
    const yearFiles = report().runs[0]!.files;
    expect(yearFiles.map((file) => file.http!.sourceFileIndex)).toEqual(
      values.map((_, index) => index),
    );
    expect(yearFiles.map((file) => file.persistence!.serverMs)).toEqual(
      values.map((value) => value.summary.academicYear),
    );
  });

  it('preflights every relation and blocks teachers if a later relation is invalid', async () => {
    const values = [result(0), relationResult(1), relationResult(2), result(3)];
    mocks.read.mockResolvedValue(recognized(values));
    mocks.compact.mockImplementation((value) => {
      if (value.id === 'file:2') throw new Error('synthetic invalid relation');
      return value.id === 'file:1' ? relationRequest(value) : request(value);
    });
    await act(async () => flow.handleFiles(files(4)));
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.compact.mock.calls.map(([value]) => value.id)).toEqual(['file:1', 'file:2']);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![0].diagnostics).toEqual([]);
    expect(flow.persistence['file:0']?.state).toBe('failed');
    expect(flow.persistence['file:3']?.state).toBe('failed');
    expect(mocks.refreshYears).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'conflict', 'invalid-request', 'review-required'] as const)(
    'never releases teachers after a relation response %s without academic confirmation',
    async (state) => {
      mocks.read.mockResolvedValue({
        successes: [relationResult(0), result(1)],
        failureDetails: [],
      });
      mocks.compact.mockImplementation((value) =>
        value.id === 'file:0' ? relationRequest(value) : request(value),
      );
      mocks.persist.mockResolvedValue({
        response: { transportVersion: 9, state, reason: 'synthetic refusal' },
        serverMs: null,
      });
      await act(async () => flow.handleFiles(files(2)));
      expect(mocks.persist).toHaveBeenCalledTimes(1);
      expect(mocks.compact).toHaveBeenCalledTimes(1);
      expect(mocks.refreshYears).not.toHaveBeenCalled();
      expect(flow.persistence['file:1']?.state).toBe('failed');
      expect(lastBatchTiming()).toMatchObject({ confirmedRequests: 0, outcome: 'blocked' });
    },
  );

  it('confirms all relations before auditing, refreshing or sending teachers', async () => {
    const values = [result(0), relationResult(1), relationResult(2), result(3)];
    mocks.read.mockResolvedValue(recognized(values));
    mocks.compact.mockImplementation((value) =>
      value.id === 'file:1' || value.id === 'file:2' ? relationRequest(value) : request(value),
    );
    const writes = [
      deferred<ReturnType<typeof confirmed>>(),
      deferred<ReturnType<typeof confirmed>>(),
    ];
    mocks.persist.mockImplementation(async (value) =>
      value.operation === 'persist-relacao'
        ? writes[Number(value.manifest.fileName.split('-')[1]!.split('.')[0]) - 1]!.promise
        : confirmed(),
    );
    const { done } = await startBatch(4);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.compact.mock.calls.map(([value]) => value.id)).toEqual(['file:1', 'file:2']);
    await act(async () => {
      writes[0]!.resolve(confirmed());
    });
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(mocks.compact).toHaveBeenCalledTimes(2);
    expect(mocks.refreshYears).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    await act(async () => {
      writes[1]!.resolve(confirmed());
      await done;
    });
    expect(mocks.refreshYears).toHaveBeenCalledTimes(2);
    expect(mocks.persist.mock.calls.map(([value]) => value.operation)).toEqual([
      'persist-relacao',
      'persist-relacao',
      'persist-notas',
      'persist-notas',
    ]);
    expect(mocks.audit).toHaveBeenCalledTimes(4);
    expect(lastBatchTiming()).toMatchObject({
      maximumPreparedRelations: 2,
      maximumPreparedTeacherItems: 2,
    });
    const positions = report().runs[0]!.files;
    expect(positions[0]!.persistence).toMatchObject({
      sourceFileIndex: 0,
      index: 2,
      operation: 'persist-notas',
    });
    expect(positions[1]!.persistence).toMatchObject({
      sourceFileIndex: 1,
      index: 0,
      operation: 'persist-relacao',
    });
    expect(positions[1]!.auditInitial).toBeNull();
    expect(positions[1]!.auditFollowUp!.phase).toBe('relation-follow-up');
  });

  it('records blocked/local-failed/unknown-year observations and preserves separate audit failures', async () => {
    const unknown = {
      ...result(0),
      summary: { ...result(0).summary, academicYear: null },
    } as unknown as BatchSuccess;
    mocks.read.mockResolvedValue({
      successes: [result(1), unknown, result(2), result(3)],
      failureDetails: [],
    });
    const diagnostic = { severity: 'blocking-error', code: 'invalid-text', message: 'synthetic' };
    mocks.diagnostics.mockImplementation((value) => (value.id === 'file:2' ? [diagnostic] : []));
    mocks.blocking.mockImplementation((diagnostics) =>
      diagnostics.filter((value: typeof diagnostic) => value.severity === 'blocking-error'),
    );
    mocks.compact.mockImplementation((value) => {
      if (value.id === 'file:3') throw new Error('synthetic canonical failure');
      return request(value);
    });
    mocks.audit.mockImplementation(async (value) =>
      value.fileName === 'sintetico-1.xlsb'
        ? { version: 1, state: 'unavailable' }
        : { version: 1, state: 'recorded', affected: 0 },
    );
    await act(async () => flow.handleFiles(files(4)));
    expect(mocks.audit.mock.calls.map(([value]) => value.fileName)).toEqual([
      'sintetico-0.xlsb',
      'sintetico-1.xlsb',
      'sintetico-2.xlsb',
      'sintetico-3.xlsb',
    ]);
    expect(mocks.audit.mock.calls[0]![0].academicYear).toBeNull();
    expect(mocks.audit.mock.calls[2]![0].diagnostics).toEqual([diagnostic]);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(flow.persistence['file:0']?.state).toBe('failed');
    expect(flow.persistence['file:1']?.state).toBe('completed');
    expect(flow.persistence['file:2']?.state).toBe('failed');
    expect(flow.persistence['file:3']?.state).toBe('failed');
    expect(Object.keys(flow.diagnosticAuditFailures)).toEqual(['file:1']);
  });

  it('stops on authorization from audit without a false receipt or academic POST', async () => {
    mocks.audit.mockResolvedValue({ version: 1, state: 'not-authorized' });
    await act(async () => flow.handleFiles(files(3)));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(flow.persistence['file:0']?.state).toBe('auth-required');
    expect(flow.pendingPersistenceCount).toBe(3);
    expect(flow.diagnosticAuditFailures['file:0']).toBeTruthy();
  });

  it('keeps audit network failure visible while preserving the existing independent academic write policy', async () => {
    mocks.audit.mockRejectedValue(new TypeError('synthetic audit lost reply'));
    await act(async () => flow.handleFiles(files(1)));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(flow.persistence['file:0']?.state).toBe('completed');
    expect(flow.diagnosticAuditFailures['file:0']).toBeTruthy();
    const timings = vi
      .mocked(console.info)
      .mock.calls.map((call) => JSON.parse(String(call[1])) as Record<string, unknown>);
    expect(timings.find((value) => value.stage === 'audit-request')).toMatchObject({
      outcome: 'failed',
    });
  });

  it('drains started writes, prioritizes uncertainty over authorization, and never sends prepared followers', async () => {
    vi.useFakeTimers();
    const values = [
      result(0, 2026),
      result(1, 2027),
      result(2, 2028),
      result(3, 2026),
      result(4, 2027),
    ];
    mocks.read.mockResolvedValue(recognized(values));
    const replies = Array.from({ length: 3 }, () =>
      deferred<{ response: GradebookImportPersistenceResponseV9; serverMs: null }>(),
    );
    mocks.persist.mockImplementation(
      (value) => replies[Number(value.manifest.fileName.split('-')[1]!.split('.')[0])]!.promise,
    );
    const { done } = await startBatch(5);
    await yieldLocalPreparation();
    expect(mocks.persist).toHaveBeenCalledTimes(3);
    await act(async () => {
      replies[0]!.resolve({
        response: { transportVersion: 9, state: 'not-authorized' },
        serverMs: null,
      });
    });
    expect(flow.loading).toBe(true);
    await act(async () => {
      replies[2]!.resolve(confirmed());
    });
    expect(flow.persistence['file:2']?.state).toBe('completed');
    expect(flow.loading).toBe(true);
    await act(async () => {
      replies[1]!.resolve({
        response: { transportVersion: 9, state: 'unavailable' },
        serverMs: null,
      });
      await done;
    });
    expect(mocks.persist).toHaveBeenCalledTimes(3);
    expect(mocks.audit).toHaveBeenCalledTimes(3);
    expect(flow.persistence['file:0']?.state).toBe('auth-required');
    expect(flow.persistence['file:1']?.state).toBe('confirmation-required');
    expect(flow.pendingPersistenceCount).toBe(4);
    expect(flow.error).toContain('incerta');
    mocks.persist.mockClear().mockResolvedValue(confirmed());
    await act(async () => {
      const resumed = flow.resumePendingPersistence();
      await vi.runAllTimersAsync();
      await resumed;
    });
    expect(mocks.persist).toHaveBeenCalledTimes(4);
    expect(
      mocks.persist.mock.calls.some(([value]) => value.manifest.fileName === 'sintetico-2.xlsb'),
    ).toBe(false);
  });

  it('ignores late responses after unmount and does not populate a newly mounted selection', async () => {
    vi.useFakeTimers();
    const oldReply = deferred<{ response: GradebookImportPersistenceResponseV9; serverMs: null }>();
    mocks.persist.mockReturnValueOnce(oldReply.promise);
    const { done: oldDone } = await startBatch(3);
    const oldReport = flow.getTimingReport;
    await yieldLocalPreparation();
    await act(async () => root.unmount());
    expect(JSON.parse(oldReport()).runs).toEqual([]);
    root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    mocks.read.mockResolvedValue(recognized([result(50)]));
    mocks.persist.mockResolvedValue(confirmed());
    await act(async () => flow.handleFiles(files(1)));
    const currentReport = flow.getTimingReport();
    const logs = vi.mocked(console.info).mock.calls.length;
    await act(async () => {
      oldReply.resolve({ response: { transportVersion: 9, state: 'unavailable' }, serverMs: null });
      await oldDone;
    });
    expect(flow.results.map((value) => value.id)).toEqual(['file:50']);
    expect(Object.keys(flow.persistence)).toEqual(['file:50']);
    expect(flow.persistence['file:50']?.state).toBe('completed');
    expect(flow.error).toBeNull();
    expect(flow.loading).toBe(false);
    expect(vi.mocked(console.info).mock.calls).toHaveLength(logs);
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(flow.getTimingReport()).toBe(currentReport);
  });

  it('separates audit network time from canonical build and records academic POST/confirmation milestones', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    mocks.audit.mockImplementation(async () => {
      clock += 80;
      return { version: 1, state: 'recorded', affected: 0 };
    });
    mocks.compact.mockImplementation((input: BatchSuccess) => {
      clock += 3;
      return request(input);
    });
    mocks.persist.mockImplementation(async (_value, onTiming, onDispatch) => {
      onDispatch?.();
      clock += 5;
      onTiming?.({
        serializationMs: 0,
        payloadBytes: 100,
        persistRequestMs: 5,
        outcome: 'no-changes',
      });
      return confirmed();
    });
    await act(async () => flow.handleFiles(files(1)));
    const timings = vi
      .mocked(console.info)
      .mock.calls.map((call) => JSON.parse(String(call[1])) as Record<string, unknown>);
    expect(timings.find((value) => value.stage === 'audit-request')).toMatchObject({
      auditRequestMs: 80,
      outcome: 'recorded',
    });
    expect(timings.find((value) => value.stage === 'canonical-file')).toMatchObject({
      version: 2,
      diagnosticLocalMs: 0,
      canonicalBuildMs: 3,
      totalMs: 83,
    });
    expect(timings.find((value) => value.stage === 'persistence-dispatch')).toMatchObject({
      queueWaitMs: 0,
    });
    expect(timings.find((value) => value.stage === 'batch-complete')).toMatchObject({
      firstPersistenceStartedMs: 83,
      firstConfirmedPersistenceMs: 88,
      batchElapsedMs: 88,
      maximumPreparedItems: 1,
      maximumActiveYearLanes: 1,
      confirmedRequests: 1,
    });
  });

  it('preserves confirmed persistence when the optional browser logger fails', async () => {
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error('synthetic-logger-failed');
    });
    await act(async () => flow.handleFiles(files(1)));
    expect(Object.values(flow.persistence).every((value) => value.state === 'completed')).toBe(
      true,
    );
    expect(flow.error).toBeNull();
    expect(report().runs[0]!.diagnosticFailures).toBeGreaterThan(0);
    expect(report().runs[0]!.coverage.measurementStatus).toBe('partial');
  });

  it('G-T17–19 keeps private sentinels out of export/console and identical remote operations with a failing logger', async () => {
    const sentinel = 'PRIVATE-SYNTHETIC-SENTINEL';
    const value = {
      ...result(0),
      id: sentinel,
      manifest: { ...result(0).manifest, fileName: sentinel, sha256: sentinel },
    } as BatchSuccess;
    mocks.read.mockImplementation(async (_input, _xlsx, _progress, runtime) => {
      runtime.onFileTiming({
        fileIndex: 0,
        outcome: 'recognized',
        fileName: sentinel,
        hash: sentinel,
      });
      return recognized([value]);
    });
    mocks.compact.mockImplementation((input) => ({ ...request(input), professor: sentinel }));
    mocks.persist.mockImplementation(async (_request, onTiming, onDispatch) => {
      onDispatch();
      onTiming({ persistRequestMs: 1, request: sentinel, response: sentinel, error: sentinel });
      return { response: { transportVersion: 9, state: 'blocked', reason: sentinel }, serverMs: 1 };
    });
    await act(async () => flow.handleFiles(files(1)));
    const firstAudit = mocks.audit.mock.calls[0]![0];
    const firstRequest = mocks.persist.mock.calls[0]![0];
    const firstState = flow.persistence[sentinel];
    expect(flow.getTimingReport()).not.toContain(sentinel);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(sentinel);
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error(sentinel);
    });
    await act(async () => flow.handleFiles(files(1)));
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(mocks.audit.mock.calls[1]![0]).toEqual(firstAudit);
    expect(mocks.persist.mock.calls[1]![0]).toEqual(firstRequest);
    expect(flow.persistence[sentinel]).toEqual(firstState);
    expect(flow.getTimingReport()).not.toContain(sentinel);
  });

  it('treats server no-changes as a completed identical reimport without academic writes', async () => {
    await act(async () => flow.handleFiles(files(18)));
    expect(mocks.compact).toHaveBeenCalledTimes(18);
    expect(mocks.persist).toHaveBeenCalledTimes(18);
    expect(Object.values(flow.persistence)).toHaveLength(18);
    expect(Object.values(flow.persistence).every((state) => state.state === 'completed')).toBe(
      true,
    );
    expect(
      Object.values(flow.persistence).every(
        (state) => state.state !== 'completed' || state.response.state === 'no-changes',
      ),
    ).toBe(true);
    expect(flow.pendingPersistenceCount).toBe(0);
  });

  it('audits a Relação only after its first materialization is confirmed', async () => {
    const base = result(0);
    const relation = {
      ...base,
      summary: { ...base.summary, masterRelationV9: { turmas: [] } },
    } as BatchSuccess;
    mocks.read.mockResolvedValue(recognized([relation]));
    mocks.compact.mockImplementationOnce((input: BatchSuccess) => ({
      transportVersion: 9,
      operation: 'persist-relacao',
      manifest: {
        fileName: input.manifest.fileName,
        sha256: input.manifest.sha256,
        parserVersion: 'synthetic:canonical-v9',
      },
      ano: input.summary.academicYear ?? 2026,
      turmas: [],
    }));
    await act(async () => flow.handleFiles(files(1)));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mocks.persist.mock.invocationCallOrder[0]!,
    );
    expect(flow.persistence['file:0']?.state).toBe('completed');
  });

  it.each([false, true])(
    'preserves an applied relation receipt after re-audit403 and resumes only its follow-up plus pending teachers (relationOnly=%s)',
    async (relationOnly) => {
      const values = relationOnly ? [relationResult(0)] : [relationResult(0), result(1)];
      mocks.read.mockResolvedValue(recognized(values));
      mocks.compact.mockImplementation((value) =>
        value.id === 'file:0' ? relationRequest(value) : request(value),
      );
      mocks.audit.mockResolvedValueOnce({ version: 1, state: 'not-authorized' });
      const applied = {
        ...confirmed(),
        response: { ...confirmed().response, state: 'applied' as const },
      };
      mocks.persist.mockResolvedValue(applied);
      await act(async () => flow.handleFiles(files(values.length)));
      expect(flow.persistence['file:0']).toMatchObject({
        state: 'completed',
        response: { state: 'applied' },
      });
      expect(flow.authorizationRequired).toBe(true);
      expect(flow.diagnosticAuditFailures['file:0']).toBeTruthy();
      expect(mocks.persist).toHaveBeenCalledTimes(1);
      expect(mocks.refreshYears).not.toHaveBeenCalled();
      expect(flow.pendingPersistenceCount).toBe(values.length);
      mocks.persist.mockClear().mockResolvedValue(confirmed());
      mocks.audit.mockResolvedValue({ version: 1, state: 'recorded', affected: 0 });
      await act(async () => flow.resumePendingPersistence());
      expect(mocks.persist).toHaveBeenCalledTimes(relationOnly ? 0 : 1);
      expect(mocks.persist.mock.calls.every(([value]) => value.operation === 'persist-notas')).toBe(
        true,
      );
      expect(mocks.refreshYears).toHaveBeenCalledWith(2026);
      if (!relationOnly)
        expect(mocks.refreshYears.mock.invocationCallOrder[0]!).toBeLessThan(
          mocks.persist.mock.invocationCallOrder[0]!,
        );
      expect(flow.persistence['file:0']).toMatchObject({
        state: 'completed',
        response: { state: 'applied' },
      });
      expect(flow.authorizationRequired).toBe(false);
      expect(flow.pendingPersistenceCount).toBe(0);
      expect(flow.diagnosticAuditFailures['file:0']).toBeUndefined();
      if (relationOnly)
        expect(lastBatchTiming()).toMatchObject({
          firstPersistenceStartedMs: null,
          firstConfirmedPersistenceMs: null,
          confirmedRequests: 0,
        });
    },
  );

  it.each([1, 18, 50])(
    'imports %i same-year selected files sequentially with per-file canonicalization',
    async (count) => {
      let active = 0;
      let maximum = 0;
      mocks.persist.mockImplementation(async () => {
        active++;
        maximum = Math.max(maximum, active);
        sequence.push('send');
        await new Promise((resolve) => setTimeout(resolve, 0));
        active--;
        return confirmed();
      });
      await act(async () => flow.handleFiles(files(count)));
      expect(mocks.persist).toHaveBeenCalledTimes(count);
      expect(mocks.persist.mock.calls.every(([value]) => value.transportVersion === 9)).toBe(true);
      expect(maximum).toBe(1);
      expect(sequence.filter((value) => value.startsWith('compact:'))).toHaveLength(count);
      expect(sequence.filter((value) => value === 'send')).toHaveLength(count);
      expect(Object.values(flow.persistence).every((state) => state.state === 'completed')).toBe(
        true,
      );
      expect(flow.pendingPersistenceCount).toBe(0);
    },
  );

  it('allows different academic years to use separate bounded lanes', async () => {
    mocks.read.mockResolvedValue({
      successes: [result(0, 2026), result(1, 2027), result(2, 2026), result(3, 2027)],
      failureDetails: [],
    });
    const activeByYear = new Map<number, number>();
    let totalActive = 0;
    let maximumTotal = 0;
    let maximumSameYear = 0;
    mocks.persist.mockImplementation(async (value: GradebookImportPersistenceRequestV9) => {
      const sameYear = (activeByYear.get(value.ano) ?? 0) + 1;
      activeByYear.set(value.ano, sameYear);
      totalActive++;
      maximumTotal = Math.max(maximumTotal, totalActive);
      maximumSameYear = Math.max(maximumSameYear, sameYear);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeByYear.set(value.ano, sameYear - 1);
      totalActive--;
      return confirmed();
    });

    await act(async () => flow.handleFiles(files(4)));

    expect(maximumSameYear).toBe(1);
    expect(maximumTotal).toBe(2);
    expect(maximumTotal).toBeLessThanOrEqual(GRADEBOOK_IMPORT_FILE_CONCURRENCY_V1);
    expect(flow.pendingPersistenceCount).toBe(0);
  });

  it('preserves confirmed files, pauses an uncertain commit, and resumes only the pending selection', async () => {
    let attempts = 0;
    mocks.persist.mockImplementation(async () => {
      if (++attempts === 3) throw new TypeError('synthetic lost reply');
      return confirmed();
    });
    await act(async () => flow.handleFiles(files(18)));
    const firstWaveCalls = mocks.persist.mock.calls.length;
    expect(firstWaveCalls).toBe(3);
    expect(firstWaveCalls).toBeLessThan(18);
    expect(flow.persistence['file:0']?.state).toBe('completed');
    expect(flow.persistence['file:1']?.state).toBe('completed');
    expect(flow.persistence['file:2']?.state).toBe('confirmation-required');
    expect(flow.pendingPersistenceCount).toBe(19 - firstWaveCalls);
    expect(flow.progress).toBeNull();
    expect(mocks.compact).toHaveBeenCalledTimes(firstWaveCalls);
    const pendingBeforeResume = flow.pendingPersistenceCount;
    mocks.persist.mockClear();
    mocks.persist.mockResolvedValue(confirmed());
    await act(async () => flow.resumePendingPersistence());
    expect(mocks.persist).toHaveBeenCalledTimes(pendingBeforeResume);
    expect(mocks.persist.mock.calls[0]![0].manifest.fileName).toBe('sintetico-2.xlsb');
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(flow.pendingPersistenceCount).toBe(0);
  });

  it('pauses at session expiry without sending the unscheduled rest', async () => {
    let calls = 0;
    mocks.persist.mockImplementation(async () =>
      ++calls === 2
        ? { response: { transportVersion: 9, state: 'not-authorized' }, serverMs: null }
        : confirmed(),
    );
    await act(async () => flow.handleFiles(files(18)));
    const firstWaveCalls = mocks.persist.mock.calls.length;
    expect(firstWaveCalls).toBe(2);
    expect(firstWaveCalls).toBeLessThan(18);
    expect(flow.authorizationRequired).toBe(true);
    expect(flow.pendingPersistenceCount).toBe(19 - firstWaveCalls);
    expect(flow.persistence['file:0']?.state).toBe('completed');
    expect(flow.persistence['file:1']?.state).toBe('auth-required');
    expect(flow.progress).toBeNull();
  });

  it('retains prepared files after an unavailable response and permits an explicit retry', async () => {
    mocks.persist.mockResolvedValueOnce({
      response: { transportVersion: 9, state: 'unavailable' },
      serverMs: null,
    });
    await act(async () => flow.handleFiles(files(18)));
    const firstWaveCalls = mocks.persist.mock.calls.length;
    expect(firstWaveCalls).toBe(1);
    expect(firstWaveCalls).toBeLessThan(18);
    expect(flow.pendingPersistenceCount).toBe(18);
    expect(flow.persistence['file:0']?.state).toBe('confirmation-required');
    expect(flow.persistence['file:1']?.state).toBe('recognized');
    expect(flow.progress).toBeNull();
    const pendingBeforeResume = flow.pendingPersistenceCount;
    mocks.persist.mockClear();
    mocks.persist.mockResolvedValue(confirmed());
    await act(async () => flow.resumePendingPersistence());
    expect(mocks.persist).toHaveBeenCalledTimes(pendingBeforeResume);
    expect(flow.pendingPersistenceCount).toBe(0);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('isolates a local validation failure instead of aborting unrelated valid teacher files', async () => {
    mocks.compact.mockImplementation((input: BatchSuccess) => {
      if (input.id === 'file:1') throw new Error('synthetic invalid file');
      return request(input);
    });
    await act(async () => flow.handleFiles(files(3)));
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(flow.persistence['file:1']?.state).toBe('failed');
    expect(flow.persistence['file:2']?.state).toBe('completed');
  });

  it('prevents two same-tick selections from starting concurrent imports', async () => {
    await act(async () => {
      await Promise.all([flow.handleFiles(files(3)), flow.handleFiles(files(3))]);
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledTimes(3);
  });

  it('keeps all selected files pending when the first server response is unavailable', async () => {
    mocks.persist.mockResolvedValue({
      response: { transportVersion: 9, state: 'unavailable' },
      serverMs: null,
    });
    await act(async () => flow.handleFiles(files(3)));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(flow.pendingPersistenceCount).toBe(3);
    expect(flow.persistence['file:0']?.state).toBe('confirmation-required');
    expect(flow.persistence['file:1']?.state).toBe('recognized');
    expect(flow.persistence['file:2']?.state).toBe('recognized');
    expect(flow.progress).toBeNull();
  });

  it('does not discard a resumable selection when a new selection exceeds 50 files', async () => {
    mocks.persist.mockRejectedValueOnce(new TypeError('synthetic lost reply'));
    await act(async () => flow.handleFiles(files(3)));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    await act(async () => flow.handleFiles(files(51)));
    expect(flow.results).toHaveLength(3);
    expect(flow.pendingPersistenceCount).toBe(3);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it('I-A carries the validated client callback into G at the original position, without another POST', async () => {
    const rows = emptyImportCommitAffectedRowsV1();
    rows.professor.update = 1;
    const diagnostic = {
      version: 1,
      scope: 'direct-import-statements',
      coverage: 'complete',
      transaction: 'committed',
      attempted: rows,
      confirmed: rows,
      unmeasuredStatements: 0,
      excludedEffects: 'sql-functions-triggers-portal',
    };
    mocks.persist.mockImplementation(async (value, onTiming, onDispatch) => {
      onDispatch?.();
      onTiming?.({
        persistRequestMs: 5,
        outcome: 'no-changes',
        commitDiagnostics: value.manifest.fileName === 'sintetico-6.xlsb' ? diagnostic : null,
      });
      return confirmed();
    });
    await act(async () => flow.handleFiles(files(18)));
    const copied = JSON.parse(flow.getTimingReport());
    expect(copied.runs[0].files[6].commitDiagnostics).toEqual(diagnostic);
    expect(
      copied.runs[0].files.filter(
        (file: { commitDiagnostics: unknown }) => file.commitDiagnostics !== null,
      ),
    ).toHaveLength(1);
    expect(mocks.persist).toHaveBeenCalledTimes(18);
    expect(flow.pendingPersistenceCount).toBe(0);
  });
});
