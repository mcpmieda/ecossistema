import type { SheetJs } from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import type { GradebookPostgresDatabaseV1 } from '../persistence/postgres/postgres-database-v1';
import { graphDownloadWorkbookV1, WorkbookTooLargeError, type GraphAppEnvV1 } from './graph-drive-v1';
import type { ReadResultV1, SyncMemoryV1 } from './sync-rules-v1';
import { prepareTeacherWorkbookV1 } from './teacher-workbook-preparation-v1';
import {
  relationNamesV1,
  writePreparedWorkbookV1,
  type PreparedWorkbookV1,
  type WriteInputV1,
  type WriteOutcomeV1,
  type WriteServicesV1,
} from './write-prepared-v1';

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
  readonly services?: WriteServicesV1;
};

/**
 * One sync read: download and read the workbook, then the database half (Relação check,
 * Auditoria, grades). Teacher grade workbooks and the Relação are written.
 */
export async function processWorkbookV1(input: ProcessWorkbookInputV1, ports: ProcessWorkbookPortsV1): Promise<ReadResultV1> {
  const started = ports.now();
  const stages: Record<string, number> = {};
  let mark = started;
  const stage = (name: string) => { const at = ports.now(); stages[name] = Math.round(at - mark); mark = at; };
  const result = (outcome: ReadResultV1['outcome'], code: string | null, savedToWrittenMs: number | null = null,
    memory?: SyncMemoryV1 | null): ReadResultV1 => {
    console.log(JSON.stringify({ event: 'notas-sync-stages', outcome, ...stages }));
    return { outcome, code, readHash: outcome === 'failed' ? null : input.hash, readMs: ports.now() - started, savedToWrittenMs,
      ...(memory === undefined ? {} : { memory }) };
  };
  const fromWrite = (written: WriteOutcomeV1) => {
    Object.assign(stages, written.stages);
    const read = result(written.outcome, written.code, written.savedToWrittenMs, written.memory);
    return written.relationChanged ? { ...read, relationChanged: true } : read;
  };
  const writeInput: WriteInputV1 = {
    name: input.name, modifiedAt: input.modifiedAt, expectedYear: input.expectedYear, memory: input.memory ?? null,
  };

  // The connection and the Relação are asked for while the workbook downloads (the connection
  // opens on its first query, so the Relação also pays for opening it, in parallel).
  // relationReady: ms from the start of the read until the Relação arrived.
  let opening: Promise<GradebookPostgresDatabaseV1 | null> | null = null;
  let earlyRelation: Promise<ReadonlyMap<string, string> | null> | null = null;
  const openLocal = () => {
    opening ??= Promise.resolve().then(() => ports.openDatabase()).then((database) => database, () => null);
    const year = input.expectedYear;
    if (!earlyRelation && year !== null) {
      const relationNames = ports.services?.relationNames ?? relationNamesV1;
      earlyRelation = opening.then((database) => (database ? relationNames(database, year) : null))
        .then((relation) => { stages.relationReady = Math.round(ports.now() - started); return relation; })
        .catch(() => null);
    }
    return opening;
  };
  void openLocal();
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
    const ready = await prepareTeacherWorkbookV1({
      bytes, fileName: input.name, lastModified: Date.parse(input.modifiedAt) || 0, xlsx: ports.xlsx, now: ports.now,
    });
    if (ready.outcome === 'unreadable') return result('unreadable', ready.code);
    const prepared: PreparedWorkbookV1 = ready.outcome === 'ready'
      ? { outcome: 'ready', request: ready.request, audit: ready.audit, studentNames: [...ready.studentNames] }
      : { outcome: 'blocked', audit: ready.audit };
    stage('prepare');

    const database = await openLocal();
    stage('open');
    if (!database) return result('failed', 'DATABASE-UNAVAILABLE');
    return fromWrite(await writePreparedWorkbookV1(writeInput, prepared, {
      database, services: ports.services, notifyPortal: ports.notifyPortal, writeTurn: ports.writeTurn,
      now: ports.now, sleep: ports.sleep, earlyRelation,
    }));
  } finally {
    await (earlyRelation as Promise<unknown> | null);
    const database = await (opening as Promise<GradebookPostgresDatabaseV1 | null> | null);
    await database?.close().catch(() => undefined);
  }
}
