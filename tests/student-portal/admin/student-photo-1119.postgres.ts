import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readPublishedPortraitV1 } from '../../../server/student-portal/photos/read-v1';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import {
  photoUidV1,
  otherPhotoUidV1,
  photoAccountV1,
  otherPhotoAccountV1,
  photoRevisionFixtureV1,
  otherPhotoRevisionV1,
  photoSourceV1,
  photoActorV1,
  syntheticPhotoHashV1,
  syntheticWebpV1,
} from '../photos/fixture-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Photo tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const name = 'portal1119_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let created = false;
let db: ReturnType<typeof postgres> | undefined;
const adapter = (
  connection: Pick<ReturnType<typeof postgres>, 'unsafe'>,
): StudentPortalPostgresQueryV1 => ({
  unsafe: <Row extends Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ) => connection.unsafe<Row[]>(text, [...parameters] as never[], { prepare: false }),
});
const native = () => {
  if (!db) throw new Error('photo-test-not-ready');
  return db;
};
const exec = (text: string) => native().unsafe(text, [], { prepare: false });

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name);
  created = true;
  const url = new URL(target);
  url.pathname = '/' + name;
  db = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await exec(`DO $$ DECLARE role_name text; BEGIN
    FOREACH role_name IN ARRAY ARRAY['gradebook_app','student_portal_app','anon','authenticated','service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS',role_name);
      END IF;
    END LOOP;
  END $$;
  CREATE SCHEMA gradebook; CREATE SCHEMA student_portal;
  CREATE TABLE gradebook.student_identity(id uuid PRIMARY KEY);
  CREATE TABLE student_portal.account(id uuid PRIMARY KEY,student_uid uuid NOT NULL REFERENCES gradebook.student_identity(id));
  GRANT USAGE ON SCHEMA student_portal TO student_portal_app;
  GRANT SELECT ON student_portal.account TO student_portal_app;
  INSERT INTO gradebook.student_identity VALUES ('${photoUidV1}'),('${otherPhotoUidV1}');
  INSERT INTO student_portal.account VALUES ('${photoAccountV1}','${photoUidV1}'),('${otherPhotoAccountV1}','${otherPhotoUidV1}');`);
  const before = await native().unsafe('SELECT * FROM student_portal.account ORDER BY id');
  await exec(readFileSync('migrations/student-photos/0001_private_delivery_v1.sql', 'utf8'));
  await exec(`ALTER TABLE student_photos.portal_delivery_v1 ADD COLUMN storage_path text;
    ALTER TABLE student_photos.portal_delivery_v1 ADD COLUMN byte_size integer;
    ALTER TABLE student_photos.portal_delivery_v1 ADD CONSTRAINT photo_revoked_storage_test CHECK(revoked_at IS NULL OR storage_path IS NULL);
    DROP POLICY portal_delivery_runtime_read_v1 ON student_photos.portal_delivery_v1;
    CREATE POLICY portal_delivery_runtime_read_v1 ON student_photos.portal_delivery_v1 FOR SELECT TO student_portal_app
      USING(image_use_authorized AND approved_at IS NOT NULL AND revoked_at IS NULL AND storage_path IS NOT NULL);`);
  expect(await native().unsafe('SELECT * FROM student_portal.account ORDER BY id')).toEqual(before);
  for (const [uid, revision, authorized] of [
    [photoUidV1, photoRevisionFixtureV1, true],
    [otherPhotoUidV1, otherPhotoRevisionV1, false],
  ] as const) {
    await native().unsafe(
      `INSERT INTO student_photos.portal_delivery_v1
      (student_uid,revision,source_revision,approved_source_revision,source_sha256,portrait_sha256,width,height,storage_path,byte_size,
        image_use_authorized,authorized_by,authorized_at,authorization_reference,approved_by,approved_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,$4,3,4,$5,$8,$6,$7::uuid,
        statement_timestamp(),'synthetic-private-reference',$7::uuid,statement_timestamp())`,
      [
        uid,
        revision,
        photoSourceV1,
        syntheticPhotoHashV1,
        `legacy/${uid}/${syntheticPhotoHashV1}.webp`,
        authorized,
        photoActorV1,
        syntheticWebpV1().length,
      ],
    );
  }
});

afterAll(async () => {
  await db?.end({ timeout: 2 });
  try {
    if (created) await cluster.unsafe('DROP DATABASE ' + name);
  } finally {
    await cluster.end({ timeout: 2 });
  }
});

it('maps account to permanent UID even when those UUIDs are different', async () => {
  expect(photoAccountV1).not.toBe(photoUidV1);
  const result = await native().begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE student_portal_app');
    return readPublishedPortraitV1(adapter(tx), photoAccountV1, photoRevisionFixtureV1, async () =>
      syntheticWebpV1(),
    );
  });
  expect(result.state).toBe('content');
  if (result.state === 'content') expect(result.bytes).toEqual(syntheticWebpV1());
});

it('denies an unauthorized photo and another account revision through the actual SQL reader', async () => {
  await native().begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE student_portal_app');
    expect(await readPublishedPortraitV1(adapter(tx), otherPhotoAccountV1, null)).toEqual({
      state: 'absent',
    });
    expect(
      await readPublishedPortraitV1(adapter(tx), photoAccountV1, otherPhotoRevisionV1),
    ).toEqual({ state: 'absent' });
    expect(
      await tx.unsafe('SELECT student_uid FROM student_photos.portal_delivery_v1'),
    ).toHaveLength(1);
  });
});

it('keeps the migration private and read-only for runtime, with no Data API grants', async () => {
  for (const role of ['anon', 'authenticated', 'service_role', 'gradebook_app']) {
    const rows = await native().unsafe(
      "SELECT has_table_privilege($1,'student_photos.portal_delivery_v1','SELECT') AS readable",
      [role],
    );
    expect(rows[0]!.readable).toBe(false);
  }
  await expect(
    native().begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE student_portal_app');
      await tx.unsafe('UPDATE student_photos.portal_delivery_v1 SET image_use_authorized=false');
    }),
  ).rejects.toMatchObject({ code: '42501' });
  const rows = await native().unsafe(
    "SELECT relrowsecurity FROM pg_class WHERE oid='student_photos.portal_delivery_v1'::regclass",
  );
  expect(rows[0]!.relrowsecurity).toBe(true);
});

it('rejects missing approval source, unproven authorization, invalid dimensions and retained revoked bytes', async () => {
  for (const change of [
    'approved_source_revision=NULL',
    'authorization_reference=NULL',
    'width=5',
    'revoked_at=statement_timestamp()',
  ])
    await expect(
      exec(
        `UPDATE student_photos.portal_delivery_v1 SET ${change} WHERE student_uid='${photoUidV1}'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
});

it('rejects oversized or foreign content at the database boundary', async () => {
  await expect(
    native().unsafe(
      'UPDATE student_photos.portal_delivery_v1 SET image_webp=$1 WHERE student_uid=$2::uuid',
      [Buffer.alloc(131073), photoUidV1],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    exec(`UPDATE student_photos.portal_delivery_v1 SET image_webp=convert_to('<svg>synthetic</svg>','UTF8')
    WHERE student_uid='${photoUidV1}'`),
  ).rejects.toMatchObject({ code: '23514' });
});
