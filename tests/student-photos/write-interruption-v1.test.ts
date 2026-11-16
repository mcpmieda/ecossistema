// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  PhotoWriteCoordinatorV1,
  type PhotoWritePortsV1,
} from '../../server/student-photos/write-coordinator-v1';
import {
  photoWriteReceiptV1,
  type PhotoWriteReceiptV1,
  type PhotoWriteContextV1,
  type PhotoWriteCommandV1,
  type PhotoWritePlanV1,
} from '../../shared/student-photos/write-v1';

const context = {
  actorId: '10000000-0000-4000-8000-000000000001',
  studentUid: '20000000-0000-4000-8000-000000000001',
};
const command = {
  requestId: '30000000-0000-4000-8000-000000000001',
  expectedRevision: null,
  kind: 'replace' as const,
};
const input = { portrait: new Uint8Array(64), avatar: new Uint8Array(64) };
const empty = { portrait: null, avatar: null };
function harness() {
  let receipt: PhotoWriteReceiptV1 | undefined;
  const repository = {
    claim: vi.fn(
      async (ctx: PhotoWriteContextV1, cmd: PhotoWriteCommandV1, plan: PhotoWritePlanV1) => {
        receipt = photoWriteReceiptV1.parse({
          ...ctx,
          ...cmd,
          plan,
          inputHash: 'a'.repeat(64),
          phase: 'prepared',
          previous: empty,
          assets: empty,
          cleanup: [],
        });
        return receipt;
      },
    ),
    commit: vi.fn(async () => {
      if (!receipt) throw new Error('synthetic-not-claimed');
      return { ...receipt, phase: 'committed' as const };
    }),
    acknowledgeCleanup: vi.fn(),
    complete: vi.fn(async () => {
      if (!receipt) throw new Error('synthetic-not-claimed');
      return { ...receipt, phase: 'complete' as const };
    }),
  };
  const ports: PhotoWritePortsV1 = {
    authorize: vi.fn(async () => undefined),
    validate: vi.fn<PhotoWritePortsV1['validate']>(async (bytes, variant) => ({
      bytes,
      width: variant === 'portrait' ? 3 : 1,
      height: variant === 'portrait' ? 4 : 1,
    })),
    upload: vi.fn<PhotoWritePortsV1['upload']>(async (data) => ({
      ...data.metadata,
      driveId: 'synthetic-drive',
      itemId: data.variant,
      etag: 'synthetic-etag',
    })),
    remove: vi.fn(),
  };
  return { repository, ports, coordinator: new PhotoWriteCoordinatorV1(repository, ports) };
}

describe('photo writer interruption boundaries', () => {
  it('rechecks permission after processing and before claiming any persistent state', async () => {
    const test = harness();
    vi.mocked(test.ports.authorize)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic-revoked'));
    await expect(
      test.coordinator.execute(context, command, input, new AbortController().signal),
    ).rejects.toThrow('synthetic-revoked');
    expect(test.ports.validate).toHaveBeenCalledTimes(2);
    expect(test.repository.claim).not.toHaveBeenCalled();
    expect(test.ports.upload).not.toHaveBeenCalled();
  });
  it('refuses oversized codec output before hashing, reserving or uploading', async () => {
    const test = harness();
    vi.mocked(test.ports.validate).mockResolvedValueOnce({
      bytes: new Uint8Array(131073),
      width: 3,
      height: 4,
    });
    await expect(
      test.coordinator.execute(context, command, input, new AbortController().signal),
    ).rejects.toThrow('invalid');
    expect(test.repository.claim).not.toHaveBeenCalled();
    expect(test.ports.upload).not.toHaveBeenCalled();
  });
  it('reports an interrupted upload as pending, not a saved photo or safe deletion', async () => {
    const test = harness(),
      abort = new AbortController();
    vi.mocked(test.ports.upload).mockImplementationOnce(async () => {
      abort.abort();
      throw new Error('synthetic-response-lost');
    });
    expect(await test.coordinator.execute(context, command, input, abort.signal)).toEqual({
      state: 'pending',
      requestId: command.requestId,
      stage: 'upload',
    });
    expect(test.repository.claim).toHaveBeenCalledOnce();
    expect(test.repository.commit).not.toHaveBeenCalled();
    expect(test.repository.complete).not.toHaveBeenCalled();
    expect(test.ports.remove).not.toHaveBeenCalled();
  });
  it('does not commit after cancellation on the final upload acknowledgement', async () => {
    const test = harness(),
      abort = new AbortController();
    vi.mocked(test.ports.upload).mockImplementation(async (data) => {
      if (data.variant === 'avatar') abort.abort();
      return {
        ...data.metadata,
        driveId: 'synthetic-drive',
        itemId: data.variant,
        etag: 'synthetic-etag',
      };
    });
    expect(await test.coordinator.execute(context, command, input, abort.signal)).toEqual({
      state: 'pending',
      requestId: command.requestId,
      stage: 'commit',
    });
    expect(test.repository.commit).not.toHaveBeenCalled();
    expect(test.repository.complete).not.toHaveBeenCalled();
  });
});
