import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installLegacyBirthReadFixtureV1 } from '../year-reset/schema-fixture';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresQueryV1,
  type StudentPortalPostgresResultV1,
  type StudentPortalPostgresSqlV1,
} from '../../../server/student-portal/persistence/postgres-persistence-v1';

let pg: PGlite;
let persistence: StudentPortalPostgresPersistenceV1;

type Row = Record<string, unknown>;

async function execute<R extends Row>(client: Pick<PGlite, 'query'>, query: string, values: readonly unknown[] = []) {
  const result = await client.query<R>(query, [...values]);
  return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length }) as StudentPortalPostgresResultV1<R>;
}

async function applySchema() {
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  await pg.exec(readFileSync('migrations/gradebook-simplified/application_role_grants.sql', 'utf8'));
  for (const file of [
    '0003_council_session_v3.sql','0004_council_v3_least_privilege.sql','0005_relational_bulletin_snapshot_v2.sql',
    '0006_import_diagnostic_treatment_v1.sql','0007_multiyear_rr_v1.sql','0008_year_reset_acl_v1.sql',
  ]) await pg.exec(readFileSync(`migrations/gradebook-simplified/${file}`, 'utf8'));
  for (const file of [
    '0001_identity_credentials_acl_v1.sql','0002_policy_publication_revision_v1.sql',
    '0003_audit_receipts_closure_integration_v1.sql','0004_gradebook_integration_usage_v1.sql',
  ]) await pg.exec(readFileSync(`migrations/student-portal/${file}`, 'utf8'));
  await installLegacyBirthReadFixtureV1(pg);
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES (1,2026,'S1','TURMA SINTETICA',6,'TESTE');
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES (1,2026,'ALUNO SINTETICO UM'),(2,2026,'ALUNO SINTETICO DOIS');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,1,1,1),(2026,1,2,2);
  `);
}

beforeAll(async () => {
  pg = new PGlite();
  await applySchema();
  const sql: StudentPortalPostgresSqlV1 = {
    unsafe<R extends Row>(query: string, values: readonly unknown[] = []) {
      return execute<R>(pg, query, values);
    },
    async begin<T>(operation: (sql: StudentPortalPostgresQueryV1) => Promise<T>) {
      return pg.transaction(async (transaction) => operation({
        unsafe<R extends Row>(query: string, values: readonly unknown[] = []) {
          return execute<R>(transaction, query, values);
        },
      }));
    },
  };
  persistence = new StudentPortalPostgresPersistenceV1(sql);
}, 30_000);

afterAll(async () => { await pg?.close(); });

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_TWO = '22222222-2222-4222-8222-222222222222';

function account(id = ACCOUNT, studentId = 1) {
  return {
    id,
    link: { academicYear: 2026 as const, studentId },
    state: 'pending-activation' as const,
    eligibility: 'eligible' as const,
    blocked: false,
    version: 0,
    securityVersion: 0,
    pinVersion: 0,
    closedAt: null,
  };
}

describe('StudentPortalPostgresPersistenceV1', () => {
  it('refuses shared-to-exclusive promotion and revision/link writes in a shared year transaction', async () => {
    await persistence.transaction(async (tx) => {
      await tx.lockAcademicYear(2026, 'shared');
      await expect(tx.lockAcademicYear(2026)).rejects.toThrow('student-portal-shared-year-write-forbidden');
      await expect(tx.insertAccount(account())).rejects.toThrow('student-portal-shared-year-write-forbidden');
      await expect(tx.closeAcademicLinks(2026, 0, new Date().toISOString())).rejects.toThrow('student-portal-shared-year-write-forbidden');
      await expect(tx.appendRevision({ eventId: crypto.randomUUID(), academicYear: 2026,
        studentIds: [], dataVersion: 'synthetic-unused', cause: 'marks', occurredAt: new Date().toISOString() }))
        .rejects.toThrow('student-portal-shared-year-write-forbidden');
    });
  });

  it('creates one durable linked account and increments portal-link coordination only once', async () => {
    const before = (await pg.query<{ portal_link_counter: number }>(
      'SELECT portal_link_counter::integer FROM student_portal.academic_revision WHERE academic_year=2026',
    )).rows[0]!.portal_link_counter;
    const first = await persistence.transaction(async (tx) => tx.insertAccount(account()));
    const second = await persistence.transaction(async (tx) => tx.insertAccount(account()));
    expect(first).toBe('created');
    expect(second).toBe('existing');
    const found = await persistence.transaction(async (tx) => tx.findByLink({ academicYear: 2026, studentId: 1 }));
    expect(found).toMatchObject({ id: ACCOUNT, version: 0, state: 'pending-activation', eligibility: 'eligible' });
    const after = (await pg.query<{ portal_link_counter: number }>(
      'SELECT portal_link_counter::integer FROM student_portal.academic_revision WHERE academic_year=2026',
    )).rows[0]!.portal_link_counter;
    expect(after).toBe(before + 1);
  });

  it('reads pre-transition birth, verifiers, challenge and opaque session hashes', async () => {
    await pg.query(`INSERT INTO student_portal.account_access_data(account_id,birth_year,confirmation,version)
      VALUES($1,2012,'unconfirmed-test',1)`,[ACCOUNT]);
    const birth = await persistence.transaction(async (tx) => {
      return tx.readBirth(ACCOUNT);
    });
    expect(birth).toEqual({ accountId: ACCOUNT, year: '2012', confirmation: 'unconfirmed-test', version: 1 });

    const verifier = { algorithm: 'synthetic-kdf', parameters: { cost: 1 }, salt: 'synthetic-salt', pepperVersion: 1, digest: 'synthetic-digest' };
    await persistence.transaction(async (tx) => {
      await tx.saveCredentials({ accountId: ACCOUNT, credentialId: 'A'.repeat(32), keyVersion: 1, state: 'active', pin: verifier, password: null, pinVersion: 0 });
      await tx.saveChallenge({ tokenHash: 'challenge-hash', accountId: ACCOUNT, securityVersion: 0, pinVersion: 0, expiresAt: '2026-12-01T12:00:00.000Z', consumedAt: null });
      await tx.saveSession({ id: '33333333-3333-4333-8333-333333333333', accountId: ACCOUNT, tokenHash: 'session-hash', securityVersion: 0, expiresAt: '2026-12-01T12:00:00.000Z', revokedAt: null, persistent: true });
    });
    expect(await persistence.transaction(async (tx) => tx.readCredentials(ACCOUNT))).toMatchObject({ credentialId: 'A'.repeat(32), pin: verifier, password: null });
    expect(await persistence.findSessionByHash('session-hash')).toMatchObject({ accountId: ACCOUNT, tokenHash: 'session-hash', persistent: true });
    expect(await persistence.transaction(async (tx) => tx.consumeChallenge('challenge-hash', 0, 0, '2026-11-01T12:00:00.000Z'))).toBe(true);
    expect(await persistence.transaction(async (tx) => tx.consumeChallenge('challenge-hash', 0, 0, '2026-11-01T12:00:01.000Z'))).toBe(false);
  });

  it('rolls back account and revision changes as one PostgreSQL transaction', async () => {
    const before = (await pg.query<{ portal_link_counter: number }>(
      'SELECT portal_link_counter::integer FROM student_portal.academic_revision WHERE academic_year=2026',
    )).rows[0]!.portal_link_counter;
    await expect(persistence.transaction(async (tx) => {
      await tx.insertAccount(account(ACCOUNT_TWO, 2));
      throw new Error('synthetic-rollback');
    })).rejects.toThrow('synthetic-rollback');
    expect((await pg.query('SELECT id FROM student_portal.account WHERE id=$1', [ACCOUNT_TWO])).rows).toEqual([]);
    const after = (await pg.query<{ portal_link_counter: number }>(
      'SELECT portal_link_counter::integer FROM student_portal.academic_revision WHERE academic_year=2026',
    )).rows[0]!.portal_link_counter;
    expect(after).toBe(before);
  });

  it('updates account state with CAS but refuses a stale version', async () => {
    const current = await persistence.transaction(async (tx) => tx.findAccount(ACCOUNT));
    expect(current).not.toBeNull();
    const updated = { ...current!, state: 'active' as const, blocked: true, version: 1, securityVersion: 1 };
    expect(await persistence.transaction(async (tx) => tx.compareAndSetAccount(updated, 0))).toBe(true);
    expect(await persistence.transaction(async (tx) => tx.compareAndSetAccount({ ...updated, version: 2 }, 0))).toBe(false);
  });

  it('stores idempotency receipts and append-only audit events without secrets', async () => {
    const key = '44444444-4444-4444-8444-444444444444';
    await persistence.transaction(async (tx) => {
      await tx.saveIdempotency({ key, actorId: ACCOUNT, requestDigest: 'a'.repeat(64), operationId: '55555555-5555-4555-8555-555555555555', version: 1, expiresAt: '2026-12-01T12:00:00.000Z' });
      await tx.appendAudit({
        eventId: '66666666-6666-4666-8666-666666666666', at: '2026-11-01T12:00:00.000Z', actorId: ACCOUNT,
        accountId: ACCOUNT, scope: { kind: 'account', academicYear: 2026, accountId: ACCOUNT },
        kind: 'blocked', result: 'success', requestId: '77777777-7777-4777-8777-777777777777', version: 1, maskedIp: null,
      });
    });
    expect(await persistence.transaction(async (tx) => tx.readIdempotency(key, ACCOUNT))).toMatchObject({ key, requestDigest: 'a'.repeat(64), version: 1 });
    expect((await pg.query(`SELECT kind,result,raw_ip FROM student_portal.audit_event WHERE event_id='66666666-6666-4666-8666-666666666666'`)).rows)
      .toEqual([{ kind: 'blocked', result: 'success', raw_ip: null }]);
  });

  it('closes all live 2026 links explicitly, revokes sessions and preserves tombstones', async () => {
    const closed = await persistence.transaction(async (tx) => tx.closeAcademicLinks(2026, 1, '2026-11-02T12:00:00.000Z'));
    expect(closed).toBe(1);
    expect(await persistence.transaction(async (tx) => tx.findByLink({ academicYear: 2026, studentId: 1 }))).toBeNull();
    expect((await pg.query('SELECT academic_year,gradebook_student_id FROM student_portal.link_closure WHERE account_id=$1', [ACCOUNT])).rows)
      .toEqual([{ academic_year: 2026, gradebook_student_id: 1 }]);
    expect(await persistence.findSessionByHash('session-hash')).toMatchObject({ revokedAt: '2026-11-02T12:00:00.000Z' });
  });
});
