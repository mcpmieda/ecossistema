// @vitest-environment node
import { installResetSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelationalCouncilV3 } from '../../../server/gradebook/application/council/relational-council-v3';
import { createCouncilWorkspaceRequestHandlerV1 } from '../../../server/gradebook/http/council-routes-v1';
import { seal } from '../../../server/auth/sealed';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { testEnv } from '../../fixtures';
import type { RuntimeEnv } from '../../../server/env';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { RELATIONAL_COUNCIL_LIMITS_V3 } from '../../../shared/gradebook-contracts/council/relational-council-v3';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER_ACTOR = '22222222-2222-4222-8222-222222222222';
// A year with one class more than a reading covers, and one whose only class is too large to read.
const CROWDED_YEAR = 2024;
const OVERSIZED_YEAR = 2023;
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(readFileSync('tests/gradebook/fixtures/student-presentation-relation.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec('GRANT SELECT ON gradebook.student_presentation_v1 TO gradebook_app;');
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0003_council_session_v3.sql', 'utf8'),
  );
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0004_council_v3_least_privilege.sql', 'utf8'),
  );
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0023_council_current_state_only_v1.sql', 'utf8'),
  );
  // It also brings the R/R marker of the recoveries, which the seed below uses.
  await installResetSchemaFixtureV1(pg);
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2),(2025,60000,2),
      (${CROWDED_YEAR},60000,2),(${OVERSIZED_YEAR},60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
      (10,2026,'6A','TURMA SINTETICA',6,'M'),(11,2026,'6B','TURMA SINTETICA B',6,'M'),
      (12,2026,'6C','TURMA SINTETICA C',6,'M'),
      (20,2025,'6A','TURMA ANTERIOR SINTETICA',6,'M'),
      (30,${OVERSIZED_YEAR},'9Z','TURMA GRANDE SINTETICA',9,'M');
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
      SELECT 1000+n,${CROWDED_YEAR},'T'||n,'TURMA SINTETICA '||n,6,'M'
      FROM generate_series(1,${RELATIONAL_COUNCIL_LIMITS_V3.classes + 1}) n;
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2026,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES
      (1,2026,'MATEMATICA'),(2,2026,'PORTUGUES'),(3,2026,'CIENCIAS');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES
      (10,2026,10,1,1),(11,2026,11,1,1),(12,2026,12,1,1),(13,2026,12,1,2),(14,2026,12,1,3);
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES
      (1,2026,'ALUNO ELEGIVEL'),(2,2026,'ALUNO APROVADO'),(3,2026,'ALUNO TRANSFERIDO'),
      (4,2026,'ALUNO AUSENTE NA RECUPERACAO'),(5,2026,'ALUNO REPROVADO PELO REGIMENTO'),
      (6,2026,'ALUNO COM RECUPERACAO PENDENTE'),(7,2026,'ALUNO APROVADO B'),
      (8,2026,'ALUNO COM REGIMENTO E AUSENCIA');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao) VALUES
      (2026,10,1,1,NULL),(2026,10,2,2,NULL),(2026,10,3,3,4),
      (2026,11,1,4,NULL),(2026,11,2,5,NULL),(2026,11,3,6,NULL),(2026,11,4,7,NULL),
      (2026,12,1,8,NULL);
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT o*100+t*10+s,o,t,s,15000,'AVALIACAO SINTETICA'
      FROM generate_series(10,14) o CROSS JOIN generate_series(1,3) t CROSS JOIN generate_series(1,2) s;
    -- Every mark at zero, except the approved students and the third component of class 6C,
    -- with every mark at its maximum.
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT i.id,v.aluno_id,CASE WHEN v.aluno_id IN (2,3,7) OR o.id=14 THEN 15000 ELSE 0 END
      FROM gradebook.instrumento i JOIN gradebook.oferta o ON o.id=i.oferta_id
      JOIN gradebook.vinculo v ON v.turma_id=o.turma_id;
    -- The recoveries: taken and not enough (1), missed in the first term (4), failed by the
    -- school's rules (5) and, for student 6, not recorded at all. Student 8 has both markers:
    -- R/R in one component and N/C in another.
    INSERT INTO gradebook.fechamento (oferta_id,aluno_id,rec1,rec2,rec3,rec_nc_mask,rec_rr_mask,u_fonte)
      VALUES (10,1,10000,10000,10000,0,0,30000),(11,4,NULL,10000,10000,1,0,NULL),
        (11,5,NULL,NULL,NULL,0,1,NULL),(12,8,NULL,NULL,NULL,0,1,NULL),
        (13,8,NULL,10000,10000,1,0,NULL);
    INSERT INTO gradebook.aluno (id,ano,nome)
      SELECT 5000+n,${OVERSIZED_YEAR},'ALUNO SINTETICO '||n
      FROM generate_series(1,${RELATIONAL_COUNCIL_LIMITS_V3.students + 1}) n;
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id)
      SELECT ${OVERSIZED_YEAR},30,n,5000+n
      FROM generate_series(1,${RELATIONAL_COUNCIL_LIMITS_V3.students + 1}) n;
  `);
  database = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe() {
      throw new Error('outside-transaction');
    },
    async begin(operation) {
      return pg.transaction(async (tx) =>
        operation({
          async unsafe(sql, values = []) {
            const result = await tx.query<Record<string, unknown>>(sql, [...values]);
            return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
          },
        }),
      );
    },
    async end() {
      await pg.close();
    },
  });
}, 30_000);
afterAll(async () => {
  await database?.close();
});

function request(operation: string, extra: Record<string, unknown> = {}) {
  return { contractVersion: 3, operation, year: 2026, classId: 10, ...extra };
}
const CLASSES = { contractVersion: 3, operation: 'classes', year: 2026 };
const mark = (valueMilli: number | null, state: string, level: string) => ({
  valueMilli,
  state,
  level,
});
const NOT_APPLICABLE = mark(null, 'not-applicable', 'not-classified');
const PENDING = mark(null, 'recovery-pending', 'not-classified');
const ZERO = mark(0, 'complete', 'below');

async function sessionRows() {
  return (
    await pg.query<Record<string, unknown>>(`SELECT ano::integer AS ano,turma_id,
      estado::integer AS estado,versao::integer AS versao,atualizado_por
      FROM gradebook.conselho_sessao ORDER BY ano DESC,turma_id`)
  ).rows;
}
/** The count the year reset keeps of the writes of a year. */
async function resetCounter(year = 2026) {
  return (
    await pg.query<{ reset: number }>(
      'SELECT reset_counter::integer AS reset FROM student_portal.academic_revision WHERE academic_year=$1',
      [year],
    )
  ).rows[0]!.reset;
}
/** The same database, with every reading of one class failing before it reaches PostgreSQL. */
function failingClassDatabase(classId: number) {
  return {
    ...database,
    transaction<T>(operation: Parameters<GradebookPostgresDatabaseV1['transaction']>[0]) {
      return database.transaction((db) =>
        operation(
          new Proxy(db, {
            get(target, key) {
              if (key === 'query')
                return async (sql: string, values: readonly unknown[] = []) => {
                  if (sql.includes('max_componentes_conselho') && values[1] === classId)
                    throw new Error('synthetic-class-reading-failure');
                  return target.query(sql, values as never);
                };
              const value: unknown = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        ),
      ) as Promise<T>;
    },
  };
}
const SEEDED_DECISION =
  'INSERT INTO gradebook.conselho_decisao (aluno_id,decisao,justificativa,registrado_por) VALUES ($1,$2,$3,$4)';
/** The workspace of a class, or the failure of the test when it could not be read. */
async function readWorkspace(classId: number) {
  const response = await createRelationalCouncilV3(database, ACTOR).execute(
    request('workspace', { classId }),
  );
  if (response.state !== 'ready' || response.operation === 'classes')
    throw new Error('workspace-missing');
  return response.workspace;
}

describe('relational Council V3 lifecycle', () => {
  it('presents the shared configured name while preserving the imported name', async () => {
    await pg.exec(`CREATE OR REPLACE VIEW gradebook.student_presentation_v1 AS
      SELECT id AS student_id,ano AS academic_year,
      CASE WHEN id=1 THEN 'NOME CONSELHO SINTETICO' ELSE nome END AS name FROM gradebook.aluno`);
    try {
      const result = await createRelationalCouncilV3(database, ACTOR).execute(request('workspace'));
      expect(result).toMatchObject({
        state: 'ready',
        workspace: {
          students: expect.arrayContaining([
            expect.objectContaining({ id: 1, name: 'NOME CONSELHO SINTETICO' }),
          ]),
        },
      });
      expect((await pg.query('SELECT nome FROM gradebook.aluno WHERE id=1')).rows).toEqual([
        { nome: 'ALUNO ELEGIVEL' },
      ]);
    } finally {
      await pg.exec(`CREATE OR REPLACE VIEW gradebook.student_presentation_v1 AS
        SELECT id AS student_id,ano AS academic_year,nome AS name FROM gradebook.aluno`);
    }
  });
  it('retries one PostgreSQL serialization abort before returning the contracted response', async () => {
    let attempts = 0;
    const retryingDatabase = {
      ...database,
      async transaction<T>(
        operation: Parameters<GradebookPostgresDatabaseV1['transaction']>[0],
      ): Promise<T> {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('synthetic-serialization-abort'), { code: '40001' });
        }
        return database.transaction(operation) as Promise<T>;
      },
    };
    const response = await createRelationalCouncilV3(retryingDatabase, ACTOR).execute(CLASSES);
    expect(response).toMatchObject({ state: 'ready', operation: 'classes' });
    expect(attempts).toBe(2);
  });

  it('keeps eligibility calculated and opens the meeting once', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    const initial = await service.execute(request('workspace'));
    expect(initial).toMatchObject({
      state: 'ready',
      workspace: {
        context: { year: 2026 },
        classGroup: { id: 10, label: '6A' },
        session: { state: 'not-opened' },
        summary: {
          total: 3,
          decided: 0,
          pending: 1,
          approved: 0,
          rejected: 0,
          absence: 0,
          forInformation: 0,
        },
      },
    });
    if (initial.state !== 'ready' || initial.operation === 'classes')
      throw new Error('initial-workspace-missing');
    const eligibleStudent = initial.workspace.students.find((student) => student.id === 1);
    expect(eligibleStudent).toMatchObject({
      eligibility: { eligible: true, failedComponentCount: 1 },
    });
    expect(eligibleStudent?.components[0]).toMatchObject({ result: 'not-approved' });
    expect(eligibleStudent?.components[0]?.terms.map((term) => term.valueMilli)).toEqual([0, 0, 0]);
    // The approved and the transferred classmates are counted in the class and are not sent.
    expect(initial.workspace.students.map((student) => student.id)).toEqual([1]);

    const resetBefore = await resetCounter();
    const opened = await service.execute(request('open'));
    expect(opened).toMatchObject({
      state: 'ready',
      operation: 'open',
      workspace: { session: { state: 'open' }, summary: { total: 3, pending: 1 } },
    });
    const row = { ano: 2026, turma_id: 10, estado: 1, versao: 1, atualizado_por: ACTOR };
    expect(await sessionRows()).toEqual([row]);
    expect(await resetCounter()).toBe(resetBefore + 1);

    // Opening again, even by someone else, answers with the open meeting and writes nothing more.
    expect(
      await createRelationalCouncilV3(database, OTHER_ACTOR).execute(request('open')),
    ).toMatchObject({
      state: 'ready',
      operation: 'open',
      workspace: { session: { state: 'open' } },
    });
    expect(await sessionRows()).toEqual([row]);
    expect(await resetCounter()).toBe(resetBefore + 1);
    expect(await service.execute(request('workspace'))).toMatchObject({
      state: 'ready',
      operation: 'workspace',
      workspace: { session: { state: 'open' } },
    });

    // Closing, reopening, the fields of the earlier version, a decision and a count: no command.
    for (const refused of [
      request('close'),
      request('reopen'),
      request('open', { expectedVersion: 1 }),
      request('open', { idempotencyKey: 'open:synthetic:0001' }),
      request('open', { justification: 'Comando retirado.' }),
      request('decision', { decision: 1, studentId: 1, justification: 'Comando retirado.' }),
      request('vote', { favoraveis: 1, contrarios: 0, studentId: 1 }),
    ])
      expect(await service.execute(refused)).toEqual({
        contractVersion: 3,
        state: 'invalid-request',
      });

    // Only the current state travels: no version, no timeline, no snapshots, no count.
    if (opened.state !== 'ready' || opened.operation === 'classes')
      throw new Error('opened-workspace-missing');
    expect(Object.keys(opened.workspace).sort()).toEqual([
      'classGroup',
      'context',
      'session',
      'students',
      'summary',
    ]);
    expect(opened.workspace.context).toEqual({ year: 2026 });
    expect(opened.workspace.classGroup).toEqual({ id: 10, label: '6A' });
    expect(opened.workspace.session).toEqual({ state: 'open' });
    expect(Object.keys(opened.workspace.students[0]!).sort()).toEqual([
      'components',
      'decision',
      'eligibility',
      'id',
      'name',
      'number',
    ]);
    expect(await sessionRows()).toEqual([row]);
    for (const table of ['conselho_idempotencia', 'conselho_votacao'])
      expect(
        (await pg.query(`SELECT count(*)::integer AS count FROM gradebook.${table}`)).rows,
      ).toEqual([{ count: 0 }]);
  }, 30_000);

  it('brings each component as the report card lays it out, with the level of every mark', async () => {
    const students = (await readWorkspace(10)).students;
    // Recovered in the three terms and still below the minimum of the year.
    expect(students.find((student) => student.id === 1)).toEqual({
      id: 1,
      name: 'ALUNO ELEGIVEL',
      number: 1,
      eligibility: { eligible: true, code: 'eligible', failedComponentCount: 1 },
      decision: null,
      components: [
        {
          offerId: 10,
          subject: 'MATEMATICA',
          terms: [ZERO, ZERO, ZERO],
          termRecoveries: [
            mark(10_000, 'complete', 'below'),
            mark(10_000, 'complete', 'below'),
            mark(10_000, 'complete', 'below'),
          ],
          annual: ZERO,
          recovery: mark(30_000, 'complete', 'below'),
          result: 'not-approved',
        },
      ],
    });
    // A component approved without recovery: no REC applies, and the total is the one of the terms.
    const [both] = (await readWorkspace(12)).students;
    expect(both?.components.find((component) => component.offerId === 14)).toEqual({
      offerId: 14,
      subject: 'CIENCIAS',
      terms: [
        mark(30_000, 'complete', 'at-or-above'),
        mark(30_000, 'complete', 'at-or-above'),
        mark(30_000, 'complete', 'at-or-above'),
      ],
      termRecoveries: [NOT_APPLICABLE, NOT_APPLICABLE, NOT_APPLICABLE],
      annual: mark(90_000, 'complete', 'at-or-above'),
      recovery: NOT_APPLICABLE,
      result: 'approved-direct',
    });
  });

  it('takes notice of N/C and R/R without counting them, and deliberates on a recovery still to be recorded', async () => {
    const workspace = await readWorkspace(11);
    expect(workspace.classGroup).toEqual({ id: 11, label: '6B' });
    expect(workspace.session).toEqual({ state: 'not-opened' });
    expect(workspace.summary).toEqual({
      // The approved classmate is counted in the class and is not one of the students sent.
      total: 4,
      decided: 0,
      // Only the student whose recovery was not recorded.
      pending: 1,
      approved: 0,
      rejected: 0,
      absence: 0,
      forInformation: 2,
    });
    expect(
      workspace.students.map((student) => ({ id: student.id, ...student.eligibility })),
    ).toEqual([
      { id: 4, eligible: false, code: 'failed-no-show', failedComponentCount: 0 },
      { id: 5, eligible: false, code: 'failed-repeat', failedComponentCount: 1 },
      { id: 6, eligible: false, code: 'recovery-pending', failedComponentCount: 0 },
    ]);
    const component = (studentId: number) =>
      workspace.students.find((student) => student.id === studentId)!.components[0]!;
    // N/C in the first term: the recovery of the year has no total.
    expect(component(4)).toMatchObject({
      terms: [ZERO, ZERO, ZERO],
      termRecoveries: [
        mark(null, 'no-show', 'not-classified'),
        mark(10_000, 'complete', 'below'),
        mark(10_000, 'complete', 'below'),
      ],
      annual: ZERO,
      recovery: mark(null, 'no-show', 'not-classified'),
      result: 'failed-no-show',
    });
    // R/R: the marker stands for the mark and is below the minimum by itself.
    expect(component(5)).toMatchObject({
      termRecoveries: [mark(null, 'repeat-failure', 'below'), PENDING, PENDING],
      annual: ZERO,
      recovery: mark(null, 'repeat-failure', 'below'),
      result: 'failed-repeat',
    });
    expect(component(6)).toMatchObject({
      termRecoveries: [PENDING, PENDING, PENDING],
      annual: ZERO,
      recovery: PENDING,
      result: 'recovery-pending',
    });
  });

  it('names a student with both R/R and N/C by the R/R, as the annual calculation does', async () => {
    const workspace = await readWorkspace(12);
    expect(workspace.summary).toEqual({
      total: 1,
      decided: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      absence: 0,
      forInformation: 1,
    });
    expect(workspace.students).toHaveLength(1);
    expect(workspace.students[0]).toMatchObject({
      id: 8,
      eligibility: { eligible: false, code: 'failed-repeat', failedComponentCount: 1 },
      decision: null,
    });
    const results = Object.fromEntries(
      workspace.students[0]!.components.map((component) => [component.offerId, component.result]),
    );
    expect(results).toEqual({ 12: 'failed-repeat', 13: 'failed-no-show', 14: 'approved-direct' });
  });

  it('answers not-found for a class of another year or an unknown one, and opens nothing', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    const before = await sessionRows();
    const resetBefore = await resetCounter();
    for (const classId of [20, 999])
      for (const operation of ['workspace', 'open'])
        expect(await service.execute(request(operation, { classId }))).toEqual({
          contractVersion: 3,
          state: 'not-found',
        });
    expect(await sessionRows()).toEqual(before);
    expect(await resetCounter()).toBe(resetBefore);
  });

  it('reads a meeting closed by the earlier version as open', async () => {
    await pg.query(
      'INSERT INTO gradebook.conselho_sessao (ano,turma_id,estado,versao,atualizado_por) VALUES (2025,20,2,2,$1)',
      [OTHER_ACTOR],
    );
    const service = createRelationalCouncilV3(database, ACTOR);
    const earlier = { year: 2025, classId: 20 };
    expect(await service.execute(request('workspace', earlier))).toMatchObject({
      state: 'ready',
      workspace: { session: { state: 'open' } },
    });
    // Opening it answers the same and leaves the row as it was.
    expect(await service.execute(request('open', earlier))).toMatchObject({
      state: 'ready',
      operation: 'open',
      workspace: { session: { state: 'open' } },
    });
    expect((await sessionRows()).find((row) => row.turma_id === 20)).toEqual({
      ano: 2025,
      turma_id: 20,
      estado: 2,
      versao: 2,
      atualizado_por: OTHER_ACTOR,
    });
  });

  it('answers every class of the year with its tally, from the class reading itself', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    // Nothing else travels with a class: no name, no state of the meeting, no next page.
    expect(await service.execute(CLASSES)).toEqual({
      contractVersion: 3,
      state: 'ready',
      operation: 'classes',
      year: 2026,
      classes: [
        // The only eligible student has no decision yet.
        { id: 10, label: '6A', tally: { approved: 0, rejected: 0, pending: 1, forInformation: 0 } },
        // The recovery still to be recorded is pending; N/C and R/R are only for information.
        { id: 11, label: '6B', tally: { approved: 0, rejected: 0, pending: 1, forInformation: 2 } },
        { id: 12, label: '6C', tally: { approved: 0, rejected: 0, pending: 0, forInformation: 1 } },
      ],
    });
    // A class with nobody for the Conselho is listed too, with its tally at zero.
    expect(await service.execute({ ...CLASSES, year: 2025 })).toMatchObject({
      state: 'ready',
      classes: [{ id: 20, tally: { approved: 0, rejected: 0, pending: 0, forInformation: 0 } }],
    });
    // The page and the flag that asked for the tally are no longer part of the request.
    for (const extra of [{ tally: true }, { offset: 0 }, { limit: 100 }, { offset: 0, limit: 100 }])
      expect(await service.execute({ ...CLASSES, ...extra })).toEqual({
        contractVersion: 3,
        state: 'invalid-request',
      });
  });

  it('refuses a year with more classes than one reading covers, instead of cutting it short', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    expect(await service.execute({ ...CLASSES, year: CROWDED_YEAR })).toEqual({
      contractVersion: 3,
      state: 'scope-too-large',
    });
  });

  it('lists a class it could not read without a tally, and answers its workspace as too large', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    expect(await service.execute({ ...CLASSES, year: OVERSIZED_YEAR })).toEqual({
      contractVersion: 3,
      state: 'ready',
      operation: 'classes',
      year: OVERSIZED_YEAR,
      classes: [{ id: 30, label: '9Z' }],
    });
    expect(
      await service.execute(request('workspace', { year: OVERSIZED_YEAR, classId: 30 })),
    ).toEqual({ contractVersion: 3, state: 'scope-too-large' });
  });

  it('opens nothing when the class cannot be read', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    const before = await sessionRows();
    const events = async () =>
      (await pg.query('SELECT count(*)::integer AS count FROM student_portal.revision_event')).rows;
    const eventsBefore = await events();
    const refused = () => service.execute(request('open', { year: OVERSIZED_YEAR, classId: 30 }));
    // The first writer to lock a year gives it its record, which is not a write of its own.
    expect(await refused()).toEqual({ contractVersion: 3, state: 'scope-too-large' });
    const resetBefore = await resetCounter(OVERSIZED_YEAR);
    expect(await refused()).toEqual({ contractVersion: 3, state: 'scope-too-large' });
    // Neither the meeting nor the write the year reset would have to know of.
    expect(await sessionRows()).toEqual(before);
    expect(await resetCounter(OVERSIZED_YEAR)).toBe(resetBefore);
    expect(await events()).toEqual(eventsBefore);
    // A reading that breaks instead of answering leaves nothing behind either.
    await expect(
      createRelationalCouncilV3(failingClassDatabase(11), ACTOR).execute(
        request('open', { classId: 11 }),
      ),
    ).rejects.toThrow('synthetic-class-reading-failure');
    expect(await sessionRows()).toEqual(before);
    expect(await events()).toEqual(eventsBefore);
  });

  it('lists a class whose reading breaks without a tally, and still answers the other classes', async () => {
    expect(
      await createRelationalCouncilV3(failingClassDatabase(11), ACTOR).execute(CLASSES),
    ).toEqual({
      contractVersion: 3,
      state: 'ready',
      operation: 'classes',
      year: 2026,
      classes: [
        { id: 10, label: '6A', tally: { approved: 0, rejected: 0, pending: 1, forInformation: 0 } },
        { id: 11, label: '6B' },
        { id: 12, label: '6C', tally: { approved: 0, rejected: 0, pending: 0, forInformation: 1 } },
      ],
    });
  });

  it('reads a decision already in the table, in the workspace and in the tally', async () => {
    // Nothing records a decision for now: it is seeded.
    await pg.query(SEEDED_DECISION, [1, 1, 'Deliberação semeada.', ACTOR]);
    const workspace = await readWorkspace(10);
    expect(workspace.session).toEqual({ state: 'open' });
    expect(workspace.summary).toEqual({
      total: 3,
      decided: 1,
      pending: 0,
      approved: 1,
      rejected: 0,
      absence: 0,
      forInformation: 0,
    });
    // Only the code travels: no label, no justification, no date.
    expect(workspace.students.map((student) => [student.id, student.decision])).toEqual([
      [1, { code: 1 }],
    ]);
    expect(await createRelationalCouncilV3(database, ACTOR).execute(CLASSES)).toMatchObject({
      state: 'ready',
      classes: [
        { id: 10, tally: { approved: 1, rejected: 0, pending: 0, forInformation: 0 } },
        { id: 11 },
        { id: 12 },
      ],
    });
  });

  it('stops counting a decision while the grades take the student out of the eligible, without erasing it', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    // A recovery of the decided student goes blank: the year is in recovery again.
    await pg.exec('UPDATE gradebook.fechamento SET rec1=NULL WHERE oferta_id=10 AND aluno_id=1');
    try {
      const workspace = await readWorkspace(10);
      expect(workspace.students).toMatchObject([
        { id: 1, eligibility: { eligible: false, code: 'recovery-pending' }, decision: null },
      ]);
      expect(workspace.summary).toEqual({
        total: 3,
        decided: 0,
        pending: 1,
        approved: 0,
        rejected: 0,
        absence: 0,
        forInformation: 0,
      });
      expect(await service.execute(CLASSES)).toMatchObject({
        state: 'ready',
        classes: [
          { id: 10, tally: { approved: 0, rejected: 0, pending: 1, forInformation: 0 } },
          { id: 11 },
          { id: 12 },
        ],
      });
    } finally {
      await pg.exec('UPDATE gradebook.fechamento SET rec1=10000 WHERE oferta_id=10 AND aluno_id=1');
    }
    // The row stayed where it was, and is in force again with the grades that made it.
    expect(
      (
        await pg.query(
          'SELECT aluno_id,decisao::integer AS decisao FROM gradebook.conselho_decisao',
        )
      ).rows,
    ).toEqual([{ aluno_id: 1, decisao: 1 }]);
    expect((await readWorkspace(10)).summary).toMatchObject({
      decided: 1,
      approved: 1,
      pending: 0,
    });
  });

  it('takes for no decision a row of a student the calculation does not send to the Conselho', async () => {
    // Rows left for the recovery still to be recorded (6), the N/C (4) and the R/R (5).
    for (const [studentId, decision] of [
      [4, 2],
      [5, 1],
      [6, 3],
    ])
      await pg.query(SEEDED_DECISION, [studentId, decision, 'Deliberação semeada.', ACTOR]);
    const workspace = await readWorkspace(11);
    expect(workspace.summary).toEqual({
      total: 4,
      decided: 0,
      // The student with the recovery to be recorded is still to be deliberated on.
      pending: 1,
      approved: 0,
      rejected: 0,
      absence: 0,
      forInformation: 2,
    });
    expect(workspace.students.map((student) => [student.id, student.decision])).toEqual([
      [4, null],
      [5, null],
      [6, null],
    ]);
    expect(await createRelationalCouncilV3(database, ACTOR).execute(CLASSES)).toMatchObject({
      state: 'ready',
      classes: [
        { id: 10 },
        { id: 11, tally: { approved: 0, rejected: 0, pending: 1, forInformation: 2 } },
        { id: 12 },
      ],
    });
  });
});

async function http(
  body: unknown,
  role: 'ADMINISTRADOR' | 'PROFESSOR' | null = 'ADMINISTRADOR',
  overrides: Partial<RuntimeEnv> = {},
) {
  const headers = new Headers({
    Origin: testEnv.OFFICIAL_ORIGIN,
    'Content-Type': 'application/json',
  });
  if (role)
    headers.set(
      'Cookie',
      `${SESSION_COOKIE}=${await seal({ oid: ACTOR, name: 'Synthetic', username: 'synthetic@example.test', roles: [role], exp: Math.floor(Date.now() / 1000) + 600 }, testEnv.SESSION_SECRET, 'admin-session')}`,
    );
  const handler = createCouncilWorkspaceRequestHandlerV1();
  const response = await handler(
    new Request(`${testEnv.OFFICIAL_ORIGIN}/api/gradebook/council-workspace`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    {
      ...testEnv,
      RUNTIME_ENVIRONMENT: 'local',
      GRADEBOOK_STORAGE_PROVIDER: 'postgres',
      GRADEBOOK_DATABASE: database,
      ...overrides,
    },
  );
  if (!response) throw new Error('route-not-found');
  return response;
}

describe('relational Council V3 HTTP boundary', () => {
  it('serves V3 only to the existing persistence administrator with no-store', async () => {
    const response = await http(CLASSES);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({
      contractVersion: 3,
      state: 'ready',
      operation: 'classes',
    });
    expect((await http(CLASSES, 'PROFESSOR')).status).toBe(403);
    expect((await http(CLASSES, null)).status).toBe(401);
  });

  it('answers the open meeting with 200, an unknown class with 404 and a retired command with 400', async () => {
    const opened = await http(request('open'));
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      state: 'ready',
      operation: 'open',
      workspace: { session: { state: 'open' } },
    });
    const unknown = await http(request('open', { classId: 999 }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ contractVersion: 3, state: 'not-found' });
    for (const retired of [
      request('close'),
      request('open', { expectedVersion: 1 }),
      { ...CLASSES, offset: 0, limit: 100 },
    ]) {
      const refused = await http(retired);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ contractVersion: 3, state: 'invalid-request' });
    }
  });

  it('answers what is too large to read with 422', async () => {
    for (const tooLarge of [
      { ...CLASSES, year: CROWDED_YEAR },
      request('workspace', { year: OVERSIZED_YEAR, classId: 30 }),
      request('open', { year: OVERSIZED_YEAR, classId: 30 }),
    ]) {
      const refused = await http(tooLarge);
      expect(refused.status).toBe(422);
      expect(refused.headers.get('Cache-Control')).toContain('no-store');
      expect(await refused.json()).toEqual({ contractVersion: 3, state: 'scope-too-large' });
    }
  });

  it('accepts another valid year scope and preserves the production gate', async () => {
    expect((await http({ ...CLASSES, year: 2025 })).status).toBe(200);
    const gated = await http(CLASSES, 'ADMINISTRADOR', {
      RUNTIME_ENVIRONMENT: 'production',
      GRADEBOOK_PRODUCTION_ENABLED: 'false',
    });
    expect(gated.status).toBe(503);
    expect(await gated.json()).toEqual({ contractVersion: 3, state: 'unavailable' });
  });
});
