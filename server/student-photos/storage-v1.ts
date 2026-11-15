import { photoAssetV1, PhotoWriteErrorV1, type PhotoAssetV1, type PhotoWriteContextV1,
  type PhotoVariantMetadataV1 } from '../../shared/student-photos/write-v1';
import { probePhotoSourceV1 } from '../../shared/student-photos/source-probe-v1';
import type { PhotoWritePortsV1, PhotoVariantV1 } from './write-coordinator-v1';

export const PHOTO_BUCKET_V1 = 'student-photos';
const base = 'https://knzzyqgafdkwzjmdrfea.supabase.co/storage/v1/object';
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer));
class PhotoStorageAbsentV1 extends Error {}
async function missingObject(response: Response): Promise<boolean> {
  if (response.status === 404) { await response.body?.cancel(); return true; }
  if (response.status !== 400) { await response.body?.cancel(); return false; }
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let json = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512) { await reader.cancel(); return false; }
      json += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(json + decoder.decode()) as Record<string, unknown>;
    return body?.code === 'NoSuchKey' && body?.error === 'not_found'
      && (body?.statusCode === '404' || body?.statusCode === 404);
  } catch { await reader.cancel().catch(() => undefined); return false; }
}

export type PhotoStorageActionV1 =
  | { kind: 'upload'; context: PhotoWriteContextV1; requestId: string; variant: PhotoVariantV1; metadata: PhotoVariantMetadataV1 }
  | { kind: 'remove'; asset: PhotoAssetV1 };

/** Private Storage API transport. The application session is checked by authorize before each operation. */
export class PhotoStorageV1 {
  constructor(private readonly serviceKey: string | undefined,
    private readonly authorize: (action: PhotoStorageActionV1) => Promise<void>,
    private readonly fetcher: typeof fetch = fetch,
    /** Reads only, never writes: the Portal (owner decision 14/11/2026) and the ADM (#1473). See read(). */
    private readonly cache?: Cache) {
    if (!serviceKey || serviceKey.length < 40) throw new Error('student-photo-storage-unavailable');
  }

  private headers(extra?: Record<string, string>): Headers {
    return new Headers({ apikey: this.serviceKey!, Authorization: `Bearer ${this.serviceKey!}`, ...extra });
  }
  private objectUrl(path: string, authenticated = false): string {
    if (!/^(?:legacy|write)\/[0-9a-f-]{36}\/[A-Za-z0-9_/-]{1,128}(?:\.webp)?$/u.test(path)
      || path.includes('..') || path.includes('//')) throw new PhotoWriteErrorV1('invalid');
    return `${base}/${authenticated ? 'authenticated/' : ''}${PHOTO_BUCKET_V1}/${path}`;
  }
  private async request(url: string, method: string, signal: AbortSignal,
    body?: BodyInit, extra?: Record<string, string>): Promise<Response> {
    const fetcher = this.fetcher;
    const response = await fetcher(url, { method, headers: this.headers(extra), body,
      redirect: 'manual', credentials: 'omit', signal });
    if (response.redirected || response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); throw new Error('student-photo-storage-redirect');
    }
    return response;
  }
  async read(assetInput: PhotoAssetV1, signal: AbortSignal): Promise<Uint8Array> {
    const asset = photoAssetV1.parse(assetInput);
    if (asset.driveId !== PHOTO_BUCKET_V1 || asset.etag !== asset.sha256)
      throw new PhotoWriteErrorV1('invalid');
    const url = this.objectUrl(asset.itemId, true);
    // Each Storage read takes ~270 ms (median; ~550 ms p90, Supabase edge logs 14/11/2026). The bytes are
    // kept in the Worker's own cache, keyed by their SHA-256: never sent to a browser or shared cache,
    // served only after the database authorized this very object, and verified again below.
    const key = this.cache ? new Request(`https://student-photo-cache.invalid/${asset.sha256}`) : null;
    const cached = key ? await this.cache!.match(key).catch(() => undefined) : undefined;
    const response = cached ?? await this.request(url, 'GET', signal);
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 131072) {
      if (await missingObject(response)) throw new PhotoStorageAbsentV1('student-photo-storage-absent');
      throw new Error(`student-photo-storage-read-${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      if (bytes.length !== asset.byteSize || await sha256(bytes) !== asset.sha256)
        throw new Error('student-photo-storage-integrity');
      const shape = probePhotoSourceV1(bytes);
      if (shape.type !== 'image/webp' || shape.width !== asset.width || shape.height !== asset.height)
        throw new Error('student-photo-storage-integrity');
      if (key && !cached) await this.cache!.put(key, new Response(bytes.slice(), {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=86400' } })).catch(() => undefined);
      return bytes;
    } catch (error) {
      bytes.fill(0);
      if (key && cached) await this.cache!.delete(key).catch(() => undefined);
      throw error;
    }
  }
  async upload(input: Parameters<PhotoWritePortsV1['upload']>[0]): Promise<PhotoAssetV1> {
    const { context, requestId, variant, metadata, signal } = input;
    const action: PhotoStorageActionV1 = { kind: 'upload', context, requestId, variant, metadata };
    await this.authorize(action); signal.throwIfAborted();
    if (input.bytes.length !== metadata.byteSize || await sha256(input.bytes) !== metadata.sha256)
      throw new PhotoWriteErrorV1('invalid');
    const shape = probePhotoSourceV1(input.bytes);
    if (shape.type !== 'image/webp' || shape.width !== metadata.width || shape.height !== metadata.height)
      throw new PhotoWriteErrorV1('invalid');
    const path = `write/${context.studentUid}/${requestId}/${variant}-${metadata.sha256}.webp`;
    const asset = photoAssetV1.parse({ ...metadata, driveId: PHOTO_BUCKET_V1, itemId: path, etag: metadata.sha256 });
    const url = this.objectUrl(path);
    const checkExisting = async () => {
      await this.authorize(action); signal.throwIfAborted();
      try { const bytes = await this.read(asset, signal); bytes.fill(0); return true; }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof PhotoStorageAbsentV1) return false;
        throw error;
      }
    };
    if (await checkExisting()) return asset;
    await this.authorize(action); signal.throwIfAborted();
    const response = await this.request(url, 'POST', signal, new Uint8Array(input.bytes).buffer,
      { 'Content-Type': 'image/webp', 'x-upsert': 'false' });
    await response.body?.cancel();
    if (!response.ok && !(await checkExisting())) throw new Error('student-photo-storage-upload');
    if (!(await checkExisting())) throw new Error('student-photo-storage-verify');
    return asset;
  }
  async remove(assetInput: PhotoAssetV1, signal: AbortSignal): Promise<'deleted' | 'already-absent'> {
    const asset = photoAssetV1.parse(assetInput);
    const action: PhotoStorageActionV1 = { kind: 'remove', asset };
    await this.authorize(action); signal.throwIfAborted();
    let bytes: Uint8Array;
    try { bytes = await this.read(asset, signal); }
    catch (error) {
      if (error instanceof PhotoStorageAbsentV1) return 'already-absent';
      throw error;
    }
    bytes.fill(0);
    await this.authorize(action); signal.throwIfAborted();
    const response = await this.request(`${base}/${PHOTO_BUCKET_V1}`, 'DELETE', signal,
      JSON.stringify({ prefixes: [asset.itemId] }), { 'Content-Type': 'application/json' });
    if (!response.ok) { await response.body?.cancel(); throw new Error('student-photo-storage-delete'); }
    const removed = await response.json() as unknown;
    if (!Array.isArray(removed) || removed.length !== 1) throw new Error('student-photo-storage-delete-conflict');
    return 'deleted';
  }
}
