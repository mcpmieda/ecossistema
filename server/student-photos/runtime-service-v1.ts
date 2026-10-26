import type { RuntimeEnv } from '../env';
import { photoWriteContextV1, photoWriteCommandV1, photoWriteReceiptV1, photoWriteFingerprintV1,
  PhotoWriteErrorV1, type PhotoWriteContextV1, type PhotoWriteReceiptV1 } from '../../shared/student-photos/write-v1';
import { studentUidV1 } from '../../shared/student-identity/student-identity-v1';
import { clearPhotoBytesV1 } from '../../shared/student-photos/admin-http-v1';
import { PhotoEditServiceV1 } from './edit-service-v1';
import { PhotoCatalogRepositoryV1, photoBytesFromHexV1 } from './catalog-repository-v1';
import { PhotoCatalogServiceV1 } from './catalog-service-v1';
import { PhotoWriteRepositoryV1, type PhotoWriteDatabaseV1 } from './write-repository-v1';
import { PhotoWriteGuardV1 } from './write-guard-v1';
import { PhotoWriteCoordinatorV1, type PhotoWriteInputV1 } from './write-coordinator-v1';
import { PhotoStorageV1, type PhotoStorageActionV1 } from './storage-v1';
import type { StudentWebpCodecV1 } from './webp-codec-v1';

/** Real request-scoped composition. Only the source-built codec is shared between requests. */
export function createPhotoRuntimeServiceV1(options: {
  env: RuntimeEnv; database: PhotoWriteDatabaseV1; codec: StudentWebpCodecV1;
  authorize(context: PhotoWriteContextV1): Promise<void>;
}) {
  const { env, database, codec, authorize } = options;
  const catalogRepository = new PhotoCatalogRepositoryV1(database);
  const catalog = new PhotoCatalogServiceV1(env, catalogRepository, authorize);
  const journal = new PhotoWriteRepositoryV1(database, true);
  const guard = new PhotoWriteGuardV1(database);

  async function load(context: PhotoWriteContextV1, requestId: string) {
    await authorize(context);
    const rows = await database.transaction(async tx => {
      await tx.query("SET LOCAL statement_timeout='10s'");
      return tx.query(`SELECT o.receipt,encode(p.portrait_bytes,'hex') AS portrait,
        encode(p.avatar_bytes,'hex') AS avatar
        FROM student_photos.write_operation_v1 o
        LEFT JOIN student_photos.write_payload_v1 p ON p.request_id=o.request_id
        WHERE o.request_id=$1 AND o.student_uid=$2`, [requestId, context.studentUid]);
    });
    if (rows.length !== 1) throw new PhotoWriteErrorV1('not-found');
    const receipt = photoWriteReceiptV1.parse(rows[0]!.receipt);
    const images: PhotoWriteInputV1 = { portrait: null, avatar: null };
    try {
      for (const variant of ['portrait', 'avatar'] as const) {
        const encoded = rows[0]![variant];
        if (encoded !== null) images[variant] = photoBytesFromHexV1(encoded);
      }
      await authorize(context);
      return { receipt, images };
    } catch (error) { clearPhotoBytesV1(images); throw error; }
  }

  /** Publish the committed, verified bytes independently of old-file cleanup. */
  async function publishCommitted(context: PhotoWriteContextV1, receipt: PhotoWriteReceiptV1,
    images: PhotoWriteInputV1, signal?: AbortSignal) {
    if (receipt.actorId !== context.actorId || receipt.studentUid !== context.studentUid
      || receipt.phase !== 'committed') throw new PhotoWriteErrorV1('receipt-conflict');
    for (const variant of ['portrait', 'avatar'] as const) {
      if (!receipt.plan[variant]) continue;
      const asset = receipt.assets[variant], bytes = images[variant];
      if (!asset || !bytes) throw new PhotoWriteErrorV1('conflict');
      signal?.throwIfAborted();
      await authorize(context);
      signal?.throwIfAborted();
      const transport = new PhotoStorageV1(env.PHOTO_STORAGE_SERVICE_KEY, async () => authorize(context));
      const verified = await transport.read(asset, signal ?? new AbortController().signal);
      verified.fill(0);
      await catalogRepository.publish(context, variant, asset);
    }
  }

  /** Publish the durable, codec-verified bytes before the receipt becomes complete.
   * A failure retains the pending receipt/payload; it never reports a false failed commit. */
  async function publishBeforeComplete(context: PhotoWriteContextV1, requestId: string) {
    const { receipt, images } = await load(context, requestId);
    try {
      await publishCommitted(context, receipt, images);
      await authorize(context);
      return await journal.complete(context, requestId);
    } finally { clearPhotoBytesV1(images); }
  }
  const repository = {
    claim: journal.claim.bind(journal), commit: journal.commit.bind(journal),
    acknowledgeCleanup: journal.acknowledgeCleanup.bind(journal), complete: publishBeforeComplete,
  };
  const storage = (verify: (action: PhotoStorageActionV1) => Promise<void>) =>
    new PhotoStorageV1(env.PHOTO_STORAGE_SERVICE_KEY, verify);
  const edit = new PhotoEditServiceV1({ codec, repository, guard, authorize, storage, publish: publishCommitted });

  /** Explicitly resume the exact saved operation, not a new upload or silent timeout takeover. */
  async function recover(contextInput: PhotoWriteContextV1, requestInput: string, signal: AbortSignal) {
    const context = photoWriteContextV1.parse(contextInput), requestId = studentUidV1.parse(requestInput);
    signal.throwIfAborted();
    const loaded = await load(context, requestId);
    let receipt: PhotoWriteReceiptV1 = loaded.receipt;
    const images = loaded.images;
    try {
      if (receipt.phase === 'complete') return {
        state: 'committed' as const, requestId, revision: requestId, cleanupPending: false,
      };
      const command = photoWriteCommandV1.parse({ requestId, expectedRevision: receipt.expectedRevision, kind: receipt.kind });
      if (receipt.actorId !== context.actorId) {
        const inputHash = await photoWriteFingerprintV1(context, command, receipt.plan);
        signal.throwIfAborted();
        await authorize(context);
        const rows = await database.transaction(async tx => {
          await tx.query("SET LOCAL lock_timeout='3s'");
          await tx.query("SET LOCAL statement_timeout='10s'");
          return tx.query('SELECT student_photos.takeover_write_v1($1,$2,$3,$4) AS receipt',
            [context.studentUid, context.actorId, requestId, inputHash]);
        });
        photoWriteReceiptV1.parse(rows[0]?.receipt);
      }
      const transport = storage(async action => {
        signal.throwIfAborted();
        await authorize(context);
        if (action.kind === 'upload') {
          if (action.requestId !== requestId || action.context.studentUid !== context.studentUid
            || action.context.actorId !== context.actorId) throw new PhotoWriteErrorV1('receipt-conflict');
          await guard.assertTransfer(context, requestId, { kind: 'upload', variant: action.variant, metadata: action.metadata });
        } else await guard.assertTransfer(context, requestId, { kind: 'remove', asset: action.asset });
        signal.throwIfAborted();
      });
      const coordinator = new PhotoWriteCoordinatorV1(repository, {
        authorize: async ctx => { signal.throwIfAborted(); await authorize(ctx); signal.throwIfAborted(); },
        // Durable payloads are already final WebP: validate pixels without recompressing.
        validate: async (bytes, variant, stageSignal) => ({
          ...await codec.validate(bytes, variant, stageSignal), bytes: new Uint8Array(bytes),
        }),
        upload: input => transport.upload(input), remove: (asset, stageSignal) => transport.remove(asset, stageSignal),
        publish: publishCommitted,
      });
      return await coordinator.execute(context, command, images, signal);
    } finally { clearPhotoBytesV1(images); }
  }
  return { catalog, catalogRepository, edit, recover };
}
