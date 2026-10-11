import { analyticsGradeV6, analyticsDeltaV6 } from '../../../src/features/gradebook/performance/analytics-format-v6';
import {
  analyticsStatsV6,
  buildPerformanceAnalyticsV6,
  createPerformanceAnalyticsV6,
} from '../../../server/gradebook/application/read-models/performance/performance-analytics-v6';
import {
  performanceAnalyticsRequestSchemaV6,
  performanceAnalyticsResponseSchemaV6,
  performanceAnalyticsMatchesV6,
} from '../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import { buildPerformanceTeacherPdfV6 } from '../../../src/features/gradebook/performance/performance-analytics-pdf-v6';
import { PDFDocument } from 'pdf-lib';
import * as performanceAnalysisModuleV3 from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import { buildPerformanceDashboardOverviewV5, createPerformanceDashboardV5 } from '../../../server/gradebook/application/read-models/performance/performance-dashboard-v5';
import { dashboardAnalysisV5, performanceDashboardMatchesV5, performanceDashboardRequestSchemaV5, performanceDashboardResponseSchemaV5 } from '../../../shared/gradebook-contracts/performance/performance-dashboard-v5';
import { createPerformanceTermComparisonV4 } from '../../../server/gradebook/application/read-models/performance/performance-term-comparison-v4';
import { performanceTermComparisonRequestSchemaV4, performanceTermComparisonResponseSchemaV4, performanceTermComparisonMatchesV4 } from '../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';
import { performanceAnalysisRequestSchemaV3, performanceAnalysisResponseSchemaV3, performanceAnalysisMatchesV3 } from '../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGradebookPostgresDatabaseFromSqlV1, type GradebookPostgresDatabaseV1, type GradebookPostgresSqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createRelationalPerformanceV2 } from '../../../server/gradebook/application/read-models/performance/relational-performance-v2';
import { handlePerformanceRequestV1 } from '../../../server/gradebook/http/performance-routes-v1';
import { performanceRequestSchemaV2, performanceResponseSchemaV2, performanceResponseMatchesV2, type PerformanceRequestV2 } from '../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { seal } from '../../../server/auth/sealed';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { testEnv } from '../../fixtures';
import type { RuntimeEnv } from '../../../server/env';

const { createPerformanceAnalysisV3 } = performanceAnalysisModuleV3;
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
let readsFail = false;
const queries: string[] = [];
/** BN-DEC-042: complete and partial results both count in the indicators. */
const counts = (state: string) => state === 'complete' || state === 'partial';
const matrixRequest = (extra = {}): PerformanceRequestV2 => ({ transportVersion: 2, operation: 'matrix', year: 2026, classId: 10, period: 1, mode: 'regular', statuses: [null, 1, 2, 3, 4, 5, 7], ...extra });
const service = () => createRelationalPerformanceV2(database);
const comparisonRequest = (extra: Record<string, unknown> = {}) => ({ transportVersion: 4, operation: 'term-comparison', year: 2026, classId: 10,
  period: 3, referencePeriod: 1, mode: 'regular', statuses: [null, 1, 2, 3, 4, 5, 7], lens: 'result', offerId: null, ...extra });
const dashboardRequest = (extra: Record<string, unknown> = {}) => ({ transportVersion: 5, operation: 'dashboard', year: 2026, classId: 10,
  period: 1, referencePeriod: null, mode: 'regular', statuses: [null, 1, 2, 3, 4, 5, 7], lens: 'result', offerId: null, ...extra });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(readFileSync('tests/gradebook/fixtures/student-presentation-relation.sql', 'utf8'));
  await pg.exec('ALTER TABLE gradebook.fechamento ADD COLUMN rec_rr_mask SMALLINT NOT NULL DEFAULT 0;');
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2),(2025,65000,3);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
      (10,2026,'A1','TURMA SINTETICA',6,'M'),(20,2026,'B1','TURMA SINTETICA B',6,'T'),
      (30,2025,'A1','OUTRO ANO SINTETICO',6,'M'),(40,2026,'C1','SEM DEFINICAO',6,'T'),
      (50,2026,'D1','AMBIGUA',6,'T'),(60,2026,'E1','LIMITE DE TAMANHO',6,'T');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2026,'DOCENTE SINTETICO'),(2,2026,'OUTRO DOCENTE SINTETICO'),(3,2025,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (1,2026,'MATEMATICA SINTETICA'),(2,2026,'PORTUGUES SINTETICO'),(3,2025,'MATEMATICA SINTETICA');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES
      (10,2026,10,1,1),(11,2026,10,1,2),(20,2026,20,1,1),(30,2025,30,3,3),
      (40,2026,40,1,1),(50,2026,50,1,1),(51,2026,50,2,1);
    INSERT INTO gradebook.aluno (id,ano,nome,conselho_anterior,conselho_anterior_por) SELECT n,2026,'ALUNO SINTETICO '||n,false,'11111111-1111-4111-8111-111111111111'::uuid FROM generate_series(1,10) n;
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (99,2025,'ALUNO SINTETICO 1'),(40,2026,'SEM DEFINICAO SINTETICO');
    INSERT INTO gradebook.vinculo SELECT 2026,10,n,n,CASE WHEN n=6 THEN 2 WHEN n=7 THEN 4 ELSE NULL END,NULL FROM generate_series(1,8) n;
    INSERT INTO gradebook.vinculo VALUES (2026,10,9,9,6,20),(2026,20,1,9,7,10),(2025,30,1,99,NULL,NULL),(2026,40,1,40,NULL,NULL);
    INSERT INTO gradebook.aluno (id,ano,nome) SELECT 1000+n,2026,'POPULACAO SINTETICA '||n FROM generate_series(1,151) n;
    INSERT INTO gradebook.vinculo SELECT 2026,60,n,1000+n,NULL,NULL FROM generate_series(1,151) n;
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT o*100+t*20+s,o,t,s,CASE WHEN s=11 THEN CASE WHEN t=3 THEN 22000 ELSE 16500 END ELSE CASE WHEN t=3 THEN 9000 ELSE 6750 END END,'AVALIACAO SINTETICA'
      FROM (VALUES (10),(11)) a(o) CROSS JOIN generate_series(1,3) b(t) CROSS JOIN (VALUES (1),(2),(11)) c(s);
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT i.id,a,CASE WHEN a=2 THEN 0 WHEN a=3 THEN 1000 WHEN a=4 THEN CASE WHEN slot=11 THEN 6000 ELSE 4000 END WHEN a=8 THEN 20000 ELSE CASE WHEN slot=11 THEN 12000 ELSE 6000 END END
      FROM gradebook.instrumento i CROSS JOIN generate_series(1,8) a WHERE a<>5 AND NOT(a=3 AND i.slot=2);
    INSERT INTO gradebook.fechamento (oferta_id,aluno_id,am1_fonte,am2_fonte,am3_fonte,rec1,rec2,rec3,rec_nc_mask,u_fonte)
      SELECT o,1,24000,24000,24000,NULL,NULL,NULL,0,72000 FROM (VALUES(10),(11)) a(o);
    INSERT INTO gradebook.fechamento (oferta_id,aluno_id,rec1,rec2,rec3,rec_nc_mask,u_fonte) VALUES
      (10,2,18000,18000,24000,0,60000),(11,2,18000,18000,24000,0,60000),
      (10,4,NULL,18000,24000,1,NULL),(11,4,NULL,NULL,NULL,0,NULL);
    INSERT INTO gradebook.conselho_decisao (aluno_id,decisao,justificativa,registrado_por)
      VALUES (4,1,'DECISAO SINTETICA','11111111-1111-4111-8111-111111111111');
  `);
  const sql: GradebookPostgresSqlV1 = {
    async unsafe() { throw new Error('read-outside-transaction'); },
    async begin(operation) { return pg.transaction(async (tx) => operation({ async unsafe(query, values = []) {
      queries.push(query);
      if (readsFail && query.startsWith('SELECT')) throw new Error('synthetic-private-failure');
      const result = await tx.query<Record<string, unknown>>(query, [...values]);
      if (query.startsWith('SET TRANSACTION')) expect((await tx.query("SELECT current_setting('transaction_read_only') AS r,current_setting('transaction_isolation') AS i")).rows).toEqual([{ r: 'on', i: 'repeatable read' }]);
      return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
    } })); },
    async end() { await pg.close(); },
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
}, 30_000);
afterAll(async () => { await database?.close(); });
beforeEach(() => { queries.length = 0; readsFail = false; });

async function matrix(extra = {}) {
  const response = await service().execute(matrixRequest(extra));
  if (response.state !== 'ready' || response.operation !== 'matrix') throw new Error(JSON.stringify(response));
  return response;
}
async function http(body: unknown, role: 'ADMINISTRADOR' | 'PROFESSOR' | null = 'ADMINISTRADOR', overrides: Partial<RuntimeEnv> = {}) {
  const headers = new Headers({ Origin: testEnv.OFFICIAL_ORIGIN, 'Content-Type': 'application/json' });
  if (role) headers.set('Cookie', `${SESSION_COOKIE}=${await seal({ oid: '11111111-1111-4111-8111-111111111111', name: 'Synthetic', username: 'synthetic@example.test', roles: [role], exp: Math.floor(Date.now() / 1000) + 600 }, testEnv.SESSION_SECRET)}`);
  const response = await handlePerformanceRequestV1(new Request(`${testEnv.OFFICIAL_ORIGIN}/api/gradebook/performance`, { method: 'POST', headers, body: JSON.stringify(body) }), { ...testEnv, RUNTIME_ENVIRONMENT: 'local', GRADEBOOK_STORAGE_PROVIDER: 'postgres', GRADEBOOK_DATABASE: database, ...overrides });
  if (!response) throw new Error('route-not-found');
  return response;
}

describe('relational performance V2 on the complete PostgreSQL baseline', () => {
  it('reads the shared presentation name without changing the imported Relação name', async () => {
    await pg.exec(`CREATE OR REPLACE VIEW gradebook.student_presentation_v1 AS
      SELECT id AS student_id,ano AS academic_year,
      CASE WHEN id=1 AND ano=2026 THEN 'NOME CONFIGURADO SINTETICO' ELSE nome END AS name
      FROM gradebook.aluno`);
    try {
      const response = await matrix();
      expect(response.rows.find((row) => row.student.id === 1)?.student.name).toBe('NOME CONFIGURADO SINTETICO');
      expect((await pg.query('SELECT nome FROM gradebook.aluno WHERE id=1')).rows).toEqual([{ nome: 'ALUNO SINTETICO 1' }]);
      expect(queries.filter((sql) => sql.includes('gradebook.student_presentation_v1'))).toHaveLength(1);
    } finally {
      await pg.exec(`CREATE OR REPLACE VIEW gradebook.student_presentation_v1 AS
        SELECT id AS student_id,ano AS academic_year,nome AS name FROM gradebook.aluno`);
    }
  });
  it('reads one repeatable read snapshot without N+1, old relations or writes', async () => {
    const result = await matrix();
    expect(queries).toHaveLength(6);
    expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|academic_record|academic_entity/u);
    expect(result.rows).toHaveLength(8);
    expect(result.offers).toHaveLength(2);
    expect(result).toMatchObject({ authority: 'calculated-preview', statistics: { classRows: 8, visibleRows: 8, eligibleRows: 6 } });
    expect(performanceResponseSchemaV2.safeParse(result).success).toBe(true);
    expect(gzipSync(JSON.stringify(result)).length).toBeLessThan(500_000);
  });
  it('keeps zero, partial, missing, N/C and the imported reference distinct', async () => {
    const result = await matrix();
    const at = (id: number) => result.rows.find((r) => r.student.id === id)!.cells[0]!;
    expect(at(1)).toMatchObject({ valueMilli: 24000, state: 'complete', sourceReferenceMilli: 24000, sourceComparison: 'match' });
    expect(at(2)).toMatchObject({ valueMilli: 0, state: 'complete', level: 'below' });
    // A result with a blank instrument is still compared with the imported AM.
    expect(at(3)).toMatchObject({ state: 'partial', level: 'below' });
    expect(at(3).sourceComparison).toBe(
      at(3).sourceReferenceMilli === null
        ? 'unavailable'
        : at(3).valueMilli === at(3).sourceReferenceMilli
          ? 'match'
          : 'mismatch',
    );
    // Nothing recorded reads as not done: zero, marked partial.
    expect(at(5)).toMatchObject({ valueMilli: 0, state: 'partial', level: 'below' });
    const recovery = await matrix({ mode: 'recovery' });
    expect(recovery.rows.map((r) => r.student.id)).toEqual([2,3,4,5]);
    const noShow = recovery.rows.find((r) => r.student.id === 4)!;
    expect(noShow.cells[0]).toMatchObject({ valueMilli: null, state: 'no-show' });
    expect(noShow.cells[1]).toMatchObject({ state: 'recovery-pending' });
  });
  it('keeps terminal R/R in the annual recovery matrix even when a recovery exam is not applicable', async () => {
    await pg.exec(`
      INSERT INTO gradebook.conselho_decisao (aluno_id,decisao,justificativa,registrado_por)
        VALUES (1,1,'DECISAO ANTERIOR SINTETICA','11111111-1111-4111-8111-111111111111');
      UPDATE gradebook.fechamento SET rec_rr_mask=1 WHERE oferta_id=10 AND aluno_id=1;
    `);
    try {
      const recovery = await matrix({ mode: 'recovery', period: 'annual' });
      const row = recovery.rows.find((value) => value.student.id === 1);
      expect(row).toBeDefined();
      expect(row?.calculatedAnnual).toMatchObject({ label: 'REPROVADO' });
      expect(row?.formalCouncilDecision).toBeNull();
      expect(row?.cells[0]).toMatchObject({
        state: 'repeat-failure',
        level: 'below',
        recoveryApplicable: false,
      });
      const result = await analysis({ mode: 'recovery', period: 'annual' });
      const resultRow = result.rows.find((value) => value.studentId === 1);
      expect(resultRow?.values[0]).toMatchObject({ state: 'repeat-failure', bucket: 'below' });
      expect(result.columns[0]?.summary.groups.below).toContain(1);
    } finally {
      await pg.exec(`
        DELETE FROM gradebook.conselho_decisao WHERE aluno_id=1;
        UPDATE gradebook.fechamento SET rec_rr_mask=0 WHERE oferta_id=10 AND aluno_id=1;
      `);
    }
  });
  it('does not promote statuses to active indicators or override human decisions', async () => {
    const result = await matrix({ period: 'annual' });
    expect(result.rows.find((r) => r.student.id === 6)).toMatchObject({ student: { indicatorEligible: false }, calculatedAnnual: { state: 'no-result', label: null } });
    expect(result.rows.find((r) => r.student.id === 7)).toMatchObject({ student: { indicatorEligible: false }, calculatedAnnual: { label: 'TRANSFERIDO' } });
    expect(result.rows.find((r) => r.student.id === 4)).toMatchObject({ calculatedAnnual: { label: 'EM RECUPERAÇÃO' }, formalCouncilDecision: { code: 1, label: 'APROVADO PELO CONSELHO' } });
  });
  it('preserves warnings and refuses to invent comparability', async () => {
    const result = await matrix();
    expect(result.rows.find((r) => r.student.id === 8)!.cells[0]!.warningCodes).toContain('value-above-maximum');
    expect(result.comparison).toEqual({ available: false, reason: 'comparability-not-contracted' });
  });
  it.each([1,2,3,'annual'])('keeps period %s in the returned request scope', async (period) => {
    expect(await matrix({ period })).toMatchObject({ period, mode: 'regular' });
  });
  it('returns current movement at the new class only and excludes the historical position', async () => {
    expect((await matrix()).rows.some((r) => r.student.id === 9)).toBe(false);
    expect((await matrix({ classId: 20 })).rows[0]!.student).toMatchObject({ id: 9, status: 7, indicatorEligible: true });
  });
  it('does not invent a successful result from missing offer definitions', async () => {
    const result = await matrix({ classId: 40 });
    expect(result.rows[0]).toMatchObject({ calculatedAnnual: null, cells: [{ valueMilli: null, state: 'unavailable' }] });
  });
  it('rejects ambiguous offerings instead of merging two teachers by subject', async () => {
    expect(await service().execute(matrixRequest({ classId: 50 }))).toEqual({ transportVersion: 2, state: 'ambiguous-offers' });
  });
  it('rejects a scope beyond the row limit instead of truncating silently', async () => {
    expect(await service().execute(matrixRequest({ classId: 60 }))).toEqual({ transportVersion: 2, state: 'scope-too-large' });
  });
  it('loads only the requested student and offer in a cell detail', async () => {
    const request: PerformanceRequestV2 = { transportVersion: 2, operation: 'cell-detail', year: 2026, classId: 10, period: 1, mode: 'regular', studentId: 2, offerId: 10 };
    const result = await service().execute(request);
    expect(result).toMatchObject({ operation: 'cell-detail', student: { id: 2 }, offer: { id: 10 } });
    expect(performanceResponseMatchesV2(request, result)).toBe(true);
    expect(queries).toHaveLength(6);
    expect(queries[5]).toContain('AND v.aluno_id=');
    expect(queries[5]).toContain('AND o.id=');
  });
  it('shows the quantitative AV1 + AV2 maximum for the parallel exam', async () => {
    await pg.exec(
      "INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao) VALUES (9901,10,1,3,NULL,'PARALELA SINTETICA')",
    );
    try {
      const result = await service().execute({
        transportVersion: 2,
        operation: 'cell-detail',
        year: 2026,
        classId: 10,
        period: 1,
        mode: 'regular',
        studentId: 2,
        offerId: 10,
      });
      if (result.state !== 'ready' || result.operation !== 'cell-detail')
        throw new Error(JSON.stringify(result));
      expect(result.terms[0].instruments.find((instrument) => instrument.slot === 3)).toMatchObject({
        slot: 3,
        maximumMilli: 13_500,
      });
    } finally {
      await pg.exec('DELETE FROM gradebook.instrumento WHERE id=9901');
    }
  });
  it('loads the student trajectory without a matrix for other students', async () => {
    const result = await service().execute({ transportVersion: 2, operation: 'student-detail', year: 2026, classId: 10, period: 3, mode: 'regular', studentId: 1 });
    expect(result).toMatchObject({ operation: 'student-detail', row: { student: { id: 1 } }, trajectory: [{ offerId: 10 }, { offerId: 11 }] });
    expect(queries).toHaveLength(6);
  });
  it.each([{ year: 2025, classId: 10 }, { year: 2027, classId: 10 }])('keeps class identities isolated inside any valid year %j', async (extra) => {
    expect(await service().execute(matrixRequest(extra))).toEqual({ transportVersion: 2, state: 'not-found' });
    expect(queries.length).toBeGreaterThan(0);
  });
  it('does not disclose whether a class exists outside the requested 2026 scope', async () => {
    expect(await service().execute(matrixRequest({ classId: 999 }))).toEqual({ transportVersion: 2, state: 'not-found' });
  });
  it('pages registered classes without inventing a selected year', async () => {
    const request = { transportVersion: 2, operation: 'classes', year: 2026, offset: 0, limit: 2 } as const;
    const result = await service().execute(request);
    expect(result).toMatchObject({ classes: [{ id: 10 }, { id: 20 }], nextOffset: 2 });
    expect(performanceResponseMatchesV2(request, result)).toBe(true);
    expect(queries).toHaveLength(3);
  });
  it.each([{ statuses: [] }, { statuses: [null,null] }, { statuses: [6] }, { classId: "1 OR 1=1" }, { mode: 'automatic' }, { extra: true }])('rejects invalid or unknown input before SQL %j', async (extra) => {
    expect(performanceRequestSchemaV2.safeParse(matrixRequest(extra)).success).toBe(false);
    expect(await service().execute(matrixRequest(extra))).toEqual({ transportVersion: 2, state: 'invalid-request' });
    expect(queries).toHaveLength(0);
  });
  it('serves V2 through the real HTTP authorization boundary with no-store', async () => {
    const response = await http(matrixRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ transportVersion: 2, authority: 'calculated-preview', operation: 'matrix' });
  });
  it.each([null, 'PROFESSOR'] as const)('denies unauthenticated or unauthorized role %s without reads', async (role) => {
    const response = await http(matrixRequest(), role);
    expect([401,403]).toContain(response.status);
    expect(queries).toHaveLength(0);
  });
  it('does not bypass the production runtime gate', async () => {
    const response = await http(matrixRequest(), 'ADMINISTRADOR', { RUNTIME_ENVIRONMENT: 'production', GRADEBOOK_PRODUCTION_ENABLED: 'false' });
    expect(response.status).toBe(503); expect(queries).toHaveLength(0);
  });
  it('keeps database failures opaque and never converts them to an empty success', async () => {
    readsFail = true;
    const response = await http(matrixRequest());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('synthetic-private-failure');
    expect(body).toContain('unavailable');
  });
});

describe('same-year trimester comparison V4', () => {
  it('compares exact proportions from one repeatable-read snapshot without N+1', async () => {
    const request = performanceTermComparisonRequestSchemaV4.parse(comparisonRequest());
    const result = await createPerformanceTermComparisonV4(database).execute(request);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('unexpected-comparison-failure');
    expect(queries).toHaveLength(6);
    expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/u);
    expect(result).toMatchObject({ authority: 'descriptive-observation', basis: 'percentage-points-of-official-maximum', referencePeriod: 1,
      analysis: { lens: 'result', matrix: { period: 3, context: { year: 2026 } } } });
    const row = (id: number) => result.rows.find((value) => value.studentId === id)!.values[0]!;
    expect(row(1)).toMatchObject({ state: 'comparable', relation: 'lower' });
    expect(row(2)).toMatchObject({ state: 'comparable', relation: 'equal', deltaPercentagePoints: 0, currentPercent: 0, referencePercent: 0 });
    expect(row(3)).toMatchObject({ state: 'comparable' });
    expect(performanceTermComparisonResponseSchemaV4.safeParse(result).success).toBe(true);
    expect(performanceTermComparisonMatchesV4(request, result)).toBe(true);
  });
  it('supports T3 against T2 and T2 against T1 for every non-assessment lens', async () => {
    for (const [period, referencePeriod, lens] of [[3,2,'result'],[2,1,'quantitative'],[2,1,'qualitative']] as const) {
      const result = await createPerformanceTermComparisonV4(database).execute(comparisonRequest({ period, referencePeriod, lens }));
      expect(result).toMatchObject({ state: 'ready', referencePeriod, analysis: { lens, matrix: { period } } });
    }
  });
  it.each([
    { period: 1, referencePeriod: 1 }, { period: 2, referencePeriod: 2 }, { period: 'annual', referencePeriod: 1 },
    { lens: 'assessments', offerId: 10 }, { year: 2025 },
  ])('rejects an invalid comparison or isolates another year %j', async (extra) => {
    expect(await createPerformanceTermComparisonV4(database).execute(comparisonRequest(extra))).toEqual({ transportVersion: 4, state: 'year' in extra ? 'not-found' : 'invalid-request' });
    if (!('year' in extra)) expect(queries).toHaveLength(0);
  });
  it('routes V4 through the existing authenticated no-store boundary', async () => {
    const response = await http(comparisonRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ transportVersion: 4, state: 'ready', operation: 'term-comparison' });
  });
  it('rejects forged comparison membership and a mismatched reference', async () => {
    const request = performanceTermComparisonRequestSchemaV4.parse(comparisonRequest());
    const result = await createPerformanceTermComparisonV4(database).execute(request);
    if (result.state !== 'ready') throw new Error('unexpected-comparison-failure');
    expect(performanceTermComparisonMatchesV4({ ...request, referencePeriod: 2 }, result)).toBe(false);
    result.columns[0]!.summary.groups.higher.push(9999);
    expect(performanceTermComparisonResponseSchemaV4.safeParse(result).success).toBe(false);
  });
});

const analysisRequest = (extra = {}) => ({ ...matrixRequest(), transportVersion: 3, operation: 'analysis', lens: 'result', offerId: null, ...extra });
async function analysis(extra = {}) {
  const result = await createPerformanceAnalysisV3(database).execute(analysisRequest(extra));
  if (result.state !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}
describe('analytical lenses V3 preserve V2 facts and one read snapshot', () => {
  it.each(['result','quantitative','qualitative'])('reads %s without extra SQL or a second academic engine', async (lens) => {
    const result = await analysis({ lens });
    expect(queries).toHaveLength(6);
    expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|academic_record|academic_entity/u);
    expect(result.matrix.rows).toHaveLength(8);
    expect(result.columns).toHaveLength(2);
    expect(result.rows.every((row) => row.values.length === 2)).toBe(true);
    expect(result.matrix.authority).toBe('calculated-preview');
    expect(gzipSync(JSON.stringify(result)).length).toBeLessThan(500_000);
    expect(performanceAnalysisResponseSchemaV3.safeParse(result).success).toBe(true);
  });
  it('retains numeric zero, counts blank and partial results, and excludes noneligible students', async () => {
    const result = await analysis({ lens: 'quantitative' });
    const at = (id: number) => result.rows.find((r) => r.studentId === id)!.values[0]!;
    expect(at(2)).toMatchObject({ valueMilli: 0, percent: 0, bucket: 'below', state: 'complete' });
    expect(at(3)).toMatchObject({ state: 'partial', bucket: 'below' });
    expect(at(5)).toMatchObject({ valueMilli: 0, percent: 0, state: 'partial', bucket: 'below' });
    expect(at(6).bucket).toBe('excluded'); expect(at(7).bucket).toBe('excluded');
    expect(at(8).percent).toBeGreaterThan(100);
    const summary = result.columns[0]!.summary;
    expect(summary.considered).toBe(6); expect(summary.scaled).toBe(6);
    expect(summary.groups.incomplete).toEqual([]);
    expect(summary.meanPercent).toBeCloseTo((12000/13500 + 0 + 8000/13500 + 40000/13500 + 1000/13500 + 0)*100/6);
    expect(summary.medianPercent).toBeCloseTo((1000/13500 + 8000/13500)*50);
  });
  it('classifies a numeric partial result at 60% and reads absence as not done', async () => {
    const result = await analysis({ lens: 'result', period: 1 });
    const at = (id: number) => result.rows.find((row) => row.studentId === id)!.values[0]!;
    expect(at(3)).toMatchObject({ state: 'partial', valueMilli: 2000, maximumMilli: 30000, bucket: 'below' });
    expect(at(3).percent).toBeCloseTo(2000 / 30000 * 100);
    expect(at(5)).toMatchObject({ state: 'partial', valueMilli: 0, percent: 0, bucket: 'below' });
    const third = await analysis({ lens: 'result', period: 3 });
    expect(third.rows.find((row) => row.studentId === 1)!.values[0]).toMatchObject({ valueMilli: 24000, maximumMilli: 40000, percent: 60, bucket: 'above' });
  });
  it.each([1,2,3,'annual'])('uses actual qualitative maxima in period %s, not a fabricated concept', async (period) => {
    const result = await analysis({ lens: 'qualitative', period });
    const first = result.rows[0]!.values[0]!;
    expect(first.valueMilli).toBe(period === 'annual' ? 36000 : 12000);
    expect(first.maximumMilli).toBe(period === 'annual' ? 55000 : period === 3 ? 22000 : 16500);
    expect(result.matrix.comparison.available).toBe(false);
  });
  it('does not assign a percentage to a complete reading whose maximum is unknown', async () => {
    await pg.exec('UPDATE gradebook.instrumento SET maximo=NULL WHERE oferta_id=10 AND trimestre=1 AND slot=11');
    try {
      const result = await analysis({ lens: 'qualitative' });
      expect(result.rows[0]!.values[0]).toMatchObject({ state: 'complete', valueMilli: 12000, maximumMilli: null, percent: null, bucket: 'unscaled' });
      expect(result.columns[0]!.summary.meanPercent).toBeNull();
      expect(result.columns[0]!.summary.groups.unscaled).toContain(1);
    } finally { await pg.exec('UPDATE gradebook.instrumento SET maximo=16500 WHERE oferta_id=10 AND trimestre=1 AND slot=11'); }
  });
  it('loads descriptions only for the explicitly selected component and preserves order', async () => {
    const result = await analysis({ lens: 'assessments', offerId: 10, period: 'annual' });
    expect(queries).toHaveLength(6); expect(queries[5]).toContain('CASE WHEN o.id=');
    expect(result.columns.map((col) => col.key)).toEqual(['10:1:1','10:1:2','10:1:11','10:2:1','10:2:2','10:2:11','10:3:1','10:3:2','10:3:11']);
    expect(result.columns.every((col) => col.label.includes('AVALIACAO SINTETICA'))).toBe(true);
    expect(result.rows[1]!.values[0]!.valueMilli).toBe(0);
  });
  it('shows a recorded PARA without adding it twice or replacing a superior original quantitative score', async () => {
    await pg.exec(`INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao) VALUES (9999,10,1,3,13500,'PARALELA SINTETICA');
      INSERT INTO gradebook.nota VALUES (9999,1,9000),(9999,2,9000);`);
    try {
      const quantitative = await analysis({ lens: 'quantitative' });
      expect(quantitative.rows[0]!.values[0]!.valueMilli).toBe(12000);
      expect(quantitative.rows[1]!.values[0]!.valueMilli).toBe(9000);
      const instruments = await analysis({ lens: 'assessments', offerId: 10 });
      expect(instruments.rows[0]!.values.find((v) => v.key === '10:1:3')).toMatchObject({ valueMilli: 9000, recordedMilli: 9000, state: 'complete', bucket: 'above' });
      expect((await pg.query('SELECT valor FROM gradebook.nota WHERE instrumento_id=9999 AND aluno_id=1')).rows).toEqual([{ valor: 9000 }]);
    } finally { await pg.exec('DELETE FROM gradebook.nota WHERE instrumento_id=9999; DELETE FROM gradebook.instrumento WHERE id=9999'); }
  });
  it('keeps N/C and recovery population, but never decomposes REC into activities', async () => {
    const result = await analysis({ mode: 'recovery' });
    expect(result.rows.map((row) => row.studentId)).toEqual([2,3,4,5]);
    expect(result.rows.find((row) => row.studentId === 4)!.values[0]).toMatchObject({ state: 'no-show', percent: null, bucket: 'no-show' });
    const quantitative = await analysis({ mode: 'recovery', lens: 'quantitative' });
    expect(quantitative.rows[0]!.values[0]!.valueMilli).toBe(0);
    expect(quantitative.matrix.rows[0]!.cells[0]!.valueMilli).toBe(18000);
  });
  it.each([{ lens: 'assessments' },{ lens: 'qualitative', offerId: 10 },{ lens: 'risk' },{ extra: true }])('rejects invalid lens/context before SQL %j', async (extra) => {
    expect(await createPerformanceAnalysisV3(database).execute(analysisRequest(extra))).toEqual({ transportVersion: 3, state: 'invalid-request' });
    expect(queries).toHaveLength(0);
  });
  it('rejects an assessment component outside the class and forged statistical membership', async () => {
    expect(await createPerformanceAnalysisV3(database).execute(analysisRequest({ lens: 'assessments', offerId: 30 }))).toMatchObject({ state: 'not-found' });
    const result = await analysis();
    const request = performanceAnalysisRequestSchemaV3.parse(analysisRequest());
    expect(performanceAnalysisMatchesV3(request, result)).toBe(true);
    expect(performanceAnalysisMatchesV3({ ...request, year: 2025 }, result)).toBe(false);
    result.columns[0]!.summary.groups.above.push(9999);
    expect(performanceAnalysisResponseSchemaV3.safeParse(result).success).toBe(false);
  });
  it('preserves the original HTTP boundary, no-store, production gate and opaque failure', async () => {
    for (const role of [null, 'PROFESSOR'] as const) expect([401,403]).toContain((await http(analysisRequest(), role)).status);
    expect(queries).toHaveLength(0);
    expect((await http(analysisRequest(), 'ADMINISTRADOR', { RUNTIME_ENVIRONMENT: 'production', GRADEBOOK_PRODUCTION_ENABLED: 'false' })).status).toBe(503);
    expect(queries).toHaveLength(0);
    const response = await http(analysisRequest());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ transportVersion: 3, state: 'ready', matrix: { authority: 'calculated-preview' } });
    readsFail=true;
    expect(await (await http(analysisRequest())).json()).toEqual({ transportVersion: 3, state: 'unavailable' });
  });
});

describe('performance dashboard V5', () => {
  it('limits the descriptive ranking to ten complete component totals in stable order', async () => {
    const base = await analysis();
    const matrixRow = base.matrix.rows[0]!;
    const analysisRow = base.rows[0]!;
    const rows = Array.from({ length: 11 }, (_, index) => ({
      ...matrixRow,
      student: { ...matrixRow.student, id: 100 + index, number: index + 1 },
      cells: matrixRow.cells.map((cell) => ({ ...cell, valueMilli: (11 - index) * 1000 })),
    }));
    const overview = buildPerformanceDashboardOverviewV5({
      ...base,
      matrix: { ...base.matrix, rows },
      rows: rows.map((row) => ({ ...analysisRow, studentId: row.student.id })),
    });
    expect(overview.ranking).toHaveLength(10);
    expect(overview.ranking.map((entry) => entry.studentId)).toEqual(Array.from({ length: 10 }, (_, index) => 100 + index));
  });
  it('returns component counts and a disjoint class panorama from one snapshot', async () => {
    const request = performanceDashboardRequestSchemaV5.parse(dashboardRequest());
    const result = await createPerformanceDashboardV5(database).execute(request);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('unexpected-dashboard-failure');
    expect(queries).toHaveLength(6);
    expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/u);
    expect(result.overview.students).toEqual({ eligible: 6, classified: 6, allAtOrAbove: 2, withBelow: 4, pending: 0 });
    expect(result.overview.groups).toEqual({ allAtOrAbove: [1, 8], withBelow: [2, 3, 4, 5], pending: [] });
    expect(result.overview.ranking.map((entry) => entry.studentId)).toEqual([8, 1, 4, 3, 2, 5]);
    expect(result.overview.ranking.find((entry) => entry.studentId === 3)).toMatchObject({ totalMilli: 4000, partial: true });
    expect(result.overview.columns[0]).toMatchObject({ considered: 6, atOrAbove: 2, below: 4, incomplete: 0, noShow: 0, unscaled: 0 });
    expect(dashboardAnalysisV5(result).matrix.readAt).toBeTruthy();
    expect(performanceDashboardResponseSchemaV5.safeParse(result).success).toBe(true);
    expect(performanceDashboardMatchesV5(request, result)).toBe(true);
  });
  it.each(['result', 'quantitative', 'qualitative'])('reuses the current %s analysis for the same-snapshot comparison panorama', async (lens) => {
    const build = vi.spyOn(performanceAnalysisModuleV3, 'buildPerformanceAnalysisV3');
    try {
      const result = await createPerformanceDashboardV5(database).execute(dashboardRequest({ period: 3, referencePeriod: 1, lens }));
      expect(result.state).toBe('ready');
      if (result.state !== 'ready') throw new Error('unexpected-dashboard-failure');
      expect(result.view).toMatchObject({ transportVersion: 4, operation: 'term-comparison', referencePeriod: 1, analysis: { matrix: { period: 3 } } });
      expect(queries).toHaveLength(6);
      expect(build).toHaveBeenCalledTimes(2);
      expect(build.mock.calls.map((call) => call[2].period)).toEqual([3, 1]);
      expect(result.overview).toEqual(buildPerformanceDashboardOverviewV5(dashboardAnalysisV5(result)));
      expect(JSON.stringify(result).match(/"operation":"analysis"/gu)).toHaveLength(1);
    } finally { build.mockRestore(); }
  });
  it('rejects invalid scopes and forged panorama membership', async () => {
    for (const extra of [{ year: 2025 }, { period: 1, referencePeriod: 1 }, { lens: 'assessments', offerId: 10, referencePeriod: 1 }]) {
      expect(await createPerformanceDashboardV5(database).execute(dashboardRequest(extra))).toEqual({ transportVersion: 5, state: 'year' in extra ? 'not-found' : 'invalid-request' });
      if (!('year' in extra)) expect(queries).toHaveLength(0);
      queries.length = 0;
    }
    const result = await createPerformanceDashboardV5(database).execute(dashboardRequest());
    if (result.state !== 'ready') throw new Error('unexpected-dashboard-failure');
    result.overview.groups.allAtOrAbove.push(9999);
    expect(performanceDashboardResponseSchemaV5.safeParse(result).success).toBe(false);
    const fresh = await createPerformanceDashboardV5(database).execute(dashboardRequest());
    if (fresh.state !== 'ready') throw new Error('unexpected-dashboard-failure');
    fresh.overview.ranking.reverse();
    expect(performanceDashboardResponseSchemaV5.safeParse(fresh).success).toBe(false);
  });
  it('routes through the authenticated no-store boundary and preserves the production gate', async () => {
    for (const role of [null, 'PROFESSOR'] as const) expect([401, 403]).toContain((await http(dashboardRequest(), role)).status);
    expect(queries).toHaveLength(0);
    expect((await http(dashboardRequest(), 'ADMINISTRADOR', { RUNTIME_ENVIRONMENT: 'production', GRADEBOOK_PRODUCTION_ENABLED: 'false' })).status).toBe(503);
    expect(queries).toHaveLength(0);
    const response = await http(dashboardRequest());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ transportVersion: 5, operation: 'dashboard', state: 'ready' });
  });
});

const analyticsRequest = (extra: Record<string, unknown> = {}) => ({
  transportVersion: 6,
  operation: 'analytics',
  year: 2026,
  classId: 10,
  period: 1,
  ...extra,
});
async function analytics(extra: Record<string, unknown> = {}) {
  const result = await createPerformanceAnalyticsV6(database).execute(analyticsRequest(extra));
  if (result.state !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}
describe('analytics V6: descriptive statistics over the shared academic snapshot', () => {
  it('keeps teacher and component subsets aligned after grouping pairs once', async () => {
    await pg.exec('UPDATE gradebook.oferta SET professor_id=2 WHERE id=11');
    try {
      const result = await analytics();
      expect(result.teachers.map((teacher) => teacher.id)).toEqual(
        [...new Set(result.components.map((component) => component.offer.teacher.id))],
      );
      for (const teacher of result.teachers) {
        const component = result.components.find((item) => item.offer.teacher.id === teacher.id)!;
        expect(teacher.offerIds).toEqual([component.offer.id]);
        expect(teacher.summary).toEqual(component.summary);
        expect(teacher.students.map((student) => student.studentId)).toEqual(
          result.students.map((student) => student.student.id),
        );
        for (const student of result.students) {
          const cell = student.cells.find((item) => item.offerId === component.offer.id)!;
          const summary = teacher.students.find((item) => item.studentId === student.student.id)!;
          expect(summary.complete).toBe(counts(cell.result.state) ? 1 : 0);
          expect(summary.partial).toBe(cell.result.state === 'partial' ? 1 : 0);
          expect(summary.meanPercent).toBe(counts(cell.result.state) ? cell.percent : null);
        }
      }
      expect(queries).toHaveLength(6);
      expect(performanceAnalyticsResponseSchemaV6.safeParse(result).success).toBe(true);
    } finally { await pg.exec('UPDATE gradebook.oferta SET professor_id=1 WHERE id=11'); }
  });
  it('retains ordered student groups when there are no component pairs', async () => {
    const matrix = await service().execute(matrixRequest({ statuses: [null, 7] }));
    if (matrix.state !== 'ready' || matrix.operation !== 'matrix') throw new Error('unexpected-matrix-failure');
    const result = buildPerformanceAnalyticsV6({
      ...matrix,
      offers: [],
      rows: matrix.rows.map((row) => ({ ...row, cells: [] })),
    }, new Map(), false);
    expect(result.students.map((student) => student.student.id)).toEqual(matrix.rows.map((row) => row.student.id));
    expect(result.summary).toMatchObject({ students: matrix.rows.length, readings: 0, studentsAtOrAbove: 0, studentsBelow: 0 });
    expect(result.students.every((student) => student.cells.length === 0 && student.summary.readings === 0 && student.summary.result.mean === null)).toBe(true);
    expect(result.components).toEqual([]);
    expect(result.teachers).toEqual([]);
  });
  it('uses one six-query read-only snapshot for every perspective', async () => {
    const result = await analytics();
    expect(queries).toHaveLength(6);
    expect(queries.join(' ')).not.toMatch(
      /\b(INSERT|UPDATE|DELETE)\b|academic_record|academic_entity/u,
    );
    expect(result.students.map((item) => item.student.id)).toEqual([1, 2, 3, 4, 5, 8]);
    expect(result).toMatchObject({
      authority: 'calculated-preview',
      classStudents: 8,
      summary: { students: 6, readings: 12, complete: 12, partial: 0, missing: 0, unavailable: 0 },
    });
    expect(performanceAnalyticsResponseSchemaV6.safeParse(result).success).toBe(true);
    expect(result.components).toHaveLength(2);
    expect(result.teachers).toHaveLength(1);
  });
  it('counts genuine zero and reads missing notes as not done in the statistics', async () => {
    const result = await analytics();
    expect(result.summary.coverage).toMatchObject({
      expected: 36,
      recorded: 28,
      missing: 8,
      zeros: 6,
    });
    const zero = result.students.find((item) => item.student.id === 2)!;
    const partial = result.students.find((item) => item.student.id === 3)!;
    const absent = result.students.find((item) => item.student.id === 5)!;
    expect(zero.summary.result).toMatchObject({ n: 2, mean: 0, median: 0 });
    expect(partial.summary.result).toMatchObject({ n: 2 });
    expect(absent.cells[0]).toMatchObject({
      percent: 0,
      result: { state: 'partial', valueMilli: 0 },
    });
    expect(result.summary.result.n).toBe(12);
    expect(result.summary.distribution[5]!.count).toBe(2);
    expect(result.summary.result.max).toBe(200);
    expect(zero.cells[0]!.gapMilli).toBe(18000);
  });
  it('keeps dimensions proportional to their own maxima and pairs the dimension gap', async () => {
    const result = await analytics();
    const complete = result.students.find((item) => item.student.id === 1)!.cells[0]!;
    expect(complete.quantitative.percent).toBeCloseTo((12000 / 13500) * 100);
    expect(complete.qualitative.percent).toBeCloseTo((12000 / 16500) * 100);
    expect(result.summary.dimensionGap.n).toBe(12);
    expect(result.summary.composition.n).toBe(12);
    expect(
      result.summary.composition.quantitativeShare! + result.summary.composition.qualitativeShare!,
    ).toBeCloseTo(100);
  });
  it('compares adjacent-term pairs, blanks included, and retains the denominator', async () => {
    const t1 = await analytics(),
      t2 = await analytics({ period: 2 }),
      t3 = await analytics({ period: 3 });
    expect(t1.summary.movement).toMatchObject({ reference: null, n: 0, meanDeltaPP: null });
    expect(t2.summary.movement).toMatchObject({ reference: 1, n: 12 });
    expect(t3.summary.movement).toMatchObject({ reference: 2, n: 12 });
    // The student with blanks is compared like everyone else.
    expect(
      t3.students
        .find((item) => item.student.id === 3)!
        .cells.every((cell) => cell.deltaPP !== null),
    ).toBe(true);
    expect(t3.summary.timeline.map((item) => item.term)).toEqual([1, 2, 3]);
  });
  it('does not confuse recovery pending, N/C, unknown eligibility or terminal R/R', async () => {
    const result = await analytics();
    expect(result.summary.recovery).toMatchObject({
      applicable: 8,
      recorded: 2,
      noShow: 1,
    });
    expect(
      result.students
        .find((item) => item.student.id === 4)!
        .cells.map((cell) => cell.recoveryState),
    ).toEqual(['no-show', 'pending']);
    await pg.exec(
      'UPDATE gradebook.fechamento SET rec_rr_mask=1 WHERE oferta_id=10 AND aluno_id=1',
    );
    try {
      const rr = await analytics();
      expect(rr.summary.recovery.repeatFailure).toBe(1);
      expect(rr.students.find((item) => item.student.id === 1)!.cells[0]!.recoveryState).toBe(
        'repeat-failure',
      );
    } finally {
      await pg.exec(
        'UPDATE gradebook.fechamento SET rec_rr_mask=0 WHERE oferta_id=10 AND aluno_id=1',
      );
    }
  });
  it('keeps independent imported references and descriptive calculations distinct', async () => {
    const result = await analytics();
    expect(result.summary.source).toEqual({ recorded: 2, comparable: 2, different: 0 });
    expect(
      result.students.find((item) => item.student.id === 1)!.cells[0]!.result.sourceReferenceMilli,
    ).toBe(24000);
  });
  it('honors year and class isolation, configured minimum, empty and undefined data', async () => {
    expect(
      await createPerformanceAnalyticsV6(database).execute(analyticsRequest({ year: 2025 })),
    ).toMatchObject({ state: 'not-found' });
    const other = await analytics({ year: 2025, classId: 30 });
    expect(other.minimumPercent).toBe(65);
    expect(other.students.map((item) => item.student.id)).toEqual([99]);
    const undefinedScope = await analytics({ classId: 40 });
    expect(undefinedScope.summary.result).toMatchObject({ n: 0, mean: null });
    expect(undefinedScope.summary.coverage).toMatchObject({ expected: 0, percent: null });
    expect(
      await createPerformanceAnalyticsV6(database).execute(analyticsRequest({ classId: 50 })),
    ).toMatchObject({ state: 'ambiguous-offers' });
    expect(
      await createPerformanceAnalyticsV6(database).execute(analyticsRequest({ classId: 60 })),
    ).toMatchObject({ state: 'scope-too-large' });
  });
  it('scopes teacher summaries and printable student metrics to the teacher offers only', async () => {
    await pg.exec('UPDATE gradebook.oferta SET professor_id=2 WHERE id=11');
    try {
      const result = await analytics();
      expect(result.teachers).toHaveLength(2);
      expect(result.teachers.map((teacher) => teacher.offerIds)).toEqual([[10], [11]]);
      for (const teacher of result.teachers) {
        expect(teacher.summary.readings).toBe(6);
        expect(teacher.students.find((item) => item.studentId === 2)).toMatchObject({
          complete: 1,
          below: 1,
          meanPercent: 0,
        });
      }
    } finally {
      await pg.exec('UPDATE gradebook.oferta SET professor_id=1 WHERE id=11');
    }
  });
  it.each([false, true])(
    'creates a real A4 PDF from the authorized teacher snapshot (detailed=%s)',
    async (detailed) => {
      const value = await analytics();
      const pdf = await PDFDocument.load(
        await buildPerformanceTeacherPdfV6(value, value.teachers[0]!.id, detailed),
      );
      expect(pdf.getPageCount()).toBeGreaterThan(0);
      expect(
        pdf
          .getPages()
          .every(
            (page) =>
              Math.abs(page.getWidth() - 595.28) < 0.01 &&
              Math.abs(page.getHeight() - 841.89) < 0.01,
          ),
      ).toBe(true);
      await expect(buildPerformanceTeacherPdfV6(value, 999, detailed)).rejects.toThrow(
        'teacher-outside-current-scope',
      );
    },
  );
  it('rejects added controls, falsely official or mismatched responses', async () => {
    const value = await analytics();
    expect(
      performanceAnalyticsRequestSchemaV6.safeParse({ ...analyticsRequest(), mode: 'recovery' })
        .success,
    ).toBe(false);
    expect(
      performanceAnalyticsResponseSchemaV6.safeParse({ ...value, authority: 'official' }).success,
    ).toBe(false);
    expect(
      performanceAnalyticsResponseSchemaV6.safeParse({
        ...value,
        students: [...value.students, value.students[0]],
      }).success,
    ).toBe(false);
    expect(
      performanceAnalyticsMatchesV6(
        performanceAnalyticsRequestSchemaV6.parse(analyticsRequest({ period: 3 })),
        value,
      ),
    ).toBe(false);
    expect(
      performanceAnalyticsResponseSchemaV6.safeParse({
        ...value,
        summary: { ...value.summary, complete: 999 },
      }).success,
    ).toBe(false);
  });
  it.each([null, 'PROFESSOR'] as const)(
    'denies unauthorized analytics before reading data (%s)',
    async (role) => {
      const response = await http(analyticsRequest(), role);
      expect([401, 403]).toContain(response.status);
      expect(queries).toHaveLength(0);
    },
  );
  it('dispatches V6 through existing no-store authorization and opaque errors', async () => {
    const response = await http(analyticsRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ transportVersion: 6, state: 'ready' });
    readsFail = true;
    const failed = await http(analyticsRequest());
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('synthetic-private-failure');
  });
  it('computes null-aware population statistics without arbitrary thresholds', () => {
    expect(analyticsStatsV6([])).toEqual({
      n: 0,
      mean: null,
      median: null,
      deviation: null,
      min: null,
      max: null,
    });
    expect(analyticsStatsV6([0])).toEqual({
      n: 1,
      mean: 0,
      median: 0,
      deviation: 0,
      min: 0,
      max: 0,
    });
    expect(analyticsStatsV6([100, 0, 50, 50])).toMatchObject({
      n: 4,
      mean: 50,
      median: 50,
      min: 0,
      max: 100,
    });
    expect(analyticsStatsV6([100, 0]).deviation).toBe(50);
  });
});

it('preserves granular milli precision and does not print a tiny change as zero', () => {
  expect(analyticsGradeV6(6750)).toBe('6,75');
  expect(analyticsGradeV6(1)).toBe('0,001');
  expect(analyticsGradeV6(0)).toBe('0');
  expect(analyticsGradeV6(null)).toBe('—');
  expect(analyticsDeltaV6(0.01)).toBe('+<0,1 p.p.');
});
