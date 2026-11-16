// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createRelationalWorkspaceV2 } from '../../../server/gradebook/application/operational-workspace/relational-workspace-v2';
import { handleOperationalWorkspaceRequestV1 } from '../../../server/gradebook/http/operational-workspace-routes-v1';
import {
  isOperationalWorkspaceRequestV2,
  isOperationalWorkspaceResponseV2,
  workspaceResponseMatchesRequestV2,
  type OperationalWorkspaceRequestV2,
} from '../../../shared/gradebook-contracts/operational-workspace/operational-workspace-transport-v2';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { seal } from '../../../server/auth/sealed';
import { testEnv } from '../../fixtures';
import type { RuntimeEnv } from '../../../server/env';

type Row = Record<string, unknown>;
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;
let transactions = 0;
let failRead = false;
const queries: string[] = [];
const args: (readonly unknown[])[] = [];
async function execute(client: Pick<PGlite, 'query'>, sql: string, values: readonly unknown[]) {
  queries.push(sql);
  args.push(values);
  if (failRead && sql.startsWith('SELECT')) throw new Error('synthetic-private-database-failure');
  const result = await client.query<Row>(sql, [...values]);
  if (sql.startsWith('SET TRANSACTION')) {
    // Inspect the actual transaction, rather than only matching SQL source text.
    const settings = await client.query(
      "SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation",
    );
    expect(settings.rows).toEqual([{ readonly: 'on', isolation: 'repeatable read' }]);
  }
  return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2),(2025,65000,3);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
      (10,2026,'A1','TURMA SINTETICA A',6,'M'),(20,2026,'B1','TURMA SINTETICA B',6,'T'),(30,2025,'A1','OUTRO ANO SINTETICO',6,'M');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (11,2026,'DOCENTE SINTETICO'),(21,2025,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES
      (11,2026,'PORTUGUÊS'),(12,2026,'MATEMÁTICA'),(13,2026,'HISTÓRIA'),(14,2026,'GEOGRAFIA'),(15,2026,'CIÊNCIAS'),
      (21,2025,'COMPONENTE SINTETICO');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES
      (10,2026,10,11,11),(11,2026,10,11,12),(12,2026,10,11,13),(13,2026,10,11,14),(14,2026,10,11,15),
      (20,2026,20,11,11),(30,2025,30,21,21);
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO'),(2,2026,'ALUNO SINTETICO'),(3,2026,'ASSISTIDO SINTETICO'),(4,2026,'LITERAL %_ SINTETICO'),(5,2026,'HISTORICO SINTETICO'),(99,2025,'ALUNO SINTETICO');
    INSERT INTO gradebook.aluno (id,ano,nome) SELECT 1000+n,2026,'PESSOA SINTETICA '||lpad(n::text,3,'0') FROM generate_series(1,250) n;
    INSERT INTO gradebook.vinculo VALUES
      (2026,10,1,1,NULL,NULL),(2026,10,2,2,6,20),(2026,20,1,2,7,10),
      (2026,10,3,3,2,NULL),(2026,10,4,4,NULL,NULL),(2026,20,5,5,6,10),(2025,30,1,99,NULL,NULL);
    INSERT INTO gradebook.vinculo SELECT 2026,10,10+n,1000+n,NULL,NULL FROM generate_series(1,250) n;
  `);
  const sql: GradebookPostgresSqlV1 = {
    async unsafe() {
      throw new Error('workspace-read-outside-transaction');
    },
    async begin(operation) {
      transactions++;
      return pg.transaction(async (client) => {
        const tx: GradebookPostgresQuerySqlV1 = {
          unsafe: (query, values = []) => execute(client, query, values),
        };
        return operation(tx);
      });
    },
    async end() {
      await pg.close();
    },
  };
  database = createGradebookPostgresDatabaseFromSqlV1(sql);
  const transaction = database.transaction.bind(database);
  database.transaction = (operation) =>
    transaction((tx) => {
      expect(tx).not.toHaveProperty('prepare');
      expect(tx).not.toHaveProperty('exec');
      return operation(tx);
    });
}, 30_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(() => {
  transactions = 0;
  queries.length = 0;
  args.length = 0;
  failRead = false;
});
const service = () => createRelationalWorkspaceV2(database);
const search = (
  extra: Partial<Extract<OperationalWorkspaceRequestV2, { operation: 'search' }>> = {},
): Extract<OperationalWorkspaceRequestV2, { operation: 'search' }> => ({
  contractVersion: 2,
  operation: 'search',
  year: 2026,
  kind: 'all',
  query: '',
  offset: 0,
  limit: 50,
  ...extra,
});
const center = (
  kind: 'student' | 'class-group' | 'teacher' | 'subject',
  id: number,
  offset = 0,
): Extract<OperationalWorkspaceRequestV2, { operation: 'center' }> => ({
  contractVersion: 2,
  operation: 'center',
  year: 2026,
  kind,
  id,
  offset,
  limit: 200,
});

async function http(
  body: unknown,
  role: 'ADMINISTRADOR' | 'PROFESSOR' | null = 'ADMINISTRADOR',
  overrides: Partial<RuntimeEnv> = {},
  origin = testEnv.OFFICIAL_ORIGIN,
) {
  const headers = new Headers({ Origin: origin, 'Content-Type': 'application/json' });
  if (role) {
    const cookie = await seal(
      {
        oid: '11111111-1111-4111-8111-111111111111',
        name: 'Synthetic',
        username: 'synthetic@example.test',
        roles: [role],
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      testEnv.SESSION_SECRET,
      'admin-session',
    );
    headers.set('Cookie', `${SESSION_COOKIE}=${cookie}`);
  }
  const env: RuntimeEnv = {
    ...testEnv,
    RUNTIME_ENVIRONMENT: 'local',
    GRADEBOOK_STORAGE_PROVIDER: 'postgres',
    GRADEBOOK_DATABASE: database,
    ...overrides,
  };
  const response = await handleOperationalWorkspaceRequestV1(
    new Request(`${testEnv.OFFICIAL_ORIGIN}/api/gradebook/operational-workspace`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    env,
  );
  if (!response) throw new Error('handler-did-not-match');
  return response;
}

describe('relational operational workspace with the complete schema and PostgreSQL facade', () => {
  it('exposes materialized years newest-first in the global bootstrap', async () => {
    expect(await service().execute({ contractVersion: 2, operation: 'bootstrap' })).toEqual({
      contractVersion: 2,
      state: 'ready',
      operation: 'bootstrap',
      years: [
        { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 },
        { year: 2025, minimumApprovalMilli: 65000, maxCouncilComponents: 3 },
      ],
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    expect(transactions).toBe(1);
  });
  it('returns scoped counts without conflating current bindings and eligible population', async () => {
    expect(
      await service().execute({ contractVersion: 2, operation: 'context', year: 2026 }),
    ).toMatchObject({
      context: { year: 2026 },
      counts: {
        students: 255,
        classes: 2,
        teachers: 1,
        subjects: 5,
        offers: 6,
        currentBindings: 254,
        historicalBindings: 2,
      },
    });
    expect(queries).toHaveLength(3);
  });
  it('loads another materialized year in an isolated transaction', async () => {
    expect(
      await service().execute({ contractVersion: 2, operation: 'context', year: 2025 }),
    ).toMatchObject({
      contractVersion: 2,
      state: 'ready',
      operation: 'context',
      context: { year: 2025 },
    });
    expect(queries).toHaveLength(3);
    expect(transactions).toBe(1);
  });
  it('keeps homonyms distinct and returns only the selected year', async () => {
    const result = await service().execute(search({ kind: 'student', query: 'ALUNO SINTETICO' }));
    expect(result).toMatchObject({
      state: 'ready',
      items: [
        { entity: { id: 1, kind: 'student' }, description: 'A1 · Nº 1' },
        { entity: { id: 2, kind: 'student' }, description: 'B1 · Nº 1' },
      ],
      nextOffset: null,
    });
    if (result.state !== 'ready' || result.operation !== 'search')
      throw new Error('unexpected-result');
    expect(result.items).toHaveLength(2);
  });
  it('preserves literal percent/underscore rather than treating the query as a SQL pattern', async () => {
    const result = await service().execute(search({ query: '%_' }));
    expect(result).toMatchObject({
      items: [{ entity: { id: 4, kind: 'student' } }],
      nextOffset: null,
    });
    expect(queries[2]).not.toContain('%_');
    expect(args[2]).toContain('%_');
  });
  it('binds SQL-like input and never executes it as syntax', async () => {
    expect(await service().execute(search({ query: "' OR 1=1 --" }))).toMatchObject({
      items: [],
      nextOffset: null,
    });
    expect(queries.join('\n')).not.toContain("' OR 1=1 --");
  });
  it('pages all entity kinds deterministically without deduplicating shared numeric IDs across kinds', async () => {
    const items = [];
    for (let offset = 0; offset < 260; offset += 100) {
      const result = await service().execute(search({ limit: 100, offset }));
      if (result.state !== 'ready' || result.operation !== 'search')
        throw new Error('unexpected-result');
      items.push(...result.items);
    }
    expect(items).toHaveLength(263);
    expect(new Set(items.map((item) => `${item.entity.kind}:${item.entity.id}`)).size).toBe(263);
    expect(items.filter((item) => item.entity.id === 11).map((item) => item.entity.kind)).toEqual([
      'teacher',
      'subject',
    ]);
  });
  it('shows current and historical bindings without inventing dates or merging transfers', async () => {
    const result = await service().execute(center('student', 2));
    expect(result).toMatchObject({
      center: {
        bindings: [
          {
            classGroup: { id: 20 },
            number: 1,
            status: 7,
            position: 'current',
            relatedClass: { id: 10 },
          },
          {
            classGroup: { id: 10 },
            number: 2,
            status: 6,
            position: 'historical',
            relatedClass: { id: 20 },
          },
        ],
        offers: [{ id: 20 }],
      },
    });
    expect(queries).toHaveLength(5);
    expect(JSON.stringify(result)).not.toMatch(/occurredOn|currentVersion|authorityMode/u);
  });
  it('keeps ASSISTIDO in the roster without calculating or fabricating an annual result', async () => {
    const result = await service().execute(center('student', 3));
    expect(result).toMatchObject({ center: { bindings: [{ status: 2, position: 'current' }] } });
    if (result.state !== 'ready' || result.operation !== 'center')
      throw new Error('unexpected-result');
    expect(result.center.offers.map((offer) => offer.id)).toEqual([10, 11, 12, 13, 14]);
    expect(JSON.stringify(result)).not.toContain('visibleResult');
  });
  it('does not manufacture a current class or offerings for a historical-only student', async () => {
    expect(await service().execute(center('student', 5))).toMatchObject({
      center: { bindings: [{ position: 'historical' }], offers: [] },
    });
  });
  it('paginates a class larger than 200 and keeps the query count bounded', async () => {
    const a = await service().execute(center('class-group', 10));
    expect(queries).toHaveLength(5);
    queries.length = 0;
    const b = await service().execute(center('class-group', 10, 200));
    expect(queries).toHaveLength(5);
    if (
      a.state !== 'ready' ||
      a.operation !== 'center' ||
      b.state !== 'ready' ||
      b.operation !== 'center'
    )
      throw new Error('unexpected-result');
    expect(a.center.bindings).toHaveLength(200);
    expect(a.center.nextOffset).toBe(200);
    expect(b.center.bindings).toHaveLength(54);
    expect(b.center.nextOffset).toBeNull();
    expect(
      [...a.center.bindings, ...b.center.bindings].filter((row) => row.position === 'historical'),
    ).toHaveLength(1);
  });
  it.each(['teacher', 'subject'] as const)(
    'reads the %s center through current offerings',
    async (kind) => {
      const result = await service().execute(center(kind, 11));
      expect(result).toMatchObject({
        center: {
          entity: { kind, id: 11 },
          bindings: [],
          offers:
            kind === 'teacher'
              ? [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }, { id: 20 }]
              : [{ id: 10 }, { id: 20 }],
          classInfo: null,
        },
      });
      expect(queries).toHaveLength(4);
    },
  );
  it('presents class offers in the teacher-configuration order instead of alphabetically', async () => {
    const result = await service().execute(center('class-group', 10));
    if (result.state !== 'ready' || result.operation !== 'center')
      throw new Error('unexpected-result');
    expect(result.center.offers.map((offer) => offer.subject.label)).toEqual([
      'PORTUGUÊS',
      'MATEMÁTICA',
      'HISTÓRIA',
      'GEOGRAFIA',
      'CIÊNCIAS',
    ]);
  });
  it('returns not-found for an entity from another year without disclosing its facts', async () => {
    expect(await service().execute(center('student', 99))).toEqual({
      contractVersion: 2,
      state: 'not-found',
    });
    expect(queries).toHaveLength(3);
  });
  it('never changes academic tables or import histories while reading all centers', async () => {
    for (const [kind, id] of [
      ['student', 1],
      ['class-group', 10],
      ['teacher', 11],
      ['subject', 11],
    ] as const)
      await service().execute(center(kind, id));
    expect(queries.every((query) => /^SET TRANSACTION|^SELECT|^WITH/u.test(query))).toBe(true);
    const counts = (
      await pg.query(
        'SELECT (SELECT count(*)::integer FROM gradebook.importacao) AS imports,(SELECT count(*)::integer FROM gradebook.nota_historico) AS histories',
      )
    ).rows;
    expect(counts).toEqual([{ imports: 0, histories: 0 }]);
  });
  it.each([
    search({ limit: 201 }),
    search({ offset: -1 }),
    search({ query: 'a'.repeat(81) }),
    { contractVersion: 2, operation: 'bootstrap', year: 2026 },
    { ...center('student', 1), id: 'student:1' },
    { ...search(), maintenanceVersion: 1 },
    null,
  ])('rejects malformed or ambiguous requests before starting a transaction', async (input) => {
    expect(isOperationalWorkspaceRequestV2(input)).toBe(false);
    expect(await service().execute(input)).toEqual({
      contractVersion: 2,
      state: 'invalid-request',
    });
    expect(queries).toHaveLength(0);
    expect(transactions).toBe(0);
  });
  it('validates complete response structure and cross-checks request context', async () => {
    const request = center('student', 2);
    const result = await service().execute(request);
    expect(isOperationalWorkspaceResponseV2(result)).toBe(true);
    expect(workspaceResponseMatchesRequestV2(request, result)).toBe(true);
    expect(workspaceResponseMatchesRequestV2({ ...request, year: 2025 }, result)).toBe(false);
    if (result.state !== 'ready' || result.operation !== 'center')
      throw new Error('unexpected-result');
    expect(
      isOperationalWorkspaceResponseV2({
        ...result,
        center: {
          ...result.center,
          bindings: [{ ...result.center.bindings[0], position: 'historical' }],
        },
      }),
    ).toBe(false);
    expect(isOperationalWorkspaceResponseV2({ ...result, context: { year: '2026' } })).toBe(false);
  });
});

describe('existing HTTP endpoint, real sealed synthetic sessions and relational SQL', () => {
  it('routes V2 without creating the legacy entity/version runtime', async () => {
    const result = await http(center('student', 2));
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect(await result.json()).toMatchObject({
      contractVersion: 2,
      operation: 'center',
      center: { entity: { id: 2 } },
    });
    expect(queries.join('\n')).not.toMatch(
      /academic_record|academic_year_versions|gradebook_runtime_probe/u,
    );
  });
  it.each([
    [null, 401],
    ['PROFESSOR', 403],
  ] as const)('rejects role %s before SQL', async (role, status) => {
    const result = await http(search(), role);
    expect(result.status).toBe(status);
    expect(queries).toHaveLength(0);
    expect(transactions).toBe(0);
    expect(result.headers.get('Cache-Control')).toContain('no-store');
  });
  it('enforces the original productive runtime gate', async () => {
    const result = await http(search(), 'ADMINISTRADOR', {
      RUNTIME_ENVIRONMENT: 'production',
      GRADEBOOK_PRODUCTION_ENABLED: 'false',
    });
    expect(result.status).toBe(503);
    expect(queries).toHaveLength(0);
  });
  it('does not fall back to legacy D1 for V2', async () => {
    const result = await http(search(), 'ADMINISTRADOR', { GRADEBOOK_STORAGE_PROVIDER: 'd1' });
    expect(result.status).toBe(503);
    expect(queries).toHaveLength(0);
  });
  it('rejects a foreign origin', async () => {
    await expect(
      http(search(), 'ADMINISTRADOR', {}, 'https://foreign.example.test'),
    ).rejects.toMatchObject({ status: 403 });
    expect(queries).toHaveLength(0);
  });
  it('maps an unknown entity to a non-disclosing 404', async () => {
    const result = await http(center('student', 99));
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({ contractVersion: 2, state: 'not-found' });
  });
  it('fails opaquely when a read fails, never returning partial detail or SQL', async () => {
    failRead = true;
    const result = await http(center('student', 1));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ contractVersion: 2, state: 'unavailable' });
    expect(result.headers.get('Cache-Control')).toContain('no-store');
  });
  it('rejects invalid V2 and oversize requests before SQL', async () => {
    expect((await http({ ...search(), limit: 10000 })).status).toBe(400);
    expect((await http({ ...search(), query: 'x'.repeat(17000) })).status).toBe(413);
    expect(queries).toHaveLength(0);
  });
});
