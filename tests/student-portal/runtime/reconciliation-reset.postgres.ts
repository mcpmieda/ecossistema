import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyCurrentGradebookSchemaV1 } from '../../../server/gradebook/recovery/current-gradebook-schema-v1';
import { createGradebookPostgresDatabaseFromSqlV1, type GradebookPostgresSqlV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createYearResetServiceV1 } from '../../../server/gradebook/application/settings/year-reset-v1';
import { lockResetWriterV1 } from '../../../server/student-portal/integration/year-reset/writer-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' || target.pathname !== '/portal705_test' || target.search || target.hash)
  throw new Error('Reconciliation reset tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const name = 'portal1269_reset_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const actor = '11111111-1111-4111-8111-111111111111';
let owner: ReturnType<typeof postgres>;
let created = false;
const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });
const database = () => createGradebookPostgresDatabaseFromSqlV1({
  unsafe: () => { throw new Error('reset-query-outside-transaction'); },
  begin: <T>(operation: (transaction: Parameters<Parameters<GradebookPostgresSqlV1['begin']>[0]>[0]) => Promise<T>) => owner.begin(async (transaction) => {
    await transaction.unsafe('SET LOCAL ROLE gradebook_app');
    return operation(transaction as unknown as Parameters<Parameters<GradebookPostgresSqlV1['begin']>[0]>[0]);
  }) as Promise<T>,
});
const service = () => createYearResetServiceV1(database(), actor);
const preview = () => service().execute({ contractVersion: 1, operation: 'preview', year: 2026 });
async function command() {
  const result = await preview();
  if (result.state !== 'ready' || result.operation !== 'preview') throw new Error('synthetic-reset-preview-failed');
  return { result, input: { contractVersion: 1, operation: 'execute', year: 2026, previewRevision: result.previewRevision,
    confirmationPhrase: result.confirmationPhrase, understandsIrreversible: true } };
}

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name); created = true;
  const url = new URL(target); url.pathname = '/' + name;
  owner = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await applyCurrentGradebookSchemaV1({ unsafe: (sql, args = []) => owner.unsafe(sql, [...args] as never[], { prepare: false }) }, process.cwd());
  for (const file of readdirSync('migrations/student-portal').filter((file) => /^\d{4}_.*\.sql$/u.test(file) && Number(file.slice(0, 4)) <= 24).sort()) {
    if (file.startsWith('0019_')) await exec('UPDATE student_portal.publication_control_v2 SET enabled=true');
    await exec(readFileSync('migrations/student-portal/' + file, 'utf8'));
  }
  for (const file of ['migrations/gradebook-simplified/0015_student_reconciliation_v1.sql',
    'migrations/student-portal/0025_reconciliation_credentials_v1.sql',
    'migrations/gradebook-simplified/0016_reconciliation_year_reset_v1.sql']) await exec(readFileSync(file, 'utf8'));
}, 60_000);
afterAll(async () => {
  await owner?.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + name);
  await cluster.end({ timeout: 2 });
});

async function pending() {
  const id = crypto.randomUUID();
  await database().transaction(async (tx) => {
    await lockResetWriterV1(tx, 2026);
    await tx.executeNative(`INSERT INTO gradebook.student_reconciliation_scope_v1(academic_year) VALUES(2026)
      ON CONFLICT(academic_year) DO UPDATE SET revision=gradebook.student_reconciliation_scope_v1.revision+1`, []);
    await tx.executeNative(`INSERT INTO gradebook.student_report_batch_v1(id,academic_year,generation,actor_id,source_evidence,
      normalization_version,digest,request_digest,idempotency_key,base_revision,base_academic_revision,state,expires_at,class_links)
      SELECT $1::uuid,2026,generation,$2::uuid,'unknown',1,repeat('a',64),repeat('b',64),gen_random_uuid(),revision,
        'synthetic-revision','awaiting_relation',now()+interval '30 days','[]'::jsonb
      FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026`, [id, actor]);
    await tx.executeNative(`INSERT INTO gradebook.student_report_pending_row_v1(batch_id,source_row,academic_year,
      name,name_key,birth_date,enrollment_hash,class_label,class_key,stage_label,stage,shift,shift_key,status,status_key,
      target_source_id,target_observation_id)
      VALUES($1::uuid,2,2026,'SYNTHETIC PERSON','SYNTHETIC PERSON','2012-01-01','synthetic-hash',
        '7A','7A','7',7,'MATUTINO','MATUTINO','REGULAR','REGULAR',gen_random_uuid(),gen_random_uuid())`, [id]);
  });
  return id;
}

it('resets a report received before the Relação, invalidates its generation and keeps global identities', async () => {
  await pending();
  const before = (await owner.unsafe('SELECT generation FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026'))[0]!.generation;
  const registry = await owner.unsafe('SELECT id FROM gradebook.student_identity ORDER BY id');
  const { result, input } = await command();
  expect(result.counts).toMatchObject({ academicYear: 0, students: 0, reconciliation: 2, totalRows: 2 });
  expect(await service().execute(input)).toMatchObject({ state: 'ready', operation: 'execute', deletedRows: 2 });
  const scope = (await owner.unsafe('SELECT generation,revision,current_batch_id FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026'))[0]!;
  expect(scope.generation).not.toBe(before); expect(Number(scope.revision)).toBe(0); expect(scope.current_batch_id).toBeNull();
  expect(Array.from(await owner.unsafe('SELECT id FROM gradebook.student_identity ORDER BY id'))).toEqual(Array.from(registry));
  expect(await preview()).toMatchObject({ state: 'not-found' });
  expect(await service().execute(input)).toMatchObject({ state: 'preview-changed' });
});

it.each(['prepare', 'decision', 'cleanup'] as const)('invalidates a preview when reconciliation %s changes its revision', async (change) => {
  const id = await pending();
  const { input } = await command();
  if (change === 'prepare') await pending();
  else await owner.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock_shared(613,0)');
    await tx.unsafe('SELECT pg_advisory_xact_lock(613,2026)');
    if (change === 'cleanup') {
      await tx.unsafe('DELETE FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1', [id]);
      await tx.unsafe("UPDATE gradebook.student_report_batch_v1 SET state='expired' WHERE id=$1", [id]);
    } else await tx.unsafe(`INSERT INTO gradebook.student_reconciliation_decision_v1(id,academic_year,generation,sequence,actor_id,action,reason)
      SELECT gen_random_uuid(),2026,generation,revision+1,$1,'name-source','synthetic-decision'
      FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026`, [actor]);
    await tx.unsafe('UPDATE gradebook.student_reconciliation_scope_v1 SET revision=revision+1 WHERE academic_year=2026');
  });
  expect(await service().execute(input)).toMatchObject({ state: 'preview-changed' });
  const fresh = await command();
  expect(await service().execute(fresh.input)).toMatchObject({ state: 'ready', deletedRows: fresh.result.counts.totalRows });
});

it('keeps a linked account and credential preparation intact until its explicit link closure', async () => {
  const id = await pending();
  await exec(`INSERT INTO gradebook.ano_letivo VALUES(2026,60000,2);
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES(1269001,2026,'SYNTHETIC LINKED PERSON');
    INSERT INTO student_portal.account(id,academic_year,gradebook_student_id,auth_state,eligibility)
      VALUES('22222222-2222-4222-8222-222222222222',2026,1269001,'active','eligible');`);
  const account = (await owner.unsafe('SELECT * FROM student_portal.account'))[0]!;
  const prepare = async () => {
    await owner.unsafe(`INSERT INTO student_portal.reconciliation_credential_attempt_v1(batch_id,academic_year,expires_at)
    VALUES($1,2026,now()+interval '1 hour')`, [id]);
  await owner.unsafe(`INSERT INTO student_portal.reconciliation_credential_stage_v1(batch_id,account_id,academic_year,generation,actor_id,
    expected_scope_revision,student_uid,target_observation_id,birth_date,credential_year,expected_account_version,expected_pin_version,
    expected_birth_version,expected_birth_source,requires_kdf,expires_at)
    SELECT $1,$2,2026,generation,$3,revision,$4,gen_random_uuid(),'2012-01-01',2012,$5,$6,0,'missing',true,now()+interval '1 hour'
    FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=2026`,
  [id, account.id, actor, account.student_uid, account.version, account.pin_version]);
  };
  await prepare();
  expect(await preview()).toMatchObject({ state: 'portal-linked-accounts' });
  expect((await owner.unsafe('SELECT count(*)::integer AS count FROM student_portal.reconciliation_credential_stage_v1'))[0]!.count).toBe(1);
  expect((await owner.unsafe('SELECT * FROM student_portal.account'))[0]).toEqual(account);
  await owner.unsafe(`UPDATE student_portal.account SET gradebook_student_id=NULL,eligibility='unlinked',closed_at=now() WHERE id=$1`, [account.id]);
  const closed = (await owner.unsafe('SELECT * FROM student_portal.account'))[0]!;
  await owner.unsafe('DELETE FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=$1', [id]);
  await owner.unsafe('DELETE FROM student_portal.reconciliation_credential_attempt_v1 WHERE batch_id=$1', [id]);
  const beforeStage = await command();
  await prepare();
  expect(await service().execute(beforeStage.input)).toMatchObject({ state: 'preview-changed' });
  await owner.unsafe(`UPDATE student_portal.reconciliation_credential_stage_v1
    SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE batch_id=$1`, [id]);
  const beforeCleanup = await command();
  expect(beforeCleanup.result.counts.reconciliation).toBe(4);
  await owner.unsafe('SELECT student_portal.cleanup_reconciliation_credentials_v1(100)');
  expect(await service().execute(beforeCleanup.input)).toMatchObject({ state: 'preview-changed' });
  const confirmed = await command();
  expect(confirmed.result.counts.reconciliation).toBe(3);
  expect(await service().execute(confirmed.input)).toMatchObject({ state: 'ready', deletedRows: confirmed.result.counts.totalRows });
  expect((await owner.unsafe('SELECT * FROM student_portal.account'))[0]).toEqual(closed);
  expect((await owner.unsafe('SELECT id FROM gradebook.student_identity WHERE id=$1', [account.student_uid]))).toHaveLength(1);
});
