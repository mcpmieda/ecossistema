import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyCurrentGradebookSchemaV1 } from '../../../server/gradebook/recovery/current-gradebook-schema-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { StudentReconciliationServiceV1 } from '../../../server/student-identity/reconciliation/service-v1';
import { resolveReconciledSourceV1 } from '../../../server/student-identity/reconciliation/resolve-source-v1';
import { prepareReconciliationCredentialsV1 } from '../../../server/student-portal/birth-year/reconciliation-credentials-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import type {
  ReconciliationContextV1,
  ReconciliationResponseV1,
  ReportRowV1,
} from '../../../shared/student-identity/reconciliation-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test'
)
  throw new Error('Core tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const databaseName = 'portal1269_core_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let owner: ReturnType<typeof postgres>,
  app: ReturnType<typeof postgres>,
  portal: ReturnType<typeof postgres>;
let service: StudentReconciliationServiceV1;
const actor = '11111111-1111-4111-8111-111111111111';
const cryptography = new PortalCryptoV1(
  new Map([[1, new Uint8Array(32).fill(17)]]),
  new Map([[1, new Uint8Array(32).fill(19)]]),
);
const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });
let firstUid: string;
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
  await exec(
    readFileSync('migrations/gradebook-simplified/0015_student_reconciliation_v1.sql', 'utf8'),
  );
  await exec(
    readFileSync('migrations/student-portal/0025_reconciliation_credentials_v1.sql', 'utf8'),
  );
  await exec(`INSERT INTO gradebook.ano_letivo VALUES(2026,60000,2);
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES(710001,2026,'7A','SYNTHETIC CLASS A',7,'MATUTINO'),(710002,2026,'7B','SYNTHETIC CLASS B',7,'MATUTINO');
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES(710001,2026,'SYNTHETIC PERSON ALPHA'),(710002,2026,'SYNTHETIC PERSON BETA');
    INSERT INTO gradebook.vinculo(ano,turma_id,aluno_id,numero,situacao) VALUES(2026,710001,710001,1,NULL),(2026,710001,710002,2,NULL);`);
  firstUid = String(
    (await owner.unsafe('SELECT student_uid FROM gradebook.aluno WHERE id=710001'))[0]!.student_uid,
  );
  app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await app.unsafe('SET ROLE gradebook_app');
  url.username = 'student_portal_app';
  portal = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  service = new StudentReconciliationServiceV1(
    createGradebookPostgresDatabaseFromSqlV1(app as unknown as GradebookPostgresSqlV1),
    actor,
    'synthetic-cursor-key-only-'.repeat(3),
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
  const response = await service.execute({ ...base, operation: 'catalog' });
  expect(response.state).toBe('ready');
  if (response.state !== 'ready' || response.operation !== 'catalog')
    throw new Error('catalog missing');
  return response.context;
}
const row = (patch: Partial<ReportRowV1> = {}): ReportRowV1 => ({
  sourceRow: 2,
  name: 'SYNTHETIC PERSON ALPHA',
  birthDate: '2012-02-03',
  filiation1: 'SYNTHETIC GUARDIAN ALPHA',
  inep: '00001234',
  enrollmentHash: 'synthetic-hash-alpha',
  classLabel: '7A 2026 - MATUTINO',
  shift: 'MATUTINO',
  stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano',
  status: 'CURSANDO',
  enrolledAt: null,
  transferredAt: null,
  ...patch,
});
const mapping = [
  {
    classLabel: '7A 2026 - MATUTINO',
    shift: 'MATUTINO',
    stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano',
    gradebookClassId: 710001,
    confirmRegular: false,
  },
];
async function request(rows: ReportRowV1[]) {
  const c = await context();
  return {
    ...base,
    operation: 'prepare' as const,
    generation: c.generation,
    expectedRevision: c.revision,
    idempotencyKey: crypto.randomUUID(),
    normalizationVersion: 1,
    sourceFormat: 'smecel-report-v1',
    date1904: false,
    sourceYear: 2026,
    confirmYear: true,
    sourceGeneratedAt: null,
    rows,
    classLinks: mapping,
  };
}
type Prepared = Extract<
  ReconciliationResponseV1,
  { state: 'ready'; operation: 'prepare' | 'activate-pending' }
>;
function prepared(r: ReconciliationResponseV1): Prepared {
  expect(r.state).toBe('ready');
  if (r.state !== 'ready' || (r.operation !== 'prepare' && r.operation !== 'activate-pending'))
    throw new Error('prepare missing');
  return r;
}
async function stage(p: Prepared) {
  return prepareReconciliationCredentialsV1(
    portal as unknown as StudentPortalPostgresSqlV1,
    cryptography,
    1,
    actor,
    {
      contractVersion: 1,
      batchId: p.batchId,
      generation: p.context.generation,
      expectedScopeRevision: p.context.revision,
    },
  );
}
const applyRequest = (p: Prepared) => ({
  ...base,
  operation: 'apply',
  generation: p.context.generation,
  expectedRevision: p.context.revision,
  idempotencyKey: crypto.randomUUID(),
  batchId: p.batchId,
  confirmDifferences: true,
});
async function count(table: string) {
  return Number(
    (await owner.unsafe('SELECT count(*)::integer AS n FROM gradebook.' + table))[0]!.n,
  );
}

it('validates every eligible birth before persisting any personal row or batch, ignoring excluded modalities', async () => {
  const input = await request([
    row({ birthDate: null }),
    row({ sourceRow: 3, name: 'SYNTHETIC PERSON BETA', birthDate: '2026-02-30' }),
    row({ sourceRow: 4, classLabel: 'MULTIFUNCIONAL MATUTINO', birthDate: null }),
  ]);
  const result = await service.execute(input);
  expect(result.state).toBe('validation-failed');
  if (result.state === 'validation-failed')
    expect(result.errors.map((e) => e.sourceRow)).toEqual([2, 3]);
  expect(await count('student_report_batch_v1')).toBe(0);
  expect(await count('student_report_pending_row_v1')).toBe(0);
});
it('activates linked people and external pending without accounts in one commit and safely retries receipts', async () => {
  const input = await request([
    row(),
    row({
      sourceRow: 3,
      name: 'SYNTHETIC OUTSIDE PERSON',
      enrollmentHash: 'synthetic-outside',
      inep: '0000999',
    }),
  ]);
  const p = prepared(await service.execute(input));
  expect(p.counts).toEqual({ rows: 2, linked: 1, pending: 1 });
  expect(await count('student_source_observation_v1')).toBe(0);
  expect(await stage(p)).toMatchObject({ state: 'ready', remainingCount: 0 });
  const apply = applyRequest(p);
  const result = await service.execute(apply);
  expect(result.state).toBe('committed');
  expect((await service.execute(apply)).state).toBe('committed');
  expect((await service.execute(input)).state).toBe('committed');
  expect(await count('student_source_observation_v1')).toBe(2);
  expect(await count('student_report_profile_v1')).toBe(1);
  expect((await owner.unsafe('SELECT 1 FROM student_portal.account')).length).toBe(0);
  const list = await service.execute({ ...base, operation: 'list' });
  expect(list.state).toBe('ready');
  if (list.state === 'ready' && list.operation === 'list') {
    expect(list.items.filter((i) => i.kind === 'person')).toHaveLength(2);
    expect(list.items.find((i) => i.kind === 'person' && i.studentUid === firstUid)).toMatchObject({
      portal: 'without-portal',
      reconciliation: 'reconciled',
    });
    expect(list.items.find((i) => i.kind === 'external')).toMatchObject({
      sourceId: expect.any(String),
      name: 'SYNTHETIC OUTSIDE PERSON',
    });
  }
});
it('reordered identical content creates no extra observation or UID and accepts metadata-free content idempotency', async () => {
  const before = await count('student_source_observation_v1');
  const p = prepared(
    await service.execute(
      await request([
        row({ sourceRow: 3 }),
        row({
          sourceRow: 2,
          name: 'SYNTHETIC OUTSIDE PERSON',
          enrollmentHash: 'synthetic-outside',
          inep: '0000999',
        }),
      ]),
    ),
  );
  expect(p.differences).toEqual([]);
  await stage(p);
  expect((await service.execute(applyRequest(p))).state).toBe('committed');
  expect(await count('student_source_observation_v1')).toBe(before);
  expect(await count('aluno')).toBe(2);
});
it('rejects stale preparation and payload reuse of an idempotency key without partial activation', async () => {
  const input = await request([row()]);
  const p = prepared(await service.execute(input));
  expect(
    (await service.execute({ ...input, rows: [row({ name: 'SYNTHETIC CHANGED' })] })).state,
  ).toBe('conflict');
  const c = await context();
  expect(
    (
      await service.execute({
        ...base,
        operation: 'name-source',
        generation: c.generation,
        expectedRevision: c.revision,
        idempotencyKey: crypto.randomUUID(),
        nameSource: 'relation',
      })
    ).state,
  ).toBe('committed');
  expect((await service.execute(applyRequest(p))).state).toBe('conflict');
  expect(await count('student_report_profile_v1')).toBe(1);
});
it('rolls back source, history, profile and the final receipt when activation fails, then retries same command', async () => {
  const p = prepared(await service.execute(await request([row({ birthDate: '2012-02-04' })])));
  await stage(p);
  const before = await count('student_source_observation_v1'),
    apply = applyRequest(p);
  await exec(`CREATE FUNCTION public.synthetic_profile_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-profile-failure'; END $$;
    CREATE TRIGGER synthetic_profile_failure BEFORE INSERT OR UPDATE ON gradebook.student_report_profile_v1 FOR EACH ROW EXECUTE FUNCTION public.synthetic_profile_failure();`);
  await expect(service.execute(apply)).rejects.toThrow('synthetic-profile-failure');
  expect(await count('student_source_observation_v1')).toBe(before);
  expect(
    (
      await owner.unsafe('SELECT state FROM gradebook.student_report_batch_v1 WHERE id=$1', [
        p.batchId,
      ])
    )[0]!.state,
  ).toBe(p.batchState);
  await exec(
    'DROP TRIGGER synthetic_profile_failure ON gradebook.student_report_profile_v1;DROP FUNCTION public.synthetic_profile_failure()',
  );
  expect((await service.execute(apply)).state).toBe('committed');
});
it('binds pagination cursors to actor/query/revision and stores no forbidden report fields', async () => {
  const first = await service.execute({ ...base, operation: 'list', limit: 1 });
  expect(first.state).toBe('ready');
  if (first.state !== 'ready' || first.operation !== 'list') return;
  expect(first.nextCursor).toBeTruthy();
  expect(
    (
      await service.execute({
        ...base,
        operation: 'list',
        limit: 1,
        cursor: first.nextCursor,
        search: 'different',
      })
    ).state,
  ).toBe('conflict');
  const input = await request([row()]);
  expect(
    (await service.execute({ ...input, rows: [{ ...row(), cpf: 'synthetic-forbidden' }] })).state,
  ).toBe('invalid-request');
});

async function mutate(command: Record<string, unknown>) {
  const c = await context();
  return service.execute({
    ...base,
    ...command,
    generation: c.generation,
    expectedRevision: c.revision,
    idempotencyKey: crypto.randomUUID(),
  });
}
it('records manual separation durably, recognizes changed hashes, requires explicit release and does not restore later corrections', async () => {
  const [external] = await owner.unsafe(
    `SELECT r.id FROM gradebook.student_source_record_v1 r JOIN gradebook.student_source_observation_v1 o ON o.id=r.current_observation_id WHERE o.name='SYNTHETIC OUTSIDE PERSON'`,
  );
  const beta = String(
    (await owner.unsafe('SELECT student_uid FROM gradebook.aluno WHERE id=710002'))[0]!.student_uid,
  );
  const p = prepared(
    await mutate({
      operation: 'resolve',
      action: 'associate',
      sourceId: external!.id,
      studentUid: beta,
      expectedLinkVersion: 0,
      revertsDecisionId: null,
    }),
  );
  await stage(p);
  expect((await service.execute(applyRequest(p))).state).toBe('committed');
  const [link] = await owner.unsafe(
    'SELECT version,decision_id FROM gradebook.student_source_link_v1 WHERE source_id=$1',
    [external!.id],
  );
  expect(
    (
      await mutate({
        operation: 'resolve',
        action: 'separate',
        sourceId: external!.id,
        studentUid: beta,
        expectedLinkVersion: Number(link!.version),
        revertsDecisionId: link!.decision_id,
      })
    ).state,
  ).toBe('committed');
  const changed = prepared(
    await service.execute(
      await request([
        row({ birthDate: '2012-02-04' }),
        row({
          sourceRow: 3,
          name: 'SYNTHETIC OUTSIDE PERSON',
          enrollmentHash: 'synthetic-changed-hash',
          inep: '0000999',
        }),
      ]),
    ),
  );
  await stage(changed);
  expect((await service.execute(applyRequest(changed))).state).toBe('committed');
  expect(
    (
      await owner.unsafe('SELECT 1 FROM gradebook.student_source_link_v1 WHERE source_id=$1', [
        external!.id,
      ])
    ).length,
  ).toBe(0);
  expect(
    (
      await mutate({
        operation: 'resolve',
        action: 'associate',
        sourceId: external!.id,
        studentUid: beta,
        expectedLinkVersion: 0,
        revertsDecisionId: null,
      })
    ).state,
  ).toBe('conflict');
  expect(
    (
      await mutate({
        operation: 'resolve',
        action: 'release',
        sourceId: external!.id,
        studentUid: beta,
        expectedLinkVersion: 0,
        revertsDecisionId: null,
      })
    ).state,
  ).toBe('committed');
  const relink = prepared(
    await mutate({
      operation: 'resolve',
      action: 'associate',
      sourceId: external!.id,
      studentUid: beta,
      expectedLinkVersion: 0,
      revertsDecisionId: null,
    }),
  );
  await stage(relink);
  expect((await service.execute(applyRequest(relink))).state).toBe('committed');
  const [alpha] = await owner.unsafe(
    'SELECT source_id,version,decision_id FROM gradebook.student_source_link_v1 WHERE student_uid=$1',
    [firstUid],
  );
  expect(
    (
      await mutate({
        operation: 'resolve',
        action: 'separate',
        sourceId: alpha!.source_id,
        studentUid: firstUid,
        expectedLinkVersion: Number(alpha!.version),
        revertsDecisionId: alpha!.decision_id,
      })
    ).state,
  ).toBe('conflict');
  expect(
    (
      await owner.unsafe('SELECT 1 FROM gradebook.student_source_link_v1 WHERE student_uid=$1', [
        firstUid,
      ])
    ).length,
  ).toBe(1);
});
it('resolves historical source evidence only to one central UID and marks affected class links for explicit review', async () => {
  const db = createGradebookPostgresDatabaseFromSqlV1(app as unknown as GradebookPostgresSqlV1);
  const evidence = {
    academicYear: 2026 as const,
    sourceSnapshotRef: 'synthetic-snapshot',
    sourceRecordRef: 'synthetic-record',
    name: 'SYNTHETIC PERSON ALPHA',
    classLabel: '7A 2026 - MATUTINO',
  };
  const resolved = await db.transaction((tx) =>
    resolveReconciledSourceV1(tx, {
      ...evidence,
      name: 'synthetic person alpha',
      classLabel: '7a 2026 - matutino',
    }),
  );
  expect(resolved).toMatchObject({ state: 'resolved', studentUid: firstUid });
  const [reportClass] = await owner.unsafe(
    'SELECT id FROM gradebook.student_report_class_v1 LIMIT 1',
  );
  expect(
    (
      await mutate({
        operation: 'class-link',
        reportClassId: reportClass!.id,
        gradebookClassId: 710002,
      })
    ).state,
  ).toBe('committed');
  const list = await service.execute({ ...base, operation: 'list' });
  if (list.state !== 'ready' || list.operation !== 'list') throw new Error('list missing');
  expect(list.items.find((i) => i.kind === 'person' && i.studentUid === firstUid)).toMatchObject({
    reconciliation: 'review-required',
  });
  expect((await db.transaction((tx) => resolveReconciledSourceV1(tx, evidence))).state).toBe(
    'ambiguous',
  );
  const [link] = await owner.unsafe(
    'SELECT source_id,version FROM gradebook.student_source_link_v1 WHERE student_uid=$1',
    [firstUid],
  );
  expect(
    (
      await mutate({
        operation: 'resolve',
        action: 'confirm',
        sourceId: link!.source_id,
        studentUid: firstUid,
        expectedLinkVersion: Number(link!.version),
        revertsDecisionId: null,
      })
    ).state,
  ).toBe('committed');
  expect((await db.transaction((tx) => resolveReconciledSourceV1(tx, evidence))).state).toBe(
    'resolved',
  );
});

it('uses bounded SQL for a synthetic school-size batch and the normalized lookup index', async () => {
  const size = 512;
  await exec(`INSERT INTO gradebook.aluno(id,ano,nome) SELECT 720000+n,2026,'SYNTHETIC LOAD PERSON '||n FROM generate_series(1,${size}) n;
    INSERT INTO gradebook.vinculo(ano,turma_id,aluno_id,numero,situacao) SELECT 2026,710001,720000+n,100+n,NULL FROM generate_series(1,${size}) n;`);
  const db = createGradebookPostgresDatabaseFromSqlV1(app as unknown as GradebookPostgresSqlV1);
  let statements = 0;
  const measured = new StudentReconciliationServiceV1(
    {
      ...db,
      transaction: (operation) =>
        db.transaction((tx) =>
          operation(
            new Proxy(tx, {
              get(target, key) {
                const member = Reflect.get(target, key);
                return typeof member === 'function'
                  ? (...args: unknown[]) => {
                      statements++;
                      return Reflect.apply(member, target, args);
                    }
                  : member;
              },
            }),
          ),
        ),
    },
    actor,
    'synthetic-cursor-key-only-'.repeat(3),
  );
  const input = await request(
    Array.from({ length: size }, (_, n) =>
      row({
        sourceRow: n + 2,
        name: `SYNTHETIC LOAD PERSON ${n + 1}`,
        enrollmentHash: `synthetic-load-${n + 1}`,
        inep: String(9000000 + n),
        filiation1: null,
        classLabel: '7C 2026 - MATUTINO',
      }),
    ),
  );
  input.classLinks = [{ ...mapping[0]!, classLabel: '7C 2026 - MATUTINO' }];
  const p = prepared(await measured.execute(input));
  expect(p.counts.linked).toBe(size);
  await stage(p);
  expect((await measured.execute(applyRequest(p))).state).toBe('committed');
  expect(statements).toBeLessThan(70);
  await exec('ANALYZE gradebook.student_source_observation_v1');
  const explain = await owner.unsafe(
    `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM gradebook.student_source_observation_v1 WHERE academic_year=2026 AND name_key='SYNTHETIC LOAD PERSON 257'`,
  );
  const plan = JSON.stringify(explain[0]!['QUERY PLAN']);
  expect(plan).toMatch(/Index (?:Only )?Scan|Bitmap Index Scan/u);
});

it('requires an explicit whole observation for conflicting N-to-one profiles and retains an unchanged choice', async () => {
  await exec(`INSERT INTO gradebook.aluno(id,ano,nome) VALUES(730001,2026,'SYNTHETIC MULTI ORIGIN PERSON');
    INSERT INTO gradebook.vinculo(ano,turma_id,aluno_id,numero,situacao) VALUES(2026,710001,730001,900,NULL);`);
  const [student] = await owner.unsafe('SELECT student_uid FROM gradebook.aluno WHERE id=730001');
  const uid = String(student!.student_uid);
  const original = [
    row({
      name: 'SYNTHETIC MULTI ORIGIN PERSON',
      enrollmentHash: 'synthetic-multi-a',
      classLabel: '7D 2026 - MATUTINO',
      inep: '7000001',
      filiation1: 'SYNTHETIC GUARDIAN MULTI',
    }),
    row({
      sourceRow: 3,
      name: 'SYNTHETIC MULTI ORIGIN PERSON',
      enrollmentHash: 'synthetic-multi-b',
      classLabel: '7D 2026 - MATUTINO',
      inep: '7000001',
      filiation1: 'SYNTHETIC GUARDIAN MULTI',
    }),
  ];
  async function importRows(rows: ReportRowV1[]) {
    const input = await request(rows);
    input.classLinks = [{ ...mapping[0]!, classLabel: '7D 2026 - MATUTINO' }];
    const p = prepared(await service.execute(input));
    await stage(p);
    expect((await service.execute(applyRequest(p))).state).toBe('committed');
  }
  await importRows(original);
  const [before] = await owner.unsafe(
    'SELECT observation_id FROM gradebook.student_report_profile_v1 WHERE student_uid=$1',
    [uid],
  );
  const changed = [original[0]!, { ...original[1]!, inep: '7000002', filiation1: null }];
  await importRows(changed);
  const list = await service.execute({
    ...base,
    operation: 'list',
    search: 'SYNTHETIC MULTI ORIGIN PERSON',
  });
  if (list.state !== 'ready' || list.operation !== 'list') throw new Error('list missing');
  expect(list.items.find((item) => item.kind === 'person')).toMatchObject({
    reconciliation: 'review-required',
  });
  const [pending] = await owner.unsafe(
    'SELECT observation_id,review_required FROM gradebook.student_report_profile_v1 WHERE student_uid=$1',
    [uid],
  );
  expect(pending).toMatchObject({ observation_id: before!.observation_id, review_required: true });
  const detail = await service.execute({ ...base, operation: 'detail', studentUid: uid });
  if (detail.state !== 'ready' || detail.operation !== 'detail') throw new Error('detail missing');
  const target = detail.sources.find((source) => source.inep === '7000002')!;
  const p = prepared(
    await mutate({
      operation: 'select-observation',
      studentUid: uid,
      observationId: target.observationId,
    }),
  );
  await stage(p);
  expect((await service.execute(applyRequest(p))).state).toBe('committed');
  await importRows([...changed].reverse());
  const [selected] = await owner.unsafe(
    `SELECT p.observation_id,p.review_required,o.inep,o.filiation1 FROM gradebook.student_report_profile_v1 p
    JOIN gradebook.student_source_observation_v1 o ON o.id=p.observation_id WHERE p.student_uid=$1`,
    [uid],
  );
  expect(selected).toMatchObject({
    observation_id: target.observationId,
    review_required: false,
    inep: '7000002',
    filiation1: null,
  });
});
