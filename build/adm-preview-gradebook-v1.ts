import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

/*
 * Local preview only (never part of a build): serves /api/gradebook/* from the real route
 * handlers over an in-memory PGlite database with invented classes, students and marks.
 * Nothing leaves the machine and nothing here is real academic data.
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS = path.join(ROOT, 'migrations/gradebook-simplified');
const ACTOR = '11111111-1111-4111-8111-111111111111';

// Deterministic 0..999 per (instrument, student), so reloads show the same marks.
const SPREAD = "(abs(hashtext(i.id::text || ':' || v.aluno_id::text)) % 1000)";
const SEED = `
  INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
  INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
    (1,2026,'6A','6º ANO A',6,'M'),(2,2026,'7A','7º ANO A',7,'M'),(3,2026,'7B','7º ANO B',7,'T'),
    (4,2026,'8A','8º ANO A',8,'T'),(5,2026,'9A','9º ANO A',9,'M');
  INSERT INTO gradebook.professor (id,ano,nome) VALUES
    (1,2026,'HELENA DUARTE'),(2,2026,'MARCOS TAVARES'),(3,2026,'LÍVIA NOGUEIRA'),
    (4,2026,'RAFAEL PIMENTEL'),(5,2026,'CECÍLIA BARROS'),(6,2026,'OTÁVIO LACERDA');
  INSERT INTO gradebook.disciplina (id,ano,nome) VALUES
    (1,2026,'PORTUGUÊS'),(2,2026,'MATEMÁTICA'),(3,2026,'HISTÓRIA'),(4,2026,'GEOGRAFIA'),
    (5,2026,'CIÊNCIAS'),(6,2026,'INGLÊS'),(7,2026,'ARTE'),(8,2026,'EDUCAÇÃO FÍSICA');
  INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id)
    SELECT t.id*10+d.id,2026,t.id,((t.id+d.id) % 6)+1,d.id
    FROM gradebook.turma t CROSS JOIN gradebook.disciplina d;
  INSERT INTO gradebook.aluno (id,ano,nome)
    SELECT t*100+n,2026,
      (ARRAY['ALICE','BERNARDO','CLARA','DAVI','ELISA','FELIPE','GABRIELA','HEITOR','ISABELA','JOÃO',
             'LARA','MIGUEL','NINA','OTTO','PIETRA','RAUL','SOFIA','THEO','VALENTINA','YURI','ZOÉ','CAIO'])[n]
      || ' ' ||
      (ARRAY['ANDRADE','BRAGA','CORDEIRO','DANTAS','ESTEVES'])[t]
      || ' ' ||
      (ARRAY['MONTE','PRADO','QUEIROZ','ROCHA','SALES','TELES','UCHOA','VIDAL','XAVIER','ZANETTI','LEAL'])[((n*7+t) % 11)+1]
    FROM generate_series(1,5) t CROSS JOIN generate_series(1,22) n;
  INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao,turma_relacionada_id)
    SELECT 2026,t,n,t*100+n,CASE WHEN n=21 THEN 2 ELSE NULL END,NULL
    FROM generate_series(1,5) t CROSS JOIN generate_series(1,22) n;
  INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao)
    SELECT o.id*100+tri*20+s,o.id,tri,s,
      CASE WHEN s=11 THEN CASE WHEN tri=3 THEN 22000 ELSE 16500 END ELSE CASE WHEN tri=3 THEN 9000 ELSE 6750 END END,
      CASE WHEN s=1 THEN 'TRABALHO' WHEN s=2 THEN 'ATIVIDADE' ELSE 'PROVA' END
    FROM gradebook.oferta o CROSS JOIN generate_series(1,3) tri CROSS JOIN (VALUES (1),(2),(11)) slots(s);
  INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
    SELECT i.id,v.aluno_id,(i.maximo * (350 + ${SPREAD} * 65 / 100) / 1000 / 250) * 250
    FROM gradebook.instrumento i
    JOIN gradebook.oferta o ON o.id=i.oferta_id
    JOIN gradebook.vinculo v ON v.turma_id=o.turma_id AND v.situacao IS NULL
    WHERE (i.trimestre < 3 OR i.slot = 1) AND ${SPREAD} % 37 <> 0;
`;

type Row = Record<string, unknown>;
type Query = (text: string, values?: unknown[]) => Promise<{ rows: Row[]; affectedRows?: number }>;
type Handler = (
  request: Request,
  env: unknown,
  afterCommit: () => void,
) => Promise<Response | null>;

const ROUTES = [
  ['assessment-names-routes-v1', 'handleAssessmentNamesRequestV1'],
  ['year-reset-routes-v1', 'handleYearResetRequestV1'],
  ['operational-workspace-routes-v1', 'handleOperationalWorkspaceRequestV1'],
  ['performance-routes-v1', 'handlePerformanceRequestV1'],
  ['bulletin-routes-v1', 'handleBulletinRequestV1'],
  ['council-routes-v1', 'handleCouncilWorkspaceRequestV1'],
  ['retired-reports-route', 'handleRetiredGradebookReportsRequest'],
] as const;

/** An empty platform (no SharePoint here) seen with every capability. It does not wait for the
 * database: the shell asks for it first and gives up after a few seconds. */
async function platformSnapshot(server: ViteDevServer) {
  const [platform, contract] = await Promise.all([
    server.ssrLoadModule('/server/platform/snapshot.ts'),
    server.ssrLoadModule('/shared/platform-contract.ts'),
  ]);
  return (platform.buildPlatformSnapshot as (source: unknown, capabilities: unknown) => unknown)(
    {
      lists: [],
      moduleItems: [],
      configurationItems: [],
      auditItems: [],
      migrationItems: [],
      correlationId: 'preview-local',
    },
    contract.PLATFORM_CAPABILITIES,
  );
}

async function createBackend(server: ViteDevServer) {
  const { PGlite } = await import('@electric-sql/pglite');
  const load = (file: string) => server.ssrLoadModule(file) as Promise<Record<string, unknown>>;
  const [schema, postgres, fixtures, sealed, session] = await Promise.all([
    load('/server/gradebook/recovery/current-gradebook-schema-v1.ts'),
    load('/server/gradebook/persistence/postgres/postgres-database-v1.ts'),
    load('/tests/fixtures.ts'),
    load('/server/auth/sealed.ts'),
    load('/server/auth/session.ts'),
  ]);
  const pg = new PGlite();
  await pg.exec(
    'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;',
  );
  const skipped: string[] = [];
  for (const file of schema.GRADEBOOK_CURRENT_SCHEMA_PLAN_V1 as readonly string[]) {
    try {
      await pg.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    } catch (error) {
      // Cross-schema objects need the Portal schema, which this preview does not create.
      await pg.exec('ROLLBACK').catch(() => undefined);
      skipped.push(`${file}: ${error instanceof Error ? error.message : 'erro'}`);
    }
  }
  // Desempenho, Conselho and Boletins read the student's display name from the reconciliation
  // view. Its migration needs the Portal lineage; without it the preview shows the Relação name.
  try {
    await pg.exec(
      readFileSync(path.join(MIGRATIONS, '0015_student_reconciliation_v1.sql'), 'utf8'),
    );
  } catch (error) {
    await pg.exec('ROLLBACK').catch(() => undefined);
    skipped.push(`0015: ${error instanceof Error ? error.message : 'erro'}`);
    await pg.exec(
      'CREATE VIEW gradebook.student_presentation_v1 AS SELECT a.id AS student_id,a.ano AS academic_year,a.nome AS name FROM gradebook.aluno a',
    );
  }
  await pg.exec(SEED);
  const run = async (query: Query, text: string, values: readonly unknown[]) => {
    const result = await query(text, [...values]);
    return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
  };
  const create = postgres.createGradebookPostgresDatabaseFromSqlV1 as (sql: unknown) => unknown;
  const database = create({
    unsafe: (text: string, values: readonly unknown[] = []) =>
      run((sql, args) => pg.query<Row>(sql, args), text, values),
    begin: (operation: (tx: unknown) => Promise<unknown>) =>
      pg.transaction((client) =>
        operation({
          unsafe: (text: string, values: readonly unknown[] = []) =>
            run((sql, args) => client.query<Row>(sql, args), text, values),
        }),
      ),
    end: async () => undefined,
  });
  const testEnv = fixtures.testEnv as Record<string, string>;
  const seal = sealed.seal as (value: unknown, secret: string) => Promise<string>;
  const cookieName = session.SESSION_COOKIE as string;
  const routes = await Promise.all(
    ROUTES.map(
      async ([file, name]) => (await load(`/server/gradebook/http/${file}.ts`))[name] as Handler,
    ),
  );
  const env = {
    ...testEnv,
    RUNTIME_ENVIRONMENT: 'local',
    GRADEBOOK_STORAGE_PROVIDER: 'postgres',
    GRADEBOOK_DATABASE: database,
  };
  // The import route opens the production database binding itself, so the preview calls the
  // same import service directly over the in-memory database.
  const [importService, importObserver, importTransport] = await Promise.all([
    load('/server/gradebook/application/import/import-relational-service-v11.ts'),
    load('/server/gradebook/persistence/postgres/import-performance-observer-v1.ts'),
    load('/shared/gradebook-contracts/imports/import-persistence-transport-v9.ts'),
  ]);
  const persistImport = async (body: Buffer): Promise<Response> => {
    const reply = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return reply(
        { transportVersion: 9, state: 'invalid-request', reason: 'JSON inválido.' },
        400,
      );
    }
    const inspect = importTransport.inspectGradebookImportPersistenceRequestV9 as (
      value: unknown,
    ) => string;
    if (inspect(payload) !== 'ready')
      return reply({
        transportVersion: 9,
        state: 'invalid-request',
        reason: 'Pacote acadêmico canônico inválido.',
      });
    const observer = (
      importObserver.createImportPerformanceObserverV1 as () => {
        wrap: (database: unknown) => unknown;
      }
    )();
    const service = (
      importService.createGradebookRelationalImportServiceV11 as (
        database: unknown,
        observer: unknown,
      ) => { execute: (request: unknown) => Promise<unknown> }
    )(observer.wrap(database), observer);
    return reply(await service.execute(payload));
  };
  return {
    skipped,
    async handle(pathname: string, search: string, method: string, body: Buffer) {
      if (pathname === '/api/gradebook/import-persistence' && method === 'POST')
        return persistImport(body);
      const cookie = await seal(
        {
          oid: ACTOR,
          name: 'Preview Local',
          username: 'preview@example.invalid',
          roles: ['ADMINISTRADOR'],
          exp: Math.floor(Date.now() / 1000) + 600,
        },
        testEnv.SESSION_SECRET ?? '',
      );
      const origin = testEnv.OFFICIAL_ORIGIN ?? '';
      const request = () =>
        new Request(origin + pathname + search, {
          method,
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            Cookie: `${cookieName}=${cookie}`,
          },
          body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(body),
        });
      for (const route of routes) {
        const response = await route(request(), env, () => undefined);
        if (response) return response;
      }
      return null;
    },
  };
}

const readBody = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });

export function admPreviewGradebookV1(): Plugin {
  return {
    name: 'adm-preview-gradebook',
    apply: 'serve',
    configureServer(server) {
      let backend: ReturnType<typeof createBackend> | undefined;
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (
          !url.pathname.startsWith('/api/gradebook/') &&
          url.pathname !== '/api/platform/bootstrap' &&
          url.pathname !== '/api/platform/snapshot-v2'
        )
          return next();
        const fail = (status: number, detail: string) => {
          response.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify({ state: 'unavailable', preview: detail }));
        };
        void (async () => {
          try {
            if (!url.pathname.startsWith('/api/gradebook/')) {
              response.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
              });
              response.end(JSON.stringify(await platformSnapshot(server)));
              return;
            }
            backend ??= createBackend(server).then((ready) => {
              if (ready.skipped.length)
                server.config.logger.info(
                  `[adm-preview] migrações puladas: ${ready.skipped.join(' | ')}`,
                );
              return ready;
            });
            const ready = await backend;
            const result = await ready.handle(
              url.pathname,
              url.search,
              request.method ?? 'GET',
              await readBody(request),
            );
            if (!result) return fail(503, 'sem manipulador sintético');
            response.writeHead(result.status, Object.fromEntries(result.headers));
            response.end(Buffer.from(await result.arrayBuffer()));
          } catch (error) {
            backend = undefined;
            server.config.logger.error(
              `[adm-preview] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
            );
            fail(500, error instanceof Error ? error.message : 'erro');
          }
        })();
      });
    },
  };
}
