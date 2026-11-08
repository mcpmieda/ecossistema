import type { RuntimeEnv } from '../env';
import { PhotoWriteErrorV1, type PhotoWriteContextV1 } from '../../shared/student-photos/write-v1';
import { PhotoCatalogRepositoryV1 } from './catalog-repository-v1';
import { PhotoStorageV1 } from './storage-v1';

/** Administrative catalog; source import is a separate, privileged one-time operation. */
export class PhotoCatalogServiceV1 {
  private readonly storage: PhotoStorageV1;
  constructor(env: RuntimeEnv, readonly repository: PhotoCatalogRepositoryV1,
    private readonly authorize: (context: PhotoWriteContextV1) => Promise<void>) {
    this.storage = new PhotoStorageV1(env.PHOTO_STORAGE_SERVICE_KEY, async () => {
      throw new PhotoWriteErrorV1('invalid');
    });
  }
  async open(context: PhotoWriteContextV1, signal: AbortSignal) {
    await this.authorize(context); signal.throwIfAborted();
    let family = await this.repository.family(context.studentUid);
    if (!family) {
      await this.authorize(context); signal.throwIfAborted();
      await this.repository.initialize(context, null);
      family = await this.repository.family(context.studentUid);
    }
    if (family?.assets.portrait) {
      const current = await this.repository.state(context);
      if (!current.portalReady) {
        await this.authorize(context); signal.throwIfAborted();
        const bytes = await this.storage.read(family.assets.portrait, signal);
        bytes.fill(0);
        await this.authorize(context); signal.throwIfAborted();
        await this.repository.publish(context, 'portrait', family.assets.portrait);
      }
    }
    await this.authorize(context);
    return this.repository.state(context);
  }
  async read(context: PhotoWriteContextV1, variant: 'portrait' | 'avatar', revision: string | null,
    signal: AbortSignal): Promise<Uint8Array | null> {
    await this.authorize(context); signal.throwIfAborted();
    const family = await this.repository.family(context.studentUid);
    if (!family || revision !== null && family.revision !== revision) return null;
    const asset = family.assets[variant] ?? family.assets.portrait;
    if (!asset) return null;
    const bytes = await this.storage.read(asset, signal);
    try { await this.authorize(context); signal.throwIfAborted(); return bytes; }
    catch (error) { bytes.fill(0); throw error; }
  }
}
