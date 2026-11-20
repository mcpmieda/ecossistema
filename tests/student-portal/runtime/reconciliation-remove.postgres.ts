import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyCurrentGradebookSchemaV1 } from '../../../server/gradebook/recovery/current-gradebook-schema-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { StudentReconciliationServiceV1 } from '../../../server/student-identity/reconciliation/service-v1';
import type { ReconciliationContextV1 } from '../../../shared/student-identity/reconciliation-v1';

/** "Excluir aluno lançado por engano" (20/11/2026) on the real schema, with synthetic students. */
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test'
)
  throw new Error('Removal tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const databaseName = 'portal_remove_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let owner: ReturnType<typeof postgres>, app: ReturnType<typeof postgres>;
let service: StudentReconciliationServiceV1;
const actor = '11111111-1111-4111-8111-111111111111';
const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });
const uids = new Map<number, string>();
const accountId = crypto.randomUUID();

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + databaseName);
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  owner = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await applyCurrentGradebookSchemaV1(
    { unsafe: (sql, params = []) => owner.unsafe(sql, [...params] as never[], { prepare: false }) },
    process.cwd(),
  );
  for (const file of readdirSync('migrations/student-portal')
    .filter((f) => /^\d{4}_.*\.sql$/u.test(f) && Number(f.slice(0, 4)) <= 24)
    .sort()) {
    if (file.startsWith('0019_'))
      await exec('UPDATE student_portal.publication_control_v2 SET enabled=true');
    await exec(readFileSync('migrations/student-portal/' + file, 'utf8'));
  }
  for (const file of [
    'gradebook-simplified/0015_student_reconciliation_v1.sql',
    'student-portal/0025_reconciliation_credentials_v1.sql',
    'gradebook-simplified/0018_smecel_only_source_v1.sql',
    'gradebook-simplified/0020_reconciliation_remove_student_v1.sql',
  ])
    await exec(readFileSync('migrations/' + file, 'utf8'));
  // 720001 was entered by mistake (nothing else); 720002 has a grade.
  await exec(`INSERT INTO gradebook.ano_letivo VALUES(2026,60000,2);
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES(720001,2026,'6A','SYNTHETIC CLASS 6A',6,'MATUTINO');
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES(720001,2026,'SYNTHETIC MISTAKE'),(720002,2026,'SYNTHETIC GRADED');
    INSERT INTO gradebook.vinculo(ano,turma_id,aluno_id,numero,situacao) VALUES(2026,720001,720001,33,NULL),(2026,720001,720002,1,NULL);
    INSERT INTO gradebook.disciplina(id,ano,nome) VALUES(720001,2026,'SYNTHETIC SUBJECT');
    INSERT INTO gradebook.professor(id,ano,nome) VALUES(720001,2026,'SYNTHETIC TEACHER');
    INSERT INTO gradebook.oferta(id,ano,turma_id,professor_id,disciplina_id) VALUES(720001,2026,720001,720001,720001);
    INSERT INTO gradebook.instrumento(id,oferta_id,trimestre,slot,maximo,descricao) VALUES(720001,720001,1,1,1000,'PROVA');
    INSERT INTO gradebook.nota(instrumento_id,aluno_id,valor) VALUES(720001,720002,500);`);
  for (const row of await owner.unsafe(
    'SELECT id,student_uid::text FROM gradebook.aluno WHERE id IN (720001,720002)',
  ))
    uids.set(Number(row.id), String(row.student_uid));
  // The Portal account of the mistaken student, never used: it points at the student.
  await owner.unsafe(
    `INSERT INTO student_portal.account(id,gradebook_student_id,auth_state,eligibility,student_uid)
     VALUES($1::uuid,720001,'pending-activation','eligible',$2::uuid)`,
    [accountId, uids.get(720001)!],
  );
  app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await app.unsafe('SET ROLE gradebook_app');
  service = new StudentReconciliationServiceV1(
    createGradebookPostgresDatabaseFromSqlV1(app as unknown as GradebookPostgresSqlV1),
    actor,
    'synthetic-cursor-key-only-'.repeat(3),
  );
}, 60000);
afterAll(async () => {
  await app?.end({ timeout: 2 });
  await owner?.end({ timeout: 2 });
  await cluster.unsafe('DROP DATABASE ' + databaseName);
  await cluster.end({ timeout: 2 });
});

const base = { contractVersion: 1 as const, academicYear: 2026 as const };
async function context(): Promise<ReconciliationContextV1> {
  const response = await service.execute({ ...base, operation: 'catalog' });
  if (response.state !== 'ready' || response.operation !== 'catalog')
    throw new Error('catalog missing');
  return response.context;
}
async function removable(id: number) {
  const response = await service.execute({
    ...base,
    operation: 'detail',
    studentUid: uids.get(id),
  });
  if (response.state !== 'ready' || response.operation !== 'detail') throw new Error('detail');
  return response.removable;
}
async function removal(id: number, accountId: string | null = null) {
  const current = await context();
  return {
    ...base,
    operation: 'remove-student' as const,
    generation: current.generation,
    expectedRevision: current.revision,
    idempotencyKey: crypto.randomUUID(),
    studentUid: uids.get(id)!,
    accountId,
  };
}

it('only a student out of the Relação with nothing in the system is offered for removal', async () => {
  // Still in the Relação: the line has to be deleted there first.
  expect(await removable(720001)).toBe(false);
  // What the next Relação import does once both lines are deleted (relational-import-writer.ts).
  await owner.unsafe(
    'UPDATE gradebook.vinculo SET fora_da_relacao=true WHERE aluno_id IN (720001,720002)',
  );
  expect(await removable(720001)).toBe(true);
  expect(await removable(720002)).toBe(false);
});

it('a student with a grade is never removed', async () => {
  const response = await service.execute(await removal(720002));
  expect(response).toMatchObject({
    state: 'conflict',
    reason: 'O aluno tem dados no sistema e não pode ser excluído.',
  });
  expect(await owner.unsafe('SELECT 1 FROM gradebook.aluno WHERE id=720002')).toHaveLength(1);
});

it('the account the screen showed must still be the student account', async () => {
  const response = await service.execute(await removal(720001, crypto.randomUUID()), {
    accountVersion: 0,
  });
  expect(response.state).toBe('conflict');
  expect(await owner.unsafe('SELECT 1 FROM gradebook.vinculo WHERE aluno_id=720001')).toHaveLength(
    1,
  );
});

it('removes the class place, waits for the Portal to close the account, then the student', async () => {
  const request = await removal(720001, accountId);
  // The student step never comes first.
  expect(await service.execute(request, { step: 'student' })).toMatchObject({ state: 'conflict' });
  const unlinked = await service.execute(request, { accountVersion: 0, step: 'class' });
  expect(unlinked.state).toBe('committed');
  if (unlinked.state !== 'committed') return;
  expect(await owner.unsafe('SELECT 1 FROM gradebook.vinculo WHERE aluno_id=720001')).toHaveLength(
    0,
  );
  const [decision] = await owner.unsafe(
    `SELECT action,student_uid,actor_id::text,before_state FROM gradebook.student_reconciliation_decision_v1 WHERE id=$1::uuid`,
    [unlinked.operationId],
  );
  expect(decision).toMatchObject({
    action: 'remove-student',
    student_uid: null,
    actor_id: actor,
    before_state: expect.objectContaining({
      name: 'SYNTHETIC MISTAKE',
      classLabel: '6A',
      number: 33,
      studentUid: uids.get(720001),
      accountId,
    }),
  });
  // The account still points at the student: it stays until the Portal closes the account.
  expect(await service.execute(request, { step: 'student' })).toMatchObject({ state: 'conflict' });
  expect(await owner.unsafe('SELECT 1 FROM gradebook.aluno WHERE id=720001')).toHaveLength(1);
  // What the Portal's "Encerrar conta" does to the account (account-closure-v1.ts).
  await owner.unsafe(
    `UPDATE student_portal.account SET gradebook_student_id=NULL,eligibility='unlinked',
       closed_at=now(),version=version+1 WHERE id=$1::uuid`,
    [accountId],
  );
  const removed = await service.execute(request, { step: 'student' });
  expect(removed).toMatchObject({ state: 'committed', operationId: unlinked.operationId });
  expect(await owner.unsafe('SELECT 1 FROM gradebook.aluno WHERE id=720001')).toHaveLength(0);
  // The same request again: the same answer, nothing else removed.
  expect(await service.execute(request, { accountVersion: 0, step: 'class' })).toMatchObject({
    state: 'committed',
    operationId: unlinked.operationId,
  });
  expect(await service.execute(request, { step: 'student' })).toMatchObject({
    state: 'committed',
  });
  expect(await owner.unsafe('SELECT 1 FROM gradebook.aluno WHERE id=720002')).toHaveLength(1);
});
