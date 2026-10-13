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
  ReconciliationContextV1, ReconciliationResponseV1, ReportRowV1,
} from '../../../shared/student-identity/reconciliation-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' || target.pathname !== '/portal705_test')
  throw new Error('Homonym regression tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const databaseName = 'portal1277_homonyms_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let owner: ReturnType<typeof postgres>, app: ReturnType<typeof postgres>, portal: ReturnType<typeof postgres>;
let service: StudentReconciliationServiceV1;
const actor = '11111111-1111-4111-8111-111111111111';
const cryptography = new PortalCryptoV1(
  new Map([[1, new Uint8Array(32).fill(17)]]),
  new Map([[1, new Uint8Array(32).fill(19)]]),
);
const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });
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
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 24).sort()) {
    if (file.startsWith('0019_')) await exec('UPDATE student_portal.publication_control_v2 SET enabled=true');
    await exec(readFileSync('migrations/student-portal/' + file, 'utf8'));
  }
  await exec(readFileSync('migrations/gradebook-simplified/0015_student_reconciliation_v1.sql', 'utf8'));
  await exec(readFileSync('migrations/student-portal/0025_reconciliation_credentials_v1.sql', 'utf8'));
  await exec(`INSERT INTO gradebook.ano_letivo VALUES(2026,60000,2);
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno)
    VALUES(710901,2026,'7H','SYNTHETIC HOMONYM CLASS',7,'MATUTINO');`);
  app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await app.unsafe('SET ROLE gradebook_app');
  url.username = 'student_portal_app';
  portal = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  service = new StudentReconciliationServiceV1(
    createGradebookPostgresDatabaseFromSqlV1(app as unknown as GradebookPostgresSqlV1),
    actor, 'synthetic-cursor-key-only-'.repeat(3),
  );
}, 60000);
afterAll(async () => {
  await app?.end({ timeout: 2 });
  await portal?.end({ timeout: 2 });
  await owner?.end({ timeout: 2 });
  await cluster.unsafe('DROP DATABASE ' + databaseName);
  await cluster.end({ timeout: 2 });
});
const base = { contractVersion: 1 as const, academicYear: 2026 as const };
async function context(): Promise<ReconciliationContextV1> {
  const result = await service.execute({ ...base, operation: 'catalog' });
  if (result.state !== 'ready' || result.operation !== 'catalog') throw new Error('catalog missing');
  return result.context;
}
type Prepared = Extract<ReconciliationResponseV1, { state: 'ready'; operation: 'prepare' | 'activate-pending' }>;
async function prepare(rows: ReportRowV1[], reverse: boolean): Promise<Prepared> {
  const c = await context();
  const result = await service.execute({
    ...base, operation: 'prepare', generation: c.generation, expectedRevision: c.revision,
    idempotencyKey: crypto.randomUUID(), normalizationVersion: 1, sourceFormat: 'smecel-report-v1',
    date1904: false, sourceYear: 2026, confirmYear: true,
    sourceGeneratedAt: new Date(Date.now() - 60000).toISOString(),
    rows: reverse ? [...rows].reverse() : rows,
    classLinks: [{ classLabel: '7H 2026 - MATUTINO', shift: 'MATUTINO',
      stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano', gradebookClassId: 710901, confirmRegular: false }],
  });
  expect(result.state).toBe('ready');
  if (result.state !== 'ready' || result.operation !== 'prepare') throw new Error('prepare missing');
  return result;
}
async function apply(p: Prepared) {
  expect(await prepareReconciliationCredentialsV1(
    portal as unknown as StudentPortalPostgresSqlV1, cryptography, 1, actor,
    { contractVersion: 1, batchId: p.batchId, generation: p.context.generation, expectedScopeRevision: p.context.revision },
  )).toMatchObject({ state: 'ready', remainingCount: 0 });
  expect((await service.execute({
    ...base, operation: 'apply', generation: p.context.generation, expectedRevision: p.context.revision,
    idempotencyKey: crypto.randomUUID(), batchId: p.batchId, confirmDifferences: true,
  })).state).toBe('committed');
}
const cases = [
  { kind: 'swapped', reverse: false, difference: 'both' },
  { kind: 'swapped', reverse: true, difference: 'both' },
  { kind: 'reused', reverse: false, difference: 'both' },
  { kind: 'reused', reverse: true, difference: 'both' },
  { kind: 'historical', reverse: false, difference: 'both' },
  { kind: 'historical', reverse: true, difference: 'both' },
  { kind: 'swapped', reverse: false, difference: 'inep' },
  { kind: 'swapped', reverse: true, difference: 'filiation' },
  { kind: 'reused', reverse: false, difference: 'empty' },
].map((scenario, index) => ({ ...scenario, studentId: 770100 + index, number: 100 + index }));

it.each(cases)('preserves both origins, profile and access for $kind/$difference hashes, reverse $reverse', async (scenario) => {
  const prefix = `SYNTHETIC HOMONYM ${scenario.studentId}`;
  const accountId = crypto.randomUUID();
  await owner.unsafe('INSERT INTO gradebook.aluno(id,ano,nome) VALUES($1,2026,$2)', [scenario.studentId, prefix]);
  await owner.unsafe('INSERT INTO gradebook.vinculo(ano,turma_id,aluno_id,numero,situacao) VALUES(2026,710901,$1,$2,NULL)', [scenario.studentId, scenario.number]);
  await owner.unsafe(`INSERT INTO student_portal.account(id,academic_year,gradebook_student_id,auth_state,eligibility)
    VALUES($1,2026,$2,'pending-activation','eligible')`, [accountId, scenario.studentId]);
  await owner.unsafe(`INSERT INTO student_portal.account_access_data(account_id,birth_year,confirmation)
    VALUES($1,2011,'confirmed')`, [accountId]);
  await owner.unsafe('INSERT INTO student_portal.password_credential(account_id,pin_verifier) VALUES($1,$2::text::jsonb)',
    [accountId, JSON.stringify(await cryptography.deriveVerifier('2011', 1))]);
  const [account] = await owner.unsafe('SELECT student_uid FROM student_portal.account WHERE id=$1', [accountId]);
  const uid = String(account!.student_uid);
  const a: ReportRowV1 = {
    sourceRow: 2, name: prefix, birthDate: '2011-03-04', filiation1: `${prefix} GUARDIAN A`,
    inep: `${scenario.studentId}1`, enrollmentHash: `${prefix}-a`, classLabel: '7H 2026 - MATUTINO',
    shift: 'MATUTINO', stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano', status: 'CURSANDO',
    enrolledAt: null, transferredAt: null,
  };
  let b: ReportRowV1 = {
    ...a, sourceRow: 3, name: `${prefix} OUTSIDE`, enrollmentHash: `${prefix}-b`,
    inep: scenario.difference === 'filiation' ? a.inep : `${scenario.studentId}2`,
    filiation1: scenario.difference === 'inep' ? a.filiation1 : `${prefix} GUARDIAN B`,
  };
  const first = await prepare([a, b], scenario.reverse);
  expect(first.counts).toEqual({ rows: 2, linked: 1, pending: 1 });
  await apply(first);
  const [rejected] = await owner.unsafe(`SELECT r.id FROM gradebook.student_source_record_v1 r
    JOIN gradebook.student_source_observation_v1 o ON o.id=r.current_observation_id WHERE o.enrollment_hash=$1`, [b.enrollmentHash]);
  const c = await context();
  expect((await service.execute({
    ...base, operation: 'resolve', action: 'reject', generation: c.generation, expectedRevision: c.revision,
    idempotencyKey: crypto.randomUUID(), sourceId: rejected!.id, studentUid: uid, expectedLinkVersion: 0, revertsDecisionId: null,
  })).state).toBe('committed');
  // Establish the reported homonym through the real pending-source path, not a fabricated link.
  b = { ...b, name: prefix };
  const homonyms = await prepare([a, b], scenario.reverse);
  expect(homonyms.counts).toEqual({ rows: 2, linked: 1, pending: 1 });
  await apply(homonyms);
  if (scenario.kind === 'historical') {
    await apply(await prepare([
      { ...a, enrollmentHash: `${prefix}-current-a` },
      { ...b, name: `${prefix} RENAMED OUTSIDE` },
    ], scenario.reverse));
  }
  const snapshot = () => owner.unsafe(`SELECT to_jsonb(p) AS profile,to_jsonb(a) AS account,
    to_jsonb(c) AS credential,to_jsonb(d) AS access_data,to_jsonb(l) AS link,
    to_jsonb(r) AS source,to_jsonb(o) AS observation,to_jsonb(v) AS enrollment
    FROM student_portal.account a
    JOIN student_portal.password_credential c ON c.account_id=a.id
    JOIN student_portal.account_access_data d ON d.account_id=a.id
    JOIN gradebook.student_report_profile_v1 p ON p.student_uid=a.student_uid
    JOIN gradebook.student_source_link_v1 l ON l.source_id=p.source_id
    JOIN gradebook.student_source_record_v1 r ON r.id=p.source_id
    JOIN gradebook.student_source_observation_v1 o ON o.id=r.current_observation_id
    JOIN gradebook.vinculo v ON v.aluno_id=a.gradebook_student_id WHERE a.id=$1`, [accountId]);
  const rejectedSnapshot = () => owner.unsafe(`SELECT to_jsonb(r) AS source,to_jsonb(o) AS observation,to_jsonb(d) AS decision
    FROM gradebook.student_source_record_v1 r
    JOIN gradebook.student_source_observation_v1 o ON o.id=r.current_observation_id
    JOIN gradebook.student_reconciliation_decision_v1 d ON d.source_id=r.id AND d.action='reject'
    WHERE r.id=$1`, [rejected!.id]);
  const before = await snapshot();
  const rejectedBefore = await rejectedSnapshot();
  expect(before).toHaveLength(1);
  expect(rejectedBefore).toHaveLength(1);
  const changed = [
    { ...a, enrollmentHash: scenario.kind === 'swapped' ? b.enrollmentHash : `${prefix}-new-a` },
    { ...b, enrollmentHash: a.enrollmentHash,
      ...(scenario.difference === 'empty' ? { inep: null, filiation1: null } : {}) },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await prepare(changed, scenario.reverse);
    expect(p.counts).toEqual({ rows: 2, linked: 0, pending: 2 });
    const pending = await owner.unsafe(`SELECT target_source_id,target_uid,pending_reason,selected_profile
      FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1 ORDER BY source_row`, [p.batchId]);
    expect(pending).toHaveLength(2);
    expect(pending[1]).toMatchObject({ target_uid: null, pending_reason: 'rejected', selected_profile: false });
    expect(pending.every((entry) => entry.target_source_id !== rejected!.id)).toBe(true);
    await apply(p);
    expect(await snapshot()).toEqual(before);
    expect(await rejectedSnapshot()).toEqual(rejectedBefore);
    expect(await owner.unsafe(`SELECT 1 FROM gradebook.student_source_link_v1 WHERE source_id=$1`, [rejected!.id])).toHaveLength(0);
  }
});
