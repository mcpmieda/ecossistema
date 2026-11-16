import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import { SessionServiceV1 } from '../../../server/student-portal/auth/session-service-v1';
import { SelfProjectionReaderV1 } from '../../../server/student-portal/publication/self-projection-reader-v1';
import { ScopedPublicationServiceV2 } from '../../../server/student-portal/publication/scoped-publication-service-v2';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import type {
  StudentPortalPostgresSqlV1,
  StudentPortalPostgresQueryV1,
} from '../../../server/student-portal/persistence/postgres-persistence-v1';
import {
  installAdminReadFixtureV2,
  readAccountIdV2,
  READ_ACTOR_V2,
  READ_SCHOOL_V2,
} from './read-fixture-v2';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Concurrency regressions require disposable local PostgreSQL.');
const name = 'portal806_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const clients: ReturnType<typeof postgres>[] = [];
let created = false;
let owner: ReturnType<typeof postgres>;
let peer: ReturnType<typeof postgres>;
let sql: StudentPortalPostgresSqlV1;
const own = readAccountIdV2(1);
const token = 'S'.repeat(43);
const cryptoPort = new PortalCryptoV1(
  new Map([[1, new Uint8Array(32).fill(7)]]),
  new Map([[1, new Uint8Array(32).fill(8)]]),
);
function client(role?: string) {
  const url = new URL(target);
  url.pathname = '/' + name;
  if (role) url.username = role;
  const value = postgres(url.toString(), {
    max: 1,
    onnotice: () => undefined,
    connection: { lock_timeout: 250, statement_timeout: 5000 },
  });
  clients.push(value);
  return value;
}
const ownerSql = () => owner as unknown as StudentPortalPostgresSqlV1;
async function revision(tx: StudentPortalPostgresQueryV1, ids: number[] = [746001]) {
  await tx.unsafe(
    `SELECT * FROM student_portal.record_gradebook_change_v1($1::uuid,2026::smallint,'marks',true,
    ARRAY(SELECT value::integer FROM jsonb_array_elements_text($2::text::jsonb)),statement_timestamp())`,
    [crypto.randomUUID(), JSON.stringify(ids)],
  );
}
async function policy(autoUpdate: boolean) {
  const service = new PolicyServiceV1(sql);
  const current = await service.read(READ_SCHOOL_V2);
  await service.mutate(READ_ACTOR_V2, {
    contractVersion: 1,
    operation: 'settings-set',
    scope: READ_SCHOOL_V2,
    expectedVersion: current.version,
    idempotencyKey: crypto.randomUUID(),
    acknowledgeImmediateEffect: true,
    value: {
      autoUpdate,
      accessEnabled: true,
      showPartials: true,
      allowedPeriods: ['T1'],
      calendar: {
        ...initialPolicyDefaultsV1().calendar,
        enrollmentStartsAt: '2026-01-01T00:00:00Z',
        yearStartsAt: '2026-01-02T00:00:00Z',
        t1EndsAt: '2026-04-01T00:00:00Z',
        t2StartsAt: '2026-04-02T00:00:00Z',
        t2EndsAt: '2026-07-01T00:00:00Z',
        t3StartsAt: '2026-07-02T00:00:00Z',
        t3EndsAt: '2026-11-01T00:00:00Z',
        recoveriesStartAt: '2026-11-02T00:00:00Z',
        yearEndsAt: '2026-12-31T23:59:59Z',
      },
    },
  });
}
async function release(operation: 'publish' | 'unpublish' = 'publish') {
  const service = new ScopedPublicationServiceV2(sql);
  const state = await service.read(READ_SCHOOL_V2);
  return service.command(READ_ACTOR_V2, {
    contractVersion: 1,
    operation,
    scope: READ_SCHOOL_V2,
    period: 'T1',
    expectedVersion: state.version,
    idempotencyKey: crypto.randomUUID(),
    ...(operation === 'publish' ? { targetDataVersion: state.dataVersion } : { confirmed: true }),
  });
}
const self = () =>
  new SessionServiceV1(sql, cryptoPort, null, true).withAuthorized(token, (context, tx) =>
    new SelfProjectionReaderV1(sql).readInTransaction(
      tx,
      context.account.id,
      crypto.randomUUID(),
      true,
    ),
  );
const score = async () => (await self())?.subjects[0]?.periods[0]?.final;
const metrics = async () =>
  (await owner.unsafe('SELECT * FROM student_portal.publication_preparation_metrics_v3'))[0]!;
beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name);
  created = true;
  owner = client();
  peer = client();
  await installAdminReadFixtureV2(
    { exec: (text) => owner.unsafe(text, [], { prepare: false }) },
    ownerSql(),
  );
  await owner.unsafe(
    `UPDATE gradebook.vinculo SET turma_id=746002 WHERE aluno_id>746050;
    INSERT INTO gradebook.professor(id,ano,nome) VALUES(806001,2026,'SYNTHETIC TEACHER');
    INSERT INTO gradebook.disciplina(id,ano,nome) VALUES(806001,2026,'MATEMATICA');
    INSERT INTO gradebook.oferta(id,ano,turma_id,professor_id,disciplina_id) VALUES(806001,2026,746001,806001,806001);
    INSERT INTO gradebook.instrumento(id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT 806000+(t-1)*20+s,806001,t,s,
        CASE WHEN s=11 THEN CASE WHEN t=3 THEN 22000 ELSE 16500 END
          ELSE CASE WHEN t=3 THEN 9000 ELSE 6750 END END,
        CASE WHEN s=1 THEN 'AV1' WHEN s=2 THEN 'AV2' ELSE 'QUALITATIVA' END
      FROM generate_series(1,3) t CROSS JOIN (VALUES(1),(2),(11)) slots(s);
    INSERT INTO gradebook.nota(instrumento_id,aluno_id,valor) VALUES(806001,746001,2000);
    INSERT INTO gradebook.fechamento(oferta_id,aluno_id,am1_fonte) SELECT 806001,746000+n,8000 FROM generate_series(1,50) n;
    SELECT * FROM student_portal.synchronize_profiles_v1(false);`,
    [],
    { prepare: false },
  );
  for (const migration of [
    '0008_atomic_publication_v2.sql',
    '0009_publication_cutover_guard_v2.sql',
    '0010_incremental_publication_v3.sql',
  ])
    await owner.unsafe(readFileSync('migrations/student-portal/' + migration, 'utf8'), [], {
      prepare: false,
    });
  sql = client('student_portal_app') as unknown as StudentPortalPostgresSqlV1;
  await owner.unsafe('SELECT student_portal.activate_scoped_publication_v2()');
}, 30_000);
beforeEach(async () => {
  await policy(false);
  await owner.unsafe(
    `DELETE FROM student_portal.publication_release_v2;
    DELETE FROM student_portal.session;
    UPDATE student_portal.account SET blocked=false WHERE id='74600000-0000-4000-8000-000000000001';
    UPDATE gradebook.instrumento SET descricao='AV1' WHERE id=806001;
    UPDATE gradebook.fechamento SET am1_fonte=8000 WHERE oferta_id=806001;
    UPDATE student_portal.academic_revision SET academic_counter=academic_counter+1 WHERE academic_year=2026;`,
    [],
    { prepare: false },
  );
  await owner.unsafe(
    `INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent)
    SELECT $1::uuid,id,$2,security_version,now()+interval '1 hour',false FROM student_portal.account WHERE id=$3::uuid`,
    [crypto.randomUUID(), await cryptoPort.hashOpaqueToken(token), own],
  );
  await policy(true);
  await release();
});
afterAll(async () => {
  for (const value of clients) await value.end({ timeout: 2 });
  if (created) await cluster.unsafe('DROP DATABASE ' + name);
  await cluster.end({ timeout: 2 });
});

it('selects no data for an empty target', async () => {
  expect(
    await owner.unsafe(
      'SELECT student_id FROM student_portal.publication_source_rows_v3(ARRAY[]::integer[])',
    ),
  ).toHaveLength(0);
});
it('prepares only the affected class, retains unrelated editions and publishes updated values immediately', async () => {
  await ownerSql().begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(613,2026)');
    await tx.unsafe(
      'UPDATE gradebook.fechamento SET am1_fonte=9000 WHERE oferta_id=806001 AND aluno_id=746001',
    );
    await revision(tx);
  });
  expect(await metrics()).toMatchObject({
    mode: 'incremental',
    scanned_students: 50,
    written_sources: 1,
  });
  expect(await score()).toMatchObject({ value: 9 });
  expect(
    (await new SelfProjectionReaderV1(sql).read(readAccountIdV2(1), crypto.randomUUID()))?.profile
      .accountId,
  ).toBe(own);
});
it('expands instrument metadata changes to classmates, not the school', async () => {
  await ownerSql().begin(async (tx) => {
    await tx.unsafe("UPDATE gradebook.instrumento SET descricao='AV1 REVISED' WHERE id=806001");
    await revision(tx);
  });
  expect(await metrics()).toMatchObject({
    mode: 'incremental',
    scanned_students: 50,
    written_sources: 50,
  });
});
it('falls back to the complete source on missing or global revision scope', async () => {
  await ownerSql().begin(async (tx) => {
    await revision(tx, []);
  });
  expect(await metrics()).toMatchObject({ mode: 'full', scanned_students: 106 });
  await owner.unsafe(
    'UPDATE student_portal.academic_revision SET academic_counter=academic_counter+1 WHERE academic_year=2026',
  );
  expect(await metrics()).toMatchObject({ mode: 'full', scanned_students: 106 });
});
it('reads session and old committed grades during an import holding the exclusive year, then sees its commit', async () => {
  let releaseWriter!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const writer = (peer as unknown as StudentPortalPostgresSqlV1).begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(613,2026)');
    await tx.unsafe(
      'UPDATE gradebook.fechamento SET am1_fonte=9000 WHERE oferta_id=806001 AND aluno_id=746001',
    );
    await revision(tx);
    entered();
    await gate;
  });
  try {
    await Promise.race([ready, writer]);
    expect(
      await new SessionServiceV1(sql, cryptoPort, null, true).read(token, crypto.randomUUID()),
    ).toMatchObject({ state: 'authenticated' });
    expect(await score()).toMatchObject({ value: 8 });
  } finally {
    releaseWriter();
    await writer;
  }
  expect(await score()).toMatchObject({ value: 9 });
});
it('honors committed withdrawal and revocation on the next snapshot and prohibits writes in read consumers', async () => {
  await expect(
    new SessionServiceV1(sql, cryptoPort, null, true).withAuthorized(token, async (_context, tx) =>
      tx.unsafe('UPDATE student_portal.account SET blocked=true WHERE false'),
    ),
  ).rejects.toMatchObject({ code: '25006' });
  await release('unpublish');
  expect((await self())?.state).toBe('no-publication');
  await owner.unsafe('UPDATE student_portal.session SET revoked_at=now()');
  expect(await self()).toBeNull();
});
it('reads a session once per authorization snapshot but retains the locked reread for commands', async () => {
  const queries: string[] = [];
  const tracked: StudentPortalPostgresSqlV1 = {
    unsafe: (query, values) => sql.unsafe(query, values),
    begin: (operation) =>
      sql.begin((tx) =>
        operation({
          unsafe: (query, values) => {
            queries.push(query);
            return tx.unsafe(query, values);
          },
        }),
      ),
  };
  const sessionQueries = () =>
    queries.filter((query) => query.includes('FROM student_portal.session WHERE token_hash='));
  const snapshot = new SessionServiceV1(tracked, cryptoPort, null, true);
  expect(
    await snapshot.read(token, crypto.randomUUID(), own, false, async (context, tx, session) => {
      expect(context.account.id).toBe(own);
      expect(session.id).toEqual(expect.any(String));
      expect((await tx.unsafe('SHOW transaction_read_only'))[0]?.transaction_read_only).toBe('on');
    }),
  ).toMatchObject({ state: 'authenticated' });
  expect(sessionQueries()).toHaveLength(1);
  expect(queries[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  expect(queries.some((query) => query.includes('FOR UPDATE'))).toBe(false);
  queries.length = 0;
  expect(
    await new SessionServiceV1(tracked, cryptoPort).read(token, crypto.randomUUID(), own),
  ).toMatchObject({ state: 'authenticated' });
  expect(sessionQueries()).toHaveLength(2);
  expect(sessionQueries()[1]).toContain('FOR UPDATE');
  const accountLock = queries.findIndex(
    (query) => query.includes('FROM student_portal.account') && query.includes('FOR UPDATE'),
  );
  expect(accountLock).toBeGreaterThan(-1);
  expect(queries.indexOf(sessionQueries()[1]!)).toBeGreaterThan(accountLock);
});
it('rechecks session identity, security version and expiry on each fresh authorization snapshot', async () => {
  const snapshot = new SessionServiceV1(sql, cryptoPort, null, true);
  let authorizedCalls = 0;
  const read = (accountId = own) =>
    snapshot.read(token, crypto.randomUUID(), accountId, false, () => {
      authorizedCalls += 1;
    });
  expect(await read(readAccountIdV2(2))).toBeNull();
  expect(authorizedCalls).toBe(0);
  expect(await read()).toMatchObject({ state: 'authenticated' });
  expect(authorizedCalls).toBe(1);
  await owner.unsafe('UPDATE student_portal.session SET security_version=security_version+1');
  expect(await read()).toBeNull();
  await owner.unsafe(`UPDATE student_portal.session SET security_version=security_version-1,
    created_at=now()-interval '2 hour',expires_at=now()-interval '1 hour'`);
  expect(await read()).toBeNull();
  expect(authorizedCalls).toBe(1);
});
it('rolls back prepared editions together with the write and preserves a frozen publication', async () => {
  await policy(false);
  const before = await metrics();
  await expect(
    ownerSql().begin(async (tx) => {
      await tx.unsafe(
        'UPDATE gradebook.fechamento SET am1_fonte=9000 WHERE oferta_id=806001 AND aluno_id=746001',
      );
      await revision(tx);
      await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw new Error('synthetic rollback');
    }),
  ).rejects.toThrow('synthetic rollback');
  expect(await metrics()).toEqual(before);
  await ownerSql().begin(async (tx) => {
    await tx.unsafe(
      'UPDATE gradebook.fechamento SET am1_fonte=9000 WHERE oferta_id=806001 AND aluno_id=746001',
    );
    await revision(tx);
  });
  expect(await score()).toMatchObject({ value: 8 });
  await policy(true);
  expect(await score()).toMatchObject({ value: 9 });
});
