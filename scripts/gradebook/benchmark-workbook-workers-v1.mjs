import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { build } from 'esbuild';
import {
  codecPart,
  describeWorkbook,
  equalValue,
  largerTeacher,
  writeFixture,
} from './reader-comparison-v1.mjs';

const REPORT_LIMITATIONS = [
  'Synthetic corpus; no explanation of historical sourceFileIndex6 applied or productive 20874.7ms.',
  'UI SheetJS is preloaded to generate valid fixtures; fresh workers include boot/evaluation in every timed round. First timed sample is after equivalence and cache warm-up, not a cold browser first visit.',
  'Binary source/parsed dimension and formula counts expose H codec fixture gaps; no invented binary cache coverage.',
  'Deep comparison remains in-browser only: summaries, diagnostics, canonical requests, failures, manifests and ordered batch results are never exported.',
  'Parallel internal parse/evaluation sums are not batch wall time, CPU or speedup fractions. No cross-context timestamps are subtracted.',
  'Interval/rAF probes include the final pending gap; these responsiveness observations are separate from duration.',
  'performance.memory covers the main context when available; worker heap/OOM bounds are unknown. Input compressed bytes are not heap.',
  'No real files, database, authentication, remote academic concurrency or production requests.',
];

/** Same H corpus/codecs, with the real sparse product reader and emitted worker. */
async function compareWorkbookWorkersV1(reader, xlsx, workerUrl, onProgress, reportLimitations) {
  if (xlsx.version !== '0.20.3') throw new Error('library-version');
  // Everything this function uses is declared inside it: the runner embeds it as text.
  /** How a worker's answer ended: a read error, a canonical error, or a request. */
  function outcomeOf(value) {
    if (value.readError) return 'read-error';
    return value.canonicalError ? 'canonical-error' : 'request';
  }
  const now = () => new Date('2026-10-02T12:00:00.000Z');
  const variants = ['W0', 'W1', 'W2'];
  let generation = 0;
  const equivalent = [];
  const entries = [];
  const initializations = [];
  const teacher = reader.WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === 'teacher');
  const corpus = [
    ...reader.WORKBOOK_READER_EQUIVALENCE_CASES_V1,
    { id: 'benchmark-9offers', workbook: largerTeacher(teacher.workbook, 2026) },
    { id: 'benchmark-9offers-2025', workbook: largerTeacher(teacher.workbook, 2025) },
  ];
  const makeClient = (variant, onReady = () => {}, onFallback = () => {}) =>
    variant === 'W0'
      ? null
      : new reader.WorkbookWorkerClientV1({
          generation: ++generation,
          concurrency: variant === 'W2' ? 2 : 1,
          workerFactory: () => new Worker(workerUrl, { type: 'module' }),
          fallbackLibrary: async () => xlsx,
          onReady,
          onFallback,
        });
  function canonical(result) {
    if (!result.summary) return { ...result, diagnostics: undefined, request: undefined };
    const source = {
      id: 'import-file:worker-equivalence',
      manifest: result.manifest,
      summary: result.summary,
    };
    const diagnostics = reader.collectGradebookImportDiagnosticsV1(source);
    let request;
    let canonicalError;
    try {
      request = reader.createGradebookCanonicalImportRequestV9(source);
    } catch (cause) {
      canonicalError = cause instanceof Error ? cause.message : String(cause);
    }
    return { ...result, diagnostics, request, canonicalError };
  }
  async function readEntry(item, index, client) {
    let timing = null;
    let summary;
    let readError;
    const started = performance.now();
    try {
      summary = client
        ? await client.read(item.file, item.data.slice(0), item.manifest, index, true, (value) => {
            timing = value;
          })
        : reader.readWorkbookData(
            item.file,
            item.data,
            xlsx,
            item.manifest,
            (value) => {
              timing = value;
            },
            true,
          );
    } catch (cause) {
      readError = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      summary,
      readError,
      manifest: item.manifest,
      timing,
      roundTripMs: performance.now() - started,
    };
  }
  /** Each corpus workbook in each format, or the codec gap that prevents it. */
  async function prepareFixtures(source) {
    for (const format of ['xlsx', 'xlsb', 'xls']) {
      const fixture = writeFixture(xlsx, source, format);
      if (fixture.gap) {
        equivalent.push({
          ordinal: equivalent.length,
          format,
          equivalent: null,
          stage: 'codec-generation',
          bytes: null,
          source: describeWorkbook(source.workbook),
          parsed: null,
          outcome: 'unavailable',
        });
        continue;
      }
      codecPart(xlsx, fixture.data, format);
      const file = new File([fixture.data], `synthetic-${source.id}.${format}`, {
        lastModified: now().getTime(),
      });
      const manifest = await reader.createSourceFileManifest(file, fixture.data, xlsx.version, {
        now,
      });
      entries.push({ id: source.id, format, file, data: fixture.data, manifest });
      const parsed = xlsx.read(fixture.data, reader.WORKBOOK_READ_OPTIONS);
      equivalent.push({
        ordinal: entries.length - 1,
        format,
        equivalent: true,
        stage: 'complete',
        bytes: fixture.data.byteLength,
        source: describeWorkbook(source.workbook),
        parsed: describeWorkbook(parsed),
        outcome: null,
      });
    }
  }
  for (const source of corpus) await prepareFixtures(source);
  // One bounded product client per preflight mode; timed rounds create fresh clients.
  const reference = [];
  /** One preflight mode: every entry read again and compared with W0's output. */
  async function checkEquivalence(variant) {
    onProgress(`equivalence/${variant}`);
    let fallbackCount = 0;
    const client = makeClient(
      variant,
      (parentMs, libraryEvaluationSumMs, workers) => {
        initializations.push({
          variant,
          phase: variant === 'W1' ? 'first-worker-load' : 'warm-worker-resource-cache',
          parentMs,
          libraryEvaluationSumMs,
          workers,
        });
      },
      () => {
        fallbackCount++;
      },
    );
    try {
      await client?.initialize();
      for (let index = 0; index < entries.length; index++) {
        const measured = await readEntry(entries[index], index, client);
        const { timing, roundTripMs, ...value } = canonical(measured);
        void timing;
        void roundTripMs;
        if (variant === 'W0') reference[index] = value;
        else equalValue(reference[index], value, 'worker-equivalence');
        equivalent.find((item) => item.ordinal === index && item.stage === 'complete').outcome =
          outcomeOf(value);
      }
      if (fallbackCount > 0) throw new Error('worker-fallback');
    } finally {
      client?.close();
    }
  }
  for (const variant of variants) await checkEquivalence(variant);
  const teachers = entries.filter((item) => item.id.startsWith('benchmark-9offers'));
  const relations = entries.filter((item) => item.id === 'relation');
  const scenarios = [
    {
      scenario: 'single-xlsb',
      items: [teachers.find((item) => item.format === 'xlsb' && item.id === 'benchmark-9offers')],
    },
    ...[18, 50].map((count) => {
      const items = Array.from({ length: count }, (_, index) => teachers[index % teachers.length]);
      items[count - 1] = relations[count % relations.length];
      return { scenario: `batch-${count}`, items };
    }),
  ];
  reference.length = 0;
  entries.length = 0;
  corpus.length = 0;
  const samples = [];
  const referenceOutputs = new Map();
  const nullableSum = (values) =>
    values.some((value) => value === null || value === undefined)
      ? null
      : values.reduce((sum, value) => sum + value, 0);
  function uiProbe() {
    const interval = 16;
    let previousTick = performance.now();
    let previousFrame = previousTick;
    let maximumIntervalDelay = 0;
    let maximumFrameGap = 0;
    let ticks = 0;
    let frames = 0;
    const heap = () =>
      Number.isFinite(performance.memory?.usedJSHeapSize)
        ? performance.memory.usedJSHeapSize
        : null;
    const heapStart = heap();
    let heapPeak = heapStart;
    const timer = setInterval(() => {
      const clock = performance.now();
      maximumIntervalDelay = Math.max(maximumIntervalDelay, clock - previousTick - interval, 0);
      previousTick = clock;
      ticks++;
      const currentHeap = heap();
      if (currentHeap !== null) heapPeak = Math.max(heapPeak ?? currentHeap, currentHeap);
    }, interval);
    let frame;
    const onFrame = () => {
      const clock = performance.now();
      maximumFrameGap = Math.max(maximumFrameGap, clock - previousFrame);
      previousFrame = clock;
      frames++;
      frame = requestAnimationFrame(onFrame);
    };
    frame = requestAnimationFrame(onFrame);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      const clock = performance.now();
      const heapEnd = heap();
      if (heapEnd !== null) heapPeak = Math.max(heapPeak ?? heapEnd, heapEnd);
      return {
        intervalMs: interval,
        intervalTicks: ticks,
        animationFrames: frames,
        maximumIntervalDelayMs: Math.max(maximumIntervalDelay, clock - previousTick - interval, 0),
        maximumAnimationFrameGapMs: Math.max(maximumFrameGap, clock - previousFrame),
        mainHeapStartBytes: heapStart,
        mainHeapSampledPeakBytes: heapPeak,
        mainHeapEndBytes: heapEnd,
        workerHeapBytes: null,
      };
    };
  }
  /** The canonical form of a measured read, without its timings. */
  function canonicalOutput(batch, output) {
    if (batch) {
      if (batch.failures.length !== 0) throw new Error('measured-read-failure');
      return batch.successes.map((result) =>
        canonical({ summary: result.summary, manifest: result.manifest, readError: undefined }),
      );
    }
    return output.map((result) => {
      const { timing, roundTripMs, ...value } = canonical(result);
      void timing;
      void roundTripMs;
      return value;
    });
  }
  async function measureScenario(scenario, cut, round, variant) {
    const stopProbe = uiProbe();
    const startedAt = performance.now();
    let initializationMs = 0;
    let workerLibraryEvaluationSumMs = variant === 'W0' ? null : 0;
    let activeWorkers = 0;
    let fallbackCount = 0;
    let maximumActiveLocalInputs = 0;
    let maximumActiveInputBytes = 0;
    let inputByteBudget = null;
    let batch;
    let output;
    const perFile = [];
    const client = makeClient(
      variant,
      (duration, evaluationMs, workers) => {
        initializationMs = duration;
        workerLibraryEvaluationSumMs = evaluationMs;
        activeWorkers = workers;
      },
      () => {
        fallbackCount++;
      },
    );
    /** Prepared bytes read with the product's capacity and byte budget, without File or hash. */
    async function readFixedBytes(localStartedAt) {
      const outcomes = [];
      const active = new Map();
      let nextIndex = 0;
      const capacity = client?.concurrency ?? 1;
      inputByteBudget = client?.inputByteBudget ?? null;
      while (nextIndex < scenario.items.length || active.size > 0) {
        const bytes = [...active.values()].reduce((sum, value) => sum + value, 0);
        const next = scenario.items[nextIndex];
        if (
          next &&
          active.size < capacity &&
          (active.size === 0 ||
            inputByteBudget === null ||
            bytes + next.data.byteLength <= inputByteBudget)
        ) {
          const index = nextIndex++;
          const queueMs = performance.now() - localStartedAt;
          const task = readEntry(next, index, client)
            .then((result) => {
              outcomes[index] = result;
              perFile[index] = {
                ...result,
                roundTripMs: client ? result.roundTripMs : null,
                queueMs: client ? queueMs : null,
                fileReadMs: null,
                manifestMs: null,
              };
            })
            .finally(() => active.delete(task));
          active.set(task, next.data.byteLength);
          maximumActiveLocalInputs = Math.max(maximumActiveLocalInputs, active.size);
          maximumActiveInputBytes = Math.max(maximumActiveInputBytes, bytes + next.data.byteLength);
        } else await Promise.race(active.keys());
      }
      return outcomes;
    }
    try {
      await client?.initialize();
      const localStartedAt = performance.now();
      if (cut === 'file-and-hash') {
        batch = await reader.importWorkbookBatch(
          scenario.items.map((item) => item.file),
          xlsx,
          () => {},
          {
            now,
            captureValues: true,
            ...(client ? { localExecutor: client } : {}),
            onLocalTiming: (value) => {
              maximumActiveLocalInputs = value.maximumActiveLocalInputs;
              maximumActiveInputBytes = value.maximumActiveInputBytes;
              inputByteBudget = value.inputByteBudget;
            },
            onStageProgress: (progress) => {
              if (!client && progress.stage === 'preparing') {
                maximumActiveLocalInputs = Math.max(maximumActiveLocalInputs, 1);
                maximumActiveInputBytes = Math.max(
                  maximumActiveInputBytes,
                  scenario.items[progress.current - 1].file.size,
                );
              }
            },
            onFileTiming: (value) =>
              (perFile[value.fileIndex] = {
                timing: {
                  totalMs: value.workbookReadMs,
                  xlsxReadMs: value.xlsxReadMs,
                  masterRelationRecognitionMs: value.masterRelationRecognitionMs,
                  recognizeWorkbookMs: value.recognizeWorkbookMs,
                },
                roundTripMs: client ? value.workerRoundTripMs : null,
                queueMs: value.localQueueMs ?? null,
                fileReadMs: value.fileReadMs,
                manifestMs: value.manifestMs,
              }),
          },
        );
      } else output = await readFixedBytes(localStartedAt);
      const localReadMs = performance.now() - localStartedAt;
      const canonicalStartedAt = performance.now();
      output = canonicalOutput(batch, output);
      const canonicalMs = performance.now() - canonicalStartedAt;
      if (output.some((item) => item.readError || item.canonicalError))
        throw new Error('measured-canonical-failure');
      if (fallbackCount > 0) throw new Error('worker-fallback');
      client?.close();
      const elapsedMs = performance.now() - startedAt;
      const responsiveness = stopProbe();
      // Validation is outside the measured interval, equally for all three modes.
      const comparisonKey = `${scenario.scenario}/${cut}`;
      if (variant === 'W0' && !referenceOutputs.has(comparisonKey))
        referenceOutputs.set(comparisonKey, { output, batch });
      else
        equalValue(
          referenceOutputs.get(comparisonKey),
          { output, batch },
          'measured-output-equivalence',
        );
      return {
        scenario: scenario.scenario,
        cut,
        variant,
        round,
        phase: round === 0 ? 'first-timed-after-preflight' : 'warm',
        files: scenario.items.length,
        inputBytes: scenario.items.reduce((sum, item) => sum + item.data.byteLength, 0),
        elapsedMs,
        initializationMs,
        workerLibraryEvaluationSumMs,
        localReadMs,
        canonicalMs,
        xlsxReadSumMs: nullableSum(perFile.map((item) => item.timing?.xlsxReadMs ?? null)),
        workbookReadSumMs: nullableSum(perFile.map((item) => item.timing?.totalMs ?? null)),
        masterRelationRecognitionSumMs: nullableSum(
          perFile.map((item) => item.timing?.masterRelationRecognitionMs ?? null),
        ),
        recognizeWorkbookSumMs: nullableSum(
          perFile.map((item) => item.timing?.recognizeWorkbookMs ?? null),
        ),
        workerRoundTripSumMs: nullableSum(perFile.map((item) => item.roundTripMs ?? null)),
        workerRoundTripOverheadSumMs: client
          ? nullableSum(
              perFile.map((item) =>
                Number.isFinite(item.roundTripMs) && Number.isFinite(item.timing?.totalMs)
                  ? Math.max(0, item.roundTripMs - item.timing.totalMs)
                  : null,
              ),
            )
          : null,
        maximumQueueMs: client ? Math.max(...perFile.map((item) => item.queueMs ?? 0)) : null,
        fileReadSumMs: nullableSum(perFile.map((item) => item.fileReadMs)),
        manifestSumMs: nullableSum(perFile.map((item) => item.manifestMs)),
        activeWorkers,
        maximumActiveLocalInputs,
        maximumActiveInputBytes,
        inputByteBudget,
        fallbackCount,
        ...responsiveness,
      };
    } finally {
      client?.close();
      stopProbe();
    }
  }
  // 3 scenarios × 2 cost cuts × 6 rounds × 3 modes = 108 timed samples.
  /** Six rounds of one scenario and cut, alternating the order of the modes. */
  async function runRounds(scenario, cut) {
    for (let round = 0; round <= 5; round++) {
      const order = round % 2 === 0 ? variants : [...variants].reverse();
      for (const variant of order) {
        onProgress(`${scenario.scenario}/${cut}/${round}/${variant}`);
        samples.push(await measureScenario(scenario, cut, round, variant));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  for (const scenario of scenarios)
    for (const cut of ['fixed-bytes', 'file-and-hash']) await runRounds(scenario, cut);
  const statistics = [];
  const median = (values) =>
    [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
  /** The warm rounds of one scenario, cut and mode: duration and responsiveness. */
  function summarize(scenario, cut, variant) {
    const warm = samples.filter(
      (sample) =>
        sample.scenario === scenario.scenario &&
        sample.cut === cut &&
        sample.variant === variant &&
        sample.phase === 'warm',
    );
    statistics.push({
      scenario: scenario.scenario,
      cut,
      variant,
      minMs: Math.min(...warm.map((sample) => sample.elapsedMs)),
      medianMs: median(warm.map((sample) => sample.elapsedMs)),
      maxMs: Math.max(...warm.map((sample) => sample.elapsedMs)),
      medianIntervalDelayMs: median(warm.map((sample) => sample.maximumIntervalDelayMs)),
      medianAnimationFrameGapMs: median(warm.map((sample) => sample.maximumAnimationFrameGapMs)),
    });
  }
  for (const scenario of scenarios)
    for (const cut of ['fixed-bytes', 'file-and-hash'])
      for (const variant of variants) summarize(scenario, cut, variant);
  return {
    reportVersion: 1,
    libraryVersion: xlsx.version,
    recordedAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
    },
    protocol: {
      timedSamples: 108,
      warmPairedRounds: 5,
      firstTimedRoundAfterPreflight: true,
      libraryUiPreloadedForFixtureGeneration: true,
      freshWorkersPerRound: true,
      sparseReaderUnchanged: true,
      responsiveness: 'interval16ms-and-rAF-gaps-in-parent-with-final-tail',
      heapCoverage: 'main-context-observable-only-workers-unavailable',
      fixedBytes:
        'prepared-manifest-and-bytes; per-active-worker-transfer-copy-included; no-File/hash/yield',
      fullFile: 'real-importWorkbookBatch-File-arrayBuffer-hash-yield-with-localExecutor',
    },
    limitations: reportLimitations,
    initializations,
    equivalence: equivalent,
    samples,
    statistics,
  };
}

const root = process.cwd();
// Rejected product candidate remains reproducible in its measured commit, not enabled on main.
if (
  !(await stat(join(root, 'src/features/gradebook/import/workbook-worker-client-v1.ts')).catch(
    () => null,
  ))
) {
  throw new Error(
    'W1/W2 were rejected. Reproduce in an isolated checkout of feddac782ebf3ccf3e84ac4af7db0ebbf42f8547; build that candidate before running this comparator.',
  );
}
const cache = join(root, 'node_modules/.cache/gradebook-reader-v1');
await mkdir(cache, { recursive: true });
const source = await readFile(
  join(root, 'src/features/gradebook/import/sheetjs-source-v1.ts'),
  'utf8',
);
const version = source.match(/SHEETJS_VERSION_V1\s*=\s*'([^']+)'/u)?.[1];
const integrity = source.match(/sha384-[A-Za-z0-9+/=]+/u)?.[0];
if (version !== '0.20.3' || !integrity) throw new Error('Cannot verify fixed project library');
const library = await readFile(join(root, 'public/vendor/sheetjs/0.20.3/xlsx.full.min.js.txt'));
if (`sha384-${createHash('sha384').update(library).digest('base64')}` !== integrity)
  throw new Error('Local library integrity mismatch');
const assets = join(root, 'dist/assets');
const workerFiles = (await readdir(assets)).filter((name) =>
  /^workbook-reader\.worker-[A-Za-z0-9_-]+\.js$/u.test(name),
);
if (workerFiles.length !== 1)
  throw new Error('Build the final product first; expected one emitted worker');
const workerPath = `/assets/${workerFiles[0]}`;
const worker = await readFile(join(assets, workerFiles[0]));
const headerSource = await readFile(join(root, 'public/_headers'), 'utf8');
const globalHeaderBlock = headerSource.match(/^\/\*\r?\n([\s\S]*?)(?=\r?\n[^\s])/u)?.[1];
if (!globalHeaderBlock) throw new Error('Cannot read production header block');
const securityHeaders = Object.fromEntries(
  globalHeaderBlock
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => {
      const [name, ...values] = line.trim().split(':');
      return [name, values.join(':').trim()];
    }),
);
if (!securityHeaders['Content-Security-Policy']) throw new Error('Production CSP missing');
const gitExecutable =
  process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git';
const git = (...args) => execFileSync(gitExecutable, args, { cwd: root, encoding: 'utf8' }).trim();
const metadata = {
  headSha: git('rev-parse', 'HEAD'),
  treeSha: git('rev-parse', 'HEAD^{tree}'),
  workingTreeModified: git('status', '--porcelain').length > 0,
  preparedAt: new Date().toISOString(),
  workerBuildAt: (await stat(join(assets, workerFiles[0]))).mtime.toISOString(),
  libraryIntegrity: integrity,
  workerBundleSha256: createHash('sha256').update(worker).digest('hex'),
  comparatorSha256: createHash('sha256')
    .update(await readFile(join(root, 'scripts/gradebook/benchmark-workbook-workers-v1.mjs')))
    .digest('hex'),
};
const entry = `export { importWorkbookBatch } from './src/features/gradebook/import/import-batch';
export { readWorkbookData, WORKBOOK_READ_OPTIONS } from './src/features/gradebook/import/workbook-reader';
export { createSourceFileManifest } from './src/features/gradebook/import/file-manifest';
export { createGradebookCanonicalImportRequestV9 } from './src/features/gradebook/import/canonical-import-v9';
export { collectGradebookImportDiagnosticsV1 } from './src/features/gradebook/import/import-diagnostics-v1';
export { WORKBOOK_READER_EQUIVALENCE_CASES_V1 } from './tests/gradebook/fixtures/workbook-reader-equivalence-v1';
export { WorkbookWorkerClientV1 } from './src/features/gradebook/import/workbook-worker-client-v1';`;
const model = (
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  })
).outputFiles[0].contents;
metadata.modelBundleSha256 = createHash('sha256').update(model).digest('hex');
const runnerSource = `import * as reader from '/model.js';
import { codecPart, describeWorkbook, equalValue, largerTeacher, writeFixture } from './scripts/gradebook/reader-comparison-v1.mjs';
const compareWorkbookWorkersV1 = ${compareWorkbookWorkersV1.toString()};
const button=document.getElementById('run');
const progress=document.getElementById('progress');
button.addEventListener('click',async()=>{
 button.disabled=true;
 try {
  const report={...${JSON.stringify(metadata)},...await compareWorkbookWorkersV1(reader,globalThis.XLSX,${JSON.stringify(workerPath)},value=>progress.textContent=value,${JSON.stringify(REPORT_LIMITATIONS)})};
  const response=await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
  if(!response.ok) throw new Error('report-save');
  document.getElementById('report').textContent=JSON.stringify({equivalent:report.equivalence.filter(item=>item.equivalent===true).length,gaps:report.equivalence.filter(item=>item.equivalent===null).length,statistics:report.statistics},null,2);
  progress.textContent='Concluído';
 } catch(cause) {
  const reasons=['library-version','worker-fallback','measured-read-failure','measured-canonical-failure','report-save'];
  document.getElementById('report').textContent=JSON.stringify({phase:progress.textContent,reason:reasons.includes(cause.message)?cause.message:'equivalence-or-harness'});
  progress.textContent='Falha técnica; nenhum resultado parcial apresentado como sucesso.';
 }
});`;
const runner = (
  await build({
    stdin: { contents: runnerSource, resolveDir: root, loader: 'js' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    external: ['/model.js'],
    write: false,
  })
).outputFiles[0].contents;
await writeFile(join(cache, 'worker-model.js'), model);
await writeFile(join(cache, 'worker-run.js'), runner);
const html = `<!doctype html><meta charset="utf-8"><title>Adendo I — workers locais</title><h1>Leitura esparsa W0/W1/W2</h1><button id="run">Executar comparador</button><p id="progress">Pronto. Execute somente na janela isolada de medição.</p><pre id="report"></pre><script src="/sheetjs.js" integrity="${integrity}"></script><script type="module" src="/run.js"></script>`;
/** An object with exactly the expected keys. */
function fields(value, expected) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
  )
    throw new Error('Invalid technical fields');
}

/** A non-negative finite number, or null. */
function metric(value) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
    throw new Error('Invalid metric');
}

function oneOf(value, allowed) {
  if (!allowed.includes(value)) throw new Error('Invalid enum');
}

/** Sheet, range, cell and formula counts of a workbook description, or null. */
function dimensions(value) {
  if (value === null) return;
  fields(value, ['sheets', 'ranges', 'cells', 'formulas']);
  for (const key of ['sheets', 'cells', 'formulas']) metric(value[key]);
  if (
    !Array.isArray(value.ranges) ||
    value.ranges.some(
      (range) =>
        range !== null &&
        (typeof range !== 'string' || !/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/u.test(range)),
    )
  )
    throw new Error('Invalid dimensions');
}

function modes(item) {
  oneOf(item.scenario, ['single-xlsb', 'batch-18', 'batch-50']);
  oneOf(item.cut, ['fixed-bytes', 'file-and-hash']);
  oneOf(item.variant, ['W0', 'W1', 'W2']);
}

function validateEnvironment(environment) {
  fields(environment, ['userAgent', 'hardwareConcurrency', 'deviceMemoryGiB']);
  if (
    typeof environment.userAgent !== 'string' ||
    environment.userAgent.length > 256 ||
    /[^\x20-\x7e]/u.test(environment.userAgent)
  )
    throw new Error('Invalid environment');
  metric(environment.hardwareConcurrency);
  metric(environment.deviceMemoryGiB);
}

function validateProtocol(protocol) {
  fields(protocol, [
    'timedSamples',
    'warmPairedRounds',
    'firstTimedRoundAfterPreflight',
    'libraryUiPreloadedForFixtureGeneration',
    'freshWorkersPerRound',
    'sparseReaderUnchanged',
    'responsiveness',
    'heapCoverage',
    'fixedBytes',
    'fullFile',
  ]);
  if (
    protocol.timedSamples !== 108 ||
    protocol.warmPairedRounds !== 5 ||
    [
      'firstTimedRoundAfterPreflight',
      'libraryUiPreloadedForFixtureGeneration',
      'freshWorkersPerRound',
      'sparseReaderUnchanged',
    ].some((key) => protocol[key] !== true)
  )
    throw new Error('Invalid protocol');
  oneOf(protocol.responsiveness, ['interval16ms-and-rAF-gaps-in-parent-with-final-tail']);
  oneOf(protocol.heapCoverage, ['main-context-observable-only-workers-unavailable']);
  oneOf(protocol.fixedBytes, [
    'prepared-manifest-and-bytes; per-active-worker-transfer-copy-included; no-File/hash/yield',
  ]);
  oneOf(protocol.fullFile, [
    'real-importWorkbookBatch-File-arrayBuffer-hash-yield-with-localExecutor',
  ]);
}

function validateEquivalenceItem(item) {
  fields(item, [
    'ordinal',
    'format',
    'equivalent',
    'stage',
    'bytes',
    'source',
    'parsed',
    'outcome',
  ]);
  metric(item.ordinal);
  metric(item.bytes);
  dimensions(item.source);
  dimensions(item.parsed);
  oneOf(item.format, ['xlsx', 'xlsb', 'xls']);
  oneOf(item.equivalent, [true, null]);
  oneOf(item.stage, ['complete', 'codec-generation']);
  oneOf(item.outcome, ['unavailable', 'read-error', 'canonical-error', 'request']);
}

const SAMPLE_FIELDS = [
  'scenario',
  'cut',
  'variant',
  'round',
  'phase',
  'files',
  'inputBytes',
  'elapsedMs',
  'initializationMs',
  'workerLibraryEvaluationSumMs',
  'localReadMs',
  'canonicalMs',
  'xlsxReadSumMs',
  'workbookReadSumMs',
  'masterRelationRecognitionSumMs',
  'recognizeWorkbookSumMs',
  'workerRoundTripSumMs',
  'workerRoundTripOverheadSumMs',
  'maximumQueueMs',
  'fileReadSumMs',
  'manifestSumMs',
  'activeWorkers',
  'maximumActiveLocalInputs',
  'maximumActiveInputBytes',
  'inputByteBudget',
  'fallbackCount',
  'intervalMs',
  'intervalTicks',
  'animationFrames',
  'maximumIntervalDelayMs',
  'maximumAnimationFrameGapMs',
  'mainHeapStartBytes',
  'mainHeapSampledPeakBytes',
  'mainHeapEndBytes',
  'workerHeapBytes',
];

/** One timed sample: its fields, a known mode and round, and no repeated combination. */
function validateSample(item, combinations) {
  fields(item, SAMPLE_FIELDS);
  modes(item);
  oneOf(item.phase, ['first-timed-after-preflight', 'warm']);
  oneOf(item.round, [0, 1, 2, 3, 4, 5]);
  for (const key of SAMPLE_FIELDS.slice(5)) metric(item[key]);
  const key = `${item.scenario}/${item.cut}/${item.variant}/${item.round}`;
  if (combinations.has(key)) throw new Error('Duplicate sample');
  combinations.add(key);
}

// Only the predefined technical report may reach disk. No workbook/source payloads.
function validateTechnicalReport(report) {
  const expectedKeys = [
    ...Object.keys(metadata),
    'reportVersion',
    'libraryVersion',
    'recordedAt',
    'environment',
    'protocol',
    'limitations',
    'initializations',
    'equivalence',
    'samples',
    'statistics',
  ];
  fields(report, expectedKeys);
  if (
    report.reportVersion !== 1 ||
    report.libraryVersion !== version ||
    report.samples?.length !== 108 ||
    !Array.isArray(report.statistics) ||
    !Array.isArray(report.equivalence)
  )
    throw new Error('Invalid report shape');
  for (const [key, value] of Object.entries(metadata))
    if (report[key] !== value) throw new Error('Code metadata mismatch');
  equalValue(report.limitations, REPORT_LIMITATIONS);
  if (
    typeof report.recordedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(report.recordedAt)
  )
    throw new Error('Invalid recording time');
  validateEnvironment(report.environment);
  validateProtocol(report.protocol);
  if (!Array.isArray(report.initializations) || report.initializations.length !== 2)
    throw new Error('Invalid initializations');
  for (const item of report.initializations) {
    fields(item, ['variant', 'phase', 'parentMs', 'libraryEvaluationSumMs', 'workers']);
    oneOf(item.variant, ['W1', 'W2']);
    oneOf(item.phase, ['first-worker-load', 'warm-worker-resource-cache']);
    for (const key of ['parentMs', 'libraryEvaluationSumMs', 'workers']) metric(item[key]);
  }
  for (const item of report.equivalence) validateEquivalenceItem(item);
  const combinations = new Set();
  for (const item of report.samples) validateSample(item, combinations);
  if (report.statistics.length !== 18) throw new Error('Invalid statistics');
  const statisticsFields = [
    'scenario',
    'cut',
    'variant',
    'minMs',
    'medianMs',
    'maxMs',
    'medianIntervalDelayMs',
    'medianAnimationFrameGapMs',
  ];
  for (const item of report.statistics) {
    fields(item, statisticsFields);
    modes(item);
    for (const key of statisticsFields.slice(3)) metric(item[key]);
  }
  return report;
}
if (process.argv.includes('--check-only'))
  console.log('Worker comparator compiled; no measurements executed.');
else {
  /** Saves only a report that passes the technical validation. */
  async function saveReport(request, response) {
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 2_000_000) throw new Error('Report bound exceeded');
      }
      const report = validateTechnicalReport(JSON.parse(body));
      const reportPath = join(cache, 'worker-browser-report.json');
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          path: reportPath,
          samples: report.samples.length,
          equivalent: report.equivalence.filter((item) => item.equivalent === true).length,
          gaps: report.equivalence.filter((item) => item.equivalent === null).length,
        }),
      );
      response.writeHead(200, securityHeaders).end('saved');
    } catch {
      response.writeHead(400, securityHeaders).end('invalid technical report');
    }
  }
  /** The page, the library, the bundles and the fixed build assets; nothing else. */
  async function staticContent(path) {
    if (path === '/') return html;
    if (path === '/sheetjs.js' || path === '/vendor/sheetjs/0.20.3/xlsx.full.min.js')
      return library;
    if (path === '/model.js') return model;
    if (path === '/run.js') return runner;
    if (/^\/assets\/[A-Za-z0-9._-]+\.js$/u.test(path)) {
      try {
        return await readFile(join(assets, path.slice('/assets/'.length)));
      } catch {
        /* Fixed build asset absent. */
      }
    }
    return undefined;
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/report' && request.method === 'POST') return saveReport(request, response);
    const content = await staticContent(path);
    response.writeHead(content === undefined ? 404 : 200, {
      ...securityHeaders,
      'Content-Type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      'Cache-Control': path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    });
    response.end(content ?? 'not found');
  });
  server.listen(0, '127.0.0.1', () =>
    console.log(
      `Local worker comparator (await exclusive measurement window): http://127.0.0.1:${server.address().port}/`,
    ),
  );
}
