// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyImportCommitAffectedRowsV1,
  IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1,
  IMPORT_COMMIT_DIAGNOSTICS_MAXIMUM_BYTES_V1,
  parseImportCommitDiagnosticsHeaderV1,
  serializeImportCommitDiagnosticsHeaderV1,
  type ImportCommitDiagnosticsV1,
} from '../../../shared/gradebook-contracts/imports/import-commit-diagnostics-v1';
import { createImportPerformanceObserverV1 } from '../../../server/gradebook/persistence/postgres/import-performance-observer-v1';
import { createGradebookPostgresDatabaseFromSqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import type { GradebookPostgresWritePortV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
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
function diagnostic(): ImportCommitDiagnosticsV1 {
  const attempted = emptyImportCommitAffectedRowsV1();
  attempted.professor.update = 1;
  return {
    version: 1,
    scope: 'direct-import-statements',
    coverage: 'complete',
    transaction: 'committed',
    attempted,
    confirmed: structuredClone(attempted),
    unmeasuredStatements: 0,
    excludedEffects: 'sql-functions-triggers-portal',
  };
}
const request: GradebookRelationImportRequestV9 = {
  transportVersion: 9,
  operation: 'persist-relacao',
  ano: 2026,
  manifest: {
    fileName: 'PRIVATE-SYNTHETIC-FILE.xlsx',
    sha256: 'a'.repeat(64),
    parserVersion: 'synthetic',
  },
  turmas: [
    {
      codigo: 'SYN-A',
      nome: 'PRIVATE-SYNTHETIC-CLASS',
      etapa: 6,
      turno: 'Matutino',
      alunos: [[1, 'PRIVATE-SYNTHETIC-STUDENT', 0]],
    },
  ],
};

describe('bounded optional commit diagnostics contract', () => {
  it('accepts only fixed aggregate fields and distinguishes missing confirmation from measured zero', () => {
    const value = diagnostic();
    const raw = serializeImportCommitDiagnosticsHeaderV1(value)!;
    expect(raw.length).toBeLessThanOrEqual(IMPORT_COMMIT_DIAGNOSTICS_MAXIMUM_BYTES_V1);
    expect(parseImportCommitDiagnosticsHeaderV1(raw)).toEqual(value);
    expect(
      parseImportCommitDiagnosticsHeaderV1(
        JSON.stringify({ ...value, transaction: 'unknown', confirmed: null }),
      )?.confirmed,
    ).toBeNull();
    const zero = emptyImportCommitAffectedRowsV1();
    expect(
      parseImportCommitDiagnosticsHeaderV1(
        JSON.stringify({ ...value, attempted: zero, confirmed: zero }),
      )?.confirmed,
    ).toEqual(zero);
    expect(parseImportCommitDiagnosticsHeaderV1(raw.padEnd(2_048, ' '))).toEqual(value);
    expect(parseImportCommitDiagnosticsHeaderV1(raw.padEnd(2_049, ' '))).toBeNull();
  });
  it.each([null, '', '{', 'null', '[]', '{}', '\u0080'])(
    'ignores missing/malformed/non-ASCII input %s',
    (raw) => {
      expect(parseImportCommitDiagnosticsHeaderV1(raw)).toBeNull();
    },
  );
  it('rejects unknown properties/categories/version, coerced enums, impossible confirmation and unsafe counts', () => {
    const valid = diagnostic();
    const invalid: unknown[] = [
      { ...valid, version: 2 },
      { ...valid, token: 'PRIVATE-TOKEN' },
      { ...valid, coverage: ['complete'] },
      { ...valid, transaction: 'rolled-back' },
      { ...valid, transaction: 'rejected' },
      { ...valid, unmeasuredStatements: 1 },
      { ...valid, attempted: { ...valid.attempted, student: { insert: 1, update: 0, delete: 0 } } },
      { ...valid, confirmed: { ...valid.confirmed, nota: { insert: 1, update: 0, delete: 0 } } },
      ...[-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN].map((insert) => ({
        ...valid,
        attempted: { ...valid.attempted, nota: { insert, update: 0, delete: 0 } },
      })),
    ];
    for (const value of invalid) {
      expect(serializeImportCommitDiagnosticsHeaderV1(value)).toBeNull();
      expect(parseImportCommitDiagnosticsHeaderV1(JSON.stringify(value))).toBeNull();
    }
    expect(
      serializeImportCommitDiagnosticsHeaderV1({
        ...valid,
        coverage: 'partial',
        unmeasuredStatements: 1,
      }),
    ).not.toBeNull();
  });
  it('omits an optional diagnostic if serialization itself fails', () => {
    vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('private-diagnostic-error');
    });
    expect(serializeImportCommitDiagnosticsHeaderV1(diagnostic())).toBeNull();
  });
});

describe('physical affected rows below the existing V11 buffer', () => {
  it('counts 512 inserted notes by actual adapter rows, without counting buffered writes twice', async () => {
    const physical = vi.fn(async (_sql: string, parameters: readonly unknown[] = []) => {
      const count = JSON.parse(String(parameters[0])).length;
      return Object.assign([], { count });
    });
    const database = createGradebookPostgresDatabaseFromSqlV1({
      unsafe: physical,
      begin: (run) => run({ unsafe: physical }),
    });
    const observer = createImportPerformanceObserverV1();
    const buffer = createBufferedRelationalImportDatabaseV11(observer.wrap(database), observer);
    await buffer.transaction(async (tx) => {
      for (let student = 1; student <= 512; student++)
        await tx.executeNative(
          'INSERT INTO gradebook.nota (instrumento_id, aluno_id, valor) VALUES ($1, $2, $3)',
          [1, student, 123],
        );
    });
    expect(observer.commitDiagnostics('applied', true)).toMatchObject({
      coverage: 'complete',
      transaction: 'committed',
      attempted: { nota: { insert: 512 } },
      confirmed: { nota: { insert: 512 } },
    });
    expect(observer.snapshot().bufferedLogicalMutations).toBe(512);
    expect(observer.snapshot().sqlCalls).toBe(physical.mock.calls.length);
    expect(physical.mock.calls.length).toBeLessThan(512);
  });
  it('counts RETURNING only once, classifies history/import and other direct tables, and does not mistake UPDATE for value differences', async () => {
    const physical = vi.fn(async () => Object.assign([{ id: 'PRIVATE-ID' }], { count: 3 }));
    const database = createGradebookPostgresDatabaseFromSqlV1({
      unsafe: physical,
      begin: (run) => run({ unsafe: physical }),
    });
    const observer = createImportPerformanceObserverV1();
    await observer.wrap(database).transaction(async (tx) => {
      await tx.executeNative(
        'INSERT INTO gradebook.importacao (ano) VALUES ($1) RETURNING id',
        [2026],
      );
      await tx.executeNative('UPDATE gradebook.nota SET valor = valor', []);
      await tx.executeNative(
        'DELETE FROM gradebook.fechamento_historico WHERE importacao_id=$1',
        [99],
      );
      await tx.executeNative('UPDATE gradebook.aluno SET nome=$1 WHERE id=$2', [
        'PRIVATE-STUDENT',
        99,
      ]);
      await tx.query('UPDATE gradebook.professor SET nome=$1 RETURNING id', ['PRIVATE-TEACHER']);
    });
    const value = observer.commitDiagnostics('applied', true);
    expect(value.attempted).toMatchObject({
      'history-import': { insert: 3, delete: 3 },
      nota: { update: 3 },
      other: { update: 3 },
      professor: { update: 1 },
    });
    expect(value.confirmed).toEqual(value.attempted);
    expect(physical).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(value)).not.toMatch(
      /PRIVATE|SELECT|UPDATE|INSERT|aluno_id|importacao_id/u,
    );
    expect(observer.commitDiagnostics('applied').confirmed).toBeNull();
    expect(observer.commitDiagnostics('unavailable', true).confirmed).toBeNull();
  });
  it('reports partial coverage rather than zero for DML without available cardinality or unclassified compound statements', async () => {
    const physical = async () => Object.assign([], { count: 2 });
    const database = createGradebookPostgresDatabaseFromSqlV1({
      unsafe: physical,
      begin: (run) => run({ unsafe: physical }),
    });
    const observer = createImportPerformanceObserverV1();
    await observer.wrap(database).transaction(async (tx) => {
      await tx.query('UPDATE gradebook.professor SET nome=$1', ['PRIVATE-TEACHER']);
      await tx.executeNative(
        'WITH x AS (UPDATE gradebook.nota SET valor=$1 RETURNING *) SELECT * FROM x',
        [99],
      );
    });
    expect(observer.commitDiagnostics('applied', true)).toMatchObject({
      coverage: 'partial',
      unmeasuredStatements: 2,
    });
  });
  it.each(['finalizer', 'commit'])(
    'never confirms successful flushes when the %s later fails and preserves the original exception',
    async (failure) => {
      const original = new Error('PRIVATE-ORIGINAL');
      const physical = async (sql: string) => {
        if (sql.includes('record_gradebook_change') && failure === 'finalizer') throw original;
        return Object.assign([], { count: 1 });
      };
      const database = createGradebookPostgresDatabaseFromSqlV1({
        unsafe: physical,
        async begin(run) {
          const value = await run({ unsafe: physical });
          if (failure === 'commit') throw original;
          return value;
        },
      });
      const observer = createImportPerformanceObserverV1();
      const buffer = createBufferedRelationalImportDatabaseV11(observer.wrap(database), observer);
      await expect(
        buffer.transaction(async (tx) => {
          await tx.executeNative(
            'INSERT INTO gradebook.nota (instrumento_id, aluno_id, valor) VALUES ($1, $2, $3)',
            [1, 2, 3],
          );
          (
            tx as typeof buffer & {
              afterImportFlush(
                run: (connection: GradebookPostgresWritePortV1) => Promise<void>,
              ): void;
            }
          ).afterImportFlush(async (connection) => {
            await connection.executeNative(
              'SELECT reset_version FROM student_portal.record_gradebook_change_v1($1)',
              ['PRIVATE-TOKEN'],
            );
          });
        }),
      ).rejects.toBe(original);
      expect(observer.commitDiagnostics('applied', true)).toMatchObject({
        transaction: failure === 'commit' ? 'unknown' : 'rejected',
        attempted: { nota: { insert: 1 } },
        confirmed: null,
      });
    },
  );
  it('keeps previously rolled-back attempts separate from a later confirmed transaction', async () => {
    const physical = async () => Object.assign([], { count: 1 });
    const database = createGradebookPostgresDatabaseFromSqlV1({
      unsafe: physical,
      begin: (run) => run({ unsafe: physical }),
    });
    const observer = createImportPerformanceObserverV1();
    const wrapped = observer.wrap(database);
    await expect(
      wrapped.transaction(async (tx) => {
        await tx.executeNative('INSERT INTO gradebook.nota VALUES ($1)', [1]);
        throw new Error('synthetic-rollback');
      }),
    ).rejects.toThrow('synthetic-rollback');
    await wrapped.transaction((tx) =>
      tx.executeNative('INSERT INTO gradebook.nota VALUES ($1)', [2]),
    );
    expect(observer.commitDiagnostics('applied', true)).toMatchObject({
      attempted: { nota: { insert: 2 } },
      confirmed: { nota: { insert: 1 } },
    });
  });
});

describe('client optional commit header without academic transport changes', () => {
  it.each(['valid', 'missing', 'invalid', 'oversized', 'getter-failure'])(
    'preserves body/status/single POST with %s diagnostics',
    async (mode) => {
      const timings: ImportPersistenceHttpTimingV1[] = [];
      const value = { transportVersion: 9, state: 'blocked', reason: 'synthetic' };
      const technical = { ...diagnostic(), transaction: 'rejected', confirmed: null };
      const raw =
        mode === 'valid'
          ? JSON.stringify(technical)
          : mode === 'invalid'
            ? '{'
            : mode === 'oversized'
              ? ' '.repeat(2_049)
              : null;
      const response = Response.json(value, {
        status: 409,
        headers: raw === null ? {} : { [IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1]: raw },
      });
      if (mode === 'getter-failure') {
        const get = response.headers.get.bind(response.headers);
        vi.spyOn(response.headers, 'get').mockImplementation((name) => {
          if (name === IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1) throw new Error('PRIVATE-HEADER-ERROR');
          return get(name);
        });
      }
      const fetch = vi.fn(async () => response);
      vi.stubGlobal('fetch', fetch);
      expect(
        (await persistGradebookCanonicalImportV9(request, (timing) => timings.push(timing)))
          .response,
      ).toEqual(value);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        '/api/gradebook/import-persistence',
        expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify(request),
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(timings[0]?.commitDiagnostics).toEqual(mode === 'valid' ? technical : null);
    },
  );
  it('delivers validated confirmed aggregates only beside an academically confirmed result, without logging private data', async () => {
    const consoleInfo = vi.spyOn(console, 'info');
    const technical = diagnostic();
    const source = {
      transportVersion: 9,
      state: 'no-changes',
      summary: {
        assessmentDefinitions: { total: 0, resolved: 0, blocked: 0 },
        assessmentComponents: { unchanged: 0, new: 0, changed: 0, blocked: 0 },
        academicRecords: { unchanged: 0, new: 0, changed: 0, missingFromNewSource: 0, blocked: 0 },
        plannedWrites: {
          logicalSources: 0,
          sourceFileVersions: 0,
          importBatchVersions: 0,
          assessmentComponentVersions: 0,
          academicRecordVersions: 0,
          logicalSourceRecordAssociationVersions: 0,
          total: 0,
        },
        committedWrites: {
          logicalSources: 0,
          sourceFileVersions: 0,
          importBatchVersions: 0,
          assessmentComponentVersions: 0,
          academicRecordVersions: 0,
          logicalSourceRecordAssociationVersions: 0,
          total: 0,
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(source, {
          headers: { [IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1]: JSON.stringify(technical) },
        }),
      ),
    );
    const callback = vi.fn();
    const result = await persistGradebookCanonicalImportV9(request, callback);
    expect(result.response).toEqual(source);
    expect(callback.mock.calls[0]![0].commitDiagnostics).toEqual(technical);
    expect(JSON.stringify(callback.mock.calls)).not.toMatch(/PRIVATE|a{64}|SYN-A/u);
    expect(consoleInfo).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { transportVersion: 9, state: 'blocked', reason: 'synthetic' },
          { headers: { [IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1]: JSON.stringify(technical) } },
        ),
      ),
    );
    await persistGradebookCanonicalImportV9(request, callback);
    expect(callback.mock.calls[1]![0].commitDiagnostics).toBeNull();
  });
});
