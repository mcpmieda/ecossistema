import type { GradebookImportDiagnosticsAuditRequestV1 } from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import type {
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { SheetJs } from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import { createGradebookRelationalImportServiceV11 } from '../application/import/import-relational-service-v11';
import { createImportPerformanceObserverV1, emitImportPerformanceV1 } from '../persistence/postgres/import-performance-observer-v1';
import {
  InvalidImportDiagnosticsSnapshotV1,
  replaceGradebookImportDiagnosticsSnapshotV1,
} from '../application/import/import-diagnostics-snapshot-v1';
import type { GradebookPostgresDatabaseV1 } from '../persistence/postgres/postgres-database-v1';
import { graphDownloadWorkbookV1, WorkbookTooLargeError, type GraphAppEnvV1 } from './graph-drive-v1';
import type { ReadResultV1, SyncMemoryV1 } from './sync-rules-v1';
import { prepareTeacherWorkbookV1 } from './teacher-workbook-preparation-v1';
import { holdNameMismatchesV1, studentKeyV1, wrongYearAuditV1 } from './server-audit-v1';

export type ProcessWorkbookInputV1 = {
  readonly driveId: string;
  readonly itemId: string;
  readonly name: string;
  readonly hash: string | null;
  readonly modifiedAt: string;
  readonly maxBytes: number;
  /** The academic year of the folder; a workbook of another year is not written (BN-DEC-046 rule 3). */
  readonly expectedYear: number | null;
  /** What was last written for this file; null writes everything. */
  readonly memory?: SyncMemoryV1 | null;
};

export type ProcessWorkbookPortsV1 = {
  readonly env: GraphAppEnvV1;
  readonly xlsx: SheetJs;
  readonly openDatabase: () => Promise<GradebookPostgresDatabaseV1>;
  /** Hint to the Portal after grades are written; the Portal's outbox stays authoritative. */
  readonly notifyPortal: () => Promise<void>;
  /** Runs the database writes in this file's turn (one file writes at a time); default: right away. */
  readonly writeTurn?: <T>(work: () => Promise<T>) => Promise<T>;
  readonly now: () => number;
  /** Waits between write retries; tests pass an instant one. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Defaults to the Graph download; tests pass synthetic bytes. */
  readonly download?: (input: ProcessWorkbookInputV1) => Promise<ArrayBuffer>;
  /** Defaults to the official Auditoria and import services. */
  readonly services?: {
    readonly recordAudit: (database: GradebookPostgresDatabaseV1, audit: GradebookImportDiagnosticsAuditRequestV1) => Promise<unknown>;
    readonly persist: (database: GradebookPostgresDatabaseV1, request: GradebookImportPersistenceRequestV9) => Promise<GradebookImportPersistenceResponseV9>;
    /** Name of each student in the system's Relação, by `TURMA|número`. */
    readonly relationNames: (database: GradebookPostgresDatabaseV1, year: number) => Promise<ReadonlyMap<string, string>>;
  };
};

async function relationNamesV1(database: GradebookPostgresDatabaseV1, year: number): Promise<ReadonlyMap<string, string>> {
  const rows = await database.query<{ codigo: string; numero: number; nome: string }>(
    `SELECT t.codigo, v.numero, a.nome
       FROM gradebook.vinculo v
       JOIN gradebook.turma t ON t.id = v.turma_id
       JOIN gradebook.aluno a ON a.id = v.aluno_id
      WHERE v.ano = $1`,
    [year],
  );
  return new Map(rows.map((row) => [studentKeyV1(String(row.codigo), Number(row.numero)), String(row.nome)]));
}

const OFFICIAL_SERVICES_V1: NonNullable<ProcessWorkbookPortsV1['services']> = {
  recordAudit: (database, audit) => replaceGradebookImportDiagnosticsSnapshotV1(database, audit),
  persist: async (database, request) => {
    // Numbers only (statements, rows, milliseconds): where the write spends its time.
    const observer = createImportPerformanceObserverV1();
    const response = await createGradebookRelationalImportServiceV11(database, observer).execute(request);
    emitImportPerformanceV1({ source: 'notas-sync', state: response.state, ...observer.snapshot() });
    return response;
  },
  relationNames: relationNamesV1,
};

const REJECTED_STATES_V1 = new Set<GradebookImportPersistenceResponseV9['state']>([
  'blocked', 'conflict', 'invalid-request', 'not-authorized', 'review-required',
]);

/**
 * One sync read, in the browser's order: Auditoria snapshot first, then the academic write
 * when nothing blocks it. Only teacher grade workbooks (`persist-notas`) are ever written.
 */
/** A short, stable fingerprint of a JSON value (what was written last, never the value itself). */
async function fingerprintV1(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Lock wait, deadlock and serialization failures: another read of the same year is writing. */
const LOCK_CONTENTION_CODES_V1 = new Set(['55P03', '40P01', '40001']);
const LOCK_RETRY_DELAYS_MS_V1 = [500, 1_000, 2_000, 3_000, 4_000, 5_000] as const;

/** Reads run side by side; their writes take turns. Each write is a whole transaction, so retrying is safe. */
async function withLockRetryV1<T>(write: () => Promise<T>, sleep: (ms: number) => Promise<void> = defaultSleepV1): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      const delay = LOCK_RETRY_DELAYS_MS_V1[attempt];
      if (typeof code !== 'string' || !LOCK_CONTENTION_CODES_V1.has(code) || delay === undefined) throw cause;
      await sleep(delay + Math.floor(Math.random() * 500));
    }
  }
}

const defaultSleepV1 = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const HEADER_KEY_V1 = '#header';
const offerKeyV1 = (offer: { readonly turmaCodigo: string; readonly disciplina: string }) =>
  `${offer.turmaCodigo}|${offer.disciplina}`;

export async function processWorkbookV1(input: ProcessWorkbookInputV1, ports: ProcessWorkbookPortsV1): Promise<ReadResultV1> {
  const started = ports.now();
  // Time per stage (milliseconds only): where a read spends its time.
  const stages: Record<string, number> = {};
  let mark = started;
  const stage = (name: string) => { const at = ports.now(); stages[name] = Math.round(at - mark); mark = at; };
  const result = (outcome: ReadResultV1['outcome'], code: string | null, savedToWrittenMs: number | null = null,
    memory?: SyncMemoryV1 | null): ReadResultV1 => {
    console.log(JSON.stringify({ event: 'notas-sync-stages', outcome, ...stages }));
    return { outcome, code, readHash: outcome === 'failed' ? null : input.hash, readMs: ports.now() - started, savedToWrittenMs,
      ...(memory === undefined ? {} : { memory }) };
  };
  const services = ports.services ?? OFFICIAL_SERVICES_V1;
  const previous = input.memory ?? null;

  // The connection and the Relação are asked for while the workbook downloads and is read.
  const opening = Promise.resolve().then(() => ports.openDatabase()).then((database) => database, () => null);
  const expectedYear = input.expectedYear;
  const earlyRelation = expectedYear === null ? null
    : opening.then((database) => (database ? services.relationNames(database, expectedYear) : null)).catch(() => null);
  try {
    let bytes: ArrayBuffer;
    try {
      bytes = ports.download
        ? await ports.download(input)
        : await graphDownloadWorkbookV1(ports.env, input.driveId, input.itemId, input.maxBytes);
    } catch (cause) {
      return cause instanceof WorkbookTooLargeError ? result('too-large', 'FILE-TOO-LARGE') : result('failed', 'GRAPH-DOWNLOAD');
    }
    stage('download');
    const prepared = await prepareTeacherWorkbookV1({
      bytes, fileName: input.name, lastModified: Date.parse(input.modifiedAt) || 0, xlsx: ports.xlsx, now: ports.now,
    });
    if (prepared.outcome === 'unreadable') return result('unreadable', prepared.code);
    if (prepared.outcome === 'ready' && prepared.request.operation !== 'persist-notas') return result('ignored', 'NOT-A-TEACHER-WORKBOOK');

    const database = await opening;
    stage('open');
    if (!database) return result('failed', 'DATABASE-UNAVAILABLE');
    try {
      // Database writes wait for this file's turn: reads run side by side, writes one at a time.
      const turn = ports.writeTurn ?? (<T,>(work: () => Promise<T>) => work());
      // The Auditoria snapshot is written only when it differs from the last one written.
      const writeAudit = async (audit: GradebookImportDiagnosticsAuditRequestV1): Promise<string> => {
        const print = await fingerprintV1([audit.academicYear, audit.fileName, audit.diagnostics]);
        if (previous?.audit !== print) await turn(() => withLockRetryV1(() => services.recordAudit(database, audit), ports.sleep));
        stage('audit');
        return print;
      };
      // Rule 3: a workbook of another year writes nothing; the Auditoria shows it under the folder's year.
      const foundYear = prepared.audit.academicYear;
      if (expectedYear !== null && foundYear !== expectedYear) {
        const audit = await writeAudit(wrongYearAuditV1(prepared.audit, expectedYear, foundYear));
        return result('blocked', 'WRONG-YEAR', null, { audit, offers: previous?.offers ?? {} });
      }
      if (prepared.outcome === 'blocked') {
        const audit = await writeAudit(prepared.audit);
        return result('blocked', 'AUDIT-BLOCKING', null, { audit, offers: previous?.offers ?? {} });
      }
      // Rule 14: a student whose sheet name is not the Relação's name for that number is held.
      let request = prepared.request;
      let audit = prepared.audit;
      if (request.operation === 'persist-notas') {
        const relation = (request.ano === expectedYear ? await earlyRelation : null)
          ?? await services.relationNames(database, request.ano);
        const checked = holdNameMismatchesV1(request, prepared.studentNames, relation);
        stage('relation');
        request = checked.request;
        audit = { ...audit, diagnostics: [...audit.diagnostics, ...checked.items] };
      }
      const auditPrint = await writeAudit(audit);

      // Only the classes/subjects that changed since the last write are sent: an offer left out
      // of the request keeps what the database has (canonical V9).
      let offers: Record<string, string> = {};
      if (request.operation === 'persist-notas') {
        const { manifest: _manifest, ofertas, ...header } = request;
        offers = { [HEADER_KEY_V1]: await fingerprintV1(header) };
        for (const offer of ofertas) offers[offerKeyV1(offer)] = await fingerprintV1(offer);
        const known = previous && previous.offers[HEADER_KEY_V1] === offers[HEADER_KEY_V1] ? previous.offers : {};
        const changed = ofertas.filter((offer) => known[offerKeyV1(offer)] !== offers[offerKeyV1(offer)]);
        if (changed.length === 0) return result('no-changes', null, null, { audit: auditPrint, offers });
        request = { ...request, ofertas: changed };
      }
      const sent = request;
      const response = await turn(() => withLockRetryV1(() => services.persist(database, sent), ports.sleep));
      stage('persist');
      if (response.state === 'unavailable') return result('failed', 'DATABASE-UNAVAILABLE');
      if (REJECTED_STATES_V1.has(response.state)) {
        return result('rejected', response.state.toUpperCase(), null, { audit: auditPrint, offers: {} });
      }
      const memory: SyncMemoryV1 = { audit: auditPrint, offers };
      if (response.state === 'no-changes') return result('no-changes', null, null, memory);
      const savedAt = Date.parse(input.modifiedAt);
      await ports.notifyPortal().catch(() => undefined);
      stage('notify');
      return result('applied', null, Number.isFinite(savedAt) ? Math.max(0, Date.now() - savedAt) : null, memory);
    } catch (cause) {
      // A snapshot the contract refuses is deterministic: retrying the same bytes cannot help.
      if (cause instanceof InvalidImportDiagnosticsSnapshotV1) return result('rejected', 'AUDIT-INVALID', null, null);
      // Only the error kind and Postgres code: a database message can carry values, never logged.
      const failure = cause as { name?: unknown; code?: unknown } | null;
      console.error(JSON.stringify({ event: 'notas-sync-database-write', name: String(failure?.name ?? 'unknown').slice(0, 60),
        code: typeof failure?.code === 'string' ? failure.code.slice(0, 10) : null }));
      return result('failed', 'DATABASE-WRITE');
    }
  } finally {
    await earlyRelation;
    const database = await opening;
    await database?.close().catch(() => undefined);
  }
}
