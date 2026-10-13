import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../../server/env';
import {
  applyCurrentGradebookSchemaV1,
  applyReconciliationCandidateSchemaV1,
} from '../../../server/gradebook/recovery/current-gradebook-schema-v1';
import { createGradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { handleStudentReconciliationRequestV1 } from '../../../server/student-identity/reconciliation/http-v1';
import { StudentReconciliationServiceV1 } from '../../../server/student-identity/reconciliation/service-v1';
import {
  reconciliationResponseV1,
  type ReconciliationPrepareV1,
  type ReconciliationResponseV1,
} from '../../../shared/student-identity/reconciliation-v1';

vi.mock('../../../server/student-portal/admin-client/pages-context-v1', () => ({
  verifiedPagesContextV1: vi.fn(async () => ({
    actorId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    requestId: crypto.randomUUID(),
    capability: 'platform.settings.write',
    authenticatedAt: new Date().toISOString(),
  })),
}));

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test'
)
  throw new Error('Prepare response tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const databaseName = 'portal1269_prepare_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let owner: ReturnType<typeof postgres>;
let database: Awaited<ReturnType<typeof createGradebookPostgresDatabaseV1>>;
let service: StudentReconciliationServiceV1;
const actor = '11111111-1111-4111-8111-111111111111';
const origin = 'https://admin.synthetic.invalid';
const base = { contractVersion: 1 as const, academicYear: 2026 as const };
const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + databaseName);
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  owner = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  const schema = {
    unsafe: (sql: string, params: readonly unknown[] = []) =>
      owner.unsafe(sql, [...params] as never[], { prepare: false }),
  };
  await applyCurrentGradebookSchemaV1(schema, process.cwd());
  for (const file of readdirSync('migrations/student-portal')
    .filter((f) => /^\d{4}_.*\.sql$/u.test(f) && Number(f.slice(0, 4)) <= 24)
    .sort()) {
    if (file.startsWith('0019_'))
      await exec('UPDATE student_portal.publication_control_v2 SET enabled=true');
    await exec(readFileSync('migrations/student-portal/' + file, 'utf8'));
  }
  await applyReconciliationCandidateSchemaV1(schema, process.cwd());
  await exec(`INSERT INTO gradebook.ano_letivo VALUES(2026,60000,2);
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno)
      VALUES(710001,2026,'7A','SYNTHETIC CLASS A',7,'MATUTINO');
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES(710001,2026,'SYNTHETIC PERSON ALPHA');
    INSERT INTO gradebook.vinculo(ano,turma_id,aluno_id,numero,situacao)
      VALUES(2026,710001,710001,1,NULL);`);
  // Use the actual runtime factory, including fetch_types:false and its row normalization.
  // The connection role is scoped to this test's sessions, without changing role grants.
  url.searchParams.set('options', '-c role=gradebook_app');
  database = await createGradebookPostgresDatabaseV1(url.toString());
  service = new StudentReconciliationServiceV1(database, actor, 'synthetic-cursor-key-'.repeat(3));
}, 60_000);

afterAll(async () => {
  await database?.close();
  await owner?.end({ timeout: 2 });
  await cluster.unsafe('DROP DATABASE ' + databaseName);
  await cluster.end({ timeout: 2 });
});

async function request(): Promise<ReconciliationPrepareV1> {
  const catalog = await service.execute({ ...base, operation: 'catalog' });
  if (catalog.state !== 'ready' || catalog.operation !== 'catalog')
    throw new Error('Synthetic catalog missing');
  const row = {
    sourceRow: 2,
    name: 'SYNTHETIC PERSON ALPHA',
    birthDate: '2012-02-03',
    filiation1: 'SYNTHETIC GUARDIAN ALPHA',
    inep: '00001234',
    enrollmentHash: 'synthetic-prepare-alpha',
    classLabel: '7A 2026 - MATUTINO',
    shift: 'MATUTINO',
    stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano',
    status: 'CURSANDO',
    enrolledAt: null,
    transferredAt: null,
  };
  return {
    ...base,
    operation: 'prepare',
    generation: catalog.context.generation,
    expectedRevision: catalog.context.revision,
    idempotencyKey: crypto.randomUUID(),
    normalizationVersion: 1,
    sourceFormat: 'smecel-report-v1',
    date1904: false,
    sourceYear: 2026,
    confirmYear: true,
    sourceGeneratedAt: null,
    rows: [row],
    classLinks: [
      {
        classLabel: row.classLabel,
        shift: row.shift,
        stageLabel: row.stageLabel,
        gradebookClassId: 710001,
        confirmRegular: false,
      },
    ],
  };
}

async function route(input: ReconciliationPrepareV1) {
  const response = await handleStudentReconciliationRequestV1(
    new Request(origin + '/api/student-reconciliation/v1', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    {
      OFFICIAL_ORIGIN: origin,
      TENANT_ID: '22222222-2222-4222-8222-222222222222',
      SESSION_SECRET: 'synthetic-only-'.repeat(5),
      RUNTIME_ENVIRONMENT: 'local',
      GRADEBOOK_STORAGE_PROVIDER: 'postgres',
      GRADEBOOK_DATABASE: database,
    } as unknown as RuntimeEnv,
  );
  return { status: response!.status, body: reconciliationResponseV1.parse(await response!.json()) };
}

function prepared(response: ReconciliationResponseV1) {
  if (response.state !== 'ready' || response.operation !== 'prepare')
    throw new Error('Synthetic preparation missing');
  return response;
}

async function snapshot() {
  const [result] = await owner.unsafe(`SELECT
    (SELECT count(*)::integer FROM gradebook.student_report_batch_v1) AS batches,
    (SELECT count(*)::integer FROM gradebook.student_report_pending_row_v1) AS pending,
    (SELECT revision::integer FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026) AS revision,
    (SELECT count(*)::integer FROM gradebook.nota) AS grades,
    (SELECT count(*)::integer FROM gradebook.student_source_link_v1) AS links,
    (SELECT count(*)::integer FROM gradebook.student_identity) AS identities`);
  return result!;
}

it('uses the production driver boundary and returns a valid new preparation through the real route', async () => {
  const [wire] = await database.query('SELECT current_user, ARRAY[]::text[] AS differences', []);
  expect(wire).toEqual({ current_user: 'gradebook_app', differences: '{}' });
  const input = await request();
  const before = await snapshot();
  const response = await route(input);
  expect(response.status).toBe(200);
  expect(prepared(response.body)).toMatchObject({ differences: [], batchState: 'preparing' });
  expect(await snapshot()).toEqual({
    ...before,
    batches: before.batches + 1,
    pending: before.pending + 1,
    revision: before.revision + 1,
  });
});

it('replays a persisted receipt with the same idempotency key without duplicating rows or advancing revision', async () => {
  const input = await request();
  // Model a preparation committed before its response reached the client.
  const stored = prepared(await service.execute(input));
  const before = await snapshot();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await route(input);
    expect(response).toEqual({ status: 200, body: stored });
    expect(await snapshot()).toEqual(before);
  }
});

it('preserves nonempty differences including accents and array-literal punctuation', async () => {
  const input = await request();
  const stored = prepared(await service.execute(input));
  const differences = ['source-count-changed', 'ação, "aspas" e \\barra'];
  await owner.unsafe(
    `UPDATE gradebook.student_report_batch_v1
    SET differences=ARRAY(SELECT jsonb_array_elements_text($2::text::jsonb)) WHERE id=$1::uuid`,
    [stored.batchId, JSON.stringify(differences)],
  );
  const before = await snapshot();
  const response = await route(input);
  expect(response.status).toBe(200);
  expect(prepared(response.body).differences).toEqual(differences);
  expect(await snapshot()).toEqual(before);
});

it('rejects an invalid array before commit and safely retries the rolled-back key', async () => {
  const input = await request();
  const before = await snapshot();
  await exec(`CREATE FUNCTION gradebook.synthetic_invalid_differences_v1() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN NEW.differences := ARRAY[NULL]::text[]; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_invalid_differences_v1 BEFORE INSERT ON gradebook.student_report_batch_v1
    FOR EACH ROW EXECUTE FUNCTION gradebook.synthetic_invalid_differences_v1();`);
  try {
    expect(await route(input)).toEqual({
      status: 503,
      body: { contractVersion: 1, state: 'unavailable' },
    });
    expect(await snapshot()).toEqual(before);
  } finally {
    await exec(`DROP TRIGGER synthetic_invalid_differences_v1 ON gradebook.student_report_batch_v1;
      DROP FUNCTION gradebook.synthetic_invalid_differences_v1();`);
  }
  const retry = await route(input);
  expect(retry.status).toBe(200);
  const after = await snapshot();
  expect(after).toEqual({
    ...before,
    batches: before.batches + 1,
    pending: before.pending + 1,
    revision: before.revision + 1,
  });
  expect(await route(input)).toEqual(retry);
  expect(await snapshot()).toEqual(after);
});
