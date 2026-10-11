// @vitest-environment node
import { installResetSchemaFixtureV1, installReconciliationSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import { createRelationalCouncilV3 } from '../../../server/gradebook/application/council/relational-council-v3';
import { createRelationalAcademicProjectionServiceV1 } from '../../../server/gradebook/application/results/relational-academic-projection-v1';
import { createRelationalPerformanceV2 } from '../../../server/gradebook/application/read-models/performance/relational-performance-v2';
import { createPerformanceDashboardV5 } from '../../../server/gradebook/application/read-models/performance/performance-dashboard-v5';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { resolveSimplifiedAnnualOutcomeV1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-annual-outcome-v1';
import type {
  GradebookNotesImportRequestV9,
  GradebookRelationImportRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

type Row = Record<string, unknown>;
const migrations = 'migrations/gradebook-simplified/';
const manifest = (fileName: string, digit: string) => ({
  fileName,
  sha256: digit.repeat(64),
  parserVersion: 'synthetic-multiyear-rr-v1',
});

let pg: PGlite;
let database: GradebookPostgresDatabaseV1;

async function execute(
  client: Pick<PGlite, 'query'>,
  query: string,
  values: readonly unknown[] = [],
) {
  const result = await client.query<Row>(query, [...values]);
  return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(`${migrations}0001_current_schema.sql`, 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  for (const migration of [
    '0003_council_session_v3.sql',
    '0004_council_v3_least_privilege.sql',
    '0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql',
    '0007_multiyear_rr_v1.sql',
  ]) await pg.exec(readFileSync(`${migrations}${migration}`, 'utf8'));
  const sql: GradebookPostgresSqlV1 = {
    unsafe: (query, values = []) => execute(pg, query, values),
    begin: (operation) => pg.transaction((client) => {
      const transaction: GradebookPostgresQuerySqlV1 = {
        unsafe: (query, values = []) => execute(client, query, values),
      };
      return operation(transaction);
    }),
    end: () => pg.close(),
  };
  await installResetSchemaFixtureV1(pg);
  await installReconciliationSchemaFixtureV1(pg);
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
}, 30_000);

afterAll(async () => { await database?.close(); });

function relation(year: number, classCode: string, hashDigit: string): GradebookRelationImportRequestV9 {
  return {
    transportVersion: 9,
    operation: 'persist-relacao',
    manifest: manifest(`RELACAO TESTE ${year}.xlsb`, hashDigit),
    ano: year,
    turmas: [{ codigo: classCode, nome: `TURMA TESTE ${year}`, etapa: 6, turno: 'MATUTINO', alunos: [[1, 'ALUNO HOMONIMO TESTE', 0]] }],
  };
}

function notes2025(): GradebookNotesImportRequestV9 {
  const term = (trimestre: 1 | 2 | 3) => ({
    trimestre,
    instrumentos: trimestre === 3
      ? [[1, 9_000, 'AV1 TESTE'], [2, 9_000, 'AV2 TESTE'], [11, 22_000, 'QUALITATIVA TESTE']] as const
      : [[1, 6_750, 'AV1 TESTE'], [2, 6_750, 'AV2 TESTE'], [11, 16_500, 'QUALITATIVA TESTE']] as const,
    alunos: [[1, [2_000, 2_000, 4_000], 8_000]] as const,
  });
  return {
    transportVersion: 9,
    operation: 'persist-notas',
    manifest: manifest('NOTAS TESTE 2025.xlsb', 'c'),
    ano: 2025,
    professor: 'DOCENTE TESTE',
    ofertas: [{
      turmaCodigo: 'T25',
      disciplina: 'COMPONENTE TESTE',
      trimestres: [term(1), term(2), term(3)],
      recuperacao: [[1, ['r'], null, null, null]],
    }],
  };
}

describe('materialização multi-ano e R/R terminal', () => {
  it('materializa anos pela Relação e mantém homônimos com IDs anuais distintos', async () => {
    const service = createGradebookRelationalImportServiceV11(database);
    await expect(service.execute(relation(2026, 'T26', 'a'))).resolves.toMatchObject({ state: 'applied' });
    await expect(service.execute(relation(2025, 'T25', 'b'))).resolves.toMatchObject({ state: 'applied' });

    const rows = (await pg.query<{ id: number; ano: number }>(
      "SELECT id,ano FROM gradebook.aluno WHERE nome='ALUNO HOMONIMO TESTE' ORDER BY ano DESC",
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.ano)).toEqual([2026, 2025]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect((await pg.query<{ ano: number }>('SELECT ano FROM gradebook.ano_letivo ORDER BY ano DESC')).rows)
      .toEqual([{ ano: 2026 }, { ano: 2025 }]);
  });

  it('persiste R/R, produz REPROVADO e o exclui do Conselho mesmo com reimportação idempotente', async () => {
    const importService = createGradebookRelationalImportServiceV11(database);
    const request = notes2025();
    await expect(importService.execute(request)).resolves.toMatchObject({ state: 'applied' });
    const resetBeforeReplay = (await pg.query('SELECT reset_counter FROM student_portal.academic_revision WHERE academic_year=2025')).rows;
    await expect(importService.execute(request)).resolves.toMatchObject({ state: 'no-changes' });
    expect((await pg.query('SELECT reset_counter FROM student_portal.academic_revision WHERE academic_year=2025')).rows).toEqual(resetBeforeReplay);

    const pair = (await pg.query<{ oferta_id: number; aluno_id: number }>(`
      SELECT o.id AS oferta_id,a.id AS aluno_id
      FROM gradebook.oferta o
      JOIN gradebook.turma t ON t.id=o.turma_id
      JOIN gradebook.vinculo v ON v.turma_id=t.id AND v.ano=2025
      JOIN gradebook.aluno a ON a.id=v.aluno_id
      WHERE o.ano=2025 AND t.codigo='T25'
    `)).rows[0]!;
    expect((await pg.query('SELECT rec_rr_mask,rec_nc_mask,rec1 FROM gradebook.fechamento WHERE oferta_id=$1 AND aluno_id=$2', [pair.oferta_id, pair.aluno_id])).rows)
      .toEqual([{ rec_rr_mask: 1, rec_nc_mask: 0, rec1: null }]);

    const projection = await createRelationalAcademicProjectionServiceV1(database).project({
      ofertaId: pair.oferta_id,
      alunoId: pair.aluno_id,
    });
    expect(projection.recovery.classification).toBe('failed-repeat');
    expect(resolveSimplifiedAnnualOutcomeV1({ status: null, components: [projection.recovery], maxCouncilComponents: 2 }))
      .toMatchObject({ visibleResult: 'REPROVADO', councilEligibility: 'not-eligible', reasons: ['component:failed-repeat'] });

    const classId = (await pg.query<{ id: number }>("SELECT id FROM gradebook.turma WHERE ano=2025 AND codigo='T25'")).rows[0]!.id;
    const performance = await createRelationalPerformanceV2(database).execute({
      transportVersion: 2, operation: 'matrix', year: 2025, classId, period: 1, mode: 'recovery', statuses: [null, 7],
    });
    expect(performance).toMatchObject({
      state: 'ready', operation: 'matrix',
      rows: [{ cells: [{ state: 'repeat-failure', level: 'below' }], calculatedAnnual: { label: 'REPROVADO' } }],
      statistics: { incompleteCells: 0, attentionRows: 1 },
    });

    const dashboard = await createPerformanceDashboardV5(database).execute({
      transportVersion: 5, operation: 'dashboard', year: 2025, classId, period: 1, mode: 'recovery',
      statuses: [null, 7], lens: 'result', offerId: null, referencePeriod: null,
    });
    expect(dashboard).toMatchObject({
      state: 'ready',
      overview: { students: { withBelow: 1, pending: 0 }, groups: { withBelow: [pair.aluno_id] }, columns: [{ below: 1, incomplete: 0 }] },
    });

    const council = await createRelationalCouncilV3(database, '11111111-1111-4111-8111-111111111111')
      .execute({ contractVersion: 3, operation: 'workspace', year: 2025, classId });
    expect(council).toMatchObject({ state: 'ready', operation: 'workspace' });
    if (council.state !== 'ready' || council.operation !== 'workspace') throw new Error('workspace-unavailable');
    expect(council.workspace.students[0]).toMatchObject({
      calculatedResult: 'REPROVADO',
      eligibility: { eligible: false, code: 'failed-repeat' },
    });
  });
});
