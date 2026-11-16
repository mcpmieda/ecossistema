// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import { checkPortalOperationV1 } from '../../../server/student-portal/observability/operation-burst-v1';
import { SessionServiceV1 } from '../../../server/student-portal/auth/session-service-v1';
import { readOwnPortraitV1 } from '../../../server/student-portal/photos/read-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
import { syntheticWebpV1, syntheticPhotoHashV1, photoRevisionFixtureV1, otherPhotoRevisionV1, photoSourceV1, photoActorV1 } from './fixture-v1';

let pg: PGlite;
let sql: StudentPortalPostgresSqlV1;
let policy: PolicyServiceV1;
let owners: { id: string; student_uid: string }[];
let statements: string[] = [];
const cryptography = new PortalCryptoV1(new Map([[1,new Uint8Array(32).fill(11)]]),new Map([[1,new Uint8Array(32).fill(22)]]));
const tokenA = cryptography.randomToken(32), tokenB = cryptography.randomToken(32);
const school = { kind: 'school', academicYear: 2026 } as const;
const storageRead = async () => syntheticWebpV1();

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql','utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(readFileSync('migrations/student-portal/0018_shared_student_identity_v1.sql','utf8'));
  await pg.exec(readFileSync('migrations/student-photos/0001_private_delivery_v1.sql','utf8'));
  await pg.exec('ALTER TABLE student_photos.portal_delivery_v1 ADD COLUMN storage_path text; ALTER TABLE student_photos.portal_delivery_v1 ADD COLUMN byte_size integer;');
  await pg.exec(`INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES (901,2026,'PHOTO','SYNTHETIC PHOTO CLASS',6,'TEST');
    INSERT INTO gradebook.aluno(id,ano,nome) VALUES (901,2026,'SYNTHETIC PHOTO A'),(902,2026,'SYNTHETIC PHOTO B');
    INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES (2026,901,1,901),(2026,901,2,902);
    SELECT * FROM student_portal.synchronize_profiles_v1(true);`);
  owners = (await pg.query<{ id: string; student_uid: string }>('SELECT id,student_uid FROM student_portal.account ORDER BY gradebook_student_id')).rows;
  const run = async <R extends Record<string, unknown>>(db: Pick<PGlite,'query'>, query: string, parameters: readonly unknown[] = []) => {
    statements.push(query); return (await db.query<R>(query,[...parameters])).rows;
  };
  sql = { unsafe: (query,parameters) => run(pg,query,parameters),
    begin: operation => pg.transaction(tx => operation({ unsafe: (query,parameters) => run(tx,query,parameters) })) };
  policy = new PolicyServiceV1(sql);
}, 30_000);

beforeEach(async () => {
  await pg.exec(`TRUNCATE student_photos.portal_delivery_v1,student_portal.session,student_portal.setting,
    student_portal.operation_receipt,student_portal.audit_event;
    UPDATE student_portal.account SET auth_state='active',blocked=false,eligibility='eligible',security_version=0;
    UPDATE gradebook.vinculo SET situacao=NULL;`);
  await policy.initializeDefaults();
  const current = await policy.read(school), now = Math.floor(Date.now()/1000)*1000;
  await policy.mutate(photoActorV1,{ contractVersion:1,operation:'settings-set',scope:school,expectedVersion:current.version,
    idempotencyKey:crypto.randomUUID(),acknowledgeImmediateEffect:true,value:{accessEnabled:true,
      calendar:{...current.value.calendar,yearStartsAt:new Date(now-86400_000).toISOString(),yearEndsAt:new Date(now+30*86400_000).toISOString()}} });
  for (let index=0;index<2;index++) {
    const owner=owners[index]!;
    await pg.query(`INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent)
      VALUES ($1::uuid,$2::uuid,$3,0,statement_timestamp()+interval '1 hour',false)`,
    [crypto.randomUUID(),owner.id,await cryptography.hashOpaqueToken(index===0?tokenA:tokenB)]);
    await pg.query(`INSERT INTO student_photos.portal_delivery_v1
      (student_uid,revision,source_revision,approved_source_revision,source_sha256,portrait_sha256,width,height,storage_path,byte_size,
      image_use_authorized,authorized_by,authorized_at,authorization_reference,approved_by,approved_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,$4,3,4,$5,$7,true,$6::uuid,statement_timestamp(),
      'synthetic-school-authorization',$6::uuid,statement_timestamp())`,
    [owner.student_uid,index===0?photoRevisionFixtureV1:otherPhotoRevisionV1,photoSourceV1,syntheticPhotoHashV1,
      `legacy/${owner.student_uid}/${syntheticPhotoHashV1}.webp`,photoActorV1,syntheticWebpV1().length]);
  }
  statements=[];
}, 30_000);
afterAll(async () => { await pg?.close(); });

it('uses the real SessionService for metadata and content, with independent account and student IDs', async () => {
  expect(owners[0]!.id).not.toBe(owners[0]!.student_uid);
  const meta=await readOwnPortraitV1(sql,cryptography,tokenA,null);
  expect(meta).toMatchObject({state:'metadata',metadata:{accountId:owners[0]!.id,revision:photoRevisionFixtureV1}});
  const selection=statements.find(query=>query.includes('JOIN student_photos.portal_delivery_v1'))!.split('FROM')[0]!;
  expect(selection).not.toContain('image_webp'); expect(selection).not.toContain('authorization_reference');
  const image=await readOwnPortraitV1(sql,cryptography,tokenA,photoRevisionFixtureV1,storageRead);
  expect(image?.state).toBe('content');
  if(image?.state==='content') expect(image.bytes).toEqual(syntheticWebpV1());
});

it('does not authorize another student by UID knowledge or another valid photo revision', async () => {
  expect(await readOwnPortraitV1(sql,cryptography,tokenA,otherPhotoRevisionV1,storageRead)).toEqual({state:'absent'});
  expect(await readOwnPortraitV1(sql,cryptography,tokenB,photoRevisionFixtureV1,storageRead)).toEqual({state:'absent'});
  expect(await readOwnPortraitV1(sql,cryptography,cryptography.randomToken(32),photoRevisionFixtureV1,storageRead)).toBeNull();
});

it.each([
  "UPDATE student_portal.account SET blocked=true",
  "UPDATE student_portal.account SET security_version=security_version+1",
  "UPDATE student_portal.session SET revoked_at=statement_timestamp()",
  // Keep created_at < expires_at so this tests authorization, not invalid fixture DML.
  "UPDATE student_portal.session SET created_at=statement_timestamp()-interval '2 hours', expires_at=statement_timestamp()-interval '1 second'",
  // 3/4/5 are actual exit states; status 6 is transfer history and needs a related class.
  "UPDATE gradebook.vinculo SET situacao=3",
  "UPDATE gradebook.vinculo SET situacao=4",
  "UPDATE gradebook.vinculo SET situacao=5",
])('refuses delivery after %s, before selecting photo data', async statement => {
  await pg.exec(statement);
  expect(await readOwnPortraitV1(sql,cryptography,tokenA,photoRevisionFixtureV1,storageRead)).toBeNull();
  expect(statements.some(query=>query.includes('JOIN student_photos.portal_delivery_v1'))).toBe(false);
});

it('refuses accessEnabled=false with the existing policy service, not a separate photo-specific access rule', async () => {
  const current=await policy.read(school);
  await policy.mutate(photoActorV1,{contractVersion:1,operation:'settings-set',scope:school,expectedVersion:current.version,
    idempotencyKey:crypto.randomUUID(),acknowledgeImmediateEffect:true,value:{accessEnabled:false}});
  statements=[];
  expect(await readOwnPortraitV1(sql,cryptography,tokenA,photoRevisionFixtureV1,storageRead)).toBeNull();
  expect(statements.some(query=>query.includes('JOIN student_photos.portal_delivery_v1'))).toBe(false);
});

it.each([
  'image_use_authorized=false',
  'approved_at=NULL,approved_by=NULL,approved_source_revision=NULL',
  'revoked_at=statement_timestamp(),storage_path=NULL',
])('withholds delivery for %s without revoking the student session', async change => {
  await pg.exec('UPDATE student_photos.portal_delivery_v1 SET '+change);
  expect(await readOwnPortraitV1(sql,cryptography,tokenA,null)).toEqual({state:'absent'});
});

it('rejects corrupt stored bytes without returning them as an image', async () => {
  await pg.exec("UPDATE student_photos.portal_delivery_v1 SET portrait_sha256=repeat('0',64)");
  await expect(readOwnPortraitV1(sql,cryptography,tokenA,photoRevisionFixtureV1,storageRead)).rejects.toThrow('student-photo-content-invalid');
});


it('aggregates verified sessions of A, keeps B independent and leaves logout usable after a read block', async () => {
  const secondTokenA = cryptography.randomToken(32);
  await pg.query(`INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent)
    VALUES ($1::uuid,$2::uuid,$3,0,statement_timestamp()+interval '1 hour',false)`,
  [crypto.randomUUID(), owners[0]!.id, await cryptography.hashOpaqueToken(secondTokenA)]);
  const calls = new Map<string, number>();
  const limiter = { limit: vi.fn(async ({ key }: { key: string }) => {
    calls.set(key, (calls.get(key) ?? 0) + 1); return { success: calls.get(key) === 1 };
  }) };
  const gate = (accountId: string) => checkPortalOperationV1(limiter, 'photo', accountId);
  expect((await readOwnPortraitV1(sql, cryptography, tokenA, null, storageRead, gate))?.state).toBe('metadata');
  statements = [];
  await expect(readOwnPortraitV1(sql, cryptography, secondTokenA, null, storageRead, gate)).rejects.toMatchObject({ state: 'rate-limited' });
  expect(statements.some(query => query.includes('JOIN student_photos.portal_delivery_v1'))).toBe(false);
  expect((await readOwnPortraitV1(sql, cryptography, tokenB, null, storageRead, gate))?.state).toBe('metadata');
  expect(new Set(limiter.limit.mock.calls.map(([input]) => input.key)).size).toBe(2);
  const logoutGuard = vi.fn(async (id: string) => { expect(id).toBe(owners[0]!.id); });
  await new SessionServiceV1(sql, cryptography).logout(tokenA, crypto.randomUUID(), logoutGuard);
  expect(logoutGuard).toHaveBeenCalledTimes(1);
  expect(await readOwnPortraitV1(sql, cryptography, tokenA, null, storageRead, gate)).toBeNull();
  expect(limiter.limit).toHaveBeenCalledTimes(3);
});

it('does not leak content or revoke the session when its required limiter is unavailable', async () => {
  const missing = (id: string) => checkPortalOperationV1(undefined, 'photo', id);
  statements = [];
  await expect(readOwnPortraitV1(sql, cryptography, tokenA, null, storageRead, missing)).rejects.toMatchObject({ state: 'unavailable' });
  expect(statements.some(query => query.includes('JOIN student_photos.portal_delivery_v1'))).toBe(false);
  await expect(new SessionServiceV1(sql, cryptography).logout(tokenA, crypto.randomUUID(), missing)).rejects.toMatchObject({ state: 'unavailable' });
  expect((await readOwnPortraitV1(sql, cryptography, tokenA, null))?.state).toBe('metadata');
});
