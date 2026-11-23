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

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER_ACTOR = '22222222-2222-4222-8222-222222222222';
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
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2),(2025,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
      (10,2026,'6A','TURMA SINTETICA',6,'M'),(20,2025,'6A','TURMA ANTERIOR SINTETICA',6,'M');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2026,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (1,2026,'MATEMATICA');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES (10,2026,10,1,1);
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES
      (1,2026,'ALUNO ELEGIVEL'),(2,2026,'ALUNO APROVADO'),(3,2026,'ALUNO TRANSFERIDO');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao) VALUES
      (2026,10,1,1,NULL),(2026,10,2,2,NULL),(2026,10,3,3,4);
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT 100+t*10+s,10,t,s,15000,'AVALIACAO SINTETICA'
      FROM generate_series(1,3) t CROSS JOIN generate_series(1,2) s;
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT id,1,0 FROM gradebook.instrumento;
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT id,2,15000 FROM gradebook.instrumento;
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT id,3,15000 FROM gradebook.instrumento;
    INSERT INTO gradebook.fechamento (oferta_id,aluno_id,rec1,rec2,rec3,rec_nc_mask,u_fonte)
      VALUES (10,1,10000,10000,10000,0,30000);
  `);
  await installResetSchemaFixtureV1(pg);
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
const CLASSES = { contractVersion: 3, operation: 'classes', year: 2026, offset: 0, limit: 100 };

async function sessionRows() {
  return (
    await pg.query<Record<string, unknown>>(`SELECT ano::integer AS ano,turma_id,
      estado::integer AS estado,versao::integer AS versao,atualizado_por
      FROM gradebook.conselho_sessao ORDER BY ano DESC,turma_id`)
  ).rows;
}
async function resetCounter() {
  return (
    await pg.query<{ reset: number }>(
      'SELECT reset_counter::integer AS reset FROM student_portal.academic_revision WHERE academic_year=2026',
    )
  ).rows[0]!.reset;
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
    expect(await service.execute(CLASSES)).toMatchObject({
      state: 'ready',
      classes: [{ id: 10, sessionState: 'not-opened' }],
    });
    const initial = await service.execute(request('workspace'));
    expect(initial).toMatchObject({
      state: 'ready',
      workspace: {
        session: { state: 'not-opened' },
        summary: { total: 3, eligible: 1, pending: 1, notEligible: 2 },
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
    expect(initial.workspace.students.find((student) => student.id === 2)?.eligibility.code).toBe(
      'approved',
    );
    expect(initial.workspace.students.find((student) => student.id === 3)?.eligibility.code).toBe(
      'status',
    );

    const resetBefore = await resetCounter();
    const opened = await service.execute(request('open'));
    expect(opened).toMatchObject({
      state: 'ready',
      operation: 'open',
      workspace: { session: { state: 'open' }, summary: { eligible: 1, pending: 1 } },
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
    expect(await service.execute(CLASSES)).toMatchObject({
      state: 'ready',
      classes: [{ id: 10, sessionState: 'open' }],
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
      'authority',
      'classGroup',
      'context',
      'readAt',
      'session',
      'students',
      'summary',
    ]);
    expect(opened.workspace.session).toEqual({ state: 'open' });
    expect(opened.workspace.students[0]).not.toHaveProperty('vote');
    expect(await sessionRows()).toEqual([row]);
    for (const table of ['conselho_idempotencia', 'conselho_votacao'])
      expect(
        (await pg.query(`SELECT count(*)::integer AS count FROM gradebook.${table}`)).rows,
      ).toEqual([{ count: 0 }]);
  }, 30_000);

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
    expect(await service.execute({ ...CLASSES, year: 2025 })).toMatchObject({
      state: 'ready',
      classes: [{ id: 20, sessionState: 'open' }],
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

  it('always tallies each class, from the class reading itself', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    expect(await service.execute(CLASSES)).toMatchObject({
      state: 'ready',
      // The only eligible student has no decision yet.
      classes: [{ id: 10, sessionState: 'open', tally: { approved: 0, rejected: 0, pending: 1 } }],
    });
    // A class with nobody eligible is listed too, with its tally at zero.
    expect(await service.execute({ ...CLASSES, year: 2025 })).toMatchObject({
      state: 'ready',
      classes: [{ id: 20, tally: { approved: 0, rejected: 0, pending: 0 } }],
    });
    // The flag that asked for the tally is no longer part of the request.
    expect(await service.execute({ ...CLASSES, tally: true })).toEqual({
      contractVersion: 3,
      state: 'invalid-request',
    });
  });

  it('reads a decision already in the table, in the workspace and in the tally', async () => {
    // Nothing records a decision for now: it is seeded.
    await pg.query(
      'INSERT INTO gradebook.conselho_decisao (aluno_id,decisao,justificativa,registrado_por) VALUES (1,1,$1,$2)',
      ['Deliberação semeada.', ACTOR],
    );
    const service = createRelationalCouncilV3(database, ACTOR);
    expect(await service.execute(request('workspace'))).toMatchObject({
      state: 'ready',
      workspace: {
        session: { state: 'open' },
        summary: { eligible: 1, decided: 1, approved: 1, pending: 0 },
        students: expect.arrayContaining([
          expect.objectContaining({
            id: 1,
            decision: expect.objectContaining({
              code: 1,
              label: 'APROVADO PELO CONSELHO',
              justification: 'Deliberação semeada.',
            }),
          }),
        ]),
      },
    });
    expect(await service.execute(CLASSES)).toMatchObject({
      state: 'ready',
      classes: [{ id: 10, tally: { approved: 1, rejected: 0, pending: 0 } }],
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

it('uses the shared presentation for the student with a current decision', async () => {
  await pg.exec(`CREATE OR REPLACE VIEW gradebook.student_presentation_v1 AS
    SELECT id AS student_id,ano AS academic_year,
    CASE WHEN id=1 THEN 'NOME CONSELHO SINTETICO' ELSE nome END AS name FROM gradebook.aluno`);
  try {
    const result = await createRelationalCouncilV3(database, ACTOR).execute(request('workspace'));
    expect(result).toMatchObject({
      state: 'ready',
      workspace: {
        students: expect.arrayContaining([
          expect.objectContaining({
            id: 1,
            name: 'NOME CONSELHO SINTETICO',
            decision: expect.objectContaining({ code: 1 }),
          }),
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

describe('relational Council V3 HTTP boundary', () => {
  it('serves V3 only to the existing persistence administrator with no-store', async () => {
    const body = { contractVersion: 3, operation: 'classes', year: 2026, offset: 0, limit: 100 };
    const response = await http(body);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({
      contractVersion: 3,
      state: 'ready',
      operation: 'classes',
    });
    expect((await http(body, 'PROFESSOR')).status).toBe(403);
    expect((await http(body, null)).status).toBe(401);
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
    for (const retired of [request('close'), request('open', { expectedVersion: 1 })]) {
      const refused = await http(retired);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ contractVersion: 3, state: 'invalid-request' });
    }
  });

  it('accepts another valid year scope and preserves the production gate', async () => {
    expect(
      (await http({ contractVersion: 3, operation: 'classes', year: 2025, offset: 0, limit: 100 }))
        .status,
    ).toBe(200);
    expect(
      (
        await http(
          { contractVersion: 3, operation: 'classes', year: 2026, offset: 0, limit: 100 },
          'ADMINISTRADOR',
          {
            RUNTIME_ENVIRONMENT: 'production',
            GRADEBOOK_PRODUCTION_ENABLED: 'false',
          },
        )
      ).status,
    ).toBe(503);
  });
});
