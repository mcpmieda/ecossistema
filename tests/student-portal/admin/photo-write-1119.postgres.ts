import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PhotoWriteRepositoryV1, type PhotoWriteDatabaseV1 } from '../../../server/student-photos/write-repository-v1';
import { PhotoWriteCoordinatorV1, type PhotoWritePortsV1 } from '../../../server/student-photos/write-coordinator-v1';
import { type PhotoAssetsV1, type PhotoWriteContextV1, type PhotoWritePlanV1, type PhotoWriteCommandV1 } from '../../../shared/student-photos/write-v1';
import { syntheticWebpV1, syntheticPhotoHashV1 } from '../photos/fixture-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1'
  || target.pathname !== '/portal705_test' || target.search || target.hash)
  throw new Error('Photo write tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const name = 'photo_write_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let db: ReturnType<typeof postgres>;
let created = false;
let repository: PhotoWriteRepositoryV1;
const actor = '10000000-0000-4000-8000-000000000001';
const noAssets: PhotoAssetsV1 = { portrait: null, avatar: null };
const noPlan: PhotoWritePlanV1 = { portrait: null, avatar: null };
const plan: PhotoWritePlanV1 = {
  portrait: { sha256: 'a'.repeat(64), byteSize: 64, width: 3, height: 4 },
  avatar: { sha256: 'b'.repeat(64), byteSize: 64, width: 1, height: 1 },
};
function command(kind: PhotoWriteCommandV1['kind'], expectedRevision: string | null = null): PhotoWriteCommandV1 {
  return { kind, expectedRevision, requestId: crypto.randomUUID() };
}
function assets(suffix: string): PhotoAssetsV1 {
  return {
    portrait: { ...plan.portrait!, driveId: 'synthetic-drive', itemId: 'portrait-' + suffix, etag: 'etag-p-' + suffix },
    avatar: { ...plan.avatar!, driveId: 'synthetic-drive', itemId: 'avatar-' + suffix, etag: 'etag-a-' + suffix },
  };
}
async function context(): Promise<PhotoWriteContextV1> {
  const studentUid = crypto.randomUUID();
  await db.unsafe('INSERT INTO gradebook.student_identity(id) VALUES ($1::uuid)', [studentUid]);
  return { studentUid, actorId: actor };
}
function database(connection: ReturnType<typeof postgres>): PhotoWriteDatabaseV1 {
  return { transaction: async work => {
    // Box the value so postgres.begin does not reinterpret a generic array result.
    const box = await connection.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE gradebook_app');
      const value = await work({ query: async (text, values = []) => Array.from(await tx.unsafe(text, [...values] as never[], { prepare: false })) });
      return { value };
    });
    return box.value;
  } };
}
async function current(ctx: PhotoWriteContextV1) {
  const rows = await db.unsafe('SELECT revision::text,pending_request::text,assets FROM student_photos.photo_family_v1 WHERE student_uid=$1::uuid', [ctx.studentUid]);
  return rows[0]!;
}
async function seedFamily(ctx: PhotoWriteContextV1) {
  const request = command('replace');
  const uploaded = assets(request.requestId);
  await repository.claim(ctx, request, plan);
  await repository.commit(ctx, request.requestId, uploaded);
  await repository.complete(ctx, request.requestId);
  return { request, uploaded };
}
async function seedApprovedDelivery(ctx: PhotoWriteContextV1, revision: string) {
  await db.unsafe(`INSERT INTO student_photos.portal_delivery_v1
    (student_uid,revision,source_revision,approved_source_revision,source_sha256,portrait_sha256,width,height,image_webp,
      image_use_authorized,authorized_by,authorized_at,authorization_reference,approved_by,approved_at)
    VALUES ($1::uuid,$2::uuid,$2::uuid,$2::uuid,$3,$3,3,4,$4,true,$5::uuid,
      statement_timestamp(),'synthetic-private-reference',$5::uuid,statement_timestamp())`,
  [ctx.studentUid,revision,syntheticPhotoHashV1,syntheticWebpV1(),actor]);
}
async function deliveryBytes(ctx: PhotoWriteContextV1) {
  const rows = await db.unsafe('SELECT image_webp IS NOT NULL AS available FROM student_photos.portal_delivery_v1 WHERE student_uid=$1::uuid', [ctx.studentUid]);
  return rows[0]!.available;
}

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name); created = true;
  const url = new URL(target); url.pathname = '/' + name;
  db = postgres(url.toString(), { max: 4, onnotice: () => undefined });
  await db.unsafe(`DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['gradebook_app','student_portal_app','anon','authenticated','service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS',r);
      END IF;
    END LOOP;
  END $$;
  CREATE SCHEMA gradebook;
  CREATE TABLE gradebook.student_identity(id uuid PRIMARY KEY);`, [], { prepare: false });
  // The migration owns BEGIN/COMMIT: reserve its connection rather than running
  // an explicit transaction across an unconstrained pool. Keep four connections
  // for the concurrency tests; the driver's unsafe-transaction guard stays on.
  const migrationConnection = await db.reserve();
  try {
    for (const migration of ['0001_private_delivery_v1.sql','0002_write_journal_v1.sql'])
      await migrationConnection.unsafe(readFileSync('migrations/student-photos/' + migration,'utf8'), [], { prepare: false });
  } finally { await migrationConnection.release(); }
  repository = new PhotoWriteRepositoryV1(database(db));
}, 30_000);
afterAll(async () => {
  await db?.end({ timeout: 2 });
  try { if (created) await cluster.unsafe('DROP DATABASE ' + name); }
  finally { await cluster.end({ timeout: 2 }); }
});

it('preserves the old photo until commit and binds a receipt to the exact actor/person/payload', async () => {
  const ctx = await context(), initial = await seedFamily(ctx);
  await seedApprovedDelivery(ctx, initial.request.requestId);
  const replacement = command('replace', initial.request.requestId);
  const claimed = await repository.claim(ctx,replacement,plan);
  expect(claimed.phase).toBe('prepared');
  expect((await current(ctx)).assets).toEqual(initial.uploaded);
  expect(await deliveryBytes(ctx)).toBe(true);
  expect(await repository.claim(ctx,replacement,plan)).toEqual(claimed);
  await expect(repository.claim(ctx,replacement,{ ...plan, portrait: { ...plan.portrait!, sha256: 'c'.repeat(64) } })).rejects.toMatchObject({ code: 'receipt-conflict' });
  await expect(repository.claim({ ...ctx, actorId: crypto.randomUUID() },replacement,plan)).rejects.toMatchObject({ code: 'receipt-conflict' });
  const other = await context();
  await expect(repository.claim(other,replacement,plan)).rejects.toMatchObject({ code: 'receipt-conflict' });
  const newAssets = assets(replacement.requestId);
  const committed = await repository.commit(ctx,replacement.requestId,newAssets);
  expect(committed.cleanup).toHaveLength(2);
  expect(await deliveryBytes(ctx)).toBe(false);
  expect(await repository.commit(ctx,replacement.requestId,newAssets)).toEqual(committed);
  expect((await current(ctx)).assets).toEqual(newAssets);
});

it('serializes two real concurrent editors and does not silently release a pending operation', async () => {
  const ctx = await context(), a = command('replace'), b = command('replace');
  const outcomes = await Promise.allSettled([repository.claim(ctx,a,plan),repository.claim(ctx,b,plan)]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const failed = outcomes.find(result => result.status === 'rejected');
  expect(failed).toMatchObject({ status: 'rejected', reason: { code: 'busy' } });
  expect(await db.unsafe('SELECT request_id FROM student_photos.write_operation_v1 WHERE student_uid=$1::uuid',[ctx.studentUid])).toHaveLength(1);
});

it('coalesces concurrent identical requests into one receipt and one prepared event', async () => {
  const ctx = await context(), request = command('replace');
  const [first,second] = await Promise.all([repository.claim(ctx,request,plan),repository.claim(ctx,request,plan)]);
  expect(second).toEqual(first);
  const audit = await db.unsafe('SELECT event FROM student_photos.write_audit_v1 WHERE request_id=$1::uuid',[request.requestId]);
  expect(audit.map(row => row.event)).toEqual(['prepared']);
});

it('changes only the avatar without touching the principal or its approved Portal copy', async () => {
  const ctx = await context(), initial = await seedFamily(ctx);
  await seedApprovedDelivery(ctx,initial.request.requestId);
  const request = command('avatar',initial.request.requestId), avatarPlan = { portrait: null, avatar: plan.avatar };
  await repository.claim(ctx,request,avatarPlan);
  const committed = await repository.commit(ctx,request.requestId,{ portrait: null, avatar: assets(request.requestId).avatar });
  expect(committed.assets.portrait).toEqual(initial.uploaded.portrait);
  expect(committed.cleanup).toEqual([initial.uploaded.avatar]);
  expect(await deliveryBytes(ctx)).toBe(true);
});

it('revokes immediately on remove, retains a tombstone, and completes only after distinct cleanup outcomes', async () => {
  const ctx = await context(), initial = await seedFamily(ctx);
  await seedApprovedDelivery(ctx,initial.request.requestId);
  const request = command('remove',initial.request.requestId);
  const receipt = await repository.claim(ctx,request,noPlan);
  expect(receipt.phase).toBe('committed');
  expect((await current(ctx)).assets).toEqual(noAssets);
  expect(await deliveryBytes(ctx)).toBe(false);
  await expect(repository.complete(ctx,request.requestId)).rejects.toMatchObject({ code: 'invalid' });
  await repository.acknowledgeCleanup(ctx,request.requestId,initial.uploaded.portrait!,'deleted');
  await repository.acknowledgeCleanup(ctx,request.requestId,initial.uploaded.portrait!,'deleted');
  await repository.acknowledgeCleanup(ctx,request.requestId,initial.uploaded.avatar!,'already-absent');
  await repository.complete(ctx,request.requestId);
  expect((await current(ctx)).revision).toBe(request.requestId);
  expect((await current(ctx)).pending_request).toBeNull();
  await expect(repository.claim(ctx,command('replace'),plan)).rejects.toMatchObject({ code: 'conflict' });
  await expect(repository.claim(ctx,command('replace',initial.request.requestId),plan)).rejects.toMatchObject({ code: 'conflict' });
  const audit = await db.unsafe('SELECT event FROM student_photos.write_audit_v1 WHERE request_id=$1::uuid ORDER BY id',[request.requestId]);
  expect(audit.map(row => row.event)).toEqual(['committed','cleanup-deleted','cleanup-already-absent','complete']);
});

it('rejects reusing old files or committing the wrong validated content', async () => {
  const ctx = await context(), initial = await seedFamily(ctx), request = command('replace',initial.request.requestId);
  await repository.claim(ctx,request,plan);
  await expect(repository.commit(ctx,request.requestId,initial.uploaded)).rejects.toMatchObject({ code: 'invalid' });
  await expect(repository.commit(ctx,request.requestId,{ ...assets(request.requestId), avatar: null })).rejects.toMatchObject({ code: 'invalid' });
  expect((await current(ctx)).assets).toEqual(initial.uploaded);
});

it('keeps private tables and audit immutable to readers, and does not grant direct publishing to the writer', async () => {
  for (const role of ['student_portal_app','anon','authenticated','service_role']) {
    for (const table of ['photo_family_v1','write_operation_v1','write_audit_v1']) {
      const rows = await db.unsafe('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed',[role,'student_photos.'+table]);
      expect(rows[0]!.allowed).toBe(false);
    }
  }
  for (const privilege of ['UPDATE','DELETE','TRUNCATE']) {
    const rows = await db.unsafe("SELECT has_table_privilege('gradebook_app','student_photos.write_audit_v1',$1) AS allowed",[privilege]);
    expect(rows[0]!.allowed).toBe(false);
  }
  const rows = await db.unsafe(`SELECT has_table_privilege('gradebook_app','student_photos.portal_delivery_v1','UPDATE') AS publish,
    has_function_privilege('gradebook_app','student_photos.revoke_changed_portrait_v1()','EXECUTE') AS execute`);
  expect(rows[0]).toEqual({ publish: false, execute: false });
});

it('rejects null identity fields in a persisted receipt instead of accepting SQL unknown', async () => {
  const ctx = await context(), request = command('replace');
  const before = await repository.claim(ctx,request,plan);
  for (const key of ['requestId','studentUid','actorId','inputHash','phase']) {
    await expect(db.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE gradebook_app');
      await tx.unsafe(`UPDATE student_photos.write_operation_v1
        SET receipt=jsonb_set(receipt,ARRAY[$2::text],'null'::jsonb) WHERE request_id=$1::uuid`,[request.requestId,key]);
    })).rejects.toMatchObject({ code:'23514' });
  }
  expect(await repository.claim(ctx,request,plan)).toEqual(before);
});

it('recovers a lost commit response without uploading again and keeps remote deletion failures pending', async () => {
  const ctx = await context(), initial = await seedFamily(ctx), request = command('replace',initial.request.requestId);
  const bytes = syntheticWebpV1();
  let uploads = 0, failCommitResponse = true, failDelete = true;
  const ports: PhotoWritePortsV1 = {
    authorize: async () => undefined,
    // This test isolates the journal; the codec is a synthetic port, NOT production decoding proof.
    validate: async (value,variant) => ({ bytes: value, width: variant === 'portrait' ? 3 : 1, height: variant === 'portrait' ? 4 : 1 }),
    upload: async input => { uploads++; return { ...input.metadata,driveId:'synthetic-drive',itemId:input.variant+'-'+request.requestId,etag:'synthetic-etag' }; },
    remove: async () => { if (failDelete) throw new Error('synthetic-remote-outage'); return 'deleted'; },
  };
  const coordinator = new PhotoWriteCoordinatorV1({
    claim: repository.claim.bind(repository),
    commit: async (...args) => {
      const result = await repository.commit(...args);
      if (failCommitResponse) { failCommitResponse = false; throw new Error('synthetic-response-lost-after-commit'); }
      return result;
    },
    acknowledgeCleanup: repository.acknowledgeCleanup.bind(repository), complete: repository.complete.bind(repository),
  },ports);
  const input = { portrait: bytes, avatar: bytes }, signal = new AbortController().signal;
  expect(await coordinator.execute(ctx,request,input,signal)).toMatchObject({ state:'pending',stage:'commit' });
  expect(uploads).toBe(2);
  expect(await coordinator.execute(ctx,request,input,signal)).toMatchObject({ state:'committed',cleanupPending:true });
  expect(uploads).toBe(2);
  failDelete = false;
  expect(await coordinator.execute(ctx,request,input,signal)).toMatchObject({ state:'committed',cleanupPending:false });
  expect(uploads).toBe(2);
});
