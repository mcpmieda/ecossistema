// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createImportPerformanceObserverV1,
  emitImportPerformanceV1,
} from '../../../server/gradebook/persistence/postgres/import-performance-observer-v1';
import { createGradebookPostgresDatabaseFromSqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createBufferedRelationalImportDatabaseV11 } from '../../../server/gradebook/persistence/postgres/relational-import-write-buffer-v11';
import {
  persistGradebookCanonicalImportV9,
  type ImportPersistenceHttpTimingV1,
} from '../../../src/features/gradebook/import/import-persistence-client-v9';
import type { GradebookRelationImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const noteInsert =
  'INSERT INTO gradebook.nota (instrumento_id, aluno_id, valor) VALUES ($1, $2, $3)';
const noteRead = 'SELECT valor FROM gradebook.nota WHERE instrumento_id = $1';
const request: GradebookRelationImportRequestV9 = {
  transportVersion: 9,
  operation: 'persist-relacao',
  ano: 2090,
  manifest: { fileName: 'sintético.xlsx', sha256: 'a'.repeat(64), parserVersion: 'synthetic' },
  turmas: [
    {
      codigo: '6A',
      nome: 'Turma sintética',
      etapa: 1,
      turno: 'Matutino',
      alunos: [[1, 'Aluno sintético', 1]],
    },
  ],
};

function adapter(options: { mismatch?: boolean; commitFailure?: boolean } = {}) {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const physical = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    clock += 2;
    const rows = sql === noteRead ? [{ valor: 'private-value' }] : [];
    const count = sql.includes('jsonb_to_recordset')
      ? JSON.parse(String(values[0])).length + (options.mismatch ? 1 : 0)
      : rows.length;
    return Object.assign(rows, { count });
  });
  const begin = vi.fn();
  const close = vi.fn(async () => undefined);
  const database = createGradebookPostgresDatabaseFromSqlV1({
    unsafe: async () => {
      throw new Error('query-escaped-physical-transaction');
    },
    async begin(operation) {
      begin();
      const result = await operation({ unsafe: physical });
      clock += 5;
      if (options.commitFailure) throw new Error('private-driver-error');
      return result;
    },
    end: close,
  });
  return { database, begin, physical, close };
}

describe('request-local import performance observer', () => {
  it('counts query delegated through executeNative once and preserves nested transaction/receiver/close', async () => {
    const fixture = adapter();
    const observer = createImportPerformanceObserverV1();
    const database = observer.wrap(fixture.database);
    await database.transaction(async (tx) => {
      await tx.query(noteRead, [12345]);
      await (tx as typeof database).transaction(async (nested) => {
        await nested.executeNative(
          'UPDATE gradebook.nota SET valor = $1 WHERE instrumento_id = $2',
          [67890, 12345],
        );
      });
    });
    expect(fixture.begin).toHaveBeenCalledTimes(1);
    expect(fixture.physical).toHaveBeenCalledTimes(2);
    expect(observer.snapshot()).toMatchObject({
      sqlCalls: 2,
      sqlReadCalls: 1,
      sqlWriteCalls: 1,
      rowsRead: 1,
      transactionMs: 9,
      transactionOutcome: 'committed',
    });
    expect(database.lastFailure()).toBeNull();
    await database.close();
    expect(fixture.close).toHaveBeenCalledTimes(1);
    const isolated = createImportPerformanceObserverV1().snapshot();
    expect(isolated).toMatchObject({ sqlCalls: 0, transactionMs: null, finalizerMs: null });
  });

  it('observes emitted groups below the buffer, skips empty flushes and never serializes cumulatively', async () => {
    const fixture = adapter();
    const observer = createImportPerformanceObserverV1();
    const buffer = createBufferedRelationalImportDatabaseV11(
      observer.wrap(fixture.database),
      observer,
    );
    const stringify = vi.spyOn(JSON, 'stringify');
    await buffer.transaction(async (tx) => {
      await tx.executeNative(noteInsert, [12345, 23456, 67890]);
      await tx.executeNative(noteInsert, [12345, 23457, 67891]);
      expect(fixture.physical).not.toHaveBeenCalled();
      await tx.query(noteRead, [12345]);
      await tx.query('SELECT pg_advisory_xact_lock_shared(613,0)', []);
      await tx.query('SELECT student_portal.ensure_year_coordination_v1($1::smallint)', [2090]);
      (
        tx as typeof buffer & {
          afterImportFlush(operation: (database: typeof tx) => Promise<void>): void;
        }
      ).afterImportFlush(async (database) => {
        await database.executeNative(
          'SELECT reset_version FROM student_portal.record_gradebook_change_v1($1)',
          ['private-token'],
        );
      });
    });
    expect(stringify).toHaveBeenCalledTimes(2);
    expect(stringify.mock.calls.every(([value]) => !Array.isArray(value))).toBe(true);
    await buffer.flush();
    const metrics = observer.snapshot();
    expect(metrics).toMatchObject({
      sqlCalls: 5,
      sqlReadCalls: 1,
      sqlWriteCalls: 2,
      sqlOtherCalls: 2,
      rowsRead: 1,
      bufferedLogicalMutations: 2,
      groupedStatements: 1,
      groupedStatementsCompleted: 1,
      groupRows: 2,
      maximumGroupRows: 2,
      flushesWithWork: 1,
      flushReasonCounts: { 'read-boundary': 1 },
      coordinationCallMs: 4,
      finalizerMs: 2,
    });
    const body = fixture.physical.mock.calls[0]![1]![0];
    expect(metrics.groupBytes).toBe(new TextEncoder().encode(String(body)).byteLength);
    const logs: string[] = [];
    emitImportPerformanceV1(metrics, (value) => logs.push(value));
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(
      /12345|23456|67890|private-value|private-token|SELECT|INSERT|instrumento_id|aluno_id/u,
    );
  });

  it('measures only fixed read-set/catalog/instrument aggregates without retaining values', async () => {
    const observer = createImportPerformanceObserverV1();
    const database = observer.wrap(
      createGradebookPostgresDatabaseFromSqlV1({
        unsafe: async (sql) =>
          Object.assign(
            Array.from({ length: sql.includes('notes') ? 7 : 2 }, () => ({ private: 'never-log' })),
            { count: 2 },
          ),
        begin: async () => {
          throw new Error('not-used');
        },
        end: async () => undefined,
      }),
    );
    const values = [2090, { jsonText: '[12345,67890]' }];
    for (const name of ['instruments', 'notes', 'closings'])
      await database.executeNative(
        `SELECT i FROM gradebook.instrumento /* import-read-set:${name} */`,
        values,
      );
    await database.executeNative('SELECT d /* import-catalog:disciplines-read */', values);
    await database.executeNative('INSERT d /* import-catalog:disciplines-create */', values);
    for (const name of ['create', 'update', 'retire'])
      await database.executeNative(`UPDATE i /* import-instruments:${name} */`, values);
    const metrics = observer.snapshot();
    expect(metrics).toMatchObject({
      sqlCalls: 8,
      sqlReadCalls: 4,
      sqlWriteCalls: 4,
      readSetBlocks: 1,
      readSetOffers: 2,
      maximumReadSetOffers: 2,
      maximumReadSetRows: 11,
      catalogReadCalls: 1,
      catalogWriteCalls: 1,
      instrumentStatements: 3,
      instrumentsCreated: 2,
      instrumentsUpdated: 2,
      instrumentsRetired: 2,
      maximumInstrumentGroupRows: 2,
      maximumInstrumentGroupBytes: 13,
    });
    expect(JSON.stringify(metrics)).not.toMatch(/12345|67890|never-log/u);
    await database.executeNative('UPDATE i /* import-instruments:create */', [
      2090,
      { jsonText: 'invalid-json' },
    ]);
    expect(observer.snapshot().sqlCalls).toBe(9);
  });

  it('records group mismatch as failure without completed groups and preserves rejection', async () => {
    const fixture = adapter({ mismatch: true });
    const observer = createImportPerformanceObserverV1();
    const buffer = createBufferedRelationalImportDatabaseV11(
      observer.wrap(fixture.database),
      observer,
    );
    await expect(
      buffer.transaction(async (tx) => {
        await tx.executeNative(noteInsert, [1, 2, 3]);
      }),
    ).rejects.toThrow('write-count-mismatch');
    expect(observer.snapshot()).toMatchObject({
      groupedStatementsFailed: 1,
      groupedStatementsCompleted: 0,
      transactionOutcome: 'rejected',
      flushReasonCounts: { 'transaction-end': 1 },
    });
  });

  it('distinguishes commit uncertainty and cannot turn logging failure into academic failure', async () => {
    const fixture = adapter({ commitFailure: true });
    const observer = createImportPerformanceObserverV1();
    await expect(
      observer.wrap(fixture.database).transaction(async () => 'callback-complete'),
    ).rejects.toThrow('private-driver-error');
    expect(observer.snapshot()).toMatchObject({ transactionOutcome: 'unknown', transactionMs: 5 });
    expect(() =>
      emitImportPerformanceV1(observer.snapshot(), () => {
        throw new Error('logger-failed');
      }),
    ).not.toThrow();
  });
});

describe('HTTP timing boundaries', () => {
  it('adds no telemetry serialization, counts sent UTF-8 and reports missing/blank server measurements as null', async () => {
    const timing: ImportPersistenceHttpTimingV1[] = [];
    const fetch = vi.fn(async () =>
      Response.json({ transportVersion: 9, state: 'blocked', reason: 'synthetic' }),
    );
    vi.stubGlobal('fetch', fetch);
    const stringify = vi.spyOn(JSON, 'stringify');
    const dispatch = vi.fn();
    const result = await persistGradebookCanonicalImportV9(
      request,
      (value) => timing.push(value),
      dispatch,
    );
    const body = fetch.mock.calls[0] as unknown as [string, RequestInit];
    // The existing contract inspector serializes once for its size guard; sending once
    // is still necessary. Telemetry uses that sent body without adding a third pass.
    expect(stringify.mock.calls.filter(([value]) => value === request)).toHaveLength(2);
    expect(timing[0]).toMatchObject({
      payloadBytes: new TextEncoder().encode(body[1].body as string).byteLength,
      outcome: 'blocked',
    });
    expect(timing[0]!.payloadBytes).toBeGreaterThan((body[1].body as string).length);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.serverMs).toBeNull();
    fetch.mockImplementation(async () =>
      Response.json(
        { transportVersion: 9, state: 'blocked', reason: 'synthetic' },
        { headers: { 'X-Gradebook-Server-Ms': '' } },
      ),
    );
    expect((await persistGradebookCanonicalImportV9(request)).serverMs).toBeNull();
  });

  it('records failed HTTP attempts and preserves the uncertainty even if its timing callback fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('synthetic-network-error');
      }),
    );
    const timing = vi.fn(() => {
      throw new Error('synthetic-logger-error');
    });
    await expect(persistGradebookCanonicalImportV9(request, timing)).rejects.toThrow(
      'synthetic-network-error',
    );
    expect(timing).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'confirmation-required',
        persistRequestMs: expect.any(Number),
      }),
    );
  });
});

it('reports import throttling wait without retrying or claiming a commit', async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      { transportVersion: 9, state: 'unavailable' },
      { status: 429, headers: { 'Retry-After': '60' } },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const timing = vi.fn();
  await expect(persistGradebookCanonicalImportV9(request, timing)).rejects.toThrow(
    'Aguarde 60 segundos',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(timing).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'unavailable', commitDiagnostics: null }),
  );
});
