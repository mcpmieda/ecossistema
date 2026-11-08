import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createGradebookRelationalImportServiceV11 } from '../../../server/gradebook/application/import/import-relational-service-v11';
import { createGradebookPostgresDatabaseFromSqlV1, type GradebookPostgresSqlV1, type GradebookPostgresQuerySqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { lockResetWriterV1, recordResetWriteV1 } from '../../../server/student-portal/integration/year-reset/writer-v1';
import { ScopedPublicationServiceV2 } from '../../../server/student-portal/publication/scoped-publication-service-v2';
import { SelfProjectionReaderV1 } from '../../../server/student-portal/publication/self-projection-reader-v1';
import { currentRevisionV1 } from '../../../server/student-portal/publication/state-v1';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import type { GradebookNotesImportRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { installAdminReadFixtureV2, readAccountIdV2, READ_ACTOR_V2, READ_SCHOOL_V2 } from './read-fixture-v2';

// Never connect this destructive fixture to an external or production database.
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' || target.pathname !== '/portal705_test' || target.search || target.hash)
  throw new Error('Import regression requires the disposable local portal705_test cluster.');
const databaseName = 'portal_import_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
if (!/^portal_import_[a-f0-9]{12}$/u.test(databaseName)) throw new Error('Invalid disposable database name.');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
let owner: ReturnType<typeof postgres>;
let portalClient: ReturnType<typeof postgres>;
let portal: StudentPortalPostgresSqlV1;
let gradebook: ReturnType<typeof createGradebookPostgresDatabaseFromSqlV1>;
let created = false;
const own = readAccountIdV2(1);
const calendar = {
  ...initialPolicyDefaultsV1().calendar,
  enrollmentStartsAt: '2026-01-01T00:00:00Z', yearStartsAt: '2026-01-02T00:00:00Z',
  t1EndsAt: '2026-04-01T00:00:00Z', t2StartsAt: '2026-04-02T00:00:00Z', t2EndsAt: '2026-07-01T00:00:00Z',
  t3StartsAt: '2026-07-02T00:00:00Z', t3EndsAt: '2026-11-01T00:00:00Z',
  recoveriesStartAt: '2026-11-02T00:00:00Z', yearEndsAt: '2026-12-31T23:59:59Z',
};
function notes(first = 2000, final = 8000, professor = 'SYNTHETIC IMPORT TEACHER'): GradebookNotesImportRequestV9 {
  const term = (trimestre: 1 | 2 | 3) => ({
    definitionSnapshotVersion: 1 as const, trimestre,
    instrumentos: [[1, trimestre === 3 ? 9000 : 6750, 'AV1 TESTE'],
      [2, trimestre === 3 ? 9000 : 6750, 'AV2 TESTE'],
      [11, trimestre === 3 ? 22000 : 16500, 'QUALITATIVA TESTE']] as const,
    alunos: [[1, [trimestre === 1 ? first : 2000, 2000, 4000], trimestre === 1 ? final : 8000],
      [2, [2000, 2000, 4002], 8002]] as const,
  });
  return { transportVersion: 9, operation: 'persist-notas', granularObservationVersion: 1 as const, ano: 2026,
    manifest: { fileName: 'SYNTHETIC IMPORT.xlsb', sha256: 'a'.repeat(64), parserVersion: 'synthetic-import-regression' },
    professor, ofertas: [{ turmaCodigo: 'R746-001', disciplina: 'MATEMATICA',
      trimestres: [term(1), term(2), term(3)], recuperacao: null }] };
}
const importer = () => createGradebookRelationalImportServiceV11(gradebook);
const self = (account = own) => new SelfProjectionReaderV1(portal).read(account, crypto.randomUUID());
const ownTerm = async () => (await self())?.subjects[0]?.periods.find((item) => item.period === 'T1');
const preparation = async () => (await owner.unsafe('SELECT mode,scanned_students,written_sources FROM student_portal.publication_preparation_metrics_v3'))[0]!;
async function policy(autoUpdate: boolean) {
  const service = new PolicyServiceV1(portal);
  const current = await service.read(READ_SCHOOL_V2);
  await service.mutate(READ_ACTOR_V2, { contractVersion: 1, operation: 'settings-set', scope: READ_SCHOOL_V2,
    expectedVersion: current.version, idempotencyKey: crypto.randomUUID(), acknowledgeImmediateEffect: true,
    value: { autoUpdate, accessEnabled: true, showPartials: true, allowedPeriods: ['T1', 'T2'], calendar } });
}
async function release(operation: 'publish' | 'publish-update' | 'unpublish' = 'publish') {
  const service = new ScopedPublicationServiceV2(portal);
  const current = await service.read(READ_SCHOOL_V2);
  return service.command(READ_ACTOR_V2, { contractVersion: 1, operation, scope: READ_SCHOOL_V2, period: 'T1',
    expectedVersion: current.version, idempotencyKey: crypto.randomUUID(),
    ...(operation === 'unpublish' ? { confirmed: true } : { targetDataVersion: current.dataVersion }) });
}
async function state() {
  const rows = await owner.unsafe(`SELECT academic_counter::integer AS academic,reset_counter::integer AS reset,
    (SELECT count(*)::integer FROM student_portal.publication_source_v2) AS sources,
    (SELECT count(*)::integer FROM student_portal.revision_event) AS events,
    (SELECT count(*)::integer FROM gradebook.nota_historico) AS history
    FROM student_portal.academic_revision WHERE academic_year=2026`);
  return rows[0]!;
}

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + databaseName);
  created = true;
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  owner = postgres(url.toString(), { max: 1, fetch_types: false, prepare: true, onnotice: () => undefined });
  const sql = owner as unknown as StudentPortalPostgresSqlV1;
  await installAdminReadFixtureV2({ exec: (text) => owner.unsafe(text, [], { prepare: false }) }, sql);
  // Two synthetic classes prove scope reduction through the actual importer, not a mocked writer.
  await owner.unsafe('UPDATE gradebook.vinculo SET turma_id=746002 WHERE aluno_id>746050');
  // The shared fixture activates only account 1. Both invented readers must be active.
  await owner.unsafe("UPDATE student_portal.account SET auth_state='active' WHERE id=$1::uuid", [readAccountIdV2(2)]);
  gradebook = createGradebookPostgresDatabaseFromSqlV1(owner as unknown as GradebookPostgresSqlV1);
  expect(await importer().execute(notes())).toMatchObject({ state: 'applied' });
  await owner.unsafe('SELECT * FROM student_portal.synchronize_profiles_v1(false)');
  for (const migration of ['0008_atomic_publication_v2.sql', '0009_publication_cutover_guard_v2.sql', '0010_incremental_publication_v3.sql'])
    await owner.unsafe(readFileSync('migrations/student-portal/' + migration, 'utf8'), [], { prepare: false });
  url.username = 'student_portal_app';
  portalClient = postgres(url.toString(), { max: 1, fetch_types: false, prepare: true, onnotice: () => undefined });
  portal = portalClient as unknown as StudentPortalPostgresSqlV1;
  await owner.unsafe('SELECT student_portal.activate_scoped_publication_v2()');
}, 30_000);
beforeEach(async () => {
  await policy(false);
  await owner.unsafe('DELETE FROM student_portal.publication_release_v2');
  await importer().execute(notes());
  // Establish an isolated known fixture, including when testing the broken importer.
  await owner.unsafe('UPDATE student_portal.academic_revision SET academic_counter=academic_counter+1 WHERE academic_year=2026');
});
afterAll(async () => {
  await portalClient?.end({ timeout: 2 });
  await owner?.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + databaseName);
  await cluster.end({ timeout: 2 });
});

it('demonstrates the native driver boolean wire trap and the explicit integer conversion', async () => {
  const [original] = await gradebook.query('SELECT $1::boolean AS flag', [1]);
  const [corrected] = await gradebook.query('SELECT $1::integer::boolean AS flag', [1]);
  expect(original).toEqual({ flag: 0 });
  expect(corrected).toEqual({ flag: 1 });
});
it.each(['marks', 'council', 'relation'] as const)('preserves true and false revision flags through the actual %s writer', async (cause) => {
  const before = await state();
  for (const changed of [true, false]) {
    await gradebook.transaction(async (tx) => {
      await lockResetWriterV1(tx, 2026);
      await recordResetWriteV1(tx, 2026, cause, { changed, studentIds: [746001] });
    });
    expect((await state()).academic).toBe(Number(before.academic) + 1);
  }
  expect((await state()).reset).toBe(Number(before.reset) + 2);
});
it('serves imported zero and changed closing immediately with auto-update ON, without republishing or jobs', async () => {
  await policy(true);
  await release();
  const before = await state();
  const previousRevision = await currentRevisionV1(portal);
  expect((await ownTerm())?.final).toMatchObject({ value: 8 });
  expect(await importer().execute(notes(0, 6000))).toMatchObject({ state: 'applied' });
  expect((await state()).academic).toBe(Number(before.academic) + 1);
  expect(await currentRevisionV1(portal)).not.toBe(previousRevision);
  expect(await preparation()).toMatchObject({ mode: 'incremental', scanned_students: 50, written_sources: 1 });
  expect((await ownTerm())?.final).toMatchObject({ value: 6 });
  expect((await ownTerm())?.partials?.[0]?.mark).toMatchObject({ kind: 'score', value: 0 });
  expect((await self(readAccountIdV2(2)))?.subjects[0]?.periods[0]?.final).toMatchObject({ value: 8.002 });
  expect((await self())?.subjects[0]?.periods.map((period) => period.period)).toEqual(['T1']);
  expect(Number((await owner.unsafe('SELECT count(*) AS n FROM student_portal.publication_job'))[0]!.n)).toBe(0);
  expect(Number((await owner.unsafe('SELECT count(*) AS n FROM student_portal.publication_release_v2'))[0]!.n)).toBe(1);
});
it('allows a manual refresh only while a published period is actually pending', async () => {
  const service = new ScopedPublicationServiceV2(portal);
  await release();
  await importer().execute(notes(3000, 9000));

  let snapshot = await service.read(READ_SCHOOL_V2);
  expect(snapshot.items.find((item) => item.period === 'T1')).toMatchObject({
    state: 'update-pending',
    publishedRevision: expect.any(String),
    availableRevision: snapshot.dataVersion,
  });

  await policy(true);
  snapshot = await service.read(READ_SCHOOL_V2);
  expect(snapshot.items.find((item) => item.period === 'T1')).toMatchObject({
    state: 'published',
    publishedRevision: snapshot.dataVersion,
    availableRevision: snapshot.dataVersion,
  });
  await expect(
    service.command(READ_ACTOR_V2, {
      contractVersion: 1,
      operation: 'publish-update',
      scope: READ_SCHOOL_V2,
      period: 'T1',
      expectedVersion: snapshot.version,
      targetDataVersion: snapshot.dataVersion,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toThrow('student-portal-publication-no-update-conflict');
  await policy(false);
  await importer().execute(notes(4000, 10000));
  snapshot = await service.read(READ_SCHOOL_V2);
  expect(snapshot.items.find((item) => item.period === 'T1')?.state).toBe('update-pending');
  await expect(release('publish-update')).resolves.toMatchObject({ version: expect.any(Number) });
  snapshot = await service.read(READ_SCHOOL_V2);
  expect(snapshot.items.find((item) => item.period === 'T1')).toMatchObject({
    state: 'published',
    publishedRevision: snapshot.dataVersion,
  });
});

it('freezes OFF, catches up on ON, never rewinds on OFF and preserves withdrawal after another import', async () => {
  await release();
  expect(await importer().execute(notes(3000, 9000))).toMatchObject({ state: 'applied' });
  expect((await ownTerm())?.final).toMatchObject({ value: 8 });
  await policy(true);
  expect((await ownTerm())?.final).toMatchObject({ value: 9 });
  await policy(false);
  expect(await importer().execute(notes(4000, 10000))).toMatchObject({ state: 'applied' });
  expect((await ownTerm())?.final).toMatchObject({ value: 9 });
  await policy(true);
  await release('unpublish');
  expect(await importer().execute(notes(5000, 11000))).toMatchObject({ state: 'applied' });
  expect((await self())?.state).toBe('no-publication');
});
it('does not advance academic source versions for identical imports or professor-only metadata', async () => {
  const before = await state();
  expect(await importer().execute(notes())).toMatchObject({ state: 'no-changes' });
  expect(await state()).toEqual(before);
  expect(await importer().execute(notes(2000, 8000, 'Synthetic Import Teacher'))).toMatchObject({ state: 'applied' });
  const after = await state();
  expect(after.academic).toBe(before.academic);
  expect(after.sources).toBe(before.sources);
  expect(after.reset).toBe(Number(before.reset) + 1);
});
it('rolls grades, history, revision and prepared source back when the finalizer fails, then retries once', async () => {
  await policy(true);
  await release();
  const before = await state();
  const raw = owner as unknown as GradebookPostgresSqlV1;
  const interrupt = (tx: GradebookPostgresQuerySqlV1): GradebookPostgresQuerySqlV1 => ({
    ...(tx.typed ? { typed: tx.typed.bind(tx) } : {}),
    async unsafe(query, values) {
      const result = await tx.unsafe(query, values);
      if (query.includes('record_gradebook_change_v1')) throw new Error('synthetic finalizer interruption');
      return result;
    },
  });
  const failing = createGradebookPostgresDatabaseFromSqlV1({ ...interrupt(raw), begin: (run) => raw.begin((tx) => run(interrupt(tx))) });
  await expect(createGradebookRelationalImportServiceV11(failing).execute(notes(3000, 9000))).rejects.toThrow('synthetic finalizer interruption');
  expect(await state()).toEqual(before);
  expect((await ownTerm())?.final).toMatchObject({ value: 8 });
  expect(await importer().execute(notes(3000, 9000))).toMatchObject({ state: 'applied' });
  expect((await state()).academic).toBe(Number(before.academic) + 1);
  expect((await ownTerm())?.final).toMatchObject({ value: 9 });
  const after = await state();
  expect(await importer().execute(notes(3000, 9000))).toMatchObject({ state: 'no-changes' });
  expect(await state()).toEqual(after);
});
it('uses the full safe scope when an import changes a shared subject label', async () => {
  const request = notes();
  const renamed = { ...request, ofertas: request.ofertas.map((offer) => ({ ...offer, disciplina: 'Matematica' })) };
  expect(await importer().execute(renamed)).toMatchObject({ state: 'applied' });
  expect(await preparation()).toMatchObject({ mode: 'full', scanned_students: 106 });
});
