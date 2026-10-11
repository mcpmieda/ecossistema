import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BirthYearServiceV1 } from '../birth-year/legacy-birth-fixture-v1';
import type { CryptoPortV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';

const ACTOR = '11111111-1111-4111-8111-111111111111';
let pg: PGlite;
let service: BirthYearServiceV1;
let sql: StudentPortalPostgresSqlV1;
let ids: string[];
let failCrypto = false;
let failAudit = false;
const syntheticSecrets = new Map<string, string>();
const unused = () => { throw new Error('synthetic-unused-crypto-method'); };
const cryptoPort: CryptoPortV1 = {
  randomToken: unused, hashOpaqueToken: unused, signQr: unused, verifyQr: unused,
  async deriveVerifier(secret, pepperVersion) {
    if (failCrypto) throw new Error('synthetic-crypto-failure');
    const digest = crypto.randomUUID();
    syntheticSecrets.set(digest, secret);
    return { algorithm: 'synthetic-port-only', parameters: {}, salt: crypto.randomUUID(), pepperVersion, digest };
  },
  async verifySecret(secret, verifier) { return syntheticSecrets.get(verifier.digest) === secret; },
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(`INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES
      (900001,2026,'B1','SYNTHETIC BIRTH CLASS',6,'TESTE'),(900002,2026,'B2','SYNTHETIC OTHER CLASS',6,'TESTE');
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES
      (900001,2026,'SYNTHETIC BIRTH ONE'),(900002,2026,'SYNTHETIC BIRTH TWO'),(900003,2026,'SYNTHETIC BIRTH OTHER');
    INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES
      (2026,900001,1,900001),(2026,900001,2,900002),(2026,900002,1,900003);
    SELECT * FROM student_portal.synchronize_profiles_v1(true);`);
  ids = (await pg.query<{ id: string }>('SELECT id FROM student_portal.account ORDER BY gradebook_student_id')).rows.map((row) => row.id);
  const run = async <R extends Record<string, unknown>>(target: Pick<PGlite, 'query'>, query: string, parameters: readonly unknown[] = []) => {
    if (failAudit && query.includes('INSERT INTO student_portal.audit_event')) throw new Error('synthetic-audit-failure');
    return (await target.query<R>(query, [...parameters])).rows;
  };
  sql = { unsafe: (query, parameters) => run(pg, query, parameters), begin: (operation) => pg.transaction((tx) => operation({
    unsafe: (query, parameters) => run(tx, query, parameters),
  })) };
  service = new BirthYearServiceV1(sql, cryptoPort, 1);
}, 30_000);

beforeEach(async () => {
  failCrypto = false;
  failAudit = false;
  syntheticSecrets.clear();
  await pg.exec(`TRUNCATE student_portal.operation_receipt,student_portal.audit_event,student_portal.account_access_data,
    student_portal.password_credential,student_portal.qr_credential,student_portal.session,student_portal.auth_challenge;
    UPDATE student_portal.account SET version=0,pin_version=0,security_version=0,auth_state='pending-activation';
    UPDATE gradebook.vinculo SET turma_id=900001 WHERE aluno_id IN (900001,900002);`);
});
afterAll(async () => { await pg?.close(); });

async function command(index = 0, action: 'set' | 'clear' = 'set', year = '2001', confirmation: 'confirmed' | 'unconfirmed-test' = 'unconfirmed-test') {
  const rows = (await pg.query<{ version: number; birth: number }>(`SELECT a.version::integer,COALESCE(d.version,0)::integer AS birth
    FROM student_portal.account a LEFT JOIN student_portal.account_access_data d ON d.account_id=a.id WHERE a.id=$1`, [ids[index]])).rows;
  return { contractVersion: 1, operation: 'birth-write', expectedVersion: rows[0]!.version, idempotencyKey: crypto.randomUUID(),
    item: { action, accountId: ids[index]!, expectedVersion: rows[0]!.birth, ...(action === 'set' ? { year, confirmation } : {}) } };
}
async function batch(items: unknown[]) {
  return { contractVersion: 1, operation: 'birth-batch', expectedVersion: (await service.readClass(900001)).scopeVersion,
    idempotencyKey: crypto.randomUUID(), classId: 900001, expectedCount: items.length, items, confirmed: true };
}
async function security() {
  return {
    account: (await pg.query('SELECT auth_state,security_version::integer,pin_version::integer,version::integer FROM student_portal.account WHERE id=$1', [ids[0]])).rows[0],
    credential: (await pg.query<Record<string, unknown>>('SELECT pin_verifier,password_verifier,pin_version::integer FROM student_portal.password_credential WHERE account_id=$1', [ids[0]])).rows[0],
    qr: (await pg.query('SELECT credential_id,state FROM student_portal.qr_credential WHERE account_id=$1', [ids[0]])).rows,
    sessions: (await pg.query('SELECT token_hash,security_version::integer,revoked_at FROM student_portal.session WHERE account_id=$1', [ids[0]])).rows,
  };
}

describe('birth year transactions through the frozen crypto port', () => {
  it('reads BN names with bounded keyset pages and separate scope/account/field versions', async () => {
    const first = await service.readClass(900001, 1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ name: expect.stringContaining('SYNTHETIC BIRTH'), year: null, confirmation: null, accountVersion: 0, version: 0 });
    const second = await service.readClass(900001, 1, first.nextAccountId!);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.accountId).not.toBe(first.items[0]!.accountId);
    expect(second.nextAccountId).toBeNull();
    await expect(service.readClass(900001, 101)).rejects.toThrow();
  });

  it('rejects partial/empty/out-of-range input without clearing and requires explicit confirmation provenance', async () => {
    await service.write(ACTOR, await command());
    for (const year of ['', '20', '200', '1899', '2027', '20010', ' 2001']) {
      await expect(service.write(ACTOR, await command(0, 'set', year))).rejects.toThrow();
    }
    const missing = await command();
    await expect(service.write(ACTOR, { ...missing, item: { ...missing.item, confirmation: undefined } })).rejects.toThrow();
    expect((await service.readClass(900001)).items.find((item) => item.accountId === ids[0])).toMatchObject({ year: '2001', confirmation: 'unconfirmed-test', version: 1 });
  });

  it('creates PIN before QR exists, replays a lost response and rejects a different payload', async () => {
    const input = await command();
    const first = await service.write(ACTOR, input);
    expect(await service.write(ACTOR, input)).toEqual(first);
    await expect(service.write(ACTOR, { ...input, item: { ...input.item, year: '2002' } })).rejects.toThrow('student-portal-birth-idempotency-conflict');
    const state = await security();
    expect(state.qr).toEqual([]);
    expect(state.account).toMatchObject({ pin_version: 1, version: 1 });
    expect(state.credential).toMatchObject({ password_verifier: null, pin_version: 1 });
    expect(JSON.stringify(state.credential)).not.toContain('2001');
  });

  it('accepts the frozen range endpoints and keeps explicit clear idempotent', async () => {
    await service.write(ACTOR, await command(0, 'set', '1900'));
    await service.write(ACTOR, await command(0, 'set', '2026'));
    const clear = await command(0, 'clear');
    const first = await service.write(ACTOR, clear);
    expect(await service.write(ACTOR, clear)).toEqual(first);
    await service.write(ACTOR, await command(0, 'clear'));
    expect((await security()).account).toMatchObject({ version: 3, pin_version: 3 });
    expect((await service.readClass(900001)).items.find((item) => item.accountId === ids[0])).toMatchObject({ year: null, confirmation: null, version: 3 });
  });

  it('rejects stale aggregate and birth CAS from two tabs without lost updates', async () => {
    const first = await command();
    const second = await command(0, 'set', '2002');
    await service.write(ACTOR, second);
    await expect(service.write(ACTOR, first)).rejects.toThrow('student-portal-birth-version-conflict');
    await expect(service.write(ACTOR, { ...first, expectedVersion: 1 })).rejects.toThrow('student-portal-birth-conflict');
    expect((await service.readClass(900001)).items.find((item) => item.accountId === ids[0])?.year).toBe('2002');
  });

  it('corrects and clears PIN atomically while preserving active password, QR and session', async () => {
    await service.write(ACTOR, await command());
    const password = await cryptoPort.deriveVerifier('synthetic-password', 1);
    await pg.query(`UPDATE student_portal.password_credential SET password_verifier=$1::jsonb WHERE account_id=$2`, [JSON.stringify(password), ids[0]]);
    await pg.query(`UPDATE student_portal.account SET auth_state='active' WHERE id=$1`, [ids[0]]);
    await pg.query(`INSERT INTO student_portal.qr_credential(credential_id,account_id,key_version,state) VALUES (repeat('q',32),$1,1,'active')`, [ids[0]]);
    await pg.query(`INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES (gen_random_uuid(),$1,repeat('s',32),0,now()+interval '1 day',true)`, [ids[0]]);
    await pg.query(`INSERT INTO student_portal.auth_challenge(token_hash,account_id,security_version,pin_version,expires_at)
      VALUES (repeat('c',32),$1,0,1,now()+interval '5 minutes')`, [ids[0]]);
    const before = await security();
    await service.write(ACTOR, await command(0, 'set', '2002'));
    const corrected = await security();
    expect(corrected.account).toMatchObject({ auth_state: 'active', security_version: 0, pin_version: 2 });
    expect(corrected.qr).toEqual(before.qr);
    expect(corrected.sessions).toEqual(before.sessions);
    expect(corrected.credential?.password_verifier).toEqual(password);
    const verifier = corrected.credential?.pin_verifier as Awaited<ReturnType<CryptoPortV1['deriveVerifier']>>;
    expect(await cryptoPort.verifySecret('2001', verifier)).toBe(false);
    expect(await cryptoPort.verifySecret('2002', verifier)).toBe(true);
    expect((await pg.query('SELECT consumed_at IS NOT NULL AS consumed FROM student_portal.auth_challenge')).rows).toEqual([{ consumed: true }]);
    await service.write(ACTOR, await command(0, 'clear'));
    const cleared = await security();
    expect(cleared.credential).toMatchObject({ pin_verifier: null, password_verifier: password, pin_version: 3 });
    expect(cleared.sessions).toEqual(before.sessions);
    expect(cleared.qr).toEqual(before.qr);
    expect(cleared.account).toMatchObject({ auth_state: 'active', security_version: 0 });
    const auditRows = (await pg.query<Record<string, unknown>>('SELECT * FROM student_portal.audit_event')).rows;
    for (const event of auditRows) {
      // UUIDs/timestamps may contain the same digits as a year; forbid secret
      // values and extra payload fields, not coincidental identifier substrings.
      expect(Object.keys(event).sort()).toEqual([
        'event_id', 'occurred_at', 'actor_id', 'account_id', 'scope_json', 'kind',
        'result', 'request_id', 'version', 'masked_ip', 'raw_ip', 'ip_expires_at', 'created_at',
        'detail_json',
      ].sort());
      // Sign-in details (0023) never travel with a birth-year change.
      expect(event.detail_json).toBeNull();
      expect(event.scope_json).toEqual({ kind: 'account', academicYear: 2026, accountId: ids[0] });
    }
    expect(JSON.stringify(auditRows)).not.toMatch(/"(?:2001|2002)"|:(?:2001|2002)(?=[,}])|synthetic-password/);
  });

  it('does not silently promote an unconfirmed record or churn versions on an identical value', async () => {
    await service.write(ACTOR, await command());
    await service.write(ACTOR, await command());
    expect((await service.readClass(900001)).items.find((item) => item.accountId === ids[0])).toMatchObject({ confirmation: 'unconfirmed-test', version: 1 });
    expect((await security()).account).toMatchObject({ version: 1, pin_version: 1 });
    await service.write(ACTOR, await command(0, 'set', '2001', 'confirmed'));
    expect((await service.readClass(900001)).items.find((item) => item.accountId === ids[0])).toMatchObject({ confirmation: 'confirmed', version: 2 });
  });

  it('rolls back birth, PIN, account and receipt when crypto or audit fails', async () => {
    const input = await command();
    failCrypto = true;
    await expect(service.write(ACTOR, input)).rejects.toThrow('synthetic-crypto-failure');
    failCrypto = false;
    failAudit = true;
    await expect(service.write(ACTOR, input)).rejects.toThrow('synthetic-audit-failure');
    failAudit = false;
    expect((await security()).credential).toBeUndefined();
    expect((await security()).account).toMatchObject({ version: 0, pin_version: 0 });
    expect((await pg.query('SELECT count(*)::integer AS count FROM student_portal.account_access_data')).rows).toEqual([{ count: 0 }]);
    expect((await pg.query('SELECT count(*)::integer AS count FROM student_portal.operation_receipt')).rows).toEqual([{ count: 0 }]);
    await expect(service.write(ACTOR, input)).resolves.toMatchObject({ version: 1 });
  });

  it('returns and replays mixed batch results without repeating committed items', async () => {
    const input = await batch([(await command(0)).item, { ...(await command(1)).item, expectedVersion: 99 }, (await command(2)).item]);
    const first = await service.batch(ACTOR, input);
    expect(first.items).toEqual([{ accountId: ids[0], state: 'committed', version: 1 },
      { accountId: ids[1], state: 'unavailable', version: 99 }, { accountId: ids[2], state: 'unavailable', version: 0 }]);
    const resumed = await service.batch(ACTOR, input);
    expect(resumed.items).toEqual([first.items[0], { accountId: ids[1], state: 'conflict', version: 0 }, { accountId: ids[2], state: 'forbidden', version: 0 }]);
    expect(await service.batch(ACTOR, input)).toEqual(resumed);
    expect((await security()).account).toMatchObject({ pin_version: 1 });
    await expect(service.batch(ACTOR, { ...input, items: input.items.slice().reverse() })).rejects.toThrow('student-portal-birth-idempotency-conflict');
  });

  it('rechecks class and scope, bounds the batch, and resumes transient failures without duplicate work', async () => {
    const input = await batch([(await command(0)).item, (await command(1)).item]);
    failCrypto = true;
    expect((await service.batch(ACTOR, input)).items.every((item) => item.state === 'unavailable')).toBe(true);
    failCrypto = false;
    await pg.exec('UPDATE gradebook.vinculo SET turma_id=900002 WHERE aluno_id=900002');
    expect((await service.batch(ACTOR, input)).items.map((item) => item.state)).toEqual(['committed', 'unavailable']);
    expect((await service.batch(ACTOR, input)).items.map((item) => item.state)).toEqual(['committed', 'forbidden']);
    await expect(service.batch(ACTOR, { ...input, idempotencyKey: crypto.randomUUID(), expectedVersion: 999 })).rejects.toThrow('student-portal-birth-scope-conflict');
    await expect(service.batch(ACTOR, { ...input, items: [input.items[0], input.items[0]] })).rejects.toThrow();
    await expect(service.batch(ACTOR, { ...input, expectedCount: 101, items: Array(101).fill(input.items[0]) })).rejects.toThrow();
  });
});
