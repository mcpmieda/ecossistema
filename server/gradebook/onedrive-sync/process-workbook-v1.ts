import type { GradebookImportDiagnosticsAuditRequestV1 } from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import type {
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { SheetJs } from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import { createGradebookRelationalImportServiceV11 } from '../application/import/import-relational-service-v11';
import {
  InvalidImportDiagnosticsSnapshotV1,
  replaceGradebookImportDiagnosticsSnapshotV1,
} from '../application/import/import-diagnostics-snapshot-v1';
import type { GradebookPostgresDatabaseV1 } from '../persistence/postgres/postgres-database-v1';
import { graphDownloadWorkbookV1, WorkbookTooLargeError, type GraphAppEnvV1 } from './graph-drive-v1';
import type { ReadResultV1 } from './sync-rules-v1';
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
};

export type ProcessWorkbookPortsV1 = {
  readonly env: GraphAppEnvV1;
  readonly xlsx: SheetJs;
  readonly openDatabase: () => Promise<GradebookPostgresDatabaseV1>;
  /** Hint to the Portal after grades are written; the Portal's outbox stays authoritative. */
  readonly notifyPortal: () => Promise<void>;
  readonly now: () => number;
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
  persist: (database, request) => createGradebookRelationalImportServiceV11(database).execute(request),
  relationNames: relationNamesV1,
};

const REJECTED_STATES_V1 = new Set<GradebookImportPersistenceResponseV9['state']>([
  'blocked', 'conflict', 'invalid-request', 'not-authorized', 'review-required',
]);

/**
 * One sync read, in the browser's order: Auditoria snapshot first, then the academic write
 * when nothing blocks it. Only teacher grade workbooks (`persist-notas`) are ever written.
 */
export async function processWorkbookV1(input: ProcessWorkbookInputV1, ports: ProcessWorkbookPortsV1): Promise<ReadResultV1> {
  const started = ports.now();
  const result = (outcome: ReadResultV1['outcome'], code: string | null, savedToWrittenMs: number | null = null): ReadResultV1 => ({
    outcome, code, readHash: outcome === 'failed' ? null : input.hash, readMs: ports.now() - started, savedToWrittenMs,
  });
  let bytes: ArrayBuffer;
  try {
    bytes = ports.download
      ? await ports.download(input)
      : await graphDownloadWorkbookV1(ports.env, input.driveId, input.itemId, input.maxBytes);
  } catch (cause) {
    return cause instanceof WorkbookTooLargeError ? result('too-large', 'FILE-TOO-LARGE') : result('failed', 'GRAPH-DOWNLOAD');
  }
  const prepared = await prepareTeacherWorkbookV1({
    bytes, fileName: input.name, lastModified: Date.parse(input.modifiedAt) || 0, xlsx: ports.xlsx, now: ports.now,
  });
  if (prepared.outcome === 'unreadable') return result('unreadable', prepared.code);
  if (prepared.outcome === 'ready' && prepared.request.operation !== 'persist-notas') return result('ignored', 'NOT-A-TEACHER-WORKBOOK');

  let database: GradebookPostgresDatabaseV1;
  try {
    database = await ports.openDatabase();
  } catch {
    return result('failed', 'DATABASE-UNAVAILABLE');
  }
  const services = ports.services ?? OFFICIAL_SERVICES_V1;
  try {
    // Rule 3: a workbook of another year writes nothing; the Auditoria shows it under the folder's year.
    const foundYear = prepared.audit.academicYear;
    if (input.expectedYear !== null && foundYear !== input.expectedYear) {
      await services.recordAudit(database, wrongYearAuditV1(prepared.audit, input.expectedYear, foundYear));
      return result('blocked', 'WRONG-YEAR');
    }
    if (prepared.outcome === 'blocked') {
      await services.recordAudit(database, prepared.audit);
      return result('blocked', 'AUDIT-BLOCKING');
    }
    // Rule 14: a student whose sheet name is not the Relação's name for that number is held.
    let request = prepared.request;
    let audit = prepared.audit;
    if (request.operation === 'persist-notas') {
      const checked = holdNameMismatchesV1(request, prepared.studentNames, await services.relationNames(database, request.ano));
      request = checked.request;
      audit = { ...audit, diagnostics: [...audit.diagnostics, ...checked.items] };
    }
    await services.recordAudit(database, audit);
    const response = await services.persist(database, request);
    if (response.state === 'unavailable') return result('failed', 'DATABASE-UNAVAILABLE');
    if (REJECTED_STATES_V1.has(response.state)) return result('rejected', response.state.toUpperCase());
    if (response.state === 'no-changes') return result('no-changes', null);
    const savedAt = Date.parse(input.modifiedAt);
    await ports.notifyPortal().catch(() => undefined);
    return result('applied', null, Number.isFinite(savedAt) ? Math.max(0, Date.now() - savedAt) : null);
  } catch (cause) {
    // A snapshot the contract refuses is deterministic: retrying the same bytes cannot help.
    if (cause instanceof InvalidImportDiagnosticsSnapshotV1) return result('rejected', 'AUDIT-INVALID');
    // Only the error kind and Postgres code: a database message can carry values, never logged.
    const failure = cause as { name?: unknown; code?: unknown } | null;
    console.error(JSON.stringify({ event: 'notas-sync-database-write', name: String(failure?.name ?? 'unknown').slice(0, 60),
      code: typeof failure?.code === 'string' ? failure.code.slice(0, 10) : null }));
    return result('failed', 'DATABASE-WRITE');
  } finally {
    await database.close().catch(() => undefined);
  }
}
