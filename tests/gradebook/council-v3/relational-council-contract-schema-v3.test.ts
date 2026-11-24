// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RELATIONAL_COUNCIL_LIMITS_V3,
  relationalCouncilInformedV3,
  relationalCouncilRequestSchemaV3,
  relationalCouncilResponseMatchesV3,
  relationalCouncilResponseSchemaV3,
  relationalCouncilTallyV3,
  relationalCouncilVotableV3,
} from '../../../shared/gradebook-contracts/council/relational-council-v3';

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0003_council_session_v3.sql', 'utf8'),
  );
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0004_council_v3_least_privilege.sql', 'utf8'),
  );
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0023_council_current_state_only_v1.sql', 'utf8'),
  );
}, 30_000);
afterAll(async () => {
  await pg?.close();
});

const open = { contractVersion: 3, operation: 'open', year: 2026, classId: 1 };
const accepts = (value: unknown) => relationalCouncilRequestSchemaV3.safeParse(value).success;
const answers = (value: unknown) => relationalCouncilResponseSchemaV3.safeParse(value).success;
const mark = { valueMilli: 12_000, state: 'complete', level: 'below' };
const component = {
  offerId: 10,
  subject: 'MATEMATICA',
  terms: [mark, mark, mark],
  termRecoveries: [mark, mark, mark],
  annual: mark,
  recovery: mark,
  result: 'not-approved',
};
/** A student by the case of its eligibility; only `eligible` is eligible by the calculation. */
const student = (id: number, code: string, decision: { code: number } | null = null) => ({
  id,
  name: `ALUNO SINTETICO ${id}`,
  number: id,
  eligibility: { eligible: code === 'eligible', code, failedComponentCount: 1 },
  decision,
  components: [component],
});
const emptySummary = {
  total: 0,
  decided: 0,
  pending: 0,
  approved: 0,
  rejected: 0,
  absence: 0,
  forInformation: 0,
};
const workspace = {
  context: { year: 2026 },
  classGroup: { id: 1, label: 'S1' },
  session: { state: 'not-opened' },
  summary: emptySummary,
  students: [] as ReturnType<typeof student>[],
};
const ready = { contractVersion: 3, state: 'ready', operation: 'workspace', workspace };
const classes = {
  contractVersion: 3,
  state: 'ready',
  operation: 'classes',
  year: 2026,
  classes: [{ id: 1, label: 'S1' }],
};
/** A class of six: one student of each case that is before the Conselho, with the summary that
 * fits them, and a classmate who is not sent. */
const council = {
  ...workspace,
  summary: {
    total: 6,
    decided: 1,
    pending: 2,
    approved: 1,
    rejected: 0,
    absence: 0,
    forInformation: 2,
  },
  students: [
    student(1, 'eligible'),
    student(2, 'eligible', { code: 1 }),
    student(3, 'recovery-pending'),
    student(4, 'failed-no-show'),
    student(5, 'failed-repeat'),
  ],
};
/** A class with this one student, counted as one the Conselho only takes notice of. */
const withStudent = (value: unknown) => ({
  ...ready,
  workspace: {
    ...workspace,
    summary: { ...emptySummary, total: 1, forInformation: 1 },
    students: [value],
  },
});

describe('relational Council V3 contract', () => {
  it('opens the meeting of a class with its four fields only, in a valid academic year', () => {
    expect(accepts(open)).toBe(true);
    expect(accepts({ ...open, year: 2025 })).toBe(true);
    expect(accepts({ ...open, year: 1999 })).toBe(false);
    expect(accepts({ ...open, classId: 0 })).toBe(false);
    for (const extra of [
      { expectedVersion: 0 },
      { idempotencyKey: 'open:test:0001' },
      { justification: 'Motivo.' },
      { reviewReference: 'review:test:0001' },
      { tieBreak: true },
      { presentes: 3 },
    ])
      expect(accepts({ ...open, ...extra })).toBe(false);
  });

  it('has no close, reopen, decision or count command', () => {
    for (const operation of ['close', 'reopen'])
      expect(accepts({ ...open, operation })).toBe(false);
    // Not even in the shape the earlier version accepted.
    expect(
      accepts({
        ...open,
        operation: 'close',
        expectedVersion: 1,
        idempotencyKey: 'close:test:0001',
        reviewReference: 'review:test:0001',
      }),
    ).toBe(false);
    for (const record of [
      { operation: 'decision', decision: 1 },
      { operation: 'vote', favoraveis: 1, contrarios: 0 },
    ])
      expect(accepts({ ...open, ...record, studentId: 2, justification: 'Registro.' })).toBe(false);
  });

  it('reads the classes of a year whole and one workspace, with no page and no tally flag', () => {
    const list = { contractVersion: 3, operation: 'classes', year: 2026 };
    expect(accepts(list)).toBe(true);
    for (const extra of [
      { offset: 0 },
      { limit: 100 },
      { offset: 0, limit: 100 },
      { tally: true },
      { tally: false },
      { classId: 1 },
    ])
      expect(accepts({ ...list, ...extra })).toBe(false);
    expect(accepts({ ...open, operation: 'workspace' })).toBe(true);
    expect(accepts({ ...open, operation: 'workspace', tally: true })).toBe(false);
    expect(accepts({ contractVersion: 3, operation: 'workspace', year: 2026 })).toBe(false);
  });

  it('answers each class with its tally, or without one when the class could not be read', () => {
    const [item] = classes.classes;
    const tally = { approved: 2, rejected: 1, pending: 3, forInformation: 1 };
    expect(answers(classes)).toBe(true);
    expect(answers({ ...classes, classes: [{ ...item, tally }, item] })).toBe(true);
    for (const refused of [
      { approved: 2, rejected: 1, pending: 3 },
      { ...tally, pending: -1 },
      { ...tally, absence: 0 },
      null,
    ])
      expect(answers({ ...classes, classes: [{ ...item, tally: refused }] })).toBe(false);
    // The name, the state of the meeting and the page of the earlier answers are gone.
    for (const extra of [{ name: 'TURMA SINTETICA' }, { sessionState: 'open' }])
      expect(answers({ ...classes, classes: [{ ...item, ...extra }] })).toBe(false);
    expect(answers({ ...classes, nextOffset: null })).toBe(false);
    // The answer never carries more classes than one reading covers.
    const many = (length: number) =>
      Array.from({ length }, (_, index) => ({ id: index + 1, label: `S${index + 1}` }));
    const limit = RELATIONAL_COUNCIL_LIMITS_V3.classes;
    expect(answers({ ...classes, classes: many(limit) })).toBe(true);
    expect(answers({ ...classes, classes: many(limit + 1) })).toBe(false);
  });

  it('answers a meeting that is either not opened or open, with nothing else about it', () => {
    for (const state of ['not-opened', 'open'])
      expect(answers({ ...ready, workspace: { ...workspace, session: { state } } })).toBe(true);
    expect(answers({ ...ready, operation: 'open' })).toBe(true);
    expect(answers({ ...ready, workspace: { ...workspace, session: { state: 'closed' } } })).toBe(
      false,
    );
    for (const operation of ['close', 'reopen'])
      expect(answers({ ...ready, operation })).toBe(false);
    for (const extra of [{ version: 1 }, { reviewReference: 'council-review:2026:1:1' }])
      expect(
        answers({ ...ready, workspace: { ...workspace, session: { state: 'open', ...extra } } }),
      ).toBe(false);
  });

  it('answers the workspace without the fields the screen no longer reads', () => {
    expect(answers({ ...ready, workspace: council })).toBe(true);
    const { forInformation: _forInformation, ...earlierSummary } = emptySummary;
    for (const extra of [
      { readAt: '2026-11-23T12:00:00.000Z' },
      { authority: 'calculated-eligibility-explicit-human-decision' },
      { context: { year: 2026, minimumApprovalMilli: 60_000 } },
      { context: { year: 2026, maxCouncilComponents: 2 } },
      { classGroup: { id: 1, label: 'S1', name: 'TURMA SINTETICA' } },
      { summary: { ...emptySummary, eligible: 0 } },
      { summary: { ...emptySummary, notEligible: 0 } },
      { summary: earlierSummary },
    ])
      expect(answers({ ...ready, workspace: { ...workspace, ...extra } })).toBe(false);
    const noticed = student(1, 'failed-no-show');
    expect(answers(withStudent(noticed))).toBe(true);
    for (const refused of [
      { ...noticed, statusLabel: 'Em curso' },
      { ...noticed, calculatedResult: 'REPROVADO POR NÃO COMPARECIMENTO' },
      { ...noticed, vote: null },
      { ...noticed, eligibility: { ...noticed.eligibility, label: 'Não compareceu.' } },
      { ...noticed, eligibility: { ...noticed.eligibility, code: 'student-not-eligible' } },
      { ...noticed, decision: { code: 1, label: 'APROVADO PELO CONSELHO' } },
      { ...noticed, decision: { code: 1, justification: 'Registro.' } },
      { ...noticed, decision: { code: 1, updatedAt: '2026-11-23T12:00:00.000Z' } },
      { ...noticed, decision: { code: 4 } },
    ])
      expect(answers(withStudent(refused))).toBe(false);
  });

  it('answers each component with its terms, their RECs, the totals and the level of each mark', () => {
    const answersComponents = (components: readonly unknown[]) =>
      answers(withStudent({ ...student(1, 'failed-no-show'), components }));
    expect(answersComponents([])).toBe(true);
    expect(answersComponents([component])).toBe(true);
    for (const state of ['recovery-pending', 'no-show', 'repeat-failure', 'not-applicable'])
      expect(
        answersComponents([
          { ...component, recovery: { valueMilli: null, state, level: 'not-classified' } },
        ]),
      ).toBe(true);
    const { termRecoveries: _termRecoveries, ...withoutRecoveries } = component;
    const { annual: _annual, ...withoutAnnual } = component;
    const { level: _level, ...withoutLevel } = mark;
    for (const refused of [
      withoutRecoveries,
      withoutAnnual,
      { ...component, termRecoveries: [mark, mark] },
      { ...component, annual: withoutLevel },
      { ...component, annual: { ...mark, level: 'above' } },
      { ...component, annual: { ...mark, maximumMilli: 100_000 } },
      { ...component, subject: { id: 1, label: 'MATEMATICA', abbreviation: 'M' } },
      { ...component, result: 'approved' },
    ])
      expect(answersComponents([refused])).toBe(false);
    const many = (length: number) =>
      Array.from({ length }, (_, index) => ({ ...component, offerId: index + 1 }));
    const limit = RELATIONAL_COUNCIL_LIMITS_V3.offers;
    expect(answersComponents(many(limit))).toBe(true);
    expect(answersComponents(many(limit + 1))).toBe(false);
  });

  it('deliberates on the eligible and on a recovery still to be recorded, and only takes notice of N/C and R/R', () => {
    const cases = [
      ['eligible', true, false],
      ['recovery-pending', true, false],
      ['failed-no-show', false, true],
      ['failed-repeat', false, true],
    ] as const;
    for (const [code, votable, informed] of cases) {
      const item = student(1, code);
      expect([code, relationalCouncilVotableV3(item)]).toEqual([code, votable]);
      expect([code, relationalCouncilInformedV3(item)]).toEqual([code, informed]);
      // Alone before the Conselho, each one is counted where its case puts it and nowhere else.
      const counted = { pending: votable ? 1 : 0, forInformation: informed ? 1 : 0 };
      const answersCounts = (summary: Partial<typeof emptySummary>) =>
        answers({
          ...ready,
          workspace: {
            ...workspace,
            summary: { ...emptySummary, total: 1, ...summary },
            students: [item],
          },
        });
      expect([code, answersCounts(counted)]).toEqual([code, true]);
      expect([code, answersCounts({})]).toEqual([code, false]);
      expect([code, answersCounts({ pending: 1, forInformation: 1 })]).toEqual([code, false]);
    }
  });

  it('sends only the students that are before the Conselho, out of the whole class', () => {
    // The cases of the classmates are not part of the answer: such a student is never sent.
    for (const code of [
      'status',
      'in-progress',
      'above-limit',
      'approved',
      'definitions-unavailable',
    ]) {
      const item = student(1, code);
      expect([code, relationalCouncilVotableV3(item), relationalCouncilInformedV3(item)]).toEqual([
        code,
        false,
        false,
      ]);
      const alone = { ...workspace, summary: { ...emptySummary, total: 1 }, students: [item] };
      expect([code, answers({ ...ready, workspace: alone })]).toEqual([code, false]);
    }
    // `total` counts the class, so it is never smaller than the students sent, and may be larger.
    const answersTotal = (total: number) =>
      answers({ ...ready, workspace: { ...council, summary: { ...council.summary, total } } });
    expect(council.students).toHaveLength(5);
    expect(answersTotal(4)).toBe(false);
    for (const total of [5, 6, 40]) expect(answersTotal(total)).toBe(true);
    // A class with nobody before the Conselho still says how many students it has.
    expect(
      answers({ ...ready, workspace: { ...workspace, summary: { ...emptySummary, total: 30 } } }),
    ).toBe(true);
  });

  it('refuses a summary that disagrees with the students it comes with', () => {
    const answersSummary = (summary: Partial<typeof council.summary>) =>
      answers({ ...ready, workspace: { ...council, summary: { ...council.summary, ...summary } } });
    expect(answersSummary({})).toBe(true);
    for (const wrong of [
      // The recovery still to be recorded is pending, not left out.
      { pending: 1 },
      // The students only taken notice of are not pending.
      { pending: 4 },
      { decided: 0 },
      { forInformation: 0 },
      { forInformation: 3 },
    ])
      expect(answersSummary(wrong)).toBe(false);
    // A decision that came with a student only taken notice of does not count as decided.
    const students = council.students.map((item) =>
      item.id === 4 ? { ...item, decision: { code: 2 } } : item,
    );
    expect(answers({ ...ready, workspace: { ...council, students } })).toBe(true);
    expect(
      answers({
        ...ready,
        workspace: { ...council, students, summary: { ...council.summary, decided: 2 } },
      }),
    ).toBe(false);
  });

  it('tallies a class from its summary, with the absences among the rejected', () => {
    expect(
      relationalCouncilTallyV3({
        total: 12,
        decided: 6,
        pending: 3,
        approved: 2,
        rejected: 3,
        absence: 1,
        forInformation: 2,
      }),
    ).toEqual({ approved: 2, rejected: 4, pending: 3, forInformation: 2 });
  });

  it('matches a ready answer to the year and the class that were asked for', () => {
    const matches = (request: unknown, response: unknown) =>
      relationalCouncilResponseMatchesV3(
        relationalCouncilRequestSchemaV3.parse(request),
        relationalCouncilResponseSchemaV3.parse(response),
      );
    const list = { contractVersion: 3, operation: 'classes', year: 2026 };
    const read = { ...open, operation: 'workspace' };
    expect(matches(list, classes)).toBe(true);
    expect(matches({ ...list, year: 2025 }, classes)).toBe(false);
    expect(matches(list, ready)).toBe(false);
    expect(matches(read, ready)).toBe(true);
    expect(matches({ ...read, classId: 2 }, ready)).toBe(false);
    expect(matches({ ...read, year: 2025 }, ready)).toBe(false);
    // The answer to opening says so: a plain reading does not stand for it.
    expect(matches(open, ready)).toBe(false);
    expect(matches(open, { ...ready, operation: 'open' })).toBe(true);
    expect(matches(read, { contractVersion: 3, state: 'not-found' })).toBe(true);
  });

  it('fails only as invalid, not authorized, not found, unavailable or too large', () => {
    for (const state of [
      'invalid-request',
      'not-authorized',
      'not-found',
      'unavailable',
      'scope-too-large',
    ]) {
      expect(answers({ contractVersion: 3, state })).toBe(true);
      expect(answers({ contractVersion: 3, state, currentVersion: 4 })).toBe(false);
    }
    for (const state of [
      'version-conflict',
      'idempotency-conflict',
      'session-not-open',
      'session-already-open',
      'session-closed',
      'closure-blocked',
      'review-conflict',
      'student-not-eligible',
    ])
      expect(answers({ contractVersion: 3, state })).toBe(false);
  });

  it('carries no count, presentes, director or tie-break in the transport', () => {
    const source = readFileSync(
      'shared/gradebook-contracts/council/relational-council-v3.ts',
      'utf8',
    );
    expect(source).not.toMatch(/presentes|favoraveis|tieBreak|desempate|director|diretor/iu);
  });
});

describe('Council V3 schema with only its current state', () => {
  it('keeps the session, the count and the idempotency keys, and no history or snapshot', async () => {
    const tables = (
      await pg.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='gradebook' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    expect(tables.filter((table) => table.startsWith('conselho_'))).toEqual([
      'conselho_anterior_historico',
      'conselho_decisao',
      'conselho_idempotencia',
      'conselho_sessao',
      'conselho_votacao',
    ]);
    expect(
      (
        await pg.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='gradebook' AND table_name='conselho_sessao' AND column_name='fechamento_atual_id'",
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pg.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='gradebook' AND table_name='aluno' AND column_name='conselho_anterior'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await pg.query('SELECT count(*)::integer AS count FROM gradebook.conselho_decisao')).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('stores no persisted presentes, director or tie-break field', async () => {
    const columns = (
      await pg.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='gradebook' AND table_name LIKE 'conselho_%' ORDER BY column_name",
      )
    ).rows.map((row) => row.column_name);
    expect(columns).not.toEqual(expect.arrayContaining(['presentes', 'diretor_id', 'desempate']));
  });

  it('enforces immutable command keys, non-negative votes and backend-only grants', async () => {
    await pg.exec(`
      INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
      INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES (1,2026,'S1','TURMA SINTETICA',6,'TESTE');
      INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO');
      INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,1,1,1);
      INSERT INTO gradebook.conselho_sessao (ano,turma_id,estado,versao,atualizado_por)
        VALUES (2026,1,1,1,'11111111-1111-4111-8111-111111111111');
    `);
    await expect(
      pg.exec(`INSERT INTO gradebook.conselho_votacao
      (ano,turma_id,aluno_id,favoraveis,contrarios,versao,justificativa,registrado_por)
      VALUES (2026,1,1,-1,0,2,'Teste','11111111-1111-4111-8111-111111111111')`),
    ).rejects.toMatchObject({ code: '23514' });
    const publicAccess = (
      await pg.query(
        "SELECT has_table_privilege('public','gradebook.conselho_sessao','SELECT') AS allowed",
      )
    ).rows;
    expect(publicAccess).toEqual([{ allowed: false }]);
    const backendAccess = (
      await pg.query(`SELECT
      has_table_privilege('gradebook_app','gradebook.conselho_sessao','SELECT') AS session_select,
      has_table_privilege('gradebook_app','gradebook.conselho_sessao','INSERT') AS session_insert,
      has_table_privilege('gradebook_app','gradebook.conselho_sessao','UPDATE') AS session_update,
      has_table_privilege('gradebook_app','gradebook.conselho_sessao','DELETE') AS session_delete,
      has_table_privilege('gradebook_app','gradebook.conselho_idempotencia','SELECT') AS key_select,
      has_table_privilege('gradebook_app','gradebook.conselho_idempotencia','INSERT') AS key_insert,
      has_table_privilege('gradebook_app','gradebook.conselho_idempotencia','UPDATE') AS key_update,
      has_table_privilege('gradebook_app','gradebook.conselho_idempotencia','DELETE') AS key_delete`)
    ).rows;
    expect(backendAccess).toEqual([
      {
        session_select: true,
        session_insert: true,
        session_update: true,
        session_delete: false,
        key_select: true,
        key_insert: true,
        key_update: false,
        key_delete: false,
      },
    ]);
  });
});
