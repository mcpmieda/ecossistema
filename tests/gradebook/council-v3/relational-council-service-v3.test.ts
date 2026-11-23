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
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
      (10,2026,'6A','TURMA SINTETICA',6,'M');
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
    const response = await createRelationalCouncilV3(retryingDatabase, ACTOR).execute({
      contractVersion: 3,
      operation: 'classes',
      year: 2026,
      offset: 0,
      limit: 100,
    });
    expect(response).toMatchObject({ state: 'ready', operation: 'classes' });
    expect(attempts).toBe(2);
  });

  it('keeps eligibility calculated and completes open, close, reopen and close again', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    expect(
      await service.execute({
        contractVersion: 3,
        operation: 'classes',
        year: 2026,
        offset: 0,
        limit: 100,
      }),
    ).toMatchObject({
      state: 'ready',
      classes: [{ id: 10, sessionState: 'not-opened', sessionVersion: 0 }],
    });
    const initial = await service.execute(request('workspace'));
    expect(initial).toMatchObject({
      state: 'ready',
      workspace: {
        session: { state: 'not-opened', version: 0 },
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

    const open = request('open', { expectedVersion: 0, idempotencyKey: 'open:synthetic:0001' });
    expect(await service.execute(open)).toMatchObject({
      state: 'ready',
      workspace: { session: { state: 'open', version: 1 } },
    });
    // The same key again changes nothing; another command under it is refused.
    const revisionBeforeReplay = (
      await pg.query(
        'SELECT reset_counter FROM student_portal.academic_revision WHERE academic_year=2026',
      )
    ).rows;
    expect(await service.execute(open)).toMatchObject({
      state: 'ready',
      workspace: { session: { version: 1 } },
    });
    expect(
      (
        await pg.query(
          'SELECT reset_counter FROM student_portal.academic_revision WHERE academic_year=2026',
        )
      ).rows,
    ).toEqual(revisionBeforeReplay);
    expect(await service.execute({ ...open, operation: 'reopen' })).toEqual({
      contractVersion: 3,
      state: 'idempotency-conflict',
    });

    // Recording a decision or a count is being redone: there is no command for either.
    for (const record of [
      { operation: 'decision', decision: 1 },
      { operation: 'vote', favoraveis: 1, contrarios: 0 },
    ])
      expect(
        await service.execute(
          request(record.operation, {
            ...record,
            studentId: 1,
            expectedVersion: 1,
            idempotencyKey: `${record.operation}:synthetic:0001`,
            justification: 'Comando retirado.',
          }),
        ),
      ).toEqual({ contractVersion: 3, state: 'invalid-request' });

    // With the eligible student still pending, the meeting cannot close.
    const pending = await service.execute(request('workspace'));
    if (pending.state !== 'ready' || pending.operation === 'classes')
      throw new Error('pending-workspace-missing');
    expect(
      await service.execute(
        request('close', {
          expectedVersion: 1,
          reviewReference: pending.workspace.session.reviewReference,
          idempotencyKey: 'close:synthetic:pending',
        }),
      ),
    ).toEqual({ contractVersion: 3, state: 'closure-blocked', currentVersion: 1 });

    // A decision already in the table is still read, and is what lets the meeting close.
    await pg.query(
      'INSERT INTO gradebook.conselho_decisao (aluno_id,decisao,justificativa,registrado_por) VALUES (1,1,$1,$2)',
      ['Deliberação semeada.', ACTOR],
    );
    const decided = await service.execute(request('workspace'));
    expect(decided).toMatchObject({
      state: 'ready',
      workspace: { session: { version: 1 }, summary: { decided: 1, approved: 1, pending: 0 } },
    });
    if (decided.state !== 'ready' || decided.operation === 'classes')
      throw new Error('decided-workspace-missing');
    const closed = await service.execute(
      request('close', {
        expectedVersion: 1,
        reviewReference: decided.workspace.session.reviewReference,
        idempotencyKey: 'close:synthetic:0001',
      }),
    );
    expect(closed).toMatchObject({
      state: 'ready',
      workspace: {
        session: { state: 'closed', version: 2 },
        summary: { eligible: 1, approved: 1 },
      },
    });
    if (closed.state !== 'ready' || closed.operation === 'classes')
      throw new Error('closed-workspace-missing');
    // Only the current state travels: no timeline, no snapshots, no count.
    expect(Object.keys(closed.workspace).sort()).toEqual([
      'authority',
      'classGroup',
      'context',
      'readAt',
      'session',
      'students',
      'summary',
    ]);
    expect(Object.keys(closed.workspace.session).sort()).toEqual([
      'reviewReference',
      'state',
      'version',
    ]);
    expect(closed.workspace.students[0]).not.toHaveProperty('vote');

    const reopened = await service.execute(
      request('reopen', { expectedVersion: 2, idempotencyKey: 'reopen:synthetic:0001' }),
    );
    expect(reopened).toMatchObject({
      state: 'ready',
      workspace: { session: { state: 'open', version: 3 } },
    });
    if (reopened.state !== 'ready' || reopened.operation === 'classes')
      throw new Error('reopened-workspace-missing');
    expect(
      await service.execute(
        request('close', {
          expectedVersion: 3,
          reviewReference: 'council-review:2026:10:2',
          idempotencyKey: 'close:synthetic:wrong',
        }),
      ),
    ).toEqual({ contractVersion: 3, state: 'review-conflict', currentVersion: 3 });
    expect(
      await service.execute(
        request('close', {
          expectedVersion: 3,
          reviewReference: reopened.workspace.session.reviewReference,
          idempotencyKey: 'close:synthetic:0002',
        }),
      ),
    ).toMatchObject({
      state: 'ready',
      workspace: { session: { state: 'closed', version: 4 } },
    });

    // Opening, closing and reopening carry no justification of their own, and nothing counts votes.
    expect(
      (
        await pg.query(
          'SELECT operacao,justificativa FROM gradebook.conselho_idempotencia ORDER BY versao_nova',
        )
      ).rows,
    ).toEqual([
      { operacao: 1, justificativa: 'sem justificativa' },
      { operacao: 4, justificativa: 'sem justificativa' },
      { operacao: 5, justificativa: 'sem justificativa' },
      { operacao: 4, justificativa: 'sem justificativa' },
    ]);
    expect(
      (await pg.query('SELECT count(*)::integer AS count FROM gradebook.conselho_votacao')).rows,
    ).toEqual([{ count: 0 }]);
  }, 30_000);

  it('serializes concurrent stale writes with CAS and keeps a retry idempotent', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    const first = request('reopen', {
      expectedVersion: 4,
      idempotencyKey: 'reopen:concurrency:0001',
    });
    expect(await service.execute(first)).toMatchObject({
      state: 'ready',
      workspace: { session: { state: 'open', version: 5 } },
    });
    expect(
      await service.execute(
        request('reopen', {
          expectedVersion: 4,
          idempotencyKey: 'reopen:concurrency:0002',
        }),
      ),
    ).toEqual({ contractVersion: 3, state: 'version-conflict', currentVersion: 5 });
    expect(await service.execute(first)).toMatchObject({
      state: 'ready',
      workspace: { session: { state: 'open', version: 5 } },
    });
  });

  it('tallies each class only when asked, from the class reading itself', async () => {
    const service = createRelationalCouncilV3(database, ACTOR);
    const classes = { contractVersion: 3, operation: 'classes', year: 2026, offset: 0, limit: 100 };
    const plain = await service.execute(classes);
    if (plain.state !== 'ready' || plain.operation !== 'classes') throw new Error('classes');
    expect(plain.classes[0]).not.toHaveProperty('tally');
    expect(await service.execute({ ...classes, tally: true })).toMatchObject({
      state: 'ready',
      // The only eligible student has the seeded approval: none rejected or pending.
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
