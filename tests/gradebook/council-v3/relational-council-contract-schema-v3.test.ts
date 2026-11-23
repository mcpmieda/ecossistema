// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  relationalCouncilRequestSchemaV3,
  relationalCouncilResponseSchemaV3,
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
const workspace = {
  context: { year: 2026, minimumApprovalMilli: 60_000, maxCouncilComponents: 2 },
  classGroup: { id: 1, label: 'S1', name: 'TURMA SINTETICA' },
  readAt: '2026-11-23T12:00:00.000Z',
  authority: 'calculated-eligibility-explicit-human-decision',
  session: { state: 'not-opened' },
  summary: {
    total: 0,
    eligible: 0,
    decided: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    absence: 0,
    notEligible: 0,
  },
  students: [],
};
const ready = { contractVersion: 3, state: 'ready', operation: 'workspace', workspace };
const classes = {
  contractVersion: 3,
  state: 'ready',
  operation: 'classes',
  year: 2026,
  classes: [{ id: 1, label: 'S1', name: 'TURMA SINTETICA', sessionState: 'not-opened' }],
  nextOffset: null,
};

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

  it('reads the classes, with their tally only when asked, and one workspace', () => {
    const list = { contractVersion: 3, operation: 'classes', year: 2026, offset: 0, limit: 100 };
    expect(accepts(list)).toBe(true);
    expect(accepts({ ...list, tally: true })).toBe(true);
    expect(accepts({ ...list, tally: 'yes' })).toBe(false);
    expect(accepts({ ...open, operation: 'workspace' })).toBe(true);
    expect(accepts({ ...open, operation: 'workspace', tally: true })).toBe(false);
  });

  it('answers a meeting that is either not opened or open, with nothing else about it', () => {
    for (const state of ['not-opened', 'open']) {
      expect(answers({ ...ready, workspace: { ...workspace, session: { state } } })).toBe(true);
      expect(
        answers({ ...classes, classes: [{ ...classes.classes[0], sessionState: state }] }),
      ).toBe(true);
    }
    expect(answers({ ...ready, operation: 'open' })).toBe(true);
    expect(answers({ ...ready, workspace: { ...workspace, session: { state: 'closed' } } })).toBe(
      false,
    );
    expect(
      answers({ ...classes, classes: [{ ...classes.classes[0], sessionState: 'closed' }] }),
    ).toBe(false);
    for (const operation of ['close', 'reopen'])
      expect(answers({ ...ready, operation })).toBe(false);
    for (const extra of [{ version: 1 }, { reviewReference: 'council-review:2026:1:1' }])
      expect(
        answers({ ...ready, workspace: { ...workspace, session: { state: 'open', ...extra } } }),
      ).toBe(false);
    expect(answers({ ...classes, classes: [{ ...classes.classes[0], sessionVersion: 1 }] })).toBe(
      false,
    );
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
