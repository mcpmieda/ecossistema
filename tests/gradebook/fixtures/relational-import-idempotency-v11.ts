import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import { createImportPerformanceObserverV1 } from '../../../server/gradebook/persistence/postgres/import-performance-observer-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresQuerySqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import type { GradebookImportPersistenceRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';

type Row = Record<string, unknown>;
type Action = 'insert' | 'update' | 'delete';
const tables = [
  'ano_letivo',
  'turma',
  'aluno',
  'vinculo',
  'vinculo_historico',
  'professor',
  'disciplina',
  'oferta',
  'instrumento',
  'nota',
  'fechamento',
  'fechamento_historico',
  'importacao',
] as const;
type DmlCategory = `${(typeof tables)[number]}:${Action}`;
export type IdempotencyFailureV11 =
  'none' | 'after-note-flush' | 'after-revision' | 'after-lifecycle';

function emptyCounts() {
  return {
    dml: {} as Partial<Record<DmlCategory, { statements: number; affectedRows: number }>>,
    revisionCalls: 0,
    lifecycleCalls: 0,
    commits: 0,
    rollbacks: 0,
  };
}

/** Disposable PGlite, real V11 -> V10 -> V9 and finalizers. The observer retains
 * only fixed categories/counts, never SQL, parameters or source records. */
export async function createRelationalImportIdempotencyFixtureV11() {
  const pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  for (const migration of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
    '0009_granular_observations_names_v1.sql',
  ])
    await pg.exec(readFileSync(`migrations/gradebook-simplified/${migration}`, 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  await pg.exec('UPDATE student_portal.lifecycle_control SET population_enabled=true');

  let counts = emptyCounts();
  let failure: IdempotencyFailureV11 = 'none';
  async function run(
    client: Pick<PGlite, 'query'>,
    query: string,
    values: readonly unknown[] = [],
  ) {
    const result = await client.query<Row>(query, [...values]);
    const affectedRows = result.affectedRows ?? result.rows.length;
    const dml = /\b(insert into|update|delete from) gradebook\.([a-z_]+)\b/iu.exec(query);
    if (dml?.[1] && dml[2] && tables.includes(dml[2] as (typeof tables)[number])) {
      const action: Action =
        dml[1].toLowerCase() === 'insert into'
          ? 'insert'
          : dml[1].toLowerCase() === 'delete from'
            ? 'delete'
            : 'update';
      const category = `${dml[2]}:${action}` as DmlCategory;
      const previous = counts.dml[category] ?? { statements: 0, affectedRows: 0 };
      counts.dml[category] = {
        statements: previous.statements + 1,
        affectedRows: previous.affectedRows + affectedRows,
      };
      if (
        category === 'nota:insert' &&
        query.includes('jsonb_to_recordset') &&
        failure === 'after-note-flush'
      )
        throw new Error('synthetic-after-note-flush');
    }
    if (query.includes('record_gradebook_change_v1')) {
      counts.revisionCalls++;
      if (failure === 'after-revision') throw new Error('synthetic-after-revision');
    }
    if (query.includes('synchronize_gradebook_profiles_v1')) {
      counts.lifecycleCalls++;
      if (failure === 'after-lifecycle') throw new Error('synthetic-after-lifecycle');
    }
    return Object.assign(result.rows, { count: affectedRows });
  }
  const database = createGradebookPostgresDatabaseFromSqlV1({
    unsafe: (query, values) => run(pg, query, values),
    async begin(operation) {
      try {
        const result = await pg.transaction((client) =>
          operation({
            unsafe: (query, values) => run(client, query, values),
          } satisfies GradebookPostgresQuerySqlV1),
        );
        counts.commits++;
        return result;
      } catch (cause) {
        counts.rollbacks++;
        throw cause;
      }
    },
    end: () => pg.close(),
  });
  const schemaTables = (
    await pg.query<{ schema: string; name: string }>(`
    SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
    WHERE table_schema IN ('gradebook','student_portal') AND table_type='BASE TABLE'
    ORDER BY table_schema,table_name`)
  ).rows;
  let lastObserver = createImportPerformanceObserverV1();

  return {
    pg,
    database,
    setFailure(value: IdempotencyFailureV11) {
      failure = value;
    },
    lastCounts() {
      return structuredClone(counts);
    },
    lastMetrics() {
      return lastObserver.snapshot();
    },
    lastCommitDiagnostics() {
      return lastObserver.commitDiagnostics('unavailable', true);
    },
    async execute(request: GradebookImportPersistenceRequestV9) {
      counts = emptyCounts();
      lastObserver = createImportPerformanceObserverV1();
      const response = await createGradebookRelationalImportServiceV11(
        lastObserver.wrap(database),
        lastObserver,
      ).execute(request);
      return {
        response,
        counts: structuredClone(counts),
        metrics: lastObserver.snapshot(),
        // This reusable fixture has no per-request resource wrapper; execute has
        // completed the real outer transaction. HTTP close is tested separately.
        diagnostics: lastObserver.commitDiagnostics(response.state, true),
      };
    },
    async snapshot() {
      const snapshot: Record<string, readonly Row[]> = {};
      for (const { schema, name } of schemaTables) {
        if (!/^[a-z_][a-z_0-9]*$/u.test(schema) || !/^[a-z_][a-z_0-9]*$/u.test(name))
          throw new Error('unsafe-fixture-table');
        snapshot[`${schema}.${name}`] = (
          await pg.query<Row>(
            `SELECT to_jsonb(t) AS row FROM ${schema}.${name} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows;
      }
      return snapshot;
    },
    async revision(year = 2026) {
      return (
        await pg.query<{ academic: number; reset: number }>(
          `
        SELECT academic_counter::integer AS academic,reset_counter::integer AS reset
        FROM student_portal.academic_revision WHERE academic_year=$1`,
          [year],
        )
      ).rows[0]!;
    },
    close: () => database.close(),
  };
}
