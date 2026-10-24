import type { GradebookPostgresValueV1 } from './postgres-values-v1';
import type { GradebookPostgresWritePortV1 } from './postgres-database-v1';
import {
  emptyImportCommitAffectedRowsV1,
  IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1,
  type ImportCommitActionV1,
  type ImportCommitCategoryV1,
  type ImportCommitDiagnosticsV1,
} from '../../../../shared/gradebook-contracts/imports/import-commit-diagnostics-v1';

export type ImportFlushReasonV1 =
  | 'read-boundary'
  | 'non-buffered-write'
  | 'transaction-end'
  | 'dependency-boundary'
  | 'row-limit'
  | 'byte-limit';
export type ImportGroupCategoryV1 =
  | 'note-delete'
  | 'note-update'
  | 'note-insert'
  | 'closing-history'
  | 'closing-delete'
  | 'closing-update'
  | 'closing-insert';
type SqlCategoryV1 = 'read' | 'write' | 'coordination' | 'finalizer' | 'other';
type TransactionOutcomeV1 = 'committed' | 'rejected' | 'unknown';
type TransactionPortV1 = GradebookPostgresWritePortV1 & {
  transaction<T>(operation: (database: GradebookPostgresWritePortV1) => Promise<T>): Promise<T>;
};

export function importPerformanceNowV1(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

function duration(started: number): number {
  return Math.max(0, Math.round((importPerformanceNowV1() - started) * 10) / 10);
}

type ImportSqlMarkerV1 =
  | 'read-set-instruments'
  | 'read-set-notes'
  | 'read-set-closings'
  | 'catalog-disciplines-read'
  | 'catalog-disciplines-create'
  | 'catalog-disciplines-update'
  | 'catalog-offers-read'
  | 'catalog-offers-create'
  | 'instruments-create'
  | 'instruments-update'
  | 'instruments-retire-notes'
  | 'instruments-retire';
function marker(query: string): ImportSqlMarkerV1 | null {
  const match =
    /\/\* import-(read-set|catalog|instruments):(instruments|notes|closings|disciplines-read|disciplines-create|disciplines-update|offers-read|offers-create|create|update|retire-notes|retire) \*\/\s*$/u.exec(
      query,
    );
  if (!match) return null;
  const name = `${match[1]}-${match[2]}`;
  const allowed: readonly string[] = [
    'read-set-instruments',
    'read-set-notes',
    'read-set-closings',
    'catalog-disciplines-read',
    'catalog-disciplines-create',
    'catalog-disciplines-update',
    'catalog-offers-read',
    'catalog-offers-create',
    'instruments-create',
    'instruments-update',
    'instruments-retire-notes',
    'instruments-retire',
  ];
  return allowed.includes(name) ? (name as ImportSqlMarkerV1) : null;
}

// Only fixed operation categories leave this module. Unknown SQL stays "other".
function category(query: string): SqlCategoryV1 {
  const known = marker(query);
  if (known) return known.startsWith('read-set-') || known.endsWith('-read') ? 'read' : 'write';
  const sql = query.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
  if (
    /^select (?:pg_advisory_xact_lock(?:_shared)?|student_portal\.ensure_year_coordination_v1)\(/u.test(
      sql,
    )
  )
    return 'coordination';
  if (
    /^select .*\bfrom student_portal\.(?:record_gradebook_change_v1|synchronize_gradebook_profiles_v1)\(/u.test(
      sql,
    )
  )
    return 'finalizer';
  if (
    /^(?:insert into|update|delete from) gradebook\.(?:ano_letivo|turma|aluno|vinculo|vinculo_historico|professor|disciplina|oferta|instrumento|nota|fechamento|fechamento_historico|importacao|conselho_decisao|conselho_votacao)\b/u.test(
      sql,
    )
  )
    return 'write';
  if (
    sql.startsWith('select ') &&
    !/\b(?:student_portal\.[a-z_]+\(|pg_[a-z_]+\()/u.test(sql) &&
    /\bfrom gradebook\.(?:ano_letivo|turma|aluno|vinculo|professor|disciplina|oferta|instrumento|nota|fechamento|conselho_decisao|conselho_votacao)\b/u.test(
      sql,
    )
  )
    return 'read';
  return 'other';
}

const markedMutations: Partial<
  Record<ImportSqlMarkerV1, readonly [ImportCommitCategoryV1, ImportCommitActionV1]>
> = {
  'catalog-disciplines-create': ['disciplina', 'insert'],
  'catalog-disciplines-update': ['disciplina', 'update'],
  'catalog-offers-create': ['oferta', 'insert'],
  'instruments-create': ['instrumento', 'insert'],
  'instruments-update': ['instrumento', 'update'],
  'instruments-retire-notes': ['nota', 'delete'],
  'instruments-retire': ['instrumento', 'delete'],
};
function directMutation(
  query: string,
  known: ImportSqlMarkerV1 | null,
): {
  category: ImportCommitCategoryV1;
  action: ImportCommitActionV1;
} | null {
  const entry = known === null ? undefined : markedMutations[known];
  if (entry) return { category: entry[0], action: entry[1] };
  if (!/^\s*(?:insert|update|delete)\b/iu.test(query)) return null;
  const match = /^(insert into|update|delete from) gradebook\.([a-z_]+)\b/u.exec(
    query.trim().replaceAll(/\s+/gu, ' ').toLowerCase(),
  );
  if (!match) return null;
  const table = match[2]!;
  let tableCategory: ImportCommitCategoryV1;
  if (['professor', 'disciplina', 'oferta', 'instrumento', 'nota', 'fechamento'].includes(table)) {
    tableCategory = table as ImportCommitCategoryV1;
  } else if (
    [
      'importacao',
      'fechamento_historico',
      'vinculo_historico',
      'nota_historico',
      'instrumento_historico',
    ].includes(table)
  ) {
    tableCategory = 'history-import';
  } else {
    tableCategory = 'other';
  }
  return {
    category: tableCategory,
    action: statementActionV1(match[1]),
  };
}

function statementActionV1(verb: string | undefined) {
  if (verb === 'insert into') return 'insert';
  return verb === 'update' ? 'update' : 'delete';
}

/** One observer per authorized request, below V11's buffer; no parameters/results retained. */
export function createImportPerformanceObserverV1() {
  const metrics = {
    sqlCalls: 0,
    sqlReadCalls: 0,
    sqlWriteCalls: 0,
    sqlOtherCalls: 0,
    sqlFailedCalls: 0,
    rowsRead: 0,
    readSetBlocks: 0,
    readSetOffers: 0,
    maximumReadSetOffers: 0,
    maximumReadSetRows: 0,
    catalogReadCalls: 0,
    catalogWriteCalls: 0,
    instrumentsCreated: 0,
    instrumentsUpdated: 0,
    instrumentsRetired: 0,
    instrumentStatements: 0,
    maximumInstrumentGroupRows: 0,
    maximumInstrumentGroupBytes: 0,
    coordinationCallMs: 0,
    transactionMs: null as number | null,
    transactionOutcome: null as TransactionOutcomeV1 | null,
    bufferedLogicalMutations: 0,
    flushesWithWork: 0,
    flushReasonCounts: {
      'read-boundary': 0,
      'non-buffered-write': 0,
      'transaction-end': 0,
      'dependency-boundary': 0,
      'row-limit': 0,
      'byte-limit': 0,
    },
    maximumPendingRows: 0,
    maximumPendingJsonBytes: 0,
    groupedStatements: 0,
    groupedStatementsCompleted: 0,
    groupedStatementsFailed: 0,
    groupRows: 0,
    maximumGroupRows: 0,
    groupBytes: 0,
    maximumGroupBytes: 0,
    finalizerMs: null as number | null,
  };
  const groupCounts: Record<ImportGroupCategoryV1, number> = {
    'note-delete': 0,
    'note-update': 0,
    'note-insert': 0,
    'closing-history': 0,
    'closing-delete': 0,
    'closing-update': 0,
    'closing-insert': 0,
  };

  let currentReadSetRows = 0;
  const attemptedRows = emptyImportCommitAffectedRowsV1();
  const committedRows = emptyImportCommitAffectedRowsV1();
  let unmeasuredStatements = 0;

  function copyRows(rows: typeof attemptedRows) {
    return Object.fromEntries(
      IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1.map((name) => [name, { ...rows[name] }]),
    ) as typeof attemptedRows;
  }

  /** The JSON batch of a read-set or instrument statement: only its length (and size) is kept. */
  function measureJsonBody(readSet: boolean, body: GradebookPostgresValueV1 | undefined) {
    if (typeof body !== 'object' || body === null) return;
    // The bounded JSON array is inspected only for its length; no values survive.
    let count: number | null = null;
    try {
      const rows: unknown = JSON.parse(body.jsonText);
      if (Array.isArray(rows)) count = rows.length;
    } catch {
      /* Optional measurement must not reject a persistence call. */
    }
    if (count === null) return;
    if (readSet) {
      currentReadSetRows = 0;
      metrics.readSetBlocks++;
      metrics.readSetOffers += count;
      metrics.maximumReadSetOffers = Math.max(metrics.maximumReadSetOffers, count);
    } else {
      metrics.instrumentStatements++;
      metrics.maximumInstrumentGroupRows = Math.max(
        metrics.maximumInstrumentGroupRows,
        count,
      );
      metrics.maximumInstrumentGroupBytes = Math.max(
        metrics.maximumInstrumentGroupBytes,
        new TextEncoder().encode(body.jsonText).byteLength,
      );
    }
  }

  /** The rows a classified mutation reports; anything not a safe count stays unmeasured. */
  function countAttemptedRows(
    mutation: NonNullable<ReturnType<typeof directMutation>>,
    affected: number | null,
  ) {
    const previous = attemptedRows[mutation.category][mutation.action];
    if (
      affected !== null &&
      Number.isSafeInteger(affected) &&
      affected >= 0 &&
      Number.isSafeInteger(previous + affected)
    ) {
      attemptedRows[mutation.category][mutation.action] += affected;
    } else unmeasuredStatements++;
  }

  /** Rows read, the read set's running size and the instruments created, updated or retired. */
  function recordResultRows(
    kind: ReturnType<typeof category>,
    known: ReturnType<typeof marker>,
    rows: number,
    changed: number | null,
  ) {
    if (kind === 'read') metrics.rowsRead += rows;
    if (known?.startsWith('read-set-')) {
      currentReadSetRows += rows;
      metrics.maximumReadSetRows = Math.max(metrics.maximumReadSetRows, currentReadSetRows);
    }
    if (known === 'instruments-create') metrics.instrumentsCreated += changed ?? 0;
    if (known === 'instruments-update') metrics.instrumentsUpdated += changed ?? 0;
    if (known === 'instruments-retire') metrics.instrumentsRetired += changed ?? 0;
  }

  async function observeSql<T>(
    sql: string,
    operation: () => Promise<T>,
    rowCount: (result: T) => number,
    values: readonly GradebookPostgresValueV1[] = [],
    changes: (result: T) => number | null = () => null,
  ): Promise<T> {
    const kind = category(sql);
    const known = marker(sql);
    const mutation = directMutation(sql, known);
    // Compound/unclassified DML has no safe per-category cardinality attribution.
    const unclassifiedMutation =
      mutation === null && /\b(?:insert\s+into|update|delete\s+from)\b/iu.test(sql);
    if (known?.startsWith('catalog-')) {
      if (kind === 'read') metrics.catalogReadCalls++;
      else metrics.catalogWriteCalls++;
    }
    if (known === 'read-set-instruments' || known?.startsWith('instruments-'))
      measureJsonBody(known === 'read-set-instruments', values[1]);
    metrics.sqlCalls++;
    if (kind === 'read') metrics.sqlReadCalls++;
    else if (kind === 'write' || kind === 'finalizer') metrics.sqlWriteCalls++;
    else metrics.sqlOtherCalls++;
    const started = importPerformanceNowV1();
    try {
      const result = await operation();
      if (mutation) countAttemptedRows(mutation, changes(result));
      else if (unclassifiedMutation) unmeasuredStatements++;
      recordResultRows(kind, known, rowCount(result), changes(result));
      return result;
    } catch (cause) {
      metrics.sqlFailedCalls++;
      if (mutation || unclassifiedMutation) unmeasuredStatements++;
      throw cause;
    } finally {
      if (kind === 'coordination') metrics.coordinationCallMs += duration(started);
    }
  }

  function wrap<T extends GradebookPostgresWritePortV1>(database: T, depth = 0): T {
    const query: GradebookPostgresWritePortV1['query'] = (sql, values) =>
      observeSql(
        sql,
        () => database.query(sql, values),
        (result) => result.length,
        values,
        (result) => (/\bRETURNING\b/iu.test(sql) ? result.length : null),
      );
    const executeNative: GradebookPostgresWritePortV1['executeNative'] = (sql, values) =>
      observeSql(
        sql,
        () => database.executeNative(sql, values),
        (result) => result.rows.length,
        values,
        (result) => result.changes,
      );
    const transaction: TransactionPortV1['transaction'] = async (operation) => {
      const started = importPerformanceNowV1();
      const before = depth === 0 ? copyRows(attemptedRows) : null;
      let callbackCompleted = false;
      try {
        const result = await (database as unknown as TransactionPortV1).transaction(async (tx) => {
          const result = await operation(wrap(tx, depth + 1));
          callbackCompleted = true;
          return result;
        });
        if (depth === 0) {
          metrics.transactionOutcome = 'committed';
          for (const name of IMPORT_COMMIT_DIAGNOSTICS_CATEGORIES_V1) {
            for (const action of ['insert', 'update', 'delete'] as const) {
              committedRows[name][action] += attemptedRows[name][action] - before![name][action];
            }
          }
        }
        return result;
      } catch (cause) {
        if (depth === 0) metrics.transactionOutcome = callbackCompleted ? 'unknown' : 'rejected';
        throw cause;
      } finally {
        if (depth === 0) metrics.transactionMs = (metrics.transactionMs ?? 0) + duration(started);
      }
    };
    return new Proxy(database, {
      get(target, property) {
        if (property === 'query') return query;
        if (property === 'executeNative') return executeNative;
        if (property === 'transaction' && typeof Reflect.get(target, property) === 'function')
          return transaction;
        const value: unknown = Reflect.get(target, property, target);
        // Preserve close, lastFailure and any adapter method with its original receiver.
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  return {
    wrap,
    commitDiagnostics(
      outcome: string | null,
      lifecycleCompleted = false,
    ): ImportCommitDiagnosticsV1 {
      const confirmed =
        lifecycleCompleted &&
        metrics.transactionOutcome === 'committed' &&
        (outcome === 'applied' || outcome === 'no-changes');
      return {
        version: 1,
        scope: 'direct-import-statements',
        coverage: unmeasuredStatements === 0 ? 'complete' : 'partial',
        transaction: metrics.transactionOutcome ?? 'not-started',
        attempted: copyRows(attemptedRows),
        confirmed: confirmed ? copyRows(committedRows) : null,
        unmeasuredStatements,
        excludedEffects: 'sql-functions-triggers-portal',
      };
    },
    bufferedMutation() {
      metrics.bufferedLogicalMutations++;
    },
    pendingSize(rows: number, bytes: number) {
      metrics.maximumPendingRows = Math.max(metrics.maximumPendingRows, rows);
      metrics.maximumPendingJsonBytes = Math.max(metrics.maximumPendingJsonBytes, bytes);
    },
    flush(reason: ImportFlushReasonV1) {
      metrics.flushesWithWork++;
      metrics.flushReasonCounts[reason]++;
    },
    groupStarted(label: ImportGroupCategoryV1, rows: number, bytes: number) {
      metrics.groupedStatements++;
      groupCounts[label]++;
      metrics.groupRows += rows;
      metrics.groupBytes += bytes;
      metrics.maximumGroupRows = Math.max(metrics.maximumGroupRows, rows);
      metrics.maximumGroupBytes = Math.max(metrics.maximumGroupBytes, bytes);
    },
    groupFinished(success: boolean) {
      if (success) metrics.groupedStatementsCompleted++;
      else metrics.groupedStatementsFailed++;
    },
    finalizerElapsed(started: number) {
      metrics.finalizerMs = (metrics.finalizerMs ?? 0) + duration(started);
    },
    snapshot() {
      return {
        ...metrics,
        flushReasonCounts: { ...metrics.flushReasonCounts },
        groupCounts: { ...groupCounts },
        attemptedAffectedRows: copyRows(attemptedRows),
        writeCoverage: unmeasuredStatements === 0 ? 'complete' : 'partial',
        unmeasuredWriteStatements: unmeasuredStatements,
      };
    },
  };
}

export type ImportPerformanceObserverV1 = ReturnType<typeof createImportPerformanceObserverV1>;

/** A logger failure after commit must never change the academic response. */
export function emitImportPerformanceV1(
  summary: object,
  logger: (value: string) => void = (value) => console.info(value),
): void {
  try {
    logger(
      JSON.stringify({ event: 'gradebook_import_performance', metricsVersion: 1, ...summary }),
    );
  } catch {
    /* Optional telemetry has no authority over academic persistence. */
  }
}
