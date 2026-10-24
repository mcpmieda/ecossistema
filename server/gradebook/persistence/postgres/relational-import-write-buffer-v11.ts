import {
  IMPORT_PENDING_LIMITS_V1,
  jsonRecordChunksV1,
  serializeJsonRecordV1,
  type SerializedJsonRecordV1,
} from './json-record-chunks-v1';
import {
  type GradebookPostgresScalarV1,
  type GradebookPostgresExecutionV1,
  type GradebookPostgresWritePortV1,
} from './postgres-database-v1';

import { postgresJsonTextV1, type GradebookPostgresValueV1 } from './postgres-values-v1';
import {
  importPerformanceNowV1,
  type ImportPerformanceObserverV1,
  type ImportFlushReasonV1,
  type ImportGroupCategoryV1,
} from './import-performance-observer-v1';

type Row = Record<string, unknown>;

interface TransactionDatabaseV11 extends GradebookPostgresWritePortV1 {
  transaction<T>(operation: (database: GradebookPostgresWritePortV1) => Promise<T>): Promise<T>;
}

export interface BufferedRelationalImportDatabaseV11 extends GradebookPostgresWritePortV1 {
  transaction<T>(operation: (database: GradebookPostgresWritePortV1) => Promise<T>): Promise<T>;
  flush(reason?: ImportFlushReasonV1): Promise<void>;
}

interface NoteValueRowV11 {
  readonly instrumento_id: number;
  readonly aluno_id: number;
  readonly valor: number | null;
}

interface NoteKeyRowV11 {
  readonly instrumento_id: number;
  readonly aluno_id: number;
}

interface ClosingHistoryRowV11 {
  readonly importacao_id: number;
  readonly oferta_id: number;
  readonly aluno_id: number;
  readonly campo: number;
  readonly valor_anterior: number | null;
  readonly valor_novo: number | null;
  readonly estado_anterior: number;
  readonly estado_novo: number;
}

interface ClosingRowV11 {
  readonly oferta_id: number;
  readonly aluno_id: number;
  readonly am1_fonte: number | null;
  readonly am2_fonte: number | null;
  readonly am3_fonte: number | null;
  readonly rec1: number | null;
  readonly rec2: number | null;
  readonly rec3: number | null;
  readonly rec_nc_mask: number;
  readonly rec_rr_mask: number;
  readonly u_fonte: number | null;
}

interface ClosingKeyRowV11 {
  readonly oferta_id: number;
  readonly aluno_id: number;
}

interface BufferedMutationRowsV11 {
  noteInsert: NoteValueRowV11;
  noteUpdate: NoteValueRowV11;
  noteDelete: NoteKeyRowV11;
  closingHistory: ClosingHistoryRowV11;
  closingInsert: ClosingRowV11;
  closingUpdate: ClosingRowV11;
  closingDelete: ClosingKeyRowV11;
}
type BufferedMutationV11 = {
  [Category in keyof BufferedMutationRowsV11]: {
    category: Category;
    row: BufferedMutationRowsV11[Category];
  };
}[keyof BufferedMutationRowsV11];
type BufferedWritesV11 = { [Category in keyof BufferedMutationRowsV11]: SerializedJsonRecordV1[] };

function emptyBuffer(): BufferedWritesV11 {
  return {
    noteInsert: [],
    noteUpdate: [],
    noteDelete: [],
    closingHistory: [],
    closingInsert: [],
    closingUpdate: [],
    closingDelete: [],
  };
}

function transactionDatabase(database: GradebookPostgresWritePortV1): TransactionDatabaseV11 {
  if (
    !('transaction' in database) ||
    typeof (database as { transaction?: unknown }).transaction !== 'function'
  ) {
    throw new Error('gradebook-relational-import-requires-postgres');
  }
  return database as TransactionDatabaseV11;
}

function compactSql(query: string): string {
  return query.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}

function integer(value: GradebookPostgresValueV1, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`gradebook-import-buffer-invalid-${label}`);
  }
  return value;
}

function nullableInteger(value: GradebookPostgresValueV1, label: string): number | null {
  if (value === null) return null;
  return integer(value, label);
}

function assertLength(
  values: readonly GradebookPostgresValueV1[],
  expected: number,
  label: string,
): void {
  if (values.length !== expected) {
    throw new Error(`gradebook-import-buffer-invalid-${label}`);
  }
}

function resultChanges(result: GradebookPostgresExecutionV1): number {
  const changes = result.changes;
  if (typeof changes !== 'number' || !Number.isSafeInteger(changes) || changes < 0) {
    throw new Error('gradebook-import-buffer-invalid-change-count');
  }
  return changes;
}

class BufferedDatabaseV11 implements BufferedRelationalImportDatabaseV11 {
  private pending: BufferedWritesV11 = emptyBuffer();
  private pendingRows = 0;
  private pendingBytes = 0;
  private readonly pendingKeys = new Set<string>();
  private failed = false;

  private assertUsable(): void {
    if (this.failed) throw new Error('gradebook-import-buffer-failed');
  }

  constructor(
    private readonly underlying: GradebookPostgresWritePortV1,
    private readonly finalizers: Array<
      (database: GradebookPostgresWritePortV1) => Promise<void>
    > | null = null,
    private readonly observer?: ImportPerformanceObserverV1,
  ) {}

  async executeNative<ResultRow extends Row = Row>(
    query: string,
    values: readonly GradebookPostgresValueV1[],
  ): Promise<GradebookPostgresExecutionV1<ResultRow>> {
    this.assertUsable();
    const mutation = this.classifyRun(query, values);
    if (mutation === null) {
      await this.flush('non-buffered-write');
      return this.underlying.executeNative<ResultRow>(query, values);
    }
    const record = serializeJsonRecordV1(mutation.row);
    let key;
    if (mutation.category === 'closingHistory') {
      key = null;
    } else if ('instrumento_id' in mutation.row) {
      key = `note:${mutation.row.instrumento_id}:${mutation.row.aluno_id}`;
    } else {
      key = `closing:${mutation.row.oferta_id}:${mutation.row.aluno_id}`;
    }
    if (key !== null && this.pendingKeys.has(key)) await this.flush('dependency-boundary');
    let addedBytes = record.jsonBytes + (this.pending[mutation.category].length > 0 ? 1 : 2);
    if (this.pendingRows + 1 > IMPORT_PENDING_LIMITS_V1.maximumRows) {
      await this.flush('row-limit');
      addedBytes = record.jsonBytes + 2;
    } else if (this.pendingBytes + addedBytes > IMPORT_PENDING_LIMITS_V1.maximumBytes) {
      await this.flush('byte-limit');
      addedBytes = record.jsonBytes + 2;
    }
    this.pending[mutation.category].push(record);
    this.pendingRows++;
    this.pendingBytes += addedBytes;
    if (key !== null) this.pendingKeys.add(key);
    this.observer?.bufferedMutation();
    this.observer?.pendingSize(this.pendingRows, this.pendingBytes);
    return { rows: [], changes: 1 };
  }

  async query<ResultRow extends Row>(
    query: string,
    values: readonly GradebookPostgresScalarV1[],
  ): Promise<readonly ResultRow[]> {
    await this.flush('read-boundary');
    return this.underlying.query<ResultRow>(query, values);
  }

  afterImportFlush(operation: (database: GradebookPostgresWritePortV1) => Promise<void>): void {
    if (this.finalizers === null) throw new Error('import-finalizer-outside-transaction');
    this.finalizers.push(operation);
  }

  async transaction<T>(
    operation: (database: GradebookPostgresWritePortV1) => Promise<T>,
  ): Promise<T> {
    await this.flush('transaction-end');
    return transactionDatabase(this.underlying).transaction(async (transaction) => {
      const finalizers = this.finalizers ?? [];
      const nested = new BufferedDatabaseV11(transaction, finalizers, this.observer);
      const result = await operation(nested);
      await nested.flush('transaction-end');
      if (this.finalizers === null) {
        for (const finalize of finalizers) {
          const started = importPerformanceNowV1();
          try {
            await finalize(transaction);
          } finally {
            this.observer?.finalizerElapsed(started);
          }
        }
      }
      return result;
    });
  }

  private classifyRun(
    query: string,
    values: readonly GradebookPostgresValueV1[],
  ): BufferedMutationV11 | null {
    const sql = compactSql(query);

    if (
      sql.startsWith('insert into gradebook.nota_historico ') ||
      sql.startsWith('insert into gradebook.instrumento_historico ')
    ) {
      throw new Error('gradebook-import-granular-history-retired');
    }

    if (
      sql.startsWith('insert into gradebook.nota (instrumento_id, aluno_id, valor)') &&
      /values\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*\)$/u.test(sql)
    ) {
      assertLength(values, 3, 'note-insert');
      return {
        category: 'noteInsert',
        row: {
          instrumento_id: integer(values[0]!, 'instrument-id'),
          aluno_id: integer(values[1]!, 'student-id'),
          valor: nullableInteger(values[2]!, 'note'),
        },
      };
    }

    if (sql.startsWith('update gradebook.nota set valor = $1 ')) {
      assertLength(values, 3, 'note-update');
      return {
        category: 'noteUpdate',
        row: {
          instrumento_id: integer(values[1]!, 'instrument-id'),
          aluno_id: integer(values[2]!, 'student-id'),
          valor: nullableInteger(values[0]!, 'note'),
        },
      };
    }

    if (sql === 'delete from gradebook.nota where instrumento_id = $1 and aluno_id = $2') {
      assertLength(values, 2, 'note-delete');
      return {
        category: 'noteDelete',
        row: {
          instrumento_id: integer(values[0]!, 'instrument-id'),
          aluno_id: integer(values[1]!, 'student-id'),
        },
      };
    }

    if (
      sql.startsWith('insert into gradebook.fechamento_historico ') &&
      /values\s*\([^)]*\)$/u.test(sql)
    ) {
      assertLength(values, 8, 'closing-history');
      return {
        category: 'closingHistory',
        row: {
          importacao_id: integer(values[0]!, 'import-id'),
          oferta_id: integer(values[1]!, 'offer-id'),
          aluno_id: integer(values[2]!, 'student-id'),
          campo: integer(values[3]!, 'closing-field'),
          valor_anterior: nullableInteger(values[4]!, 'previous-closing'),
          valor_novo: nullableInteger(values[5]!, 'next-closing'),
          estado_anterior: integer(values[6]!, 'previous-state'),
          estado_novo: integer(values[7]!, 'next-state'),
        },
      };
    }

    if (
      sql.startsWith('insert into gradebook.fechamento (oferta_id, aluno_id,') &&
      /values\s*\([^)]*\)$/u.test(sql)
    ) {
      assertLength(values, 11, 'closing-insert');
      return { category: 'closingInsert', row: this.closingRow(values, false) };
    }

    if (sql.startsWith('update gradebook.fechamento set am1_fonte = $1')) {
      assertLength(values, 11, 'closing-update');
      return { category: 'closingUpdate', row: this.closingRow(values, true) };
    }

    if (sql.startsWith('delete from gradebook.fechamento where oferta_id = $1 ')) {
      assertLength(values, 2, 'closing-delete');
      return {
        category: 'closingDelete',
        row: {
          oferta_id: integer(values[0]!, 'offer-id'),
          aluno_id: integer(values[1]!, 'student-id'),
        },
      };
    }

    return null;
  }

  private closingRow(values: readonly GradebookPostgresValueV1[], update: boolean): ClosingRowV11 {
    const offset = update ? 0 : 2;
    const ofertaIndex = update ? 9 : 0;
    const alunoIndex = update ? 10 : 1;
    return {
      oferta_id: integer(values[ofertaIndex]!, 'offer-id'),
      aluno_id: integer(values[alunoIndex]!, 'student-id'),
      am1_fonte: nullableInteger(values[offset]!, 'am1'),
      am2_fonte: nullableInteger(values[offset + 1]!, 'am2'),
      am3_fonte: nullableInteger(values[offset + 2]!, 'am3'),
      rec1: nullableInteger(values[offset + 3]!, 'rec1'),
      rec2: nullableInteger(values[offset + 4]!, 'rec2'),
      rec3: nullableInteger(values[offset + 5]!, 'rec3'),
      rec_nc_mask: integer(values[offset + 6]!, 'rec-mask'),
      rec_rr_mask: integer(values[offset + 7]!, 'rr-mask'),
      u_fonte: nullableInteger(values[offset + 8]!, 'u'),
    };
  }

  async flush(reason: ImportFlushReasonV1 = 'transaction-end'): Promise<void> {
    this.assertUsable();
    const current = this.pending;
    if (
      current.noteInsert.length === 0 &&
      current.noteUpdate.length === 0 &&
      current.noteDelete.length === 0 &&
      current.closingHistory.length === 0 &&
      current.closingInsert.length === 0 &&
      current.closingUpdate.length === 0 &&
      current.closingDelete.length === 0
    ) {
      return;
    }
    this.observer?.flush(reason);

    try {
      await this.groupedRun(
        `DELETE FROM gradebook.nota AS current
       USING jsonb_to_recordset($1::jsonb) AS incoming(
         instrumento_id integer,
         aluno_id integer
       )
       WHERE current.instrumento_id = incoming.instrumento_id
         AND current.aluno_id = incoming.aluno_id`,
        current.noteDelete,
        'note-delete',
      );
      await this.groupedRun(
        `UPDATE gradebook.nota AS current
       SET valor = incoming.valor
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         instrumento_id integer,
         aluno_id integer,
         valor integer
       )
       WHERE current.instrumento_id = incoming.instrumento_id
         AND current.aluno_id = incoming.aluno_id`,
        current.noteUpdate,
        'note-update',
      );
      await this.groupedRun(
        `INSERT INTO gradebook.nota (instrumento_id, aluno_id, valor)
       SELECT instrumento_id, aluno_id, valor
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         instrumento_id integer,
         aluno_id integer,
         valor integer
       )`,
        current.noteInsert,
        'note-insert',
      );
      await this.groupedRun(
        `INSERT INTO gradebook.fechamento_historico
       (importacao_id, oferta_id, aluno_id, campo, valor_anterior, valor_novo, estado_anterior, estado_novo)
       SELECT importacao_id, oferta_id, aluno_id, campo, valor_anterior, valor_novo, estado_anterior, estado_novo
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         importacao_id integer,
         oferta_id integer,
         aluno_id integer,
         campo integer,
         valor_anterior integer,
         valor_novo integer,
         estado_anterior smallint,
         estado_novo smallint
       )`,
        current.closingHistory,
        'closing-history',
      );
      await this.groupedRun(
        `DELETE FROM gradebook.fechamento AS current
       USING jsonb_to_recordset($1::jsonb) AS incoming(
         oferta_id integer,
         aluno_id integer
       )
       WHERE current.oferta_id = incoming.oferta_id
         AND current.aluno_id = incoming.aluno_id`,
        current.closingDelete,
        'closing-delete',
      );
      await this.groupedRun(
        `UPDATE gradebook.fechamento AS current
       SET am1_fonte = incoming.am1_fonte,
           am2_fonte = incoming.am2_fonte,
           am3_fonte = incoming.am3_fonte,
           rec1 = incoming.rec1,
           rec2 = incoming.rec2,
           rec3 = incoming.rec3,
           rec_nc_mask = incoming.rec_nc_mask,
           rec_rr_mask = incoming.rec_rr_mask,
           u_fonte = incoming.u_fonte
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         oferta_id integer,
         aluno_id integer,
         am1_fonte integer,
         am2_fonte integer,
         am3_fonte integer,
         rec1 integer,
         rec2 integer,
         rec3 integer,
         rec_nc_mask smallint,
         rec_rr_mask smallint,
         u_fonte integer
       )
       WHERE current.oferta_id = incoming.oferta_id
         AND current.aluno_id = incoming.aluno_id`,
        current.closingUpdate,
        'closing-update',
      );
      await this.groupedRun(
        `INSERT INTO gradebook.fechamento
       (oferta_id, aluno_id, am1_fonte, am2_fonte, am3_fonte, rec1, rec2, rec3, rec_nc_mask, rec_rr_mask, u_fonte)
       SELECT oferta_id, aluno_id, am1_fonte, am2_fonte, am3_fonte, rec1, rec2, rec3, rec_nc_mask, rec_rr_mask, u_fonte
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         oferta_id integer,
         aluno_id integer,
         am1_fonte integer,
         am2_fonte integer,
         am3_fonte integer,
         rec1 integer,
         rec2 integer,
         rec3 integer,
         rec_nc_mask smallint,
         rec_rr_mask smallint,
         u_fonte integer
       )`,
        current.closingInsert,
        'closing-insert',
      );

      this.pending = emptyBuffer();
      this.pendingRows = 0;
      this.pendingBytes = 0;
      this.pendingKeys.clear();
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  }

  private async groupedRun(
    query: string,
    records: readonly SerializedJsonRecordV1[],
    label: ImportGroupCategoryV1,
  ): Promise<void> {
    for (const chunk of jsonRecordChunksV1(records)) {
      this.observer?.groupStarted(label, chunk.rows, chunk.bytes);
      try {
        const result = await this.underlying.executeNative(query, [
          postgresJsonTextV1(chunk.jsonText),
        ]);
        if (resultChanges(result) !== chunk.rows)
          throw new Error(`gradebook-import-buffer-write-count-mismatch:${label}`);
        this.observer?.groupFinished(true);
      } catch (cause) {
        this.observer?.groupFinished(false);
        throw cause;
      }
    }
  }
}

export function createBufferedRelationalImportDatabaseV11(
  database: GradebookPostgresWritePortV1,
  observer?: ImportPerformanceObserverV1,
): BufferedRelationalImportDatabaseV11 {
  return new BufferedDatabaseV11(database, null, observer);
}
