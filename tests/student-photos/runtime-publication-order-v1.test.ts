// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../server/env';
import type { PhotoWriteReceiptV1 } from '../../shared/student-photos/write-v1';
import { StudentWebpCodecV1 } from '../../server/student-photos/webp-codec-v1';
import type { PhotoWriteDatabaseV1 } from '../../server/student-photos/write-repository-v1';
import { createPhotoRuntimeServiceV1 } from '../../server/student-photos/runtime-service-v1';
import { command, preview, images, ACTOR, STUDENT } from './http-fixture-v1';
const controls = vi.hoisted(() => ({
  trace: [] as string[],
  cleanupFails: true,
  publishFails: false,
  receipt: undefined as unknown,
}));
vi.mock('../../server/student-photos/write-repository-v1', () => ({
  PhotoWriteRepositoryV1: class {
    async claim() {
      return controls.receipt;
    }
    async commit() {
      throw new Error('already-committed');
    }
    async acknowledgeCleanup() {
      return { ...(controls.receipt as object), cleanup: [] };
    }
    async complete() {
      controls.trace.push('complete');
      return { ...(controls.receipt as object), phase: 'complete' };
    }
  },
}));
vi.mock('../../server/student-photos/write-guard-v1', () => ({
  PhotoWriteGuardV1: class {
    async assertInitialized() {}
    async assertTransfer() {}
  },
}));
vi.mock('../../server/student-photos/catalog-repository-v1', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../server/student-photos/catalog-repository-v1')>();
  return {
    ...actual,
    PhotoCatalogRepositoryV1: class {
      async publish(_context: unknown, variant: string, _asset: unknown) {
        if (controls.publishFails) throw new Error('synthetic-publication-outage');
        controls.trace.push('publish-' + variant);
      }
    },
  };
});
vi.mock('../../server/student-photos/storage-v1', () => ({
  PhotoStorageV1: class {
    async upload() {
      throw new Error('already-uploaded');
    }
    async read() {
      return new Uint8Array(32).fill(7);
    }
    async remove() {
      controls.trace.push('remove');
      if (controls.cleanupFails) throw new Error('synthetic-etag-conflict');
      return 'deleted';
    }
  },
}));
const context = { actorId: ACTOR, studentUid: STUDENT };
beforeEach(() => {
  controls.trace.length = 0;
  controls.cleanupFails = true;
  controls.publishFails = false;
});
function runtime() {
  const approval = preview().approval;
  const asset = (variant: 'portrait' | 'avatar') => ({
    ...approval.output[variant]!,
    driveId: 'synthetic-drive',
    itemId: 'new-' + variant,
    etag: 'synthetic-etag',
  });
  const old = { ...asset('portrait'), itemId: 'old-portrait' };
  const receipt: PhotoWriteReceiptV1 = {
    ...command,
    ...context,
    inputHash: 'a'.repeat(64),
    phase: 'committed',
    plan: approval.output,
    assets: { portrait: asset('portrait'), avatar: asset('avatar') },
    previous: { portrait: old, avatar: null },
    cleanup: [old],
  };
  controls.receipt = receipt;
  const bytes = images();
  const hex = (value: Uint8Array) =>
    Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const database: PhotoWriteDatabaseV1 = {
    transaction: (work) =>
      work({
        query: async (sql) =>
          sql.includes('SELECT o.receipt')
            ? [{ receipt, portrait: hex(bytes.portrait), avatar: hex(bytes.avatar) }]
            : [],
      }),
  };
  const codec = new StudentWebpCodecV1(
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
  );
  vi.spyOn(codec, 'normalize').mockImplementation(async (value, variant) => ({
    bytes: new Uint8Array(value),
    width: variant === 'portrait' ? 3 : 4,
    height: 4,
  }));
  vi.spyOn(codec, 'validate').mockImplementation(async (_value, variant) => ({
    width: variant === 'portrait' ? 3 : 4,
    height: 4,
  }));
  return {
    service: createPhotoRuntimeServiceV1({
      env: {} as RuntimeEnv,
      database,
      codec,
      authorize: async () => undefined,
    }),
    approval,
  };
}
it.each(['save', 'recover'])(
  'publishes before a cleanup ETag conflict in the actual %s composition',
  async (mode) => {
    const { service, approval } = runtime();
    const signal = new AbortController().signal;
    const result =
      mode === 'save'
        ? await service.edit.save(context, command, approval, images(), signal)
        : await service.recover(context, command.requestId, signal);
    expect(result).toMatchObject({ state: 'committed', cleanupPending: true });
    expect(controls.trace).toEqual(['publish-portrait', 'publish-avatar', 'remove']);
  },
);
it('retains pending recovery bytes when publication fails, before touching the old file', async () => {
  const { service, approval } = runtime();
  controls.publishFails = true;
  expect(
    await service.edit.save(context, command, approval, images(), new AbortController().signal),
  ).toMatchObject({ state: 'committed', cleanupPending: true });
  expect(controls.trace).toEqual([]);
});
it('reuses the publisher idempotently when completing cleanup', async () => {
  const { service, approval } = runtime();
  controls.cleanupFails = false;
  expect(
    await service.edit.save(context, command, approval, images(), new AbortController().signal),
  ).toMatchObject({ state: 'committed', cleanupPending: false });
  expect(controls.trace).toEqual([
    'publish-portrait',
    'publish-avatar',
    'remove',
    'publish-portrait',
    'publish-avatar',
    'complete',
  ]);
});
