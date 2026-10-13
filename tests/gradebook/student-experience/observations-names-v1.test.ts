// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import { createAssessmentNamesServiceV1 } from '../../../server/gradebook/application/settings/assessment-names-v1';
import { createRelationalPerformanceV2 } from '../../../server/gradebook/application/read-models/performance/relational-performance-v2';
import { createRelationalBulletinServiceV2 } from '../../../server/gradebook/application/bulletins/relational-bulletin-v2';
import { createRelationalBulletinSnapshotRepositoryV2 } from '../../../server/gradebook/persistence/postgres/relational-bulletin-snapshot-v2';
import {
  AcademicStudentReaderPostgresV1,
  academicToSelfV1,
} from '../../../server/student-portal/academic/academic-reader-v1';
import {
  assessmentNamesRequestSchemaV1,
  assessmentLabelV1,
} from '../../../shared/gradebook-contracts/settings/assessment-names-v1';
import type {
  GradebookNotesImportRequestV9,
  GradebookRelationImportRequestV9,
  GradebookImportTermV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

let pg: PGlite, database: GradebookPostgresDatabaseV1;
const file = (name: string) => readFileSync('migrations/' + name, 'utf8');
const manifest = {
  fileName: 'SYNTHETIC OBSERVATIONS.xlsb',
  sha256: 'b'.repeat(64),
  parserVersion: 'synthetic-817',
};
const relation = (year: number): GradebookRelationImportRequestV9 => ({
  transportVersion: 9,
  operation: 'persist-relacao',
  manifest: { ...manifest, sha256: 'a'.repeat(64) },
  ano: year,
  turmas: [
    {
      codigo: 'TEST',
      nome: 'SYNTHETIC CLASS',
      etapa: 6,
      turno: 'TESTE',
      alunos: [[1, 'SYNTHETIC STUDENT', 0]],
    },
  ],
});
function notes(
  values: GradebookNotesImportRequestV9['ofertas'][number]['trimestres'][number]['alunos'][number][1],
): GradebookNotesImportRequestV9 {
  const term = (trimestre: 1 | 2 | 3): GradebookImportTermV9 => ({
    trimestre,
    instrumentos: [
      [1, 5000, 'AV 1'],
      [2, 5000, 'AV 2'],
      [3, 5000, 'PARALELA'],
      [11, 2000, 'ATIVIDADE'],
      [12, null, '2'],
    ],
    alunos: [[1, trimestre === 1 ? values : [['u'], ['u'], ['u'], ['u'], ['u']], ['u']]],
  });
  return {
    transportVersion: 9,
    granularObservationVersion: 1,
    operation: 'persist-notas',
    manifest,
    ano: 2026,
    professor: 'SYNTHETIC TEACHER',
    ofertas: [
      {
        turmaCodigo: 'TEST',
        disciplina: 'SYNTHETIC SUBJECT',
        trimestres: [term(1), term(2), term(3)],
        recuperacao: [],
      },
    ],
  };
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(file('gradebook-simplified/0001_current_schema.sql'));
  await pg.exec(
    'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;',
  );
  for (const n of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
    '0008_year_reset_acl_v1.sql',
    '0009_granular_observations_names_v1.sql',
  ])
    await pg.exec(file('gradebook-simplified/' + n));
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  for (const n of [
    '0008_atomic_publication_v2.sql',
    '0009_publication_cutover_guard_v2.sql',
    '0010_incremental_publication_v3.sql',
    '0011_live_event_outbox_v1.sql',
    '0012_granular_observations_names_v1.sql',
  ])
    await pg.exec(file('student-portal/' + n));
  const run = async (
    client: Pick<PGlite, 'query'>,
    query: string,
    values: readonly unknown[] = [],
  ) => {
    const r = await client.query<Record<string, unknown>>(query, [...values]);
    return Object.assign(r.rows, { count: r.affectedRows ?? r.rows.length });
  };
  const sql: GradebookPostgresSqlV1 = {
    unsafe: (q, v) => run(pg, q, v),
    begin: (cb) => pg.transaction((tx) => cb({ unsafe: (q, v) => run(tx, q, v) })),
    end: () => pg.close(),
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
  const service = createGradebookRelationalImportServiceV11(database);
  expect((await service.execute(relation(2026))).state).toBe('applied');
  expect((await service.execute(relation(2025))).state).toBe('applied');
}, 30000);
afterAll(async () => database?.close());
const rows = async () =>
  (
    await pg.query<{ slot: number; valor: number | null }>(
      `SELECT i.slot,n.valor FROM gradebook.instrumento i JOIN gradebook.nota n ON n.instrumento_id=i.id ORDER BY slot`,
    )
  ).rows;

describe('observed granular facts and ecosystem names #817', () => {
  it('persists zero, observed blank and never-read separately; excludes an inactive placeholder', async () => {
    const r = await createGradebookRelationalImportServiceV11(database).execute(
      notes([0, null, ['u'], null, null]),
    );
    expect(r).toMatchObject({ state: 'applied' });
    expect(await rows()).toEqual([
      { slot: 1, valor: 0 },
      { slot: 2, valor: null },
      { slot: 11, valor: null },
    ]);
    const before = (
      await pg.query<Record<string, unknown>>(
        'SELECT * FROM gradebook.nota_historico ORDER BY importacao_id,instrumento_id,aluno_id',
      )
    ).rows;
    expect(before).toEqual([]);
    expect(
      (
        await createGradebookRelationalImportServiceV11(database).execute(
          notes([0, null, ['u'], null, null]),
        )
      ).state,
    ).toBe('no-changes');
    expect(
      (
        await pg.query<Record<string, unknown>>(
          'SELECT * FROM gradebook.nota_historico ORDER BY importacao_id,instrumento_id,aluno_id',
        )
      ).rows,
    ).toEqual(before);
  });
  it('preserves a prior observation when unavailable and replaces blank/zero current state without history', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    expect((await service.execute(notes([null, 0, ['u'], ['u'], null]))).state).toBe('applied');
    expect(await rows()).toEqual([
      { slot: 1, valor: null },
      { slot: 2, valor: 0 },
      { slot: 11, valor: null },
    ]);
    expect(
      (
        await pg.query(
          'SELECT valor_anterior,valor_novo,nao_feito_anterior,nao_feito_novo FROM gradebook.nota_historico ORDER BY importacao_id,instrumento_id,aluno_id',
        )
      ).rows,
    ).toEqual([]);
  });
  it('keeps legacy untagged blank-as-clear compatibility without guessing a historical observation', async () => {
    const original = notes([null, 0, ['u'], null, null]);
    const { granularObservationVersion, ...r } = original;
    expect(granularObservationVersion).toBe(1);
    expect((await createGradebookRelationalImportServiceV11(database).execute(r)).state).toBe(
      'applied',
    );
    expect(await rows()).toEqual([{ slot: 2, valor: 0 }]);
    expect(
      (
        await createGradebookRelationalImportServiceV11(database).execute(
          notes([null, 0, null, null, null]),
        )
      ).state,
    ).toBe('applied');
  });
  it('saves six-key names with CAS, idempotent replay, year isolation and transactional notifications', async () => {
    const service = createAssessmentNamesServiceV1(database);
    expect(await service.execute({ contractVersion: 1, operation: 'read', year: 2026 })).toEqual({
      contractVersion: 1,
      state: 'ready',
      year: 2026,
      version: 0,
      names: {},
    });
    const change = {
      contractVersion: 1,
      operation: 'save',
      year: 2026,
      expectedVersion: 0,
      names: { '1:2': 'Simulado' },
    };
    expect(await service.execute(change)).toMatchObject({
      state: 'ready',
      version: 1,
      names: { '1:2': 'Simulado' },
    });
    const rev = (
      await pg.query('SELECT * FROM student_portal.academic_revision WHERE academic_year=2026')
    ).rows;
    expect(await service.execute(change)).toMatchObject({ state: 'ready', version: 1 });
    expect(
      (await pg.query('SELECT * FROM student_portal.academic_revision WHERE academic_year=2026'))
        .rows,
    ).toEqual(rev);
    expect(await service.execute({ ...change, names: { '1:2': 'Concorrente' } })).toMatchObject({
      state: 'conflict',
    });
    expect(
      await service.execute({ ...change, year: 2025, names: { '1:2': 'Outro ano' } }),
    ).toMatchObject({ state: 'ready', version: 1 });
    expect(
      await service.execute({ contractVersion: 1, operation: 'read', year: 2026 }),
    ).toMatchObject({ names: { '1:2': 'Simulado' } });
    expect(
      (
        await pg.query(
          "SELECT count(*)::integer n FROM student_portal.live_event_outbox_v1 e JOIN student_portal.revision_event r ON r.event_id=e.source_event_id WHERE r.cause='academic-policy' AND e.academic_year=2026",
        )
      ).rows[0],
    ).toEqual({ n: 2 });
    expect(await service.execute({ ...change, names: { '1:3': 'not allowed' } })).toMatchObject({
      state: 'invalid-request',
    });
  });
  it('returns named granular zero/not-done in both the admin detail and Portal projection', async () => {
    const pair = (
      await pg.query<{ classId: number; studentId: number; offerId: number }>(
        `SELECT v.turma_id AS "classId",v.aluno_id AS "studentId",o.id AS "offerId" FROM gradebook.vinculo v JOIN gradebook.oferta o ON o.turma_id=v.turma_id WHERE v.ano=2026`,
      )
    ).rows[0]!;
    const detail = await createRelationalPerformanceV2(database).execute({
      transportVersion: 2,
      operation: 'cell-detail',
      year: 2026,
      period: 1,
      mode: 'regular',
      ...pair,
    });
    expect(detail.state).toBe('ready');
    const text = JSON.stringify(detail);
    expect(text).toContain('Simulado');
    expect(text).toContain('"notDone":true');
    const source = (
      await pg.query<{ period_mask: number; payload_json: Record<string, unknown> }>(
        'SELECT * FROM student_portal.publication_source_rows_v3(NULL)',
      )
    ).rows[0]!;
    expect(source.period_mask).toBe(1);
    const reader = new AcademicStudentReaderPostgresV1({ unsafe: async () => [] });
    const revision = (
      await pg.query<{ generation: string; data_counter: string }>(
        'SELECT academic_generation AS generation,academic_counter::text AS data_counter FROM student_portal.academic_revision WHERE academic_year=2026',
      )
    ).rows[0]!;
    const academic = reader.projectPreparedSourceV2(
      { academicYear: 2026, studentId: pair.studentId },
      revision.generation + ':' + revision.data_counter,
      {
        ...(source.payload_json as Record<string, unknown>),
        data_version: revision.generation + ':' + revision.data_counter,
        account_id: '81700000-0000-4000-8000-000000000001',
      },
    );
    const self = academicToSelfV1(academic!.student, '81700000-0000-4000-8000-000000000001');
    expect(JSON.stringify(self)).toContain('Simulado');
    expect(JSON.stringify(self)).toContain('"notDone":true');
  });
  it('preserves observation and names in the detailed bulletin without replacing the official term value', async () => {
    const pair = (
      await pg.query<{ classId: number; studentId: number }>(
        `SELECT turma_id AS "classId",aluno_id AS "studentId" FROM gradebook.vinculo WHERE ano=2026`,
      )
    ).rows[0]!;
    const service = createRelationalBulletinServiceV2({
      database,
      snapshots: createRelationalBulletinSnapshotRepositoryV2(database),
    });
    const response = await service.execute(
      {
        contractVersion: 2,
        operation: 'preview',
        selection: {
          year: 2026,
          ...pair,
          detail: 'detailed',
          presentation: { locale: 'pt-BR', dateStyle: 'long' },
          period: { kind: 'term', term: 1 },
        },
      },
      { issuerOid: '11111111-1111-4111-8111-111111111111' },
    );
    expect(response.state).toBe('ready');
    if (response.state !== 'ready' || response.operation !== 'preview')
      throw new Error('preview expected');
    const instrument = response.model.subjects[0]!.terms[0]!.instruments;
    expect(instrument).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Simulado', valueMilli: 0 }),
        expect.objectContaining({ notDone: true, valueMilli: null }),
      ]),
    );
    expect(response.model.subjects[0]!.terms[0]!.sourceAmMilli).toBeNull();
  });
  it('rolls back a label update when its revision/outbox hook fails', async () => {
    const before = (
      await pg.query(
        'SELECT nomes_avaliacoes,nomes_avaliacoes_versao FROM gradebook.ano_letivo WHERE ano=2026',
      )
    ).rows;
    await pg.exec(
      `CREATE FUNCTION student_portal.synthetic_reject_policy_817() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.cause='academic-policy' THEN RAISE EXCEPTION 'synthetic-policy-hook-failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_reject_policy_817 BEFORE INSERT ON student_portal.revision_event FOR EACH ROW EXECUTE FUNCTION student_portal.synthetic_reject_policy_817();`,
    );
    try {
      await expect(
        createAssessmentNamesServiceV1(database).execute({
          contractVersion: 1,
          operation: 'save',
          year: 2026,
          expectedVersion: 1,
          names: { '1:2': 'Not committed' },
        }),
      ).resolves.toMatchObject({ state: 'unavailable' });
    } finally {
      await pg.exec(
        'DROP TRIGGER synthetic_reject_policy_817 ON student_portal.revision_event; DROP FUNCTION student_portal.synthetic_reject_policy_817();',
      );
    }
    expect(
      (
        await pg.query(
          'SELECT nomes_avaliacoes,nomes_avaliacoes_versao FROM gradebook.ano_letivo WHERE ano=2026',
        )
      ).rows,
    ).toEqual(before);
  });
  it('normalizes only allowed labels and preserves source labels when an override is removed', () => {
    expect(assessmentLabelV1(2, 1, { '1:2': 'Simulado' }, 'Avaliação da fonte')).toBe('Simulado');
    expect(assessmentLabelV1(2, 2, { '1:2': 'Simulado' }, 'Avaliação da fonte')).toBe(
      'Avaliação da fonte',
    );
    expect(assessmentLabelV1(2, 1, {})).toBe('Avaliação 2');
    for (const name of ['\u0000', 'a\nB', 'x'.repeat(81)])
      expect(
        assessmentNamesRequestSchemaV1.safeParse({
          contractVersion: 1,
          operation: 'save',
          year: 2026,
          expectedVersion: 0,
          names: { '1:1': name },
        }).success,
      ).toBe(false);
  });
});
