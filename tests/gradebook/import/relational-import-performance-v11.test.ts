// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import { createGradebookPostgresDatabaseFromSqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createImportPerformanceObserverV1 } from '../../../server/gradebook/persistence/postgres/import-performance-observer-v1';
import type {
  GradebookImportInstrumentV9,
  GradebookImportOfferV9,
  GradebookImportTermV9,
  GradebookNotesImportRequestV9,
  GradebookRelationImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

// Invented fixture only. All three original baseline repetitions had these exact
// hashes and committed-write summaries: a7cd386 + F2 observer working tree, whose
// unchanged implementation was subsequently committed as fe985 (before F3/F4/F5).
const BASELINE_V11 = {
  'M01-first-15-offers': {
    digest: '483b243b73d9256e2912ffb18d5b6f617d034b485cfbbbe3fc7f421cce1fa0ec',
    records: 677,
    imports: 1,
    total: 678,
  },
  'M02-identical-15-offers': {
    digest: '483b243b73d9256e2912ffb18d5b6f617d034b485cfbbbe3fc7f421cce1fa0ec',
    records: 0,
    imports: 0,
    total: 0,
  },
  'M03-one-mark': {
    digest: '6e6709403d577f6a2f5282c265267bb22729d0701a7c3290669eaa4bffb312da',
    records: 1,
    imports: 0,
    total: 1,
  },
  'M04-instrument-metadata': {
    digest: 'afe124f524a60ee92300a8ff2c33a9f3e531512cf9b957403592894f9fc22c7d',
    records: 1,
    imports: 0,
    total: 1,
  },
  'M05-unavailable-preserves': {
    digest: 'afe124f524a60ee92300a8ff2c33a9f3e531512cf9b957403592894f9fc22c7d',
    records: 0,
    imports: 0,
    total: 0,
  },
  'M05-authoritative-remove': {
    digest: '220f01a8a35132b9db1e68b81f213cfcd05f3d30cf77802bc18587b5adfd9a4e',
    records: 9,
    imports: 0,
    total: 9,
  },
} as const;
type ScenarioV11 = keyof typeof BASELINE_V11;
type MetricsV11 = ReturnType<ReturnType<typeof createImportPerformanceObserverV1>['snapshot']>;
interface BenchmarkRecordV11 {
  readonly scenario: ScenarioV11;
  readonly repetition: number;
  readonly elapsedMs: number;
  readonly metrics: MetricsV11;
  readonly stateDigest: string;
}
const manifest = {
  fileName: 'SYNTHETIC BENCHMARK.xlsb',
  sha256: 'b'.repeat(64),
  parserVersion: 'synthetic-benchmark-1225',
};
const instruments: readonly GradebookImportInstrumentV9[] = [
  [1, 10000, 'AV1 SYNTHETIC'],
  [2, 10000, 'AV2 SYNTHETIC'],
  [3, 10000, 'AV3 SYNTHETIC'],
  [11, 10000, 'QUALITATIVE SYNTHETIC'],
];
function term(trimestre: 1 | 2 | 3): GradebookImportTermV9 {
  return {
    trimestre,
    definitionSnapshotVersion: 1,
    instrumentos: instruments,
    alunos: [
      [1, [5000, 5000, 5000, 5000], 10000],
      [2, [5000, 5000, 5000, null], 10000],
    ],
  };
}
function initialRequest(): GradebookNotesImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-notas',
    ano: 2026,
    granularObservationVersion: 1,
    manifest,
    professor: 'SYNTHETIC BENCHMARK TEACHER',
    ofertas: Array.from({ length: 15 }, (_, index) => ({
      turmaCodigo: `B${index}`,
      disciplina: 'SYNTHETIC SUBJECT',
      trimestres: [term(1), term(2), term(3)],
      recuperacao: null,
    })),
  };
}
function mapFirstOfferTerms(
  request: GradebookNotesImportRequestV9,
  change: (term: GradebookImportTermV9) => GradebookImportTermV9,
): GradebookNotesImportRequestV9 {
  return {
    ...request,
    ofertas: request.ofertas.map((offer, index): GradebookImportOfferV9 =>
      index !== 0
        ? offer
        : {
            ...offer,
            trimestres: [
              change(offer.trimestres[0]),
              change(offer.trimestres[1]),
              change(offer.trimestres[2]),
            ],
          },
    ),
  };
}
const relation: GradebookRelationImportRequestV9 = {
  transportVersion: 9,
  operation: 'persist-relacao',
  ano: 2026,
  manifest,
  turmas: Array.from({ length: 15 }, (_, index) => ({
    codigo: `B${index}`,
    nome: `SYNTHETIC CLASS ${index}`,
    etapa: 6,
    turno: 'MATUTINO',
    alunos: [
      [1, `SYNTHETIC STUDENT A ${index}`, 0],
      [2, `SYNTHETIC STUDENT B ${index}`, 0],
    ],
  })),
};
const FACTS_SQL_V11 = `SELECT jsonb_build_object(
  'notes', (SELECT jsonb_agg(jsonb_build_array(o.turma_id,i.trimestre,i.slot,n.aluno_id,n.valor) ORDER BY o.turma_id,i.trimestre,i.slot,n.aluno_id)
    FROM gradebook.nota n JOIN gradebook.instrumento i ON i.id=n.instrumento_id JOIN gradebook.oferta o ON o.id=i.oferta_id),
  'instruments', (SELECT jsonb_agg(jsonb_build_array(oferta_id,trimestre,slot,maximo,descricao) ORDER BY oferta_id,trimestre,slot) FROM gradebook.instrumento),
  'closing', (SELECT jsonb_agg(to_jsonb(f) ORDER BY oferta_id,aluno_id) FROM gradebook.fechamento f),
  'revision', (SELECT jsonb_agg(jsonb_build_array(academic_counter,reset_counter)) FROM student_portal.academic_revision WHERE academic_year=2026)
) AS facts`;
function medianV11(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const center = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[center]!
    : (ordered[center - 1]! + ordered[center]!) / 2;
}

const file = (folder: string, name: string) => readFileSync(`migrations/${folder}/${name}`, 'utf8');

async function runRepetition(
  repetition: number,
  baselineProfile: boolean,
): Promise<BenchmarkRecordV11[]> {
  const pg = new PGlite();
  const records: BenchmarkRecordV11[] = [];
  const calls: string[] = [];
  try {
    await pg.exec(file('gradebook-simplified', '0001_current_schema.sql'));
    await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
    for (const name of [
      '0003_council_session_v3.sql',
      '0004_council_v3_least_privilege.sql',
      '0005_relational_bulletin_snapshot_v2.sql',
      '0006_import_diagnostic_treatment_v1.sql',
      '0007_multiyear_rr_v1.sql',
      '0009_granular_observations_names_v1.sql',
    ])
      await pg.exec(file('gradebook-simplified', name));
    await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
    for (const name of [
      '0008_atomic_publication_v2.sql',
      '0009_publication_cutover_guard_v2.sql',
      '0010_incremental_publication_v3.sql',
      '0011_live_event_outbox_v1.sql',
      '0012_granular_observations_names_v1.sql',
    ])
      await pg.exec(file('student-portal', name));
    const execute = async (
      client: Pick<PGlite, 'query'>,
      sql: string,
      values: readonly unknown[] = [],
    ) => {
      calls.push(sql);
      const result = await client.query<Record<string, unknown>>(sql, [...values]);
      return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
    };
    const database = createGradebookPostgresDatabaseFromSqlV1({
      unsafe: (sql, values) => execute(pg, sql, values),
      begin: (operation) =>
        pg.transaction((client) =>
          operation({ unsafe: (sql, values) => execute(client, sql, values) }),
        ),
    });
    expect(
      (await createGradebookRelationalImportServiceV11(database).execute(relation)).state,
    ).toBe('applied');
    const run = async (scenario: ScenarioV11, request: GradebookNotesImportRequestV9) => {
      const expected = BASELINE_V11[scenario];
      const observer = createImportPerformanceObserverV1();
      calls.length = 0;
      const started = performance.now();
      const response = await createGradebookRelationalImportServiceV11(
        observer.wrap(database),
        observer,
      ).execute(request);
      const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      expect(response.state, scenario).toBe(expected.total === 0 ? 'no-changes' : 'applied');
      if (response.state !== 'applied' && response.state !== 'no-changes')
        throw new Error('synthetic-benchmark-refusal');
      expect(response.summary.committedWrites, scenario).toEqual({
        logicalSources: 0,
        sourceFileVersions: 0,
        importBatchVersions: expected.imports,
        assessmentComponentVersions: 0,
        academicRecordVersions: expected.records,
        logicalSourceRecordAssociationVersions: 0,
        total: expected.total,
      });
      const facts = (await pg.query<Record<string, unknown>>(FACTS_SQL_V11)).rows[0];
      const stateDigest = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
      expect(stateDigest, scenario).toBe(expected.digest);
      const metrics = observer.snapshot();
      expect(metrics.transactionOutcome).toBe('committed');
      expect(metrics.sqlFailedCalls).toBe(0);
      if (expected.total === 0) {
        expect(calls.some((sql) => /^(INSERT|UPDATE|DELETE)/u.test(sql))).toBe(false);
        expect(calls.some((sql) => sql.includes('record_gradebook_change_v1'))).toBe(false);
        expect(metrics.sqlWriteCalls).toBe(0);
        expect(metrics.groupedStatements).toBe(0);
      }
      // The explicit historical profile retains every semantic assertion above.
      // It alone omits bounds that the pre-optimization source cannot satisfy.
      if (!baselineProfile) {
        for (const category of ['instruments', 'notes', 'closings'])
          expect(calls.filter((sql) => sql.includes(`import-read-set:${category}`))).toHaveLength(
            1,
          );
        for (const category of ['disciplines-read', 'offers-read'])
          expect(calls.filter((sql) => sql.includes(`import-catalog:${category}`))).toHaveLength(1);
        // Five context reads + two catalog reads + three read-set categories.
        expect(metrics.sqlReadCalls).toBeLessThanOrEqual(5 + 2 + 3);
        const instrumentCreates = calls.filter((sql) => sql.includes('import-instruments:create'));
        expect(instrumentCreates.length).toBeLessThanOrEqual(request.ofertas.length);
        if (scenario === 'M01-first-15-offers') expect(instrumentCreates).toHaveLength(15);
      }
      records.push({ scenario, repetition, elapsedMs, metrics, stateDigest });
    };
    const initial = initialRequest();
    await run('M01-first-15-offers', initial);
    await run('M02-identical-15-offers', initial);
    const delta = mapFirstOfferTerms(initial, (source) =>
      source.trimestre !== 1
        ? source
        : {
            ...source,
            alunos: source.alunos.map(([number, values, am], index) => [
              number,
              index !== 0 ? values : [6000, ...values.slice(1)],
              am,
            ]),
          },
    );
    await run('M03-one-mark', delta);
    const metadata = mapFirstOfferTerms(delta, (source) =>
      source.trimestre !== 1
        ? source
        : {
            ...source,
            instrumentos: [[1, 11000, 'AV1 SYNTHETIC UPDATED'], ...source.instrumentos.slice(1)],
          },
    );
    await run('M04-instrument-metadata', metadata);
    const unavailable = mapFirstOfferTerms(metadata, (source) => ({
      ...source,
      instrumentos: source.instrumentos.slice(0, 3),
      alunos: source.alunos.map(([number, values, am]) => [number, values.slice(0, 3), am]),
      unavailableValueSlots: [11],
    }));
    await run('M05-unavailable-preserves', unavailable);
    const removed = mapFirstOfferTerms(unavailable, (source) => {
      const { unavailableValueSlots, ...rest } = source;
      void unavailableValueSlots;
      return rest;
    });
    await run('M05-authoritative-remove', removed);
    return records;
  } finally {
    await pg.close();
  }
}

it('preserves all six measured states and logical summaries while bounding SQL by block and offer', async () => {
  const repetitions = Number(process.env.BENCHMARK_REPETITIONS_V11 ?? '1');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error('invalid-benchmark-repetitions');
  const profile = process.env.BENCHMARK_PROFILE_V11 ?? 'optimized';
  if (profile !== 'optimized' && profile !== 'baseline')
    throw new Error('invalid-benchmark-profile');
  const records: BenchmarkRecordV11[] = [];
  for (let index = 0; index < repetitions; index++)
    records.push(...(await runRepetition(index, profile === 'baseline')));
  if (process.env.BENCHMARK_REPORT_V11 === '1' || process.env.BENCHMARK_REPORT_PATH_V11) {
    const report = {
      event: 'synthetic_import_benchmark_v11',
      profile,
      node: process.version,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      engine: 'locked PGlite',
      repetitions,
      fixture:
        '15 offers, 30 invented bindings, 180 instruments, 360 observed notes including null',
      scenarios: (Object.keys(BASELINE_V11) as ScenarioV11[]).map((scenario) => {
        const runs = records.filter((record) => record.scenario === scenario);
        return {
          scenario,
          medianElapsedMs: medianV11(runs.map((record) => record.elapsedMs)),
          medianSqlCalls: medianV11(runs.map((record) => record.metrics.sqlCalls)),
          medianReadCalls: medianV11(runs.map((record) => record.metrics.sqlReadCalls)),
          medianGroupedStatements: medianV11(
            runs.map((record) => record.metrics.groupedStatements),
          ),
          medianFlushes: medianV11(runs.map((record) => record.metrics.flushesWithWork)),
          runs: runs.map(({ repetition, elapsedMs, metrics, stateDigest }) => ({
            repetition,
            elapsedMs,
            metrics,
            stateDigest,
          })),
        };
      }),
    };
    if (process.env.BENCHMARK_REPORT_V11 === '1') console.info(JSON.stringify(report));
    if (process.env.BENCHMARK_REPORT_PATH_V11) {
      const output = resolve(process.env.BENCHMARK_REPORT_PATH_V11);
      const root = resolve(process.cwd());
      if (output === root || output.startsWith(root + '/'))
        throw new Error('benchmark-report-must-be-outside-repository');
      writeFileSync(output, JSON.stringify(report, null, 2));
    }
  }
}, 120_000);
