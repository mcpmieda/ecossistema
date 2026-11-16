import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  PhotoWriteRepositoryV1,
  type PhotoWriteDatabaseV1,
} from '../../../server/student-photos/write-repository-v1';
import { PhotoWriteGuardV1 } from '../../../server/student-photos/write-guard-v1';
import {
  PhotoEditServiceV1,
  type PhotoEditServiceOptionsV1,
} from '../../../server/student-photos/edit-service-v1';
import {
  type PhotoWriteContextV1,
  type PhotoWriteCommandV1,
  type PhotoWritePlanV1,
  type PhotoAssetsV1,
} from '../../../shared/student-photos/write-v1';
import { probePhotoSourceV1 } from '../../../shared/student-photos/source-probe-v1';

const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test' ||
  target.search ||
  target.hash
)
  throw new Error('Photo edit tests require disposable local PostgreSQL');
const cluster = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const name = 'photo_edit_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
let db: ReturnType<typeof postgres>;
let created = false,
  activeTransactions = 0;
let repository: PhotoWriteRepositoryV1, guard: PhotoWriteGuardV1;
const actorId = '10000000-0000-4000-8000-000000000001';
const plan: PhotoWritePlanV1 = {
  portrait: { sha256: 'a'.repeat(64), byteSize: 30, width: 24, height: 32 },
  avatar: { sha256: 'b'.repeat(64), byteSize: 30, width: 16, height: 16 },
};
function command(
  kind: PhotoWriteCommandV1['kind'],
  expectedRevision: string | null = null,
): PhotoWriteCommandV1 {
  return { kind, expectedRevision, requestId: crypto.randomUUID() };
}
function assets(id: string): PhotoAssetsV1 {
  return {
    portrait: {
      ...plan.portrait!,
      driveId: 'synthetic-drive',
      itemId: id + '-portrait',
      etag: '"synthetic-p"',
    },
    avatar: {
      ...plan.avatar!,
      driveId: 'synthetic-drive',
      itemId: id + '-avatar',
      etag: '"synthetic-a"',
    },
  };
}
async function context(initialize = true): Promise<PhotoWriteContextV1> {
  const studentUid = crypto.randomUUID();
  await db.unsafe('INSERT INTO gradebook.student_identity(id) VALUES ($1::uuid)', [studentUid]);
  if (initialize)
    await db.unsafe('INSERT INTO student_photos.photo_family_v1(student_uid) VALUES ($1::uuid)', [
      studentUid,
    ]);
  return { studentUid, actorId };
}
async function seeded(ctx: PhotoWriteContextV1) {
  const cmd = command('replace'),
    value = assets(cmd.requestId);
  await repository.claim(ctx, cmd, plan);
  await repository.commit(ctx, cmd.requestId, value);
  await repository.complete(ctx, cmd.requestId);
  return { cmd, value };
}
function database(): PhotoWriteDatabaseV1 {
  return {
    transaction: async (work) => {
      const box = await db.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE gradebook_app');
        activeTransactions++;
        try {
          return {
            value: await work({
              query: async (text, values = []) =>
                Array.from(await tx.unsafe(text, [...values] as never[], { prepare: false })),
            }),
          };
        } finally {
          activeTransactions--;
        }
      });
      return box.value;
    },
  };
}
function inputBytes(width: number, height: number): Uint8Array {
  // Synthetic codec port below isolates orchestration. This is not a decoder fixture.
  const b = new Uint8Array(30),
    v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF'));
  v.setUint32(4, 22, true);
  b.set(new TextEncoder().encode('WEBPVP8 '), 8);
  v.setUint32(16, 10, true);
  b.set([0x9d, 1, 0x2a], 23);
  v.setUint16(26, width, true);
  v.setUint16(28, height, true);
  return b;
}

beforeAll(async () => {
  await cluster.unsafe('CREATE DATABASE ' + name);
  created = true;
  const url = new URL(target);
  url.pathname = '/' + name;
  db = postgres(url.toString(), { max: 4, onnotice: () => undefined });
  await db.unsafe(
    `DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['gradebook_app','student_portal_app','anon','authenticated','service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS',r);
      END IF;
    END LOOP;
  END $$;
  CREATE SCHEMA gradebook;
  CREATE TABLE gradebook.student_identity(id uuid PRIMARY KEY);`,
    [],
    { prepare: false },
  );
  const connection = await db.reserve();
  try {
    for (const file of ['0001_private_delivery_v1.sql', '0002_write_journal_v1.sql'])
      await connection.unsafe(readFileSync('migrations/student-photos/' + file, 'utf8'), [], {
        prepare: false,
      });
  } finally {
    await connection.release();
  }
  repository = new PhotoWriteRepositoryV1(database());
  guard = new PhotoWriteGuardV1(database());
}, 30_000);
afterAll(async () => {
  await db?.end({ timeout: 2 });
  try {
    if (created) await cluster.unsafe('DROP DATABASE ' + name);
  } finally {
    await cluster.end({ timeout: 2 });
  }
});

it('does not turn missing legacy adoption into an empty photo family', async () => {
  const ctx = await context(false);
  await expect(guard.assertInitialized(ctx)).rejects.toMatchObject({ code: 'not-found' });
  expect(
    await db.unsafe(
      'SELECT student_uid FROM student_photos.photo_family_v1 WHERE student_uid=$1::uuid',
      [ctx.studentUid],
    ),
  ).toHaveLength(0);
});

it('authorizes only the planned variant and exact content of a currently reserved upload', async () => {
  const ctx = await context(),
    cmd = command('replace');
  const upload = {
    kind: 'upload' as const,
    variant: 'portrait' as const,
    metadata: plan.portrait!,
  };
  await expect(guard.assertTransfer(ctx, cmd.requestId, upload)).rejects.toMatchObject({
    code: 'not-found',
  });
  await repository.claim(ctx, cmd, plan);
  await guard.assertTransfer(ctx, cmd.requestId, upload);
  await guard.assertTransfer(ctx, cmd.requestId, {
    kind: 'upload',
    variant: 'avatar',
    metadata: plan.avatar!,
  });
  await expect(
    guard.assertTransfer(ctx, cmd.requestId, {
      ...upload,
      metadata: { ...upload.metadata, sha256: '0'.repeat(64) },
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    guard.assertTransfer(ctx, cmd.requestId, { ...upload, variant: 'avatar' }),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('never treats another operator, person or request identifier as authorization', async () => {
  const ctx = await context(),
    other = await context(),
    cmd = command('replace');
  await repository.claim(ctx, cmd, plan);
  const action = {
    kind: 'upload' as const,
    variant: 'portrait' as const,
    metadata: plan.portrait!,
  };
  await expect(
    guard.assertTransfer({ ...ctx, actorId: crypto.randomUUID() }, cmd.requestId, action),
  ).rejects.toMatchObject({ code: 'receipt-conflict' });
  await expect(guard.assertTransfer(other, cmd.requestId, action)).rejects.toMatchObject({
    code: 'not-found',
  });
  await expect(guard.assertTransfer(ctx, crypto.randomUUID(), action)).rejects.toMatchObject({
    code: 'not-found',
  });
});

it('permits only retired exact files after commit and never deletes the live family', async () => {
  const ctx = await context(),
    old = await seeded(ctx),
    cmd = command('replace', old.cmd.requestId);
  const replacement = assets(cmd.requestId);
  await repository.claim(ctx, cmd, plan);
  await expect(
    guard.assertTransfer(ctx, cmd.requestId, { kind: 'remove', asset: old.value.portrait! }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await repository.commit(ctx, cmd.requestId, replacement);
  await expect(
    guard.assertTransfer(ctx, cmd.requestId, {
      kind: 'upload',
      variant: 'portrait',
      metadata: plan.portrait!,
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await guard.assertTransfer(ctx, cmd.requestId, { kind: 'remove', asset: old.value.portrait! });
  await expect(
    guard.assertTransfer(ctx, cmd.requestId, { kind: 'remove', asset: replacement.portrait! }),
  ).rejects.toMatchObject({ code: 'conflict' });
  for (const change of [
    { etag: '"wrong"' },
    { sha256: '0'.repeat(64) },
    { itemId: 'other-file' },
  ]) {
    await expect(
      guard.assertTransfer(ctx, cmd.requestId, {
        kind: 'remove',
        asset: { ...old.value.portrait!, ...change },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  }
});

it('closes deletion authority after acknowledgement or completion instead of reusing an old receipt', async () => {
  const ctx = await context(),
    old = await seeded(ctx),
    cmd = command('remove', old.cmd.requestId);
  await repository.claim(ctx, cmd, { portrait: null, avatar: null });
  await guard.assertTransfer(ctx, cmd.requestId, { kind: 'remove', asset: old.value.portrait! });
  await repository.acknowledgeCleanup(ctx, cmd.requestId, old.value.portrait!, 'deleted');
  await expect(
    guard.assertTransfer(ctx, cmd.requestId, { kind: 'remove', asset: old.value.portrait! }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await repository.acknowledgeCleanup(ctx, cmd.requestId, old.value.avatar!, 'already-absent');
  await repository.complete(ctx, cmd.requestId);
  await expect(
    guard.assertTransfer(ctx, cmd.requestId, { kind: 'remove', asset: old.value.avatar! }),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('uses read-only transactions with the existing restricted database role', async () => {
  const ctx = await context(),
    cmd = command('replace');
  await repository.claim(ctx, cmd, plan);
  const monitored = new PhotoWriteGuardV1({
    transaction: (work) =>
      database().transaction(async (tx) => {
        const result = await work(tx);
        const rows = await tx.query(
          "SELECT current_user AS role,current_setting('transaction_read_only') AS readonly",
        );
        expect(rows[0]).toEqual({ role: 'gradebook_app', readonly: 'on' });
        return result;
      }),
  });
  const before = await db.unsafe(
    'SELECT event FROM student_photos.write_audit_v1 WHERE request_id=$1::uuid ORDER BY id',
    [cmd.requestId],
  );
  await monitored.assertInitialized(ctx);
  await monitored.assertTransfer(ctx, cmd.requestId, {
    kind: 'upload',
    variant: 'portrait',
    metadata: plan.portrait!,
  });
  expect(
    Array.from(
      await db.unsafe(
        'SELECT event FROM student_photos.write_audit_v1 WHERE request_id=$1::uuid ORDER BY id',
        [cmd.requestId],
      ),
    ),
  ).toEqual(Array.from(before));
});

it('composes preview, real journal and per-transfer guard, with no database transaction spanning storage I/O', async () => {
  const ctx = await context(),
    cmd = command('replace'),
    sent: Uint8Array[] = [];
  const input = { portrait: inputBytes(24, 32), avatar: inputBytes(16, 16) };
  const codec: PhotoEditServiceOptionsV1['codec'] = {
    normalize: async (b, _variant, quality) => {
      const probe = probePhotoSourceV1(b),
        bytes = new Uint8Array(b);
      bytes[22] = quality;
      return { bytes, width: probe.width, height: probe.height };
    },
  };
  const service = new PhotoEditServiceV1({
    codec,
    repository,
    guard,
    authorize: async () => undefined,
    storage: (authorize) => ({
      upload: async (data) => {
        await authorize({
          kind: 'upload',
          context: data.context,
          requestId: data.requestId,
          variant: data.variant,
          metadata: data.metadata,
        });
        expect(activeTransactions).toBe(0);
        sent.push(new Uint8Array(data.bytes));
        return {
          ...data.metadata,
          driveId: 'synthetic-drive',
          itemId: data.variant + data.requestId,
          etag: '"synthetic"',
        };
      },
      remove: async (asset) => {
        await authorize({ kind: 'remove', asset });
        expect(activeTransactions).toBe(0);
        return 'deleted';
      },
    }),
  });
  const signal = new AbortController().signal;
  const preview = await service.preview(ctx, cmd, { portrait: 92, avatar: 86 }, input, signal);
  expect(
    await db.unsafe(
      'SELECT request_id FROM student_photos.write_operation_v1 WHERE student_uid=$1::uuid',
      [ctx.studentUid],
    ),
  ).toHaveLength(0);
  const wrong = structuredClone(preview.approval);
  wrong.output.avatar!.sha256 = '0'.repeat(64);
  await expect(service.save(ctx, cmd, wrong, input, signal)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(sent).toHaveLength(0);
  expect(
    await db.unsafe(
      'SELECT request_id FROM student_photos.write_operation_v1 WHERE student_uid=$1::uuid',
      [ctx.studentUid],
    ),
  ).toHaveLength(0);
  await expect(service.save(ctx, cmd, preview.approval, input, signal)).resolves.toMatchObject({
    state: 'committed',
    cleanupPending: false,
  });
  expect(sent).toEqual([preview.images.portrait, preview.images.avatar]);
  await service.save(ctx, cmd, preview.approval, input, signal);
  expect(sent).toHaveLength(2);
  const rows = await db.unsafe(
    'SELECT event FROM student_photos.write_audit_v1 WHERE request_id=$1::uuid ORDER BY id',
    [cmd.requestId],
  );
  expect(rows.map((row) => row.event)).toEqual(['prepared', 'committed', 'complete']);
});
