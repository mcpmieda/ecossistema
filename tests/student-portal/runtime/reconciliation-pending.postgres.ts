import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyCurrentGradebookSchemaV1 } from '../../../server/gradebook/recovery/current-gradebook-schema-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { StudentReconciliationServiceV1 } from '../../../server/student-identity/reconciliation/service-v1';
import { prepareReconciliationCredentialsV1 } from '../../../server/student-portal/birth-year/reconciliation-credentials-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import type {
  ReconciliationContextV1,
  ReconciliationPrepareV1,
  ReconciliationResponseV1,
  ReportRowV1,
} from '../../../shared/student-identity/reconciliation-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' || target.search || target.hash)
  throw new Error('Pending report tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const actor = '11111111-1111-4111-8111-111111111111';
const base = { contractVersion: 1 as const, academicYear: 2026 as const };
const declaredDate = '2026-01-02T00:00:00.000Z';
const cryptography = new PortalCryptoV1(
  new Map([[1, new Uint8Array(32).fill(71)]]),
  new Map([[1, new Uint8Array(32).fill(73)]]),
);
type Fixture = {
  name: string;
  owner: ReturnType<typeof postgres>;
  app: ReturnType<typeof postgres>;
  portal: ReturnType<typeof postgres>;
  service: StudentReconciliationServiceV1;
};
const fixtures: Fixture[] = [];
const created: string[] = [];
let pendingFirst: Fixture, relationFirst: Fixture;

async function fixture(): Promise<Fixture> {
  const name = 'portal1269_pending_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  await cluster.unsafe('CREATE DATABASE ' + name);
  created.push(name);
  const url = new URL(target);
  url.pathname = '/' + name;
  const owner = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  const app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  const portal = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  const result = { name, owner, app, portal, service: new StudentReconciliationServiceV1(
    createGradebookPostgresDatabaseFromSqlV1(app as unknown as GradebookPostgresSqlV1),
    actor, 'synthetic-pending-cursor-key-'.repeat(3),
  ) };
  fixtures.push(result);
  const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });
  await applyCurrentGradebookSchemaV1({ unsafe: (sql, params = []) =>
    owner.unsafe(sql, [...params] as never[], { prepare: false }) }, process.cwd());
  for (const file of readdirSync('migrations/student-portal')
    .filter((file) => /^\d{4}_.*\.sql$/u.test(file) && Number(file.slice(0, 4)) <= 24).sort()) {
    if (file.startsWith('0019_')) await exec('UPDATE student_portal.publication_control_v2 SET enabled=true');
    await exec(readFileSync('migrations/student-portal/' + file, 'utf8'));
  }
  for (const path of ['migrations/gradebook-simplified/0015_student_reconciliation_v1.sql',
    'migrations/student-portal/0025_reconciliation_credentials_v1.sql']) await exec(readFileSync(path, 'utf8'));
  await app.unsafe('SET ROLE gradebook_app');
  await portal.unsafe('SET ROLE student_portal_app');
  return result;
}
beforeAll(async () => {
  pendingFirst = await fixture();
  relationFirst = await fixture();
}, 60_000);
afterAll(async () => {
  for (const f of fixtures) {
    await f.app.end({ timeout: 2 });
    await f.portal.end({ timeout: 2 });
    await f.owner.end({ timeout: 2 });
  }
  for (const name of created) await cluster.unsafe('DROP DATABASE ' + name);
  await cluster.end({ timeout: 2 });
});

const reportRow = (patch: Partial<ReportRowV1> = {}): ReportRowV1 => ({
  sourceRow: 2, name: 'SYNTHETIC PENDING ALPHA', birthDate: '2012-02-03',
  filiation1: 'SYNTHETIC GUARDIAN ALPHA', inep: '00007101', enrollmentHash: 'synthetic-pending-alpha',
  classLabel: '7A 2026 - MATUTINO', shift: 'MATUTINO',
  stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano', status: 'CURSANDO',
  enrolledAt: null, transferredAt: null, ...patch,
});
const reportRows = () => [reportRow(), reportRow({
  sourceRow: 3, name: 'SYNTHETIC EXTERNAL BETA', inep: '00007102',
  filiation1: 'SYNTHETIC GUARDIAN BETA', enrollmentHash: 'synthetic-pending-beta',
})];
const mapping = [{
  classLabel: '7A 2026 - MATUTINO', shift: 'MATUTINO',
  stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano', gradebookClassId: 730001, confirmRegular: false,
}];
async function catalog(f: Fixture) {
  const r = await f.service.execute({ ...base, operation: 'catalog' });
  if (r.state !== 'ready' || r.operation !== 'catalog') throw new Error('synthetic-catalog-missing');
  return r;
}
async function list(f: Fixture) {
  const r = await f.service.execute({ ...base, operation: 'list' });
  if (r.state !== 'ready' || r.operation !== 'list') throw new Error('synthetic-list-missing');
  return r;
}
// The count of the side column follows the rule of the pending view of the screen.
async function expectPendingCount(f: Fixture) {
  const rows = (await list(f)).items.filter((item) => item.kind === 'external' || item.reconciliation !== 'reconciled');
  expect(await f.service.execute({ ...base, operation: 'pending-count' }))
    .toEqual({ contractVersion: 1, state: 'ready', operation: 'pending-count', pending: rows.length });
  return rows.length;
}
async function prepareInput(f: Fixture, rows = reportRows(), sourceGeneratedAt: string | null = declaredDate): Promise<ReconciliationPrepareV1> {
  const { context } = await catalog(f);
  return { ...base, operation: 'prepare', generation: context.generation, expectedRevision: context.revision,
    idempotencyKey: crypto.randomUUID(), normalizationVersion: 1, sourceFormat: 'smecel-report-v1',
    date1904: false, sourceYear: 2026, confirmYear: true, sourceGeneratedAt, rows,
    classLinks: context.relationAvailable ? mapping : [],
  };
}
type Prepared = Extract<ReconciliationResponseV1, { state: 'ready'; operation: 'prepare' | 'activate-pending' }>;
function prepared(result: ReconciliationResponseV1): Prepared {
  expect(result.state).toBe('ready');
  if (result.state !== 'ready' || (result.operation !== 'prepare' && result.operation !== 'activate-pending'))
    throw new Error('synthetic-prepare-missing');
  return result;
}
const mutation = (context: ReconciliationContextV1) => ({ ...base,
  generation: context.generation, expectedRevision: context.revision, idempotencyKey: crypto.randomUUID(),
});
async function stage(f: Fixture, p: Prepared) {
  const request = { ...mutation(p.context), operation: 'stage', batchId: p.batchId };
  expect(await f.service.execute(request)).toMatchObject({ state: 'ready', operation: 'stage' });
  expect(await prepareReconciliationCredentialsV1(f.portal as unknown as StudentPortalPostgresSqlV1,
    cryptography, 1, actor, { contractVersion: 1, batchId: p.batchId,
      generation: p.context.generation, expectedScopeRevision: p.context.revision }))
    .toMatchObject({ state: 'ready', remainingCount: 0 });
}
function apply(p: Prepared, confirmDifferences = true) {
  return { ...mutation(p.context), operation: 'apply', batchId: p.batchId, confirmDifferences };
}
async function insertRelation(f: Fixture) {
  await f.owner.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock_shared(613,0)');
    await tx.unsafe('SELECT pg_advisory_xact_lock(613,2026)');
    await tx.unsafe(`INSERT INTO gradebook.ano_letivo VALUES(2026,60000,2);
      INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES(730001,2026,'7A','SYNTHETIC PENDING CLASS',7,'MATUTINO');
      INSERT INTO gradebook.aluno(id,ano,nome) VALUES(730001,2026,'SYNTHETIC PENDING ALPHA');
      INSERT INTO gradebook.vinculo(ano,turma_id,aluno_id,numero) VALUES(2026,730001,730001,1);`, [], { prepare: false });
    await tx.unsafe(`SELECT student_portal.record_gradebook_change_v1(gen_random_uuid(),2026::smallint,
      'relation',true,ARRAY[730001],statement_timestamp())`);
  });
  return String((await f.owner.unsafe('SELECT student_uid FROM gradebook.aluno WHERE id=730001'))[0]!.student_uid);
}
async function currentFacts(f: Fixture) {
  return Array.from(await f.owner.unsafe(`SELECT o.name,o.birth_date::text,o.enrollment_hash,c.class_key,
    l.student_uid IS NOT NULL AS linked,COALESCE(p.observation_id=o.id,false) AS selected
    FROM gradebook.student_source_record_v1 r JOIN gradebook.student_source_observation_v1 o ON o.id=r.current_observation_id
    JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id
    LEFT JOIN gradebook.student_source_link_v1 l ON l.source_id=r.id AND l.academic_year=r.academic_year
    LEFT JOIN gradebook.student_report_profile_v1 p ON p.student_uid=l.student_uid AND p.academic_year=l.academic_year
    ORDER BY o.name`));
}

it('warns after 27 days, hides expired pre-Relação data and cleans it at 30 days without creating identities', async () => {
  const input = await prepareInput(pendingFirst);
  const p = prepared(await pendingFirst.service.execute(input));
  expect(p.batchState).toBe('awaiting_relation');
  expect(p.counts).toEqual({ rows: 2, linked: 0, pending: 2 });
  const [ttl] = await pendingFirst.owner.unsafe(`SELECT extract(epoch FROM expires_at-received_at)/86400 AS days
    FROM gradebook.student_report_batch_v1 WHERE id=$1`, [p.batchId]);
  expect(Number(ttl!.days)).toBeGreaterThan(29.99);
  expect(Number(ttl!.days)).toBeLessThanOrEqual(30);
  await pendingFirst.owner.unsafe(`UPDATE gradebook.student_report_batch_v1
    SET received_at=clock_timestamp()-interval '26 days 23 hours',expires_at=clock_timestamp()+interval '3 days 1 hour'
    WHERE id=$1`, [p.batchId]);
  expect((await list(pendingFirst)).items.every((item) => item.kind === 'external' && !item.warning)).toBe(true);
  await pendingFirst.owner.unsafe(`UPDATE gradebook.student_report_batch_v1
    SET received_at=clock_timestamp()-interval '27 days 1 second',expires_at=clock_timestamp()+interval '3 days'-interval '1 second'
    WHERE id=$1`, [p.batchId]);
  const warned = await list(pendingFirst);
  expect(warned.items).toHaveLength(2);
  expect(warned.items.every((item) => item.kind === 'external' && item.warning && item.sourceId === null)).toBe(true);
  await pendingFirst.owner.unsafe(`UPDATE gradebook.student_report_batch_v1
    SET received_at=clock_timestamp()-interval '30 days 1 second',expires_at=clock_timestamp()-interval '1 second'
    WHERE id=$1`, [p.batchId]);
  expect((await list(pendingFirst)).items).toEqual([]);
  expect((await catalog(pendingFirst)).reportClasses).toEqual([]);
  expect(await pendingFirst.service.execute(input)).toMatchObject({ state: 'expired' });
  const before = (await catalog(pendingFirst)).context;
  await pendingFirst.portal.unsafe('SELECT student_portal.cleanup_reconciliation_pending_v1(100)');
  expect((await catalog(pendingFirst)).context.revision).toBeGreaterThan(before.revision);
  expect((await pendingFirst.owner.unsafe('SELECT state,class_links FROM gradebook.student_report_batch_v1 WHERE id=$1', [p.batchId]))[0])
    .toMatchObject({ state: 'expired', class_links: [] });
  for (const table of ['student_report_pending_row_v1', 'student_source_observation_v1', 'student_report_profile_v1', 'student_identity', 'aluno'])
    expect(await pendingFirst.owner.unsafe('SELECT 1 FROM gradebook.' + table)).toHaveLength(0);
  expect(await pendingFirst.owner.unsafe('SELECT 1 FROM student_portal.account')).toHaveLength(0);
});

let pendingOrderFacts: Awaited<ReturnType<typeof currentFacts>> = [];
it('receives a report before the Relação, activates its mapped batch atomically and replays the activation receipt', async () => {
  const input = await prepareInput(pendingFirst);
  const p = prepared(await pendingFirst.service.execute(input));
  expect(p.context.relationAvailable).toBe(false);
  const available = await catalog(pendingFirst);
  expect(available.classes).toEqual([]);
  expect(available.reportClasses).toEqual([expect.objectContaining({ classId: null, label: mapping[0]!.classLabel })]);
  const external = (await list(pendingFirst)).items;
  expect(external).toHaveLength(2);
  expect(external.every((item) => item.kind === 'external' && item.sourceId === null && item.batchId === p.batchId)).toBe(true);
  expect(await expectPendingCount(pendingFirst)).toBe(2);
  expect(await pendingFirst.owner.unsafe('SELECT 1 FROM gradebook.aluno')).toHaveLength(0);
  const studentUid = await insertRelation(pendingFirst);
  const c = (await catalog(pendingFirst)).context;
  expect(c.relationAvailable).toBe(true);
  const activate = { ...mutation(c), operation: 'activate-pending', batchId: p.batchId, classLinks: mapping };
  const activated = prepared(await pendingFirst.service.execute(activate));
  expect(activated.batchId).not.toBe(p.batchId);
  expect(activated.counts).toEqual({ rows: 2, linked: 1, pending: 1 });
  expect(prepared(await pendingFirst.service.execute(activate)).batchId).toBe(activated.batchId);
  expect(await pendingFirst.owner.unsafe('SELECT 1 FROM gradebook.student_source_observation_v1')).toHaveLength(0);
  await stage(pendingFirst, activated);
  const command = apply(activated, false);
  expect(await pendingFirst.service.execute(command)).toMatchObject({ state: 'committed' });
  expect(await pendingFirst.service.execute(command)).toMatchObject({ state: 'committed' });
  expect(await pendingFirst.service.execute(activate)).toMatchObject({ state: 'committed', operationId: activated.batchId });
  expect(await pendingFirst.owner.unsafe('SELECT 1 FROM gradebook.student_report_pending_row_v1')).toHaveLength(0);
  expect(await pendingFirst.owner.unsafe('SELECT 1 FROM gradebook.student_source_observation_v1')).toHaveLength(2);
  const people = (await list(pendingFirst)).items;
  expect(people.find((item) => item.kind === 'person')).toMatchObject({ studentUid, reconciliation: 'reconciled', portal: 'without-portal' });
  expect(people.filter((item) => item.kind === 'external')).toHaveLength(1);
  expect(await expectPendingCount(pendingFirst)).toBe(1);
  expect(await pendingFirst.owner.unsafe('SELECT 1 FROM student_portal.account')).toHaveLength(0);
  pendingOrderFacts = await currentFacts(pendingFirst);
});

it('produces equivalent reconciled facts when the Relação arrives before the same report', async () => {
  await insertRelation(relationFirst);
  const p = prepared(await relationFirst.service.execute(await prepareInput(relationFirst)));
  expect(p.counts).toEqual({ rows: 2, linked: 1, pending: 1 });
  await stage(relationFirst, p);
  expect(await relationFirst.service.execute(apply(p, false))).toMatchObject({ state: 'committed' });
  expect(pendingOrderFacts).toHaveLength(2);
  expect(await currentFacts(relationFirst)).toEqual(pendingOrderFacts);
  expect(await relationFirst.owner.unsafe('SELECT 1 FROM student_portal.account')).toHaveLength(0);
});

it.each(['older', 'unknown'] as const)('requires confirmation for changed content with %s source metadata', async (kind) => {
  const rows = reportRows();
  rows[0] = reportRow({ enrollmentHash: 'synthetic-pending-' + kind });
  const before = await currentFacts(pendingFirst);
  const p = prepared(await pendingFirst.service.execute(await prepareInput(pendingFirst, rows,
    kind === 'older' ? '2026-01-01T00:00:00.000Z' : null)));
  expect(p.batchState).toBe('review_required');
  expect(p.differences).toContain(kind === 'older'
    ? 'Relatório anterior ao vigente. Confira as alterações.'
    : 'Data do relatório não confirmada. Confira as alterações.');
  await stage(pendingFirst, p);
  const command = apply(p, false);
  expect(await pendingFirst.service.execute(command)).toMatchObject({ state: 'conflict' });
  expect(await currentFacts(pendingFirst)).toEqual(before);
  expect(await pendingFirst.service.execute({ ...command, confirmDifferences: true })).toMatchObject({ state: 'committed' });
  expect(await pendingFirst.service.execute({ ...command, confirmDifferences: true })).toMatchObject({ state: 'committed' });
  expect(await pendingFirst.owner.unsafe('SELECT 1 FROM student_portal.account')).toHaveLength(0);
});
