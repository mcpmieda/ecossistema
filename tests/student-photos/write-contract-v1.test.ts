// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  PhotoWriteCoordinatorV1,
  type PhotoWritePortsV1,
} from '../../server/student-photos/write-coordinator-v1';
import {
  photoWriteContextV1,
  photoWriteCommandV1,
  photoWritePlanV1,
  assertPhotoWritePlanV1,
  photoWriteFingerprintV1,
  assertPhotoUploadedAssetsV1,
  photoWriteReceiptV1,
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
const plan: PhotoWritePlanV1 = {
  portrait: { sha256: 'a'.repeat(64), byteSize: 64, width: 3, height: 4 },
  avatar: { sha256: 'b'.repeat(64), byteSize: 64, width: 1, height: 1 },
};
const empty = { portrait: null, avatar: null };
const repository = () => ({
  claim: vi.fn(),
  commit: vi.fn(),
  acknowledgeCleanup: vi.fn(),
  complete: vi.fn(),
});
const ports = (): PhotoWritePortsV1 => ({
  authorize: vi.fn(async () => undefined),
  validate: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
});

describe('administrative photo write contracts', () => {
  it('rejects extra selectors, URLs and authorization claims in the request contract', () => {
    expect(
      photoWriteCommandV1.safeParse({ ...command, studentUid: context.studentUid }).success,
    ).toBe(false);
    expect(photoWriteContextV1.safeParse({ ...context, canWrite: true }).success).toBe(false);
    expect(
      photoWriteCommandV1.safeParse({
        ...command,
        expectedRevision: 'https://external.example/photo',
      }).success,
    ).toBe(false);
  });
  it('has exactly two bounded variants and no background-removal output', () => {
    expect(photoWritePlanV1.safeParse({ ...plan, transparent: plan.portrait }).success).toBe(false);
    expect(() => assertPhotoWritePlanV1(command, { ...plan, avatar: null })).toThrow('invalid');
    expect(() => assertPhotoWritePlanV1({ ...command, kind: 'avatar' }, plan)).toThrow('invalid');
    expect(() => assertPhotoWritePlanV1({ ...command, kind: 'remove' }, plan)).toThrow('invalid');
    expect(() =>
      assertPhotoWritePlanV1(command, { ...plan, portrait: { ...plan.portrait!, height: 5 } }),
    ).toThrow('invalid');
    expect(() =>
      assertPhotoWritePlanV1(command, {
        ...plan,
        avatar: { ...plan.avatar!, width: 321, height: 321 },
      }),
    ).toThrow('invalid');
    expect(() =>
      assertPhotoWritePlanV1(command, { ...plan, avatar: { ...plan.avatar!, byteSize: 65537 } }),
    ).toThrow('invalid');
    expect(
      photoWritePlanV1.safeParse({ ...plan, portrait: { ...plan.portrait!, byteSize: 131073 } })
        .success,
    ).toBe(false);
  });
  it('binds idempotency to the actor, permanent student, base revision and exact outputs', async () => {
    const first = await photoWriteFingerprintV1(context, command, plan);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(await photoWriteFingerprintV1(context, { ...command }, { ...plan })).toBe(first);
    expect(
      await photoWriteFingerprintV1({ ...context, actorId: context.studentUid }, command, plan),
    ).not.toBe(first);
    expect(
      await photoWriteFingerprintV1(
        context,
        { ...command, expectedRevision: context.studentUid },
        plan,
      ),
    ).not.toBe(first);
    expect(
      await photoWriteFingerprintV1(context, command, {
        ...plan,
        avatar: { ...plan.avatar!, sha256: 'c'.repeat(64) },
      }),
    ).not.toBe(first);
  });
  it('requires independently verified new file references, not an overwritten old file', () => {
    const receipt = photoWriteReceiptV1.parse({
      ...context,
      ...command,
      inputHash: 'c'.repeat(64),
      phase: 'prepared',
      plan,
      previous: empty,
      assets: empty,
      cleanup: [],
    });
    const portrait = { ...plan.portrait!, driveId: 'drive', itemId: 'portrait', etag: 'etag' };
    const avatar = { ...plan.avatar!, driveId: 'drive', itemId: 'avatar', etag: 'etag' };
    expect(() => assertPhotoUploadedAssetsV1(receipt, { portrait, avatar })).not.toThrow();
    expect(() =>
      assertPhotoUploadedAssetsV1(receipt, {
        portrait,
        avatar: { ...avatar, sha256: '0'.repeat(64) },
      }),
    ).toThrow('invalid');
    expect(() =>
      assertPhotoUploadedAssetsV1(receipt, { portrait, avatar: { ...avatar, itemId: 'portrait' } }),
    ).toThrow('invalid');
    expect(() =>
      assertPhotoUploadedAssetsV1(
        { ...receipt, previous: { portrait, avatar } },
        { portrait, avatar },
      ),
    ).toThrow('invalid');
  });
  it('checks administrative authorization before decoding, reserving or using Graph', async () => {
    const store = repository(),
      adapters = ports();
    adapters.authorize = vi.fn(async () => {
      throw new Error('synthetic-forbidden');
    });
    const coordinator = new PhotoWriteCoordinatorV1(store, adapters);
    await expect(
      coordinator.execute(
        context,
        command,
        { portrait: new Uint8Array(64), avatar: new Uint8Array(64) },
        new AbortController().signal,
      ),
    ).rejects.toThrow('synthetic-forbidden');
    expect(adapters.validate).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(adapters.upload).not.toHaveBeenCalled();
  });
  it('rejects invalid variant shape before a receipt and aborts before authorization when already cancelled', async () => {
    const store = repository(),
      adapters = ports(),
      coordinator = new PhotoWriteCoordinatorV1(store, adapters);
    await expect(
      coordinator.execute(context, command, empty, new AbortController().signal),
    ).rejects.toThrow('invalid');
    expect(store.claim).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort();
    vi.mocked(adapters.authorize).mockClear();
    await expect(coordinator.execute(context, command, empty, abort.signal)).rejects.toThrow();
    expect(adapters.authorize).not.toHaveBeenCalled();
  });
});
