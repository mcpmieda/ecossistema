// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../server/env';
import { PhotoCatalogRepositoryV1 } from '../../server/student-photos/catalog-repository-v1';
import { PhotoCatalogServiceV1 } from '../../server/student-photos/catalog-service-v1';
import { PhotoStorageV1 } from '../../server/student-photos/storage-v1';
import type { PhotoWriteDatabaseV1 } from '../../server/student-photos/write-repository-v1';

const context = { actorId: '10000000-0000-4000-8000-000000000001', studentUid: '20000000-0000-4000-8000-000000000001' };
const env = { PHOTO_STORAGE_SERVICE_KEY: 'x'.repeat(40) } as RuntimeEnv;
function repositoryFor() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('AS ready')) return [{ ready: 0 }];
    return [];
  });
  const database: PhotoWriteDatabaseV1 = { transaction: work => work({ query }) };
  return new PhotoCatalogRepositoryV1(database);
}

describe('private Storage catalog', () => {
  it('initializes confirmed absence without reading the old provider', async () => {
    const repository = repositoryFor();
    vi.spyOn(repository, 'initialize').mockResolvedValue();
    vi.spyOn(repository, 'state').mockResolvedValue({ version: 1, studentUid: context.studentUid,
      revision: null, initialized: true, hasPortrait: false, hasAvatar: false,
      pendingRequest: null, pendingKind: null, pendingStage: null, ownPending: false, portalReady: false });
    const service = new PhotoCatalogServiceV1(env, repository, async () => undefined);
    expect((await service.open(context, new AbortController().signal)).initialized).toBe(true);
    expect(repository.initialize).toHaveBeenCalledWith(context, null);
  });

  it('reads the exact private asset after authorization', async () => {
    const repository = repositoryFor();
    const asset = { driveId: 'student-photos', itemId: `legacy/${context.studentUid}/` + 'a'.repeat(64) + '.webp',
      etag: 'a'.repeat(64), sha256: 'a'.repeat(64), byteSize: 32, width: 3, height: 4 };
    vi.spyOn(repository, 'family').mockResolvedValue({ revision: context.studentUid, pending: null,
      assets: { portrait: asset, avatar: null } });
    const read = vi.spyOn(PhotoStorageV1.prototype, 'read').mockResolvedValue(new Uint8Array(32).fill(7));
    const authorize = vi.fn(async () => undefined);
    const service = new PhotoCatalogServiceV1(env, repository, authorize);
    expect(await service.read(context, 'avatar', context.studentUid, new AbortController().signal))
      .toEqual(new Uint8Array(32).fill(7));
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(asset, expect.any(AbortSignal));
    read.mockRestore();
  });
});
