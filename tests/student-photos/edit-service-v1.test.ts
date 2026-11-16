// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  PhotoEditServiceV1,
  type PhotoEditServiceOptionsV1,
} from '../../server/student-photos/edit-service-v1';
import {
  PhotoWriteErrorV1,
  photoWriteFingerprintV1,
  type PhotoWriteReceiptV1,
  type PhotoWritePlanV1,
} from '../../shared/student-photos/write-v1';
import type { PhotoWriteRepositoryV1 } from '../../server/student-photos/write-repository-v1';
import { probePhotoSourceV1 } from '../../shared/student-photos/source-probe-v1';
import type { PhotoStorageActionV1 } from '../../server/student-photos/storage-v1';

const context = {
  actorId: '10000000-0000-4000-8000-000000000001',
  studentUid: '20000000-0000-4000-8000-000000000001',
};
const command = {
  requestId: '30000000-0000-4000-8000-000000000001',
  expectedRevision: null,
  kind: 'replace' as const,
};
const qualities = { portrait: 92 as const, avatar: 86 as const };
const signal = () => new AbortController().signal;
// These headers isolate orchestration only. The Workerd proof uses the real pixel codec.
function source(width: number, height: number) {
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
function harness() {
  const inputs = { portrait: source(24, 32), avatar: source(16, 16) };
  const receipts = new Map<string, PhotoWriteReceiptV1>();
  const originalInputs: Uint8Array[] = [],
    outputs: Uint8Array[] = [],
    uploadReferences: Uint8Array[] = [];
  const sent: { variant: string; bytes: Uint8Array }[] = [];
  let transfer: ((action: PhotoStorageActionV1) => Promise<void>) | undefined;
  const codec = {
    normalize: vi.fn<PhotoEditServiceOptionsV1['codec']['normalize']>(
      async (b, _variant, quality) => {
        originalInputs.push(new Uint8Array(b));
        const out = new Uint8Array(b);
        out[22] = quality;
        outputs.push(out);
        const probe = probePhotoSourceV1(b);
        return { bytes: out, width: probe.width, height: probe.height };
      },
    ),
  };
  const repository = {
    claim: vi.fn<PhotoWriteRepositoryV1['claim']>(async (ctx, cmd, plan) => {
      const inputHash = await photoWriteFingerprintV1(ctx, cmd, plan);
      const old = receipts.get(cmd.requestId);
      if (old) {
        if (old.inputHash !== inputHash) throw new PhotoWriteErrorV1('receipt-conflict');
        return old;
      }
      const receipt: PhotoWriteReceiptV1 = {
        ...ctx,
        ...cmd,
        inputHash,
        plan,
        previous: { portrait: null, avatar: null },
        assets: { portrait: null, avatar: null },
        cleanup: [],
        phase: cmd.kind === 'remove' ? 'committed' : 'prepared',
      };
      receipts.set(cmd.requestId, receipt);
      return receipt;
    }),
    commit: vi.fn<PhotoWriteRepositoryV1['commit']>(async (_ctx, id, assets) => {
      const receipt = { ...receipts.get(id)!, assets, phase: 'committed' as const };
      receipts.set(id, receipt);
      return receipt;
    }),
    acknowledgeCleanup: vi.fn<PhotoWriteRepositoryV1['acknowledgeCleanup']>(),
    complete: vi.fn<PhotoWriteRepositoryV1['complete']>(async (_ctx, id) => {
      const receipt = { ...receipts.get(id)!, phase: 'complete' as const };
      receipts.set(id, receipt);
      return receipt;
    }),
  };
  const guard = {
    assertInitialized: vi.fn(async () => undefined),
    assertTransfer: vi.fn(async () => undefined),
  };
  const authorize = vi.fn(async () => undefined);
  const storage = vi.fn<PhotoEditServiceOptionsV1['storage']>((callback) => {
    transfer = callback;
    return {
      upload: async (data) => {
        await callback({
          kind: 'upload',
          context: data.context,
          requestId: data.requestId,
          variant: data.variant,
          metadata: data.metadata,
        });
        uploadReferences.push(data.bytes);
        sent.push({ variant: data.variant, bytes: new Uint8Array(data.bytes) });
        return {
          ...data.metadata,
          driveId: 'synthetic-drive',
          itemId: data.variant,
          etag: '"synthetic-tag"',
        };
      },
      remove: async (asset) => {
        await callback({ kind: 'remove', asset });
        return 'deleted';
      },
    };
  });
  return {
    inputs,
    codec,
    repository,
    guard,
    authorize,
    storage,
    sent,
    originalInputs,
    outputs,
    uploadReferences,
    transfer: () => {
      if (!transfer) throw new Error('synthetic-unbound');
      return transfer;
    },
    service: new PhotoEditServiceV1({ codec, repository, guard, authorize, storage }),
  };
}

describe('final preview and confirmed photo save', () => {
  it('previews without writing, then saves exactly those final bytes from the same original source', async () => {
    const f = harness(),
      initial = {
        portrait: new Uint8Array(f.inputs.portrait),
        avatar: new Uint8Array(f.inputs.avatar),
      };
    const preview = await f.service.preview(context, command, qualities, f.inputs, signal());
    expect(f.repository.claim).not.toHaveBeenCalled();
    expect(f.storage).not.toHaveBeenCalled();
    expect(preview.images.portrait).not.toEqual(initial.portrait);
    expect(
      await f.service.save(context, command, preview.approval, f.inputs, signal()),
    ).toMatchObject({ state: 'committed', cleanupPending: false });
    const savedPlan: PhotoWritePlanV1 = f.repository.claim.mock.calls[0]![2];
    expect(savedPlan).toEqual(preview.approval.output);
    expect(f.sent).toEqual([
      { variant: 'portrait', bytes: preview.images.portrait },
      { variant: 'avatar', bytes: preview.images.avatar },
    ]);
    expect(f.originalInputs).toEqual([
      initial.portrait,
      initial.avatar,
      initial.portrait,
      initial.avatar,
    ]);
    expect(f.inputs).toEqual(initial);
    expect(f.outputs.every((b) => b.every((v) => v === 0))).toBe(true);
    expect(f.uploadReferences.every((b) => b.every((v) => v === 0))).toBe(true);
    expect(f.guard.assertTransfer).toHaveBeenCalledTimes(2);
  });

  it('does not re-encode the preview output as though it were the original upload', async () => {
    const f = harness(),
      preview = await f.service.preview(context, command, qualities, f.inputs, signal());
    await expect(
      f.service.save(context, command, preview.approval, preview.images, signal()),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.repository.claim).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  it.each(['source', 'output', 'quality'] as const)(
    'refuses changed %s before any journal reservation or remote mutation',
    async (change) => {
      const f = harness(),
        preview = await f.service.preview(context, command, qualities, f.inputs, signal());
      if (change === 'source') f.inputs.avatar[21] = 7;
      if (change === 'output') preview.approval.output.avatar!.sha256 = '0'.repeat(64);
      if (change === 'quality') preview.approval.qualities.avatar = 80;
      await expect(
        f.service.save(context, command, preview.approval, f.inputs, signal()),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(f.repository.claim).not.toHaveBeenCalled();
      expect(f.sent).toHaveLength(0);
      expect(f.outputs.every((b) => b.every((v) => v === 0))).toBe(true);
    },
  );

  it.each(['actor', 'person', 'request', 'revision'] as const)(
    'cannot reuse a preview under a different %s',
    async (field) => {
      const f = harness(),
        preview = await f.service.preview(context, command, qualities, f.inputs, signal());
      const ctx = { ...context },
        cmd: { requestId: string; expectedRevision: string | null; kind: 'replace' } = {
          ...command,
        };
      const another = '40000000-0000-4000-8000-000000000001';
      if (field === 'actor') ctx.actorId = another;
      if (field === 'person') ctx.studentUid = another;
      if (field === 'request') cmd.requestId = another;
      if (field === 'revision') cmd.expectedRevision = another;
      await expect(
        f.service.save(ctx, cmd, preview.approval, f.inputs, signal()),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(f.repository.claim).not.toHaveBeenCalled();
      expect(f.sent).toHaveLength(0);
    },
  );

  it('rejects an uninitialized legacy family without treating it as no photo', async () => {
    const f = harness();
    f.guard.assertInitialized.mockRejectedValue(new PhotoWriteErrorV1('not-found'));
    await expect(
      f.service.preview(context, command, qualities, f.inputs, signal()),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(f.codec.normalize).not.toHaveBeenCalled();
    expect(f.repository.claim).not.toHaveBeenCalled();
  });

  it('requires authorization before processing and rechecks it before returning a preview', async () => {
    const f = harness();
    f.authorize.mockRejectedValueOnce(new Error('synthetic-denied'));
    await expect(
      f.service.preview(context, command, qualities, f.inputs, signal()),
    ).rejects.toThrow('synthetic-denied');
    expect(f.codec.normalize).not.toHaveBeenCalled();
    f.authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic-revoked'));
    await expect(
      f.service.preview(context, command, qualities, f.inputs, signal()),
    ).rejects.toThrow('synthetic-revoked');
    expect(f.outputs.every((b) => b.every((v) => v === 0))).toBe(true);
    expect(f.repository.claim).not.toHaveBeenCalled();
  });

  it('snapshots both inputs before asynchronous permission or codec work', async () => {
    const f = harness(),
      originalAvatar = new Uint8Array(f.inputs.avatar);
    f.authorize.mockImplementationOnce(async () => {
      f.inputs.avatar[21] = 17;
    });
    await f.service.preview(context, command, qualities, f.inputs, signal());
    expect(f.originalInputs[1]).toEqual(originalAvatar);
    expect(f.inputs.avatar[21]).toBe(17);
  });

  it('retains the committed receipt on an identical retry without uploading again', async () => {
    const f = harness(),
      preview = await f.service.preview(context, command, qualities, f.inputs, signal());
    await f.service.save(context, command, preview.approval, f.inputs, signal());
    await f.service.save(context, command, preview.approval, f.inputs, signal());
    expect(f.sent).toHaveLength(2);
    expect(f.repository.commit).toHaveBeenCalledOnce();
    expect(f.uploadReferences.every((b) => b.every((v) => v === 0))).toBe(true);
  });

  it('supports avatar-only and removal without inventing a portrait or preview for deletion', async () => {
    const f = harness(),
      cmd = { ...command, kind: 'avatar' as const };
    const input = { portrait: null, avatar: f.inputs.avatar };
    const preview = await f.service.preview(
      context,
      cmd,
      { portrait: null, avatar: 80 },
      input,
      signal(),
    );
    expect(preview.images.portrait).toBeNull();
    await f.service.save(context, cmd, preview.approval, input, signal());
    expect(f.sent.map((v) => v.variant)).toEqual(['avatar']);
    const removing = harness();
    await removing.service.save(
      context,
      { ...command, kind: 'remove' },
      null,
      { portrait: null, avatar: null },
      signal(),
    );
    expect(removing.codec.normalize).not.toHaveBeenCalled();
    expect(removing.sent).toHaveLength(0);
  });

  it('binds storage callbacks to the resolved scope and current authority', async () => {
    const f = harness(),
      preview = await f.service.preview(context, command, qualities, f.inputs, signal());
    await f.service.save(context, command, preview.approval, f.inputs, signal());
    const action: PhotoStorageActionV1 = {
      kind: 'upload',
      context: { ...context },
      requestId: command.requestId,
      variant: 'avatar',
      metadata: preview.approval.output.avatar!,
    };
    action.context.studentUid = '40000000-0000-4000-8000-000000000001';
    await expect(f.transfer()(action)).rejects.toMatchObject({ code: 'receipt-conflict' });
    f.authorize.mockRejectedValue(new Error('synthetic-revoked'));
    await expect(f.transfer()({ ...action, context })).rejects.toThrow('synthetic-revoked');
  });

  it('clears validated buffers after a failed reservation, without clearing the caller inputs', async () => {
    const f = harness(),
      preview = await f.service.preview(context, command, qualities, f.inputs, signal());
    f.repository.claim.mockRejectedValue(new PhotoWriteErrorV1('conflict'));
    await expect(
      f.service.save(context, command, preview.approval, f.inputs, signal()),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.outputs.every((b) => b.every((v) => v === 0))).toBe(true);
    expect(f.inputs.portrait).toEqual(source(24, 32));
    expect(f.inputs.avatar).toEqual(source(16, 16));
  });

  it('rejects bad quality, extra variants and cancelled calls before codec work', async () => {
    const f = harness();
    await expect(
      f.service.preview(context, command, { ...qualities, portrait: 91 }, f.inputs, signal()),
    ).rejects.toThrow();
    await expect(
      f.service.preview(
        context,
        { ...command, kind: 'avatar' },
        { portrait: null, avatar: 80 },
        f.inputs,
        signal(),
      ),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.preview(context, command, qualities, f.inputs, controller.signal),
    ).rejects.toBeDefined();
    expect(f.codec.normalize).not.toHaveBeenCalled();
    expect(f.repository.claim).not.toHaveBeenCalled();
  });
});
