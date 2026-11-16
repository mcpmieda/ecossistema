// @vitest-environment node
import { installResetSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImportDiagnosticTreatmentServiceV1 } from '../../../server/gradebook/application/audit/import-diagnostic-treatment-v1';
import { createImportDiagnosticTreatmentRequestHandlerV1 } from '../../../server/gradebook/http/import-diagnostic-treatment-routes-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { seal } from '../../../server/auth/sealed';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { testEnv } from '../../fixtures';
import type { RuntimeEnv } from '../../../server/env';

const ACTOR = '11111111-1111-4111-8111-111111111111';
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(
    readFileSync('migrations/gradebook-simplified/0006_import_diagnostic_treatment_v1.sql', 'utf8'),
  );
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
      VALUES (1,2026,'6A','TURMA SINTETICA',6,'M');
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,1,1,1);
    INSERT INTO gradebook.importacao_diagnostico
      (id,ano,arquivo,hash,chave,nivel,codigo,turma_codigo,disciplina,periodo,
       aluno_numero,campo,rotulo)
      VALUES (1,2026,'fonte-sintetica.xlsb',decode(repeat('a',64),'hex'),'achado-1',
        'warning','source-unavailable','6A','MATEMATICA','1 trimestre',1,
        'term-result','Resultado');
  `);
  await installResetSchemaFixtureV1(pg);
  database = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe() {
      throw new Error('outside-transaction');
    },
    async begin(operation) {
      return pg.transaction(async (transaction) =>
        operation({
          async unsafe(sql, values = []) {
            const result = await transaction.query<Record<string, unknown>>(sql, [...values]);
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

const context = {
  contractVersion: 1,
  operation: 'context',
  year: 2026,
  findings: [{ fileName: 'fonte-sintetica.xlsb', key: 'achado-1' }],
} as const;

describe('import diagnostic treatment V1 service', () => {
  it('records immutable, idempotent acknowledgement and note in a bounded context query', async () => {
    const service = createImportDiagnosticTreatmentServiceV1(database, ACTOR);
    await expect(service.execute(context)).resolves.toMatchObject({ state: 'ready', items: [] });

    const acknowledgement = {
      contractVersion: 1,
      operation: 'record',
      year: 2026,
      diagnosticId: 1,
      action: 1,
      note: null,
      idempotencyKey: 'audit:service:0001',
    } as const;
    const first = await service.execute(acknowledgement);
    expect(first).toMatchObject({
      state: 'ready',
      operation: 'record',
      item: {
        actionLabel: 'RECONHECIDO',
        studentName: 'ALUNO SINTETICO',
        current: true,
      },
    });
    const retry = await service.execute(acknowledgement);
    expect(retry).toEqual(first);
    await expect(
      service.execute({ ...acknowledgement, action: 2, note: 'Outro comando.' }),
    ).resolves.toEqual({ contractVersion: 1, state: 'idempotency-conflict' });

    await expect(
      service.execute({
        ...acknowledgement,
        action: 2,
        note: 'Contato com a fonte registrado.',
        idempotencyKey: 'audit:service:0002',
      }),
    ).resolves.toMatchObject({
      state: 'ready',
      item: {
        actionLabel: 'ANOTAÇÃO',
        note: 'Contato com a fonte registrado.',
      },
    });
    const loaded = await service.execute(context);
    expect(loaded).toMatchObject({ state: 'ready', operation: 'context' });
    if (loaded.state !== 'ready' || loaded.operation !== 'context')
      throw new Error('context-missing');
    expect(loaded.items).toHaveLength(2);
    expect(
      (
        await pg.query(
          'SELECT count(*)::integer AS count FROM gradebook.importacao_diagnostico_tratamento',
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
  });

  it('paginates history with a stable timestamp/id cursor while new actions arrive', async () => {
    const service = createImportDiagnosticTreatmentServiceV1(database, ACTOR);
    const firstPage = await service.execute({
      contractVersion: 1,
      operation: 'history',
      year: 2026,
      limit: 1,
      cursor: null,
    });
    expect(firstPage).toMatchObject({ state: 'ready', operation: 'history' });
    if (
      firstPage.state !== 'ready' ||
      firstPage.operation !== 'history' ||
      firstPage.nextCursor === null
    ) {
      throw new Error('first-history-page-missing');
    }

    const inserted = await service.execute({
      contractVersion: 1,
      operation: 'record',
      year: 2026,
      diagnosticId: 1,
      action: 2,
      note: 'Nova ação entre duas páginas.',
      idempotencyKey: 'audit:service:0003',
    });
    expect(inserted).toMatchObject({ state: 'ready', operation: 'record' });
    if (inserted.state !== 'ready' || inserted.operation !== 'record') {
      throw new Error('insert-between-pages-missing');
    }

    const secondPage = await service.execute({
      contractVersion: 1,
      operation: 'history',
      year: 2026,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage).toMatchObject({ state: 'ready', operation: 'history' });
    if (secondPage.state !== 'ready' || secondPage.operation !== 'history') {
      throw new Error('second-history-page-missing');
    }
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.items[0]?.id).not.toBe(inserted.item.id);
  });

  it('keeps history after the current snapshot row is removed', async () => {
    await pg.exec('DELETE FROM gradebook.importacao_diagnostico WHERE id=1');
    const response = await createImportDiagnosticTreatmentServiceV1(database, ACTOR).execute({
      contractVersion: 1,
      operation: 'history',
      year: 2026,
      limit: 100,
      cursor: null,
    });
    expect(response).toMatchObject({ state: 'ready', operation: 'history', nextCursor: null });
    if (response.state !== 'ready' || response.operation !== 'history')
      throw new Error('history-missing');
    expect(response.items).toHaveLength(3);
    expect(response.items.every((item) => item.current === false)).toBe(true);
    expect(response.items.every((item) => item.studentName === 'ALUNO SINTETICO')).toBe(true);
    await expect(
      createImportDiagnosticTreatmentServiceV1(database, ACTOR).execute({
        contractVersion: 1,
        operation: 'record',
        year: 2026,
        diagnosticId: 1,
        action: 1,
        note: null,
        idempotencyKey: 'audit:service:missing',
      }),
    ).resolves.toEqual({ contractVersion: 1, state: 'not-found' });
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
  if (role) {
    headers.set(
      'Cookie',
      `${SESSION_COOKIE}=${await seal(
        {
          oid: ACTOR,
          name: 'Synthetic',
          username: 'synthetic@example.test',
          roles: [role],
          exp: Math.floor(Date.now() / 1000) + 600,
        },
        testEnv.SESSION_SECRET, 'admin-session',
      )}`,
    );
  }
  const response = await createImportDiagnosticTreatmentRequestHandlerV1()(
    new Request(`${testEnv.OFFICIAL_ORIGIN}/api/gradebook/audit-treatment`, {
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

describe('import diagnostic treatment V1 HTTP boundary', () => {
  it('is admin-only, no-store and accepts another isolated academic year', async () => {
    const body = { contractVersion: 1, operation: 'history', year: 2026, limit: 100, cursor: null };
    const allowed = await http(body);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Cache-Control')).toContain('no-store');
    expect(await allowed.json()).toMatchObject({
      contractVersion: 1,
      state: 'ready',
      operation: 'history',
    });
    expect((await http(body, 'PROFESSOR')).status).toBe(403);
    expect((await http(body, null)).status).toBe(401);
    const otherYear = await http({ ...body, year: 2025 });
    expect(otherYear.status).toBe(200);
    expect(await otherYear.json()).toMatchObject({ contractVersion: 1, state: 'ready', operation: 'history', items: [] });
  });

  it('keeps the production gate fail-closed', async () => {
    const response = await http(
      { contractVersion: 1, operation: 'history', year: 2026, limit: 100, cursor: null },
      'ADMINISTRADOR',
      { RUNTIME_ENVIRONMENT: 'production', GRADEBOOK_PRODUCTION_ENABLED: 'false' },
    );
    expect(response.status).toBe(503);
  });
});
