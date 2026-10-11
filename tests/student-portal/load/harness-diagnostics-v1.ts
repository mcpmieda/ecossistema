import { writeFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, totalmem } from 'node:os';

// Test-only, fixed technical vocabulary. Never retain requests, bodies or exception messages.
const kinds = ['setup', 'reconciliation-stage', 'manual-denied', 'self-1', 'login-1', 'self-2', 'login-2', 'self-5', 'login-5',
  'denied', 'nat-unaffected', 'invalid-claim', 'logout', 'revoked'] as const;
type Kind = typeof kinds[number] | 'unknown';
export const HARNESS_DIAGNOSTIC_SAMPLE_LIMIT_V1 = 128;
type Sample = {
  sequence: number; kind: Kind; ms: number | null; status: number | null; bodyComplete: boolean;
  queries: number | null; rows: number | null; bytes: number | null;
  internalMs: number | null; lockTimeouts: number | null;
};
type MeasuredResponse = { status: number; headers: { get(name: string): string | null } };
export type HarnessDiagnosticStateV1 = {
  outcome: 'passed' | 'failed'; phase: 'creation' | 'scenarios' | 'validation' | 'complete' | 'cleanup';
  scenariosComplete: boolean; checks: 'not-reached' | 'failed' | 'passed';
  cleanup: 'not-created' | 'closed' | 'failed';
};
const finite = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? value : null;
function header(response: MeasuredResponse | undefined, name: string, integer = false) {
  const value = response?.headers.get(name);
  if (value == null || !value.trim() || value.length > 32) return null;
  const parsed = finite(Number(value));
  return integer && parsed !== null && !Number.isSafeInteger(parsed) ? null : parsed;
}
const maximum = (values: (number | null)[]) => {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.max(...present) : null;
};

export class HarnessDiagnosticsV1 {
  private readonly samples: Sample[] = [];
  private started = 0;
  private finished = 0;
  private collectionFailures = 0;
  begin(kind: string) {
    const sequence = ++this.started;
    if (this.samples.length === HARNESS_DIAGNOSTIC_SAMPLE_LIMIT_V1) return undefined;
    const sample: Sample = { sequence, kind: kinds.includes(kind as typeof kinds[number]) ? kind as Kind : 'unknown',
      ms: null, status: null, bodyComplete: false, queries: null, rows: null, bytes: null, internalMs: null, lockTimeouts: null };
    this.samples.push(sample);
    return sample;
  }
  finish(sample: Sample | undefined, ms: number, response?: MeasuredResponse, bytes: number | null = null) {
    this.finished++;
    if (!sample) return;
    sample.ms = finite(ms);
    sample.status = response?.status ?? null;
    sample.bodyComplete = bytes !== null;
    sample.bytes = finite(bytes);
    try {
      sample.queries = header(response, 'x-harness-queries', true);
      sample.rows = header(response, 'x-harness-rows', true);
      sample.internalMs = header(response, 'x-harness-ms');
      sample.lockTimeouts = header(response, 'x-harness-lock-timeouts', true);
    } catch { this.collectionFailures++; }
  }
  snapshot(state: HarnessDiagnosticStateV1) {
    const samples = this.samples.map(sample => ({ ...sample }));
    const report = [...new Set(samples.map(sample => sample.kind))].map(kind => {
      const values = samples.filter(sample => sample.kind === kind && sample.bodyComplete);
      const times = values.map(sample => sample.ms).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
      const percentile = (q: number) => times[Math.ceil(q * times.length) - 1] ?? null;
      return { kind, count: values.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99),
        maxQueries: maximum(values.map(sample => sample.queries)), maxRows: maximum(values.map(sample => sample.rows)),
        maxBytes: maximum(values.map(sample => sample.bytes)),
        missingQueries: values.filter(sample => sample.queries === null).length,
        missingRows: values.filter(sample => sample.rows === null).length };
    });
    let environment = null;
    try {
      const processors = cpus();
      // End-of-run snapshot, not sampled CPU, isolate heap, quota or pressure during a request.
      environment = { node: process.version, platform: process.platform, arch: process.arch,
        availableParallelism: availableParallelism(), logicalCpus: processors.length,
        cpuModel: processors[0]?.model.slice(0, 120) ?? null, totalMemoryBytes: totalmem(), freeMemoryBytesAtExport: freemem() };
    } catch { /* Host metadata is optional; retain the measurements if it is unavailable. */ }
    return { version: 1 as const, ...state,
      coverage: { started: this.started, finished: this.finished, inFlight: this.started - this.finished,
        retained: samples.length, omitted: this.started - samples.length, sampleLimit: HARNESS_DIAGNOSTIC_SAMPLE_LIMIT_V1,
        collectionFailures: this.collectionFailures,
        samples: state.scenariosComplete && this.finished === this.started && this.started === samples.length &&
          this.collectionFailures === 0 && samples.every(sample => sample.bodyComplete) ? 'complete' : 'partial' },
      environment, report, samples };
  }
}
export type HarnessDiagnosticV1 = ReturnType<HarnessDiagnosticsV1['snapshot']>;

export function emitHarnessDiagnosticV1(diagnostic: HarnessDiagnosticV1) {
  const json = JSON.stringify(diagnostic);
  const destination = process.env.PORTAL_TEST_METRICS_PATH;
  if (destination) {
    try { writeFileSync(destination, json); }
    catch {
      try { console.warn('PORTAL_SYNTHETIC_HARNESS_DIAGNOSTIC_FILE_UNAVAILABLE'); }
      catch { /* Optional diagnostics cannot change the scenario result. */ }
    }
  }
  try { console.info('PORTAL_SYNTHETIC_HARNESS_DIAGNOSTIC', json); }
  catch { /* Independent destination; never substitute a diagnostic failure for the original error. */ }
}
