import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyCurrentGradebookSchemaV1 } from '../../../server/gradebook/recovery/current-gradebook-schema-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import { prepareReconciliationCredentialsV1 } from '../../../server/student-portal/birth-year/reconciliation-credentials-v1';
import { QrServiceV1 } from '../../../server/student-portal/auth/qr-service-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test'
) {
  throw new Error('Reconciliation tests require disposable local PostgreSQL');
}
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const databaseName =
  'portal1269_credentials_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let owner: ReturnType<typeof postgres>;
let portal: ReturnType<typeof postgres>;
let peer: ReturnType<typeof postgres>;
const actor = '11111111-1111-4111-8111-111111111111';
const generation = crypto.randomUUID();
const cryptography = new PortalCryptoV1(
  new Map([[1, new Uint8Array(32).fill(17)]]),
  new Map([[1, new Uint8Array(32).fill(19)]]),
);
let nextStudent = 700000;
const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });
const runtime = () => portal as unknown as StudentPortalPostgresSqlV1;
type Student = { id: number; uid: string; accountId: string | null };
type Batch = { id: string; students: Student[]; classId: string };

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + databaseName);
  const url = new URL(target);
  url.pathname = '/' + databaseName;
  owner = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  peer = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await applyCurrentGradebookSchemaV1(
    {
      unsafe: (text, parameters = []) =>
        owner.unsafe(text, [...parameters] as never[], { prepare: false }),
    },
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
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES(700000,2026,'SYN','SYNTHETIC CLASS',7,'MATUTINO');`);
  await owner.unsafe(
    'INSERT INTO gradebook.student_reconciliation_scope_v1(academic_year,generation) VALUES(2026,$1)',
    [generation],
  );
  url.username = 'student_portal_app';
  portal = postgres(url.toString(), { max: 1, onnotice: () => undefined });
}, 60_000);
afterAll(async () => {
  await portal?.end({ timeout: 2 });
  await peer?.end({ timeout: 2 });
  await owner?.end({ timeout: 2 });
  await cluster.unsafe('DROP DATABASE ' + databaseName);
  await cluster.end({ timeout: 2 });
});

async function students(count: number, withAccount = true): Promise<Student[]> {
  const result: Student[] = [];
  for (let index = 0; index < count; index++) {
    const id = ++nextStudent;
    const [row] = await owner.unsafe(
      'INSERT INTO gradebook.aluno(id,ano,nome) VALUES($1,2026,$2) RETURNING student_uid',
      [id, 'SYNTHETIC PERSON ' + id],
    );
    let accountId: string | null = null;
    if (withAccount) {
      accountId = crypto.randomUUID();
      await owner.unsafe(
        `INSERT INTO student_portal.account(id,academic_year,gradebook_student_id,auth_state,eligibility)
        VALUES($1,2026,$2,'active','eligible')`,
        [accountId, id],
      );
      const verifier = await cryptography.deriveVerifier('2012', 1);
      await owner.unsafe(
        `INSERT INTO student_portal.account_access_data(account_id,birth_year,confirmation) VALUES($1,2012,'confirmed');`,
        [accountId],
      );
      await owner.unsafe(
        `INSERT INTO student_portal.password_credential(account_id,pin_verifier,password_verifier)
        VALUES($1,$2::text::jsonb,$2::text::jsonb)`,
        [accountId, JSON.stringify(verifier)],
      );
      await owner.unsafe(
        `INSERT INTO student_portal.qr_credential(credential_id,account_id,key_version,state)
        VALUES($1,$2,1,'active')`,
        ['q' + crypto.randomUUID().replaceAll('-', ''), accountId],
      );
      await owner.unsafe(
        `INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent)
        VALUES($1,$2,$3,0,now()+interval '1 day',false)`,
        [crypto.randomUUID(), accountId, crypto.randomUUID()],
      );
    }
    result.push({ id, uid: String(row!.student_uid), accountId });
  }
  return result;
}
async function batch(people: Student[], birth = '2013-02-03'): Promise<Batch> {
  const id = crypto.randomUUID(),
    classId = crypto.randomUUID();
  const [revision] = await owner.unsafe(
    'SELECT student_portal.reconciliation_revision_v1(2026::smallint) AS revision',
  );
  await owner.unsafe(
    `INSERT INTO gradebook.student_report_batch_v1(id,academic_year,generation,actor_id,source_evidence,normalization_version,
    digest,request_digest,idempotency_key,base_revision,base_academic_revision,state,expires_at,class_links)
    VALUES($1,2026,$2,$3,'unknown',1,$4,$4,$5,0,$6,'preparing',now()+interval '24 hours','[]')`,
    [id, generation, actor, 'a'.repeat(64), crypto.randomUUID(), revision!.revision],
  );
  await owner.unsafe(
    `INSERT INTO gradebook.student_report_class_v1(id,academic_year,label,class_key,shift,shift_key,stage_label,stage,gradebook_class_id)
    VALUES($1::uuid,2026,'SYNTHETIC CLASS',($1::uuid)::text,'MATUTINO','MATUTINO','7',7,700000)`,
    [classId],
  );
  for (const [index, person] of people.entries())
    await owner.unsafe(
      `INSERT INTO gradebook.student_report_pending_row_v1(batch_id,source_row,academic_year,
    name,name_key,birth_date,enrollment_hash,class_label,class_key,stage_label,stage,shift,shift_key,status,status_key,
    gradebook_class_id,target_uid,target_source_id,target_observation_id,selected_profile)
    VALUES($1,$2,2026,$3,$3,$4::date,$5,'SYNTHETIC CLASS',$6,'7',7,'MATUTINO','MATUTINO','ATIVO','ATIVO',700000,$7,$8,$9,true)`,
      [
        id,
        index + 2,
        'SYNTHETIC PERSON ' + person.id,
        birth,
        'synthetic-' + person.id,
        classId,
        person.uid,
        crypto.randomUUID(),
        crypto.randomUUID(),
      ],
    );
  return { id, students: people, classId };
}
function prepare(b: Batch) {
  return prepareReconciliationCredentialsV1(runtime(), cryptography, 1, actor, {
    contractVersion: 1,
    batchId: b.id,
    generation,
    expectedScopeRevision: 0,
  });
}
async function materialize(tx: postgres.TransactionSql, b: Batch) {
  const rows = await tx.unsafe(
    'SELECT *,birth_date::text AS birth_date FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1 ORDER BY source_row',
    [b.id],
  );
  for (const r of rows) {
    await tx.unsafe(
      `INSERT INTO gradebook.student_source_record_v1(id,academic_year,last_batch_id) VALUES($1,2026,$2)`,
      [r.target_source_id, b.id],
    );
    await tx.unsafe(
      `INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,version,batch_id,report_class_id,name,name_key,
      birth_date,enrollment_hash,shift,shift_key,status,status_key) VALUES($1,2026,$2,1,$3,$4,$5,$5,$6,$7,'MATUTINO','MATUTINO','ATIVO','ATIVO')`,
      [
        r.target_observation_id,
        r.target_source_id,
        b.id,
        b.classId,
        r.name,
        r.birth_date,
        r.enrollment_hash,
      ],
    );
    const decision = crypto.randomUUID();
    await tx.unsafe(
      `INSERT INTO gradebook.student_reconciliation_decision_v1(id,academic_year,generation,sequence,actor_id,action,
      source_id,student_uid,observation_id,reason) VALUES($1,2026,$2,1,$3,'associate',$4,$5,$6,'synthetic')`,
      [decision, generation, actor, r.target_source_id, r.target_uid, r.target_observation_id],
    );
    await tx.unsafe(
      `INSERT INTO gradebook.student_source_link_v1(academic_year,source_id,student_uid,version,decision_id) VALUES(2026,$1,$2,1,$3)`,
      [r.target_source_id, r.target_uid, decision],
    );
    await tx.unsafe(
      `INSERT INTO gradebook.student_report_profile_v1(academic_year,student_uid,source_id,observation_id,version)
      VALUES(2026,$1,$2,$3,1) ON CONFLICT(academic_year,student_uid) DO UPDATE SET source_id=EXCLUDED.source_id,
      observation_id=EXCLUDED.observation_id,version=student_report_profile_v1.version+1`,
      [r.target_uid, r.target_source_id, r.target_observation_id],
    );
  }
}
async function apply(b: Batch) {
  return owner.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE gradebook_app');
    await materialize(tx, b);
    try {
      return await tx.unsafe(
        'SELECT student_portal.apply_reconciliation_credentials_v1($1,$2) AS applied',
        [b.id, actor],
      );
    } catch (error) {
      const detail = error as { message?: string; where?: string };
      throw new Error((detail.message ?? 'synthetic SQL failure') + ' ' + (detail.where ?? ''), {
        cause: error,
      });
    }
  });
}
async function snapshot(people: Student[]) {
  const ids = people.map((p) => p.accountId).filter(Boolean);
  return owner.unsafe(
    `SELECT a.id,a.version,a.pin_version,a.security_version,p.pin_verifier,p.password_verifier,
    (SELECT credential_id FROM student_portal.qr_credential q WHERE q.account_id=a.id AND q.state='active') AS qr,
    (SELECT revoked_at FROM student_portal.session s WHERE s.account_id=a.id LIMIT 1) AS revoked,
    (SELECT birth_year FROM student_portal.account_birth_v1 d WHERE d.account_id=a.id) AS birth
    FROM student_portal.account a LEFT JOIN student_portal.password_credential p ON p.account_id=a.id
    WHERE a.id IN(SELECT value::uuid FROM jsonb_array_elements_text($1::text::jsonb)) ORDER BY a.id`,
    [JSON.stringify(ids)],
  );
}

it('prepares at most four sequential KDFs without changing any account and resumes before one activation', async () => {
  const people = await students(5),
    b = await batch(people),
    before = await snapshot(people);
  expect(await prepare(b)).toEqual({ state: 'preparing', preparedCount: 4, remainingCount: 1 });
  expect(await snapshot(people)).toEqual(before);
  expect(await prepare(b)).toEqual({ state: 'ready', preparedCount: 5, remainingCount: 0 });
  expect(await prepare(b)).toEqual({ state: 'ready', preparedCount: 5, remainingCount: 0 });
  await apply(b);
  const after = await snapshot(people);
  for (const [index, row] of after.entries()) {
    expect(await cryptography.verifySecret('2013', row.pin_verifier)).toBe(true);
    expect(await cryptography.verifySecret('2012', row.pin_verifier)).toBe(false);
    expect(row.password_verifier).toEqual(before[index]!.password_verifier);
    expect(row.qr).toBe(before[index]!.qr);
    expect(row.revoked).toBeNull();
    expect(row.security_version).toBe(before[index]!.security_version);
    expect(row.birth).toBe(2013);
  }
  expect(
    (
      await owner.unsafe(
        'SELECT 1 FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=$1',
        [b.id],
      )
    ).length,
  ).toBe(0);
}, 30_000);

it('rolls back every profile, birth and PIN when the last credential fails, then safely retries', async () => {
  const people = await students(2),
    b = await batch(people),
    before = await snapshot(people);
  await prepare(b);
  const last = people
    .map((p) => p.accountId!)
    .sort()
    .at(-1)!;
  await exec(`CREATE FUNCTION public.synthetic_pin_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.account_id='${last}'::uuid THEN RAISE EXCEPTION 'synthetic-final-pin-failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_pin_failure BEFORE INSERT OR UPDATE ON student_portal.password_credential FOR EACH ROW EXECUTE FUNCTION public.synthetic_pin_failure();`);
  await expect(apply(b)).rejects.toThrow('synthetic-final-pin-failure');
  expect(await snapshot(people)).toEqual(before);
  expect(
    (
      await owner.unsafe(
        'SELECT 1 FROM gradebook.student_source_observation_v1 WHERE batch_id=$1',
        [b.id],
      )
    ).length,
  ).toBe(0);
  await exec(
    'DROP TRIGGER synthetic_pin_failure ON student_portal.password_credential; DROP FUNCTION public.synthetic_pin_failure()',
  );
  await apply(b);
  expect((await snapshot(people)).every((row) => row.birth === 2013)).toBe(true);
});

it('keeps the PIN verifier/version on same-year canonical adoption and day/month correction; no account is created', async () => {
  const people = await students(1),
    first = await batch(people, '2012-02-03'),
    before = await snapshot(people);
  expect(await prepare(first)).toEqual({ state: 'ready', preparedCount: 1, remainingCount: 0 });
  await apply(first);
  const correction = await batch(people, '2012-03-04');
  await prepare(correction);
  await apply(correction);
  expect(await snapshot(people)).toEqual(before);
  expect(
    (
      await owner.unsafe('SELECT 1 FROM student_portal.account_access_data WHERE account_id=$1', [
        people[0]!.accountId,
      ])
    ).length,
  ).toBe(1);
  const absent = await students(1, false),
    withoutAccount = await batch(absent);
  await prepare(withoutAccount);
  await apply(withoutAccount);
  expect(
    (
      await owner.unsafe('SELECT 1 FROM student_portal.account WHERE student_uid=$1', [
        absent[0]!.uid,
      ])
    ).length,
  ).toBe(0);
});

it('rejects account CAS changes and expired staging without partial activation or lifetime renewal', async () => {
  const people = await students(1),
    b = await batch(people);
  await prepare(b);
  await owner.unsafe('UPDATE student_portal.account SET version=version+1 WHERE id=$1', [
    people[0]!.accountId,
  ]);
  await expect(apply(b)).rejects.toThrow('student-reconciliation-credential-conflict');
  const expired = await batch(await students(1));
  await prepare(expired);
  await owner.unsafe(
    `UPDATE student_portal.reconciliation_credential_attempt_v1 SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE batch_id=$1`,
    [expired.id],
  );
  expect((await prepare(expired)).state).toBe('expired');
  await expect(apply(expired)).rejects.toThrow('student-reconciliation-credential-expired');
});

it('denies public/direct runtime credential access and keeps only narrow metadata functions', async () => {
  for (const role of ['anon', 'authenticated', 'gradebook_app', 'student_portal_app']) {
    await expect(
      peer.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE ' + role);
        return tx.unsafe('SELECT * FROM student_portal.reconciliation_credential_stage_v1');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  }
  await expect(
    portal.unsafe('SELECT student_portal.apply_reconciliation_credentials_v1($1,$2)', [
      crypto.randomUUID(),
      actor,
    ]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    portal.unsafe(`UPDATE student_portal.account_access_data SET birth_year=2001`),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(portal.unsafe('SELECT nome FROM gradebook.aluno')).rejects.toMatchObject({
    code: '42501',
  });
  const functions =
    await owner.unsafe(`SELECT p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='student_portal' AND p.proname='apply_reconciliation_credentials_v1'`);
  expect(functions[0]).toMatchObject({ prosecdef: true, proconfig: ['search_path=pg_catalog'] });
});

it.each([
  { empty: 'none', lateWrite: false },
  { empty: 'absent', lateWrite: false },
  { empty: 'row', lateWrite: false },
  { empty: 'absent', lateWrite: true },
])(
  'reverses the first association with preserved legacy state ($empty), blocking later writes ($lateWrite)',
  async ({ empty, lateWrite }) => {
    const people = await students(1),
      first = await batch(people);
    if (empty !== 'none') {
      await owner.unsafe(
        'UPDATE student_portal.password_credential SET pin_verifier=NULL WHERE account_id=$1',
        [people[0]!.accountId],
      );
      if (empty === 'absent')
        await owner.unsafe('DELETE FROM student_portal.account_access_data WHERE account_id=$1', [
          people[0]!.accountId,
        ]);
      else
        await owner.unsafe(
          'UPDATE student_portal.account_access_data SET birth_year=NULL,confirmation=NULL WHERE account_id=$1',
          [people[0]!.accountId],
        );
    }
    const [before] = await snapshot(people);
    await prepare(first);
    await apply(first);
    const afterAssociation = await snapshot(people),
      undo = await batch(people);
    const [link] = await owner.unsafe(
      `SELECT p.source_id,p.observation_id,l.decision_id FROM gradebook.student_report_profile_v1 p
    JOIN gradebook.student_source_link_v1 l USING(academic_year,source_id,student_uid) WHERE p.student_uid=$1`,
      [people[0]!.uid],
    );
    await owner.unsafe(
      `UPDATE gradebook.student_report_batch_v1 SET purpose='decision',resolution=$2::text::jsonb WHERE id=$1`,
      [
        undo.id,
        JSON.stringify({
          action: 'separate',
          sourceId: link!.source_id,
          studentUid: people[0]!.uid,
          observationId: link!.observation_id,
          revertsDecisionId: link!.decision_id,
        }),
      ],
    );
    await owner.unsafe(
      `UPDATE gradebook.student_report_pending_row_v1 SET selected_profile=false,target_source_id=$2,target_observation_id=$3 WHERE batch_id=$1`,
      [undo.id, link!.source_id, link!.observation_id],
    );
    if (lateWrite) {
      await owner.unsafe('UPDATE student_portal.account SET version=version+1 WHERE id=$1', [
        people[0]!.accountId,
      ]);
      expect((await prepare(undo)).state).toBe('conflict');
      expect((await snapshot(people))[0]!.birth).toBe(2013);
      return;
    }
    expect((await prepare(undo)).state).toBe('ready');
    expect(await snapshot(people)).toEqual(afterAssociation);
    const applyUndo = () =>
      owner.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE gradebook_app');
        await tx.unsafe(
          `INSERT INTO gradebook.student_reconciliation_decision_v1(id,academic_year,generation,sequence,actor_id,
      action,source_id,student_uid,observation_id,reason,reverts_decision_id) VALUES($1,2026,$2,2,$3,'separate',$4,$5,$6,'synthetic',$7)`,
          [
            crypto.randomUUID(),
            generation,
            actor,
            link!.source_id,
            people[0]!.uid,
            link!.observation_id,
            link!.decision_id,
          ],
        );
        await tx.unsafe('DELETE FROM gradebook.student_report_profile_v1 WHERE student_uid=$1', [
          people[0]!.uid,
        ]);
        await tx.unsafe('DELETE FROM gradebook.student_source_link_v1 WHERE source_id=$1', [
          link!.source_id,
        ]);
        await tx.unsafe('SELECT student_portal.apply_reconciliation_credentials_v1($1,$2)', [
          undo.id,
          actor,
        ]);
      });
    if (empty !== 'none') {
      await exec(`CREATE FUNCTION public.synthetic_clear_pin_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.account_id='${people[0]!.accountId}'::uuid AND NEW.pin_verifier IS NULL THEN RAISE EXCEPTION 'synthetic-clear-pin-failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_clear_pin_failure BEFORE INSERT OR UPDATE ON student_portal.password_credential FOR EACH ROW EXECUTE FUNCTION public.synthetic_clear_pin_failure();`);
      try {
        await expect(applyUndo()).rejects.toThrow('synthetic-clear-pin-failure');
        expect(await snapshot(people)).toEqual(afterAssociation);
        expect(
          (
            await owner.unsafe(
              'SELECT 1 FROM gradebook.student_report_profile_v1 WHERE student_uid=$1',
              [people[0]!.uid],
            )
          ).length,
        ).toBe(1);
        expect(
          (
            await owner.unsafe(
              'SELECT 1 FROM gradebook.student_source_link_v1 WHERE student_uid=$1',
              [people[0]!.uid],
            )
          ).length,
        ).toBe(1);
      } finally {
        await exec(
          'DROP TRIGGER synthetic_clear_pin_failure ON student_portal.password_credential; DROP FUNCTION public.synthetic_clear_pin_failure()',
        );
      }
    }
    await applyUndo();
    const [after] = await snapshot(people),
      [previous] = afterAssociation;
    expect(after!.birth).toBe(before!.birth);
    if (empty === 'none') {
      expect(await cryptography.verifySecret('2012', after!.pin_verifier as never)).toBe(true);
      expect(after!.pin_verifier).not.toEqual(previous!.pin_verifier);
    } else expect(after!.pin_verifier).toBeNull();
    expect(after!.password_verifier).toEqual(previous!.password_verifier);
    expect(after!.qr).toBe(previous!.qr);
    expect(after!.security_version).toBe(previous!.security_version);
    expect(after!.revoked).toBe(previous!.revoked);
  },
);

it('keeps confirmed credentials during link review and exposes canonical birth for accounts created after reconciliation', async () => {
  const people = await students(1),
    b = await batch(people);
  await owner.unsafe(
    "UPDATE gradebook.student_report_pending_row_v1 SET name='SYNTHETIC REPORT NAME',name_key='SYNTHETIC REPORT NAME' WHERE batch_id=$1",
    [b.id],
  );
  await prepare(b);
  await apply(b);
  const currentName = async () =>
    (
      await portal.unsafe(
        'SELECT name FROM student_portal.academic_student_v1 WHERE student_id=$1',
        [people[0]!.id],
      )
    )[0]!.name;
  expect(await currentName()).toBe('SYNTHETIC REPORT NAME');
  const gradebookName = () =>
    owner.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE gradebook_app');
      return (
        await tx.unsafe('SELECT name FROM gradebook.student_presentation_v1 WHERE student_id=$1', [
          people[0]!.id,
        ])
      )[0]!.name;
    });
  expect(await gradebookName()).toBe(await currentName());
  await owner.unsafe(
    "UPDATE gradebook.student_reconciliation_scope_v1 SET name_source='relation' WHERE academic_year=2026",
  );
  expect(await currentName()).toBe('SYNTHETIC PERSON ' + people[0]!.id);
  expect(await gradebookName()).toBe(await currentName());
  expect(
    (await owner.unsafe('SELECT nome FROM gradebook.aluno WHERE id=$1', [people[0]!.id]))[0]!.nome,
  ).toBe('SYNTHETIC PERSON ' + people[0]!.id);
  await owner.unsafe(
    "UPDATE gradebook.student_reconciliation_scope_v1 SET name_source='report' WHERE academic_year=2026",
  );
  const before = await snapshot(people);
  await owner.unsafe(
    'UPDATE gradebook.student_report_profile_v1 SET review_required=true WHERE student_uid=$1',
    [people[0]!.uid],
  );
  await owner.unsafe(
    'UPDATE gradebook.student_source_link_v1 SET review_required=true WHERE student_uid=$1',
    [people[0]!.uid],
  );
  expect(await snapshot(people)).toEqual(before);
  expect(await currentName()).toBe('SYNTHETIC REPORT NAME');
  expect(
    (
      await portal.unsafe(
        'SELECT confirmation FROM student_portal.account_birth_v1 WHERE account_id=$1',
        [people[0]!.accountId],
      )
    )[0]!.confirmation,
  ).toBe('confirmed');
  const academic = await students(1, false),
    report = await batch(academic);
  await prepare(report);
  await apply(report);
  const id = crypto.randomUUID();
  await owner.unsafe(
    `INSERT INTO student_portal.account(id,academic_year,gradebook_student_id,auth_state,eligibility)
    VALUES($1,2026,$2,'pending-activation','eligible')`,
    [id, academic[0]!.id],
  );
  const [birth] = await portal.unsafe(
    'SELECT birth_year,confirmation,source FROM student_portal.account_birth_v1 WHERE account_id=$1',
    [id],
  );
  expect(birth).toEqual({ birth_year: 2013, confirmation: 'confirmed', source: 'profile' });
  const issuer = new QrServiceV1(runtime(), cryptography, 1, 1);
  const command = {
    contractVersion: 1,
    operation: 'qr-issue',
    accountId: id,
    expectedVersion: 0,
    idempotencyKey: crypto.randomUUID(),
  };
  const issued = await issuer.command(actor, command);
  expect(issued.qr).toContain('/access#v1.');
  const [credential] = await owner.unsafe(
    'SELECT pin_verifier FROM student_portal.password_credential WHERE account_id=$1',
    [id],
  );
  expect(await cryptography.verifySecret('2013', credential!.pin_verifier as never)).toBe(true);
  expect(await issuer.command(actor, command)).toEqual(issued);
  expect(
    (
      await owner.unsafe(
        'SELECT pin_verifier FROM student_portal.password_credential WHERE account_id=$1',
        [id],
      )
    )[0]!.pin_verifier,
  ).toEqual(credential!.pin_verifier);
});

it('expires only pending data with bounded cleanup while preserving applied observations and transition history', async () => {
  const people = await students(1),
    applied = await batch(people);
  await prepare(applied);
  await apply(applied);
  await owner.unsafe("UPDATE gradebook.student_report_batch_v1 SET state='applied' WHERE id=$1", [
    applied.id,
  ]);
  const pending = await batch(await students(1, false));
  await owner.unsafe(
    "UPDATE gradebook.student_report_batch_v1 SET expires_at=now()-interval '1 second' WHERE id=$1",
    [pending.id],
  );
  expect(
    (await portal.unsafe('SELECT student_portal.cleanup_reconciliation_pending_v1(1) AS n'))[0]!.n,
  ).toBe(1);
  expect(
    (
      await owner.unsafe(
        'SELECT 1 FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1',
        [pending.id],
      )
    ).length,
  ).toBe(0);
  expect(
    (
      await owner.unsafe('SELECT state FROM gradebook.student_report_batch_v1 WHERE id=$1', [
        pending.id,
      ])
    )[0]!.state,
  ).toBe('expired');
  expect(
    (
      await owner.unsafe(
        'SELECT 1 FROM gradebook.student_source_observation_v1 WHERE batch_id=$1',
        [applied.id],
      )
    ).length,
  ).toBe(1);
});
