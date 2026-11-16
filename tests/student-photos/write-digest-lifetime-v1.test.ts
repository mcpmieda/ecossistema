// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PhotoWriteCoordinatorV1,
  type PhotoWritePortsV1,
} from '../../server/student-photos/write-coordinator-v1';
const context = {
  actorId: '11111111-1111-4111-8111-111111111111',
  studentUid: '22222222-2222-4222-8222-222222222222',
};
const command = {
  requestId: '33333333-3333-4333-8333-333333333333',
  expectedRevision: null,
  kind: 'avatar' as const,
};
afterEach(() => vi.restoreAllMocks());
describe('coordinator digest buffer lifetime', () => {
  it.each([false, true])(
    'clears the private digest buffer even when digest fails: %s',
    async (shouldFail) => {
      const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
      const captured: Uint8Array[] = [];
      vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, input) => {
        const bytes =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        captured.push(bytes);
        expect(bytes.some((value) => value !== 0)).toBe(true);
        if (shouldFail) throw new Error('synthetic-digest-failure');
        return originalDigest(algorithm, input);
      });
      const stop = async () => {
        throw new Error('synthetic-stop-before-write');
      };
      const repository = {
        claim: vi.fn(stop),
        commit: vi.fn(stop),
        acknowledgeCleanup: vi.fn(stop),
        complete: vi.fn(stop),
      };
      const ports: PhotoWritePortsV1 = {
        authorize: async () => undefined,
        validate: async (bytes) => ({ bytes: new Uint8Array(bytes), width: 4, height: 4 }),
        upload: stop,
        remove: stop,
      };
      const source = new Uint8Array(64).fill(77);
      await expect(
        new PhotoWriteCoordinatorV1(repository, ports).execute(
          context,
          command,
          { portrait: null, avatar: source },
          new AbortController().signal,
        ),
      ).rejects.toThrow(shouldFail ? 'synthetic-digest-failure' : 'synthetic-stop-before-write');
      expect(captured).toHaveLength(1);
      expect(Array.from(captured[0]!)).toEqual(Array(64).fill(0));
      expect(Array.from(source)).toEqual(Array(64).fill(77));
      expect(repository.commit).not.toHaveBeenCalled();
    },
  );
});
