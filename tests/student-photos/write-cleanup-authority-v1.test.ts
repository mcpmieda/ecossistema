// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  PhotoWriteCoordinatorV1,
  type PhotoWritePortsV1,
} from '../../server/student-photos/write-coordinator-v1';
import type { PhotoWriteRepositoryV1 } from '../../server/student-photos/write-repository-v1';
import { photoWriteReceiptV1 } from '../../shared/student-photos/write-v1';

const context = {
  actorId: '10000000-0000-4000-8000-000000000001',
  studentUid: '20000000-0000-4000-8000-000000000001',
};
const command = {
  requestId: '30000000-0000-4000-8000-000000000001',
  expectedRevision: null,
  kind: 'remove' as const,
};
const empty = { portrait: null, avatar: null };
const metadata = {
  sha256: 'a'.repeat(64),
  byteSize: 64,
  width: 3,
  height: 4,
  driveId: 'synthetic-drive',
  etag: 'synthetic-etag',
};

/** Isolates post-commit control flow; database atomicity is covered by native PostgreSQL tests. */
function harness() {
  const portrait = { ...metadata, itemId: 'retired-portrait' };
  const avatar = { ...metadata, width: 1, height: 1, itemId: 'retired-avatar' };
  const receipt = photoWriteReceiptV1.parse({
    ...context,
    ...command,
    plan: empty,
    inputHash: 'a'.repeat(64),
    phase: 'committed',
    previous: { portrait, avatar },
    assets: empty,
    cleanup: [portrait, avatar],
  });
  const repository = {
    claim: vi.fn<PhotoWriteRepositoryV1['claim']>(async () => receipt),
    commit: vi.fn<PhotoWriteRepositoryV1['commit']>(),
    acknowledgeCleanup: vi.fn<PhotoWriteRepositoryV1['acknowledgeCleanup']>(
      async (_context, _requestId, asset) => ({
        ...receipt,
        cleanup: receipt.cleanup.filter((item) => item.itemId !== asset.itemId),
      }),
    ),
    complete: vi.fn<PhotoWriteRepositoryV1['complete']>(),
  };
  const ports: PhotoWritePortsV1 = {
    authorize: vi.fn(async () => undefined),
    validate: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn<PhotoWritePortsV1['remove']>(async () => 'deleted'),
  };
  return {
    repository,
    ports,
    receipt,
    coordinator: new PhotoWriteCoordinatorV1(repository, ports),
  };
}
const pending = {
  state: 'committed',
  requestId: command.requestId,
  revision: command.requestId,
  cleanupPending: true,
};

describe('authority loss after a committed photo operation', () => {
  it('preserves the committed outcome when cleanup authorization fails before the first deletion', async () => {
    const test = harness();
    vi.mocked(test.ports.authorize)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic-permission-revoked'));
    expect(
      await test.coordinator.execute(context, command, empty, new AbortController().signal),
    ).toEqual(pending);
    expect(test.repository.claim).toHaveBeenCalledOnce();
    expect(test.ports.remove).not.toHaveBeenCalled();
    expect(test.repository.acknowledgeCleanup).not.toHaveBeenCalled();
    expect(test.repository.complete).not.toHaveBeenCalled();
  });

  it('stops before the second deletion when permission is lost after one retired file was removed', async () => {
    const test = harness();
    vi.mocked(test.ports.authorize)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic-permission-revoked'));
    expect(
      await test.coordinator.execute(context, command, empty, new AbortController().signal),
    ).toEqual(pending);
    expect(test.ports.remove).toHaveBeenCalledExactlyOnceWith(
      test.receipt.cleanup[0],
      expect.any(AbortSignal),
    );
    expect(test.repository.acknowledgeCleanup).toHaveBeenCalledExactlyOnceWith(
      context,
      command.requestId,
      test.receipt.cleanup[0],
      'deleted',
    );
    expect(test.repository.complete).not.toHaveBeenCalled();
  });

  it('keeps cancellation checks after asynchronous cleanup authorization and performs no deletion', async () => {
    const test = harness(),
      abort = new AbortController();
    vi.mocked(test.ports.authorize)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        abort.abort();
      });
    expect(await test.coordinator.execute(context, command, empty, abort.signal)).toEqual(pending);
    expect(test.ports.remove).not.toHaveBeenCalled();
    expect(test.repository.complete).not.toHaveBeenCalled();
  });
});
