import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyCurrentGradebookSchemaV1, assertCurrentGradebookSchemaV1 } from '../../../server/gradebook/recovery/current-gradebook-schema-v1.ts';
import { assertStudentIdentitySchemaV1 } from '../../student-identity/schema-state-helper.ts';
import { resolveStudentIdentitiesV1 } from '../../student-identity/resolve-student-identity-helper.ts';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1'
  || target.pathname !== '/portal705_test' || target.search || target.hash) {
  throw new Error('Identity tests require disposable local PostgreSQL');
}
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const databases: string[] = [];
const connections: ReturnType<typeof postgres>[] = [];
let source: ReturnType<typeof postgres>;
let restored: ReturnType<typeof postgres>;
let restoreRoleInheritance = false;
// Valid persisted PostgreSQL UUID, deliberately not an RFC-versioned generated UUID.
const uid = '00000000-0000-0000-0000-000000000abc';
const migration = () => readFileSync('migrations/student-portal/0018_shared_student_identity_v1.sql', 'utf8');
const adapter = (connection: Pick<ReturnType<typeof postgres>, 'unsafe'>) => ({
  unsafe: (text: string, parameters: readonly unknown[] = []) =>
    connection.unsafe(text, [...parameters] as never[], { prepare: false }),
});
const exec = (connection: ReturnType<typeof postgres>, text: string) =>
  connection.unsafe(text, [], { prepare: false });

/** Creates an isolated native database from the exact pre-identity migration sequence. */
async function createTarget() {
  const name = 'portal1114_identity_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  await cluster.unsafe('CREATE DATABASE ' + name);
  databases.push(name);
  const url = new URL(target); url.pathname = '/' + name;
  const connection = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  connections.push(connection);
  await applyCurrentGradebookSchemaV1(adapter(connection), process.cwd());
  await assertCurrentGradebookSchemaV1(adapter(connection));
  const baseline = readdirSync('migrations/student-portal')
    .filter(file => /^\d{4}_.+\.sql$/u.test(file) && Number(file.slice(0, 4)) <= 17)
    .sort((left, right) => left.localeCompare(right));
  if (baseline.length !== 17) throw new Error('student-identity-portal-baseline-incomplete');
  for (const file of baseline) await exec(connection, readFileSync('migrations/student-portal/' + file, 'utf8'));
  await exec(connection, `CREATE TABLE student_portal.profile_photo (
    account_id uuid PRIMARY KEY REFERENCES student_portal.account(id) ON DELETE RESTRICT,
    sharepoint_drive_id text NOT NULL,sharepoint_item_id text NOT NULL
  )`);
  return connection;
}

/** Captures only synthetic, pre-existing fields to detect accidental backfill changes. */
async function preservedState(connection: ReturnType<typeof postgres>) {
  const rows = await connection.unsafe(`SELECT jsonb_build_object(
    'students',(SELECT jsonb_agg(to_jsonb(s)-'student_uid' ORDER BY id) FROM gradebook.aluno s),
    'accounts',(SELECT jsonb_agg(to_jsonb(a)-'student_uid' ORDER BY id) FROM student_portal.account a),
    'photos',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM student_portal.profile_photo p),
    'qr',(SELECT jsonb_agg(to_jsonb(q) ORDER BY credential_id) FROM student_portal.qr_credential q),
    'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM student_portal.session s)
  ) AS snapshot`);
  return rows[0]!.snapshot;
}
let originalState: unknown;

beforeAll(async () => {
  // The native suite shares cluster roles across isolated databases and runs serially.
  // Match the real Gradebook baseline without weakening its assertion or leaking settings.
  const roles = await cluster.unsafe('SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=\'gradebook_app\'');
  if (roles[0]?.rolsuper === true || roles[0]?.rolbypassrls === true) {
    throw new Error('student-identity-test-role-unsafe');
  }
  restoreRoleInheritance = roles[0]?.rolinherit === true;
  if (restoreRoleInheritance) await cluster.unsafe('ALTER ROLE gradebook_app NOINHERIT');
  source = await createTarget();
  await exec(source, `
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,3);
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (101,2026,'SYNTHETIC NATIVE IDENTITY');
    INSERT INTO student_portal.account (id,academic_year,gradebook_student_id,auth_state,eligibility,version,security_version)
      VALUES ('${uid}',2026,101,'active','eligible',9,3);
    INSERT INTO student_portal.profile_photo VALUES ('${uid}','synthetic-drive','synthetic-item');
    INSERT INTO student_portal.qr_credential (credential_id,account_id,key_version,state)
      VALUES ('${'q'.repeat(40)}','${uid}',1,'active');
    INSERT INTO student_portal.session (id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES ('30000000-0000-4000-8000-000000000001','${uid}','synthetic-native-identity-session',3,now()+interval '1 day',false);
  `);
  originalState = await preservedState(source);
  await exec(source, migration());
  restored = await createTarget();
  await exec(restored, migration());
}, 30_000);

afterAll(async () => {
  try {
    for (const connection of connections) await connection.end({ timeout: 2 });
    for (const name of databases) await cluster.unsafe('DROP DATABASE ' + name);
  } finally {
    try {
      if (restoreRoleInheritance) await cluster.unsafe('ALTER ROLE gradebook_app INHERIT');
    } finally { await cluster.end({ timeout: 2 }); }
  }
});

it('upgrades the complete hardened Gradebook foundation without renumbering or changing protected state', async () => {
  await assertStudentIdentitySchemaV1(adapter(source));
  expect(await preservedState(source)).toEqual(originalState);
  const rows = await source.unsafe(`SELECT s.student_uid::text AS student_uid,a.student_uid::text AS account_uid
    FROM gradebook.aluno s JOIN student_portal.account a ON a.gradebook_student_id=s.id AND a.academic_year=s.ano`);
  expect(rows[0]).toEqual({ student_uid: uid, account_uid: uid });
});

it('resolves canonical non-RFC UUIDs through both references with native driver JSON inference', async () => {
  const query = async (text: string, parameters: readonly (string | number)[]) =>
    Array.from(await source.unsafe(text, [...parameters]));
  const academic = await resolveStudentIdentitiesV1(query, {
    source: 'gradebook', academicYear: 2026, studentIds: [101, 101, 999],
  });
  const portal = await resolveStudentIdentitiesV1(query, {
    source: 'portal', academicYear: 2026, accountIds: [uid.toUpperCase(), uid],
  });
  expect(academic.map(item => item.studentUid)).toEqual([uid]);
  expect(portal.map(item => item.studentUid)).toEqual([uid]);
});

it('restores the identity registry before academic/account/photo references as the table owner', async () => {
  // Only synthetic identity-related data: this is not an institutional backup or RPO/RTO claim.
  for (const table of ['gradebook.student_identity','gradebook.ano_letivo','gradebook.aluno',
    'student_portal.account','student_portal.profile_photo','student_portal.qr_credential','student_portal.session']) {
    const rows = await source.unsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS data FROM ${table} t`);
    expect(Array.isArray(rows[0]!.data)).toBe(true);
    await restored.unsafe(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::text::jsonb)`,
      [JSON.stringify(rows[0]!.data)]);
  }
  await assertStudentIdentitySchemaV1(adapter(restored));
  expect(await preservedState(restored)).toEqual(originalState);
  const rows = await restored.unsafe('SELECT student_uid::text FROM gradebook.aluno WHERE id=101');
  expect(rows[0]).toEqual({ student_uid: uid });
});

it('supports existing restricted roles and rolls back identity allocation with a failed academic transaction', async () => {
  await source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE gradebook_app');
    await tx.unsafe("INSERT INTO gradebook.aluno (id,ano,nome) VALUES (102,2026,'SYNTHETIC RESTRICTED ROLE')");
  });
  await source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE student_portal_app');
    await tx.unsafe(`INSERT INTO student_portal.account (id,academic_year,gradebook_student_id,auth_state,eligibility)
      VALUES ('20000000-0000-4000-8000-000000000001',2026,102,'pending-activation','eligible')`);
  });
  const before = await source.unsafe('SELECT id::text FROM gradebook.student_identity ORDER BY id');
  await expect(source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE gradebook_app');
    await tx.unsafe("INSERT INTO gradebook.aluno (id,ano,nome) VALUES (103,2026,'SYNTHETIC ROLLBACK')");
    throw new Error('synthetic-identity-rollback');
  })).rejects.toThrow('synthetic-identity-rollback');
  expect(Array.from(await source.unsafe('SELECT id::text FROM gradebook.student_identity ORDER BY id'))).toEqual(Array.from(before));
  await assertStudentIdentitySchemaV1(adapter(source));
});

it('rejects reassignment across people and direct runtime access to registry writes', async () => {
  await expect(source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE student_portal_app');
    await tx.unsafe('UPDATE student_portal.account SET gradebook_student_id=102 WHERE id=$1', [uid]);
  })).rejects.toThrow('student-identity-mismatch');
  await expect(source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE gradebook_app');
    await tx.unsafe('DELETE FROM gradebook.student_identity WHERE id=$1', [uid]);
  })).rejects.toThrow('permission denied');
  await assertStudentIdentitySchemaV1(adapter(source));
});

it('blocks supplied UID reuse by the effective runtime role but permits exact replay without allocation', async () => {
  await source.unsafe('INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2027,60000,3)');
  const before = Array.from(await source.unsafe('SELECT id::text FROM gradebook.student_identity ORDER BY id'));
  await expect(source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE gradebook_app');
    await tx.unsafe("INSERT INTO gradebook.aluno (id,ano,nome,student_uid) VALUES (201,2027,'SYNTHETIC UNAPPROVED REUSE',$1)", [uid]);
  })).rejects.toThrow('student-identity-reuse-requires-owner-restore');
  await source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE gradebook_app');
    await tx.unsafe(`INSERT INTO gradebook.aluno (id,ano,nome,student_uid)
      VALUES (101,2026,'SYNTHETIC NATIVE IDENTITY',$1)
      ON CONFLICT (id) DO UPDATE SET nome=EXCLUDED.nome`, [uid]);
  });
  expect(Array.from(await source.unsafe('SELECT id::text FROM gradebook.student_identity ORDER BY id'))).toEqual(before);
  expect(Array.from(await source.unsafe('SELECT id FROM gradebook.aluno WHERE id=201'))).toEqual([]);
  await assertStudentIdentitySchemaV1(adapter(source));
});

it('cannot claim an existing person through a newly created closed account or its account primary key', async () => {
  await source.unsafe("INSERT INTO gradebook.aluno (id,ano,nome) VALUES (104,2026,'SYNTHETIC WITHOUT PORTAL ACCOUNT')");
  const students = await source.unsafe('SELECT student_uid::text AS uid FROM gradebook.aluno WHERE id=104');
  const personUid = students[0]!.uid as string;
  await expect(source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE student_portal_app');
    await tx.unsafe(`INSERT INTO student_portal.account
      (id,academic_year,auth_state,eligibility,closed_at,student_uid)
      VALUES ('50000000-0000-4000-8000-000000000001',2026,'active','unlinked',now(),$1)`, [personUid]);
  })).rejects.toThrow('student-identity-closed-account-reuse-forbidden');
  await source.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE student_portal_app');
    await tx.unsafe(`INSERT INTO student_portal.account (id,academic_year,auth_state,eligibility,closed_at)
      VALUES ($1,2026,'active','unlinked',now())`, [personUid]);
  });
  const accounts = await source.unsafe('SELECT student_uid::text AS uid FROM student_portal.account WHERE id=$1', [personUid]);
  expect(accounts[0]!.uid).not.toBe(personUid);
  await assertStudentIdentitySchemaV1(adapter(source));
});

it('fails postflight for a missing, unvalidated or incorrectly targeted composite FK', async () => {
  const name = 'account_academic_identity_fk_v1';
  for (const replacement of [
    null,
    `ALTER TABLE student_portal.account ADD CONSTRAINT ${name}
      FOREIGN KEY (gradebook_student_id,academic_year,student_uid)
      REFERENCES gradebook.aluno(id,ano,student_uid) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID`,
    `ALTER TABLE student_portal.account ADD CONSTRAINT ${name}
      FOREIGN KEY (student_uid) REFERENCES gradebook.student_identity(id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
  ]) {
    await expect(source.begin(async tx => {
      await tx.unsafe(`ALTER TABLE student_portal.account DROP CONSTRAINT ${name}`);
      if (replacement !== null) await tx.unsafe(replacement);
      await expect(assertStudentIdentitySchemaV1(adapter(tx))).rejects.toThrow('student-identity-postflight-invariant-failed');
      throw new Error('synthetic-postflight-probe-rollback');
    })).rejects.toThrow('synthetic-postflight-probe-rollback');
    await assertStudentIdentitySchemaV1(adapter(source));
  }
});

it('fails postflight when the input guard no longer runs as the effective caller', async () => {
  await expect(source.begin(async tx => {
    await tx.unsafe('ALTER FUNCTION gradebook.guard_student_uid_input_v1() SECURITY DEFINER');
    await expect(assertStudentIdentitySchemaV1(adapter(tx))).rejects.toThrow('student-identity-postflight-invariant-failed');
    throw new Error('synthetic-guard-probe-rollback');
  })).rejects.toThrow('synthetic-guard-probe-rollback');
  await assertStudentIdentitySchemaV1(adapter(source));
});
