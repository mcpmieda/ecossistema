import type {
  GradebookImportDiagnosticAuditItemV1,
  GradebookImportDiagnosticsAuditRequestV1,
} from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import type {
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { createGradebookRelationalImportServiceV11 } from '../application/import/import-relational-service-v11';
import {
  InvalidImportDiagnosticsSnapshotV1,
  replaceGradebookImportDiagnosticsSnapshotV1,
} from '../application/import/import-diagnostics-snapshot-v1';
import { createImportPerformanceObserverV1, emitImportPerformanceV1 } from '../persistence/postgres/import-performance-observer-v1';
import type { GradebookPostgresDatabaseV1 } from '../persistence/postgres/postgres-database-v1';
import type { ReadResultV1, SyncMemoryV1 } from './sync-rules-v1';
import { holdNameMismatchesV1, relationReviewItemsV1, studentKeyV1, wrongYearAuditV1 } from './server-audit-v1';

/**
 * The database half of one OneDrive read: Relação check, Auditoria, grades, Portal hint.
 * It runs next to the database (in Pages) when it can, and in the reader otherwise.
 */
export type PreparedWorkbookV1 =
  | {
      readonly outcome: 'ready';
      readonly request: GradebookImportPersistenceRequestV9;
      readonly audit: GradebookImportDiagnosticsAuditRequestV1;
      /** `TURMA|número` → name in the workbook. */
      readonly studentNames: ReadonlyArray<readonly [string, string]>;
    }
  | { readonly outcome: 'blocked'; readonly audit: GradebookImportDiagnosticsAuditRequestV1 };

export type WriteInputV1 = {
  readonly name: string;
  readonly modifiedAt: string;
  readonly expectedYear: number | null;
  readonly memory: SyncMemoryV1 | null;
};

export type WriteOutcomeV1 = {
  readonly outcome: ReadResultV1['outcome'];
  readonly code: string | null;
  readonly savedToWrittenMs: number | null;
  readonly memory?: SyncMemoryV1 | null;
  readonly stages: Readonly<Record<string, number>>;
  /** A Relação was written with changes: the teachers' workbooks of the year are read again. */
  readonly relationChanged?: boolean;
};

export type WriteServicesV1 = {
  readonly recordAudit: (database: GradebookPostgresDatabaseV1, audit: GradebookImportDiagnosticsAuditRequestV1) => Promise<unknown>;
  readonly persist: (database: GradebookPostgresDatabaseV1, request: GradebookImportPersistenceRequestV9) => Promise<GradebookImportPersistenceResponseV9>;
  /** Name of each student in the system's Relação, by `TURMA|número`. */
  readonly relationNames: (database: GradebookPostgresDatabaseV1, year: number) => Promise<ReadonlyMap<string, string>>;
};

export type WritePortsV1 = {
  readonly database: GradebookPostgresDatabaseV1;
  readonly services?: WriteServicesV1;
  /** Hint to the Portal after grades are written; the Portal's outbox stays authoritative. */
  readonly notifyPortal: () => Promise<void>;
  /** Runs one database write in this file's turn; default: right away. */
  readonly writeTurn?: <T>(work: () => Promise<T>) => Promise<T>;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The Relação already asked for (alongside the download), when available. */
  readonly earlyRelation?: Promise<ReadonlyMap<string, string> | null> | null;
  /** Tag for the write metrics log. */
  readonly source?: string;
};

/** The system's Relação of a year: number in the class → the student's name. */
export async function relationNamesV1(database: GradebookPostgresDatabaseV1, year: number): Promise<ReadonlyMap<string, string>> {
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

function officialServicesV1(source: string): WriteServicesV1 {
  return {
    recordAudit: (database, audit) => replaceGradebookImportDiagnosticsSnapshotV1(database, audit),
    persist: async (database, request) => {
      // Numbers only (statements, rows, milliseconds): where the write spends its time.
      const observer = createImportPerformanceObserverV1();
      const response = await createGradebookRelationalImportServiceV11(observer.wrap(database), observer).execute(request);
      emitImportPerformanceV1({ source, state: response.state, ...observer.snapshot() });
      return response;
    },
    relationNames: relationNamesV1,
  };
}

const REJECTED_STATES_V1 = new Set<GradebookImportPersistenceResponseV9['state']>([
  'blocked', 'conflict', 'invalid-request', 'not-authorized', 'review-required',
]);

/** A short, stable fingerprint of a JSON value (what was written last, never the value itself). */
async function fingerprintV1(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Lock wait, deadlock and serialization failures: another write of the same year is running. */
const LOCK_CONTENTION_CODES_V1 = new Set(['55P03', '40P01', '40001']);
const LOCK_RETRY_DELAYS_MS_V1 = [500, 1_000, 2_000, 3_000, 4_000, 5_000] as const;
const defaultSleepV1 = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Each write is a whole transaction, so retrying after lock contention is safe. */
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

const HEADER_KEY_V1 = '#header';
const RELATION_KEY_V1 = '#relacao';
const offerKeyV1 = (offer: { readonly turmaCodigo: string; readonly disciplina: string }) => `${offer.turmaCodigo}|${offer.disciplina}`;

export async function writePreparedWorkbookV1(input: WriteInputV1, prepared: PreparedWorkbookV1, ports: WritePortsV1): Promise<WriteOutcomeV1> {
  const stages: Record<string, number> = {};
  let mark = ports.now();
  const stage = (name: string) => { const at = ports.now(); stages[name] = Math.round(at - mark); mark = at; };
  const done = (outcome: ReadResultV1['outcome'], code: string | null, savedToWrittenMs: number | null = null,
    memory?: SyncMemoryV1 | null): WriteOutcomeV1 => ({ outcome, code, savedToWrittenMs, stages, ...(memory === undefined ? {} : { memory }) });
  const services = ports.services ?? officialServicesV1(ports.source ?? 'notas-sync');
  const { database } = ports;
  const previous = input.memory;
  const expectedYear = input.expectedYear;
  const turn = ports.writeTurn ?? (<T,>(work: () => Promise<T>) => work());
  try {
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
      return done('blocked', 'WRONG-YEAR', null, { audit, offers: previous?.offers ?? {} });
    }
    if (prepared.outcome === 'blocked') {
      const audit = await writeAudit(prepared.audit);
      return done('blocked', 'AUDIT-BLOCKING', null, { audit, offers: previous?.offers ?? {} });
    }
    // The Relação: written whole (it only adds and updates students, never removes them). A class
    // move the database cannot pair by itself holds this Relação and becomes an Auditoria finding.
    if (prepared.request.operation === 'persist-relacao') {
      const relation = prepared.request;
      const print = await fingerprintV1(relation);
      if (previous?.offers[RELATION_KEY_V1] === print) {
        const auditPrint = await writeAudit(prepared.audit);
        return done('no-changes', null, null, { audit: auditPrint, offers: { [RELATION_KEY_V1]: print } });
      }
      const response = await turn(() => withLockRetryV1(() => services.persist(database, relation), ports.sleep));
      stage('persist');
      if (response.state === 'unavailable') return done('failed', 'DATABASE-UNAVAILABLE');
      const review = response.state === 'review-required'
        ? relationReviewItemsV1(prepared.audit.fileName, response.reason, response.movementReview) : [];
      const auditPrint = await writeAudit({ ...prepared.audit, diagnostics: [...prepared.audit.diagnostics, ...review] });
      if (response.state === 'review-required') return done('blocked', 'RELATION-REVIEW', null, { audit: auditPrint, offers: {} });
      if (REJECTED_STATES_V1.has(response.state)) return done('rejected', response.state.toUpperCase(), null, { audit: auditPrint, offers: {} });
      const memory: SyncMemoryV1 = { audit: auditPrint, offers: { [RELATION_KEY_V1]: print } };
      if (response.state === 'no-changes') return done('no-changes', null, null, memory);
      await ports.notifyPortal().catch(() => undefined);
      stage('notify');
      const savedAt = Date.parse(input.modifiedAt);
      return { ...done('applied', null, Number.isFinite(savedAt) ? Math.max(0, Date.now() - savedAt) : null, memory), relationChanged: true };
    }
    // Rule 14: a student whose sheet name is not the Relação's name for that number is held.
    let request = prepared.request;
    let audit = prepared.audit;
    if (request.operation === 'persist-notas') {
      const relation = (request.ano === expectedYear ? await ports.earlyRelation : null)
        ?? await services.relationNames(database, request.ano);
      const checked = holdNameMismatchesV1(request, new Map(prepared.studentNames), relation);
      stage('relation');
      request = checked.request;
      audit = { ...audit, diagnostics: [...audit.diagnostics, ...checked.items] as GradebookImportDiagnosticAuditItemV1[] };
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
      if (changed.length === 0) return done('no-changes', null, null, { audit: auditPrint, offers });
      request = { ...request, ofertas: changed };
    }
    const sent = request;
    const response = await turn(() => withLockRetryV1(() => services.persist(database, sent), ports.sleep));
    stage('persist');
    if (response.state === 'unavailable') return done('failed', 'DATABASE-UNAVAILABLE');
    if (REJECTED_STATES_V1.has(response.state)) return done('rejected', response.state.toUpperCase(), null, { audit: auditPrint, offers: {} });
    const memory: SyncMemoryV1 = { audit: auditPrint, offers };
    if (response.state === 'no-changes') return done('no-changes', null, null, memory);
    const savedAt = Date.parse(input.modifiedAt);
    await ports.notifyPortal().catch(() => undefined);
    stage('notify');
    return done('applied', null, Number.isFinite(savedAt) ? Math.max(0, Date.now() - savedAt) : null, memory);
  } catch (cause) {
    // A snapshot the contract refuses is deterministic: retrying the same bytes cannot help.
    if (cause instanceof InvalidImportDiagnosticsSnapshotV1) return done('rejected', 'AUDIT-INVALID', null, null);
    // Only the error kind and Postgres code: a database message can carry values, never logged.
    const failure = cause as { name?: unknown; code?: unknown } | null;
    console.error(JSON.stringify({ event: 'notas-sync-database-write', name: String(failure?.name ?? 'unknown').slice(0, 60),
      code: typeof failure?.code === 'string' ? failure.code.slice(0, 10) : null }));
    return done('failed', 'DATABASE-WRITE');
  }
}
