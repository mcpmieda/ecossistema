import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { PhotoCatalogRepositoryV1 } from '../../../server/student-photos/catalog-repository-v1';
import { PhotoWriteRepositoryV1, type PhotoWriteDatabaseV1 } from '../../../server/student-photos/write-repository-v1';
import { photoWriteFingerprintV1, type PhotoAssetV1, type PhotoWriteContextV1,
  photoVariantMetadataV1 } from '../../../shared/student-photos/write-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' || target.pathname !== '/portal705_test'
  || target.search || target.hash) throw new Error('Photo catalog tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const name = 'photo_runtime_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let db: ReturnType<typeof postgres>, created = false;
let portrait: Uint8Array, avatar: Uint8Array;
const actor = crypto.randomUUID();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function adapter(): PhotoWriteDatabaseV1 { return { transaction: async work => {
  const box = await db.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE gradebook_app');
    return { value: await work({ query: async (text, parameters = []) => Array.from(await tx.unsafe(text, [...parameters] as never[])) }) };
  });
  return box.value;
} }; }
function asset(bytes: Uint8Array, width: number, height: number, uid: string,
  requestId?: string, variant: 'portrait' | 'avatar' = 'portrait'): PhotoAssetV1 {
  const digest = hash(bytes);
  return { driveId: 'student-photos', itemId: requestId
    ? `write/${uid}/${requestId}/${variant}-${digest}.webp` : `legacy/${uid}/${digest}.webp`,
    etag: digest, width, height, byteSize: bytes.length, sha256: digest };
}
function planOf(assets: { portrait: PhotoAssetV1; avatar: PhotoAssetV1 }) {
  const metadata = (value: PhotoAssetV1) => photoVariantMetadataV1.parse({
    width: value.width, height: value.height, byteSize: value.byteSize, sha256: value.sha256 });
  return { portrait: metadata(assets.portrait), avatar: metadata(assets.avatar) };
}
async function person(legacy = false) {
  const context: PhotoWriteContextV1 = { studentUid: crypto.randomUUID(), actorId: actor };
  const accountId = crypto.randomUUID();
  await db.unsafe('INSERT INTO gradebook.student_identity(id) VALUES($1)', [context.studentUid]);
  await db.unsafe('INSERT INTO student_portal.account(id,student_uid,academic_year) VALUES($1,$2,2026)',
    [accountId, context.studentUid]);
  if (legacy) await db.unsafe(`INSERT INTO student_portal.profile_photo(account_id,sharepoint_drive_id,sharepoint_item_id,content_type,byte_size,etag)
    VALUES($1,'synthetic-drive',$2,'image/webp',$3,'"synthetic-legacy"')`,
    [accountId, 'old-' + accountId, portrait.length]);
  return { context, accountId, catalog: new PhotoCatalogRepositoryV1(adapter()), writer: new PhotoWriteRepositoryV1(adapter(), true) };
}
beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name); created = true;
  const url = new URL(target); url.pathname = '/' + name; db = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await db.unsafe(`CREATE SCHEMA gradebook;CREATE TABLE gradebook.student_identity(id uuid PRIMARY KEY);
    CREATE TABLE gradebook.aluno(id integer PRIMARY KEY,ano integer,student_uid uuid REFERENCES gradebook.student_identity(id));
    CREATE SCHEMA student_portal;CREATE TABLE student_portal.account(id uuid PRIMARY KEY,academic_year integer,student_uid uuid REFERENCES gradebook.student_identity(id));`, [], { prepare: false });
  for (const file of ['0001_private_delivery_v1.sql', '0002_write_journal_v1.sql', '0003_runtime_catalog_v1.sql',
    '0004_resumable_payload_v1.sql', '0005_supabase_storage_v1.sql'])
    await db.unsafe(readFileSync('migrations/student-photos/' + file, 'utf8'), [], { prepare: false });
  portrait = new Uint8Array(await sharp({ create: { width: 30, height: 40, channels: 3, background: '#446699' } }).webp({ quality: 92 }).toBuffer());
  avatar = new Uint8Array(await sharp({ create: { width: 32, height: 32, channels: 3, background: '#446699' } }).webp({ quality: 92 }).toBuffer());
}, 30_000);
afterAll(async () => { await db?.end({ timeout: 2 }); if (created) await cluster.unsafe('DROP DATABASE ' + name); await cluster.end({ timeout: 2 }); });

it('adopts an exact legacy link into private Storage metadata without duplicating bytes in Postgres', async () => {
  const p = await person(true), reference = await p.catalog.legacy(p.context.studentUid);
  const original = asset(portrait, 30, 40, p.context.studentUid);
  await db.unsafe('SELECT student_photos.adopt_storage_photo_v1($1::uuid,$2::text::jsonb,$3::text::jsonb)',
    [p.context.studentUid, JSON.stringify(reference), JSON.stringify(original)]);
  await db.unsafe('SELECT student_photos.adopt_storage_photo_v1($1::uuid,$2::text::jsonb,$3::text::jsonb)',
    [p.context.studentUid, JSON.stringify(reference), JSON.stringify(original)]);
  expect((await p.catalog.state(p.context)).portalReady).toBe(true);
  const rows = await db.unsafe(`SELECT storage_path,byte_size,image_webp,image_use_authorized
    FROM student_photos.portal_delivery_v1 WHERE student_uid=$1`, [p.context.studentUid]);
  expect(rows[0]).toMatchObject({ storage_path: original.itemId, byte_size: portrait.length, image_webp: null,
    image_use_authorized: true });
  const legacy = await db.unsafe('SELECT sharepoint_item_id,version FROM student_portal.profile_photo WHERE account_id=$1', [p.accountId]);
  expect(legacy[0]!.sharepoint_item_id).toBe(reference!.itemId);
  expect(legacy[0]!.version).toBe('1');
});

it('refuses a changed legacy snapshot or mismatched imported size', async () => {
  const p = await person(true), reference = await p.catalog.legacy(p.context.studentUid);
  const original = asset(portrait, 30, 40, p.context.studentUid);
  await expect(db.unsafe('SELECT student_photos.adopt_storage_photo_v1($1::uuid,$2::text::jsonb,$3::text::jsonb)',
    [p.context.studentUid, JSON.stringify({ ...reference, version: 2 }), JSON.stringify(original)]))
    .rejects.toThrow('photo-storage-legacy-mismatch');
  await expect(db.unsafe('SELECT student_photos.adopt_storage_photo_v1($1::uuid,$2::text::jsonb,$3::text::jsonb)',
    [p.context.studentUid, JSON.stringify(reference), JSON.stringify({ ...original, byteSize: portrait.length + 1 })]))
    .rejects.toThrow('photo-storage-legacy-mismatch');
  expect(await p.catalog.family(p.context.studentUid)).toBeNull();
});

it('resolves account and academic reference to the same permanent identity', async () => {
  const p = await person();
  await db.unsafe('INSERT INTO gradebook.aluno(id,ano,student_uid) VALUES(71,2026,$1)', [p.context.studentUid]);
  expect(await p.catalog.resolve({ source: 'portal', academicYear: 2026, accountIds: [p.accountId] })).toBe(p.context.studentUid);
  expect(await p.catalog.resolve({ source: 'gradebook', academicYear: 2026, studentIds: [71] })).toBe(p.context.studentUid);
});

it('publishes committed Storage paths, clears recovery bytes and revokes on removal', async () => {
  const p = await person(); await p.catalog.initialize(p.context, null, null);
  const command = { requestId: crypto.randomUUID(), expectedRevision: null, kind: 'replace' as const };
  const assets = { portrait: asset(portrait, 30, 40, p.context.studentUid, command.requestId),
    avatar: asset(avatar, 32, 32, p.context.studentUid, command.requestId, 'avatar') };
  await p.writer.claim(p.context, command, planOf(assets), { portrait, avatar });
  await p.writer.commit(p.context, command.requestId, assets);
  await p.catalog.publish(p.context, 'portrait', assets.portrait);
  await p.catalog.publish(p.context, 'avatar', assets.avatar);
  await p.writer.complete(p.context, command.requestId);
  expect((await p.catalog.state(p.context)).portalReady).toBe(true);
  expect(await db.unsafe('SELECT request_id FROM student_photos.write_payload_v1 WHERE request_id=$1', [command.requestId])).toHaveLength(0);
  const remove = { requestId: crypto.randomUUID(), expectedRevision: command.requestId, kind: 'remove' as const };
  await p.writer.claim(p.context, remove, { portrait: null, avatar: null }, { portrait: null, avatar: null });
  const delivery = await db.unsafe('SELECT storage_path,image_webp FROM student_photos.portal_delivery_v1 WHERE student_uid=$1', [p.context.studentUid]);
  expect(delivery[0]).toMatchObject({ storage_path: null, image_webp: null });
});

it('keeps recovery fenced and denies public writes to private catalog tables', async () => {
  const p = await person(); await p.catalog.initialize(p.context, null, null);
  const command = { requestId: crypto.randomUUID(), expectedRevision: null, kind: 'replace' as const };
  const assets = { portrait: asset(portrait, 30, 40, p.context.studentUid, command.requestId),
    avatar: asset(avatar, 32, 32, p.context.studentUid, command.requestId, 'avatar') };
  const receipt = await p.writer.claim(p.context, command, planOf(assets), { portrait, avatar });
  const next = { ...p.context, actorId: crypto.randomUUID() };
  const fingerprint = await photoWriteFingerprintV1(next, command, receipt.plan);
  await adapter().transaction(tx => tx.query('SELECT student_photos.takeover_write_v1($1::uuid,$2::uuid,$3::uuid,$4)',
    [next.studentUid, next.actorId, command.requestId, fingerprint]));
  await expect(p.writer.commit(p.context, command.requestId, assets)).rejects.toThrow('receipt-conflict');
  expect((await p.writer.commit(next, command.requestId, assets)).actorId).toBe(next.actorId);
  const audit = await db.unsafe('SELECT previous_actor::text,acting_actor::text FROM student_photos.recovery_audit_v1 WHERE request_id=$1',
    [command.requestId]);
  expect(audit[0]).toMatchObject({ previous_actor: p.context.actorId, acting_actor: next.actorId });
  await expect(p.catalog.publish(next, 'portrait', { ...assets.portrait, itemId: 'write/other.webp' }))
    .rejects.toThrow('photo-storage-publication-conflict');
  const roles = await db.unsafe("SELECT has_function_privilege('student_portal_app','student_photos.publish_storage_asset_v1(uuid,uuid,text,jsonb)','EXECUTE') AS portal_publish,has_function_privilege('anon','student_photos.adopt_storage_photo_v1(uuid,jsonb,jsonb)','EXECUTE') AS public_import");
  expect(roles[0]).toMatchObject({ portal_publish: false, public_import: false });
  const grants = await db.unsafe("SELECT has_table_privilege('gradebook_app','student_photos.asset_delivery_v1','INSERT') AS direct_insert,has_table_privilege('student_portal_app','student_photos.asset_delivery_v1','DELETE') AS portal_delete");
  expect(grants[0]).toMatchObject({ direct_insert: false, portal_delete: false });
});

it('reads the avatar image of several subjects in one statement, as the runtime role', async () => {
  const edited = await person(); await edited.catalog.initialize(edited.context, null, null);
  const command = { requestId: crypto.randomUUID(), expectedRevision: null, kind: 'replace' as const };
  const assets = { portrait: asset(portrait, 30, 40, edited.context.studentUid, command.requestId),
    avatar: asset(avatar, 32, 32, edited.context.studentUid, command.requestId, 'avatar') };
  await edited.writer.claim(edited.context, command, planOf(assets), { portrait, avatar });
  await edited.writer.commit(edited.context, command.requestId, assets);
  const adopted = await person(true), reference = await adopted.catalog.legacy(adopted.context.studentUid);
  const original = asset(portrait, 30, 40, adopted.context.studentUid);
  await db.unsafe('SELECT student_photos.adopt_storage_photo_v1($1::uuid,$2::text::jsonb,$3::text::jsonb)',
    [adopted.context.studentUid, JSON.stringify(reference), JSON.stringify(original)]);
  const without = await person();
  await db.unsafe('INSERT INTO gradebook.aluno(id,ano,student_uid) VALUES(72,2026,$1)', [edited.context.studentUid]);
  const portal = (accountId: string) => ({ source: 'portal' as const, academicYear: 2026, accountIds: [accountId] });
  // The avatar when there is one, the portrait while there is none, nothing without a photo,
  // and no person at all for a reference that resolves to nobody.
  expect(await edited.catalog.avatarFamilies([portal(edited.accountId), portal(adopted.accountId),
    portal(without.accountId), portal(crypto.randomUUID()), { source: 'gradebook', academicYear: 2026, studentIds: [72] }]))
    .toEqual([{ uid: edited.context.studentUid, asset: assets.avatar }, { uid: adopted.context.studentUid, asset: original },
      { uid: without.context.studentUid, asset: null }, null, { uid: edited.context.studentUid, asset: assets.avatar }]);
});