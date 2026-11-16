// @vitest-environment node
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { PhotoStorageV1 } from '../../server/student-photos/storage-v1';
import { syntheticWebpV1 } from '../student-portal/photos/fixture-v1';

const uid = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001';
const bytes = syntheticWebpV1();
const sha256 = createHash('sha256').update(bytes).digest('hex');
const metadata = { sha256, byteSize: bytes.length, width: 3, height: 4 };
const signal = new AbortController().signal;

it('keeps objects private, immutable, verified and guarded through upload, read and cleanup', async () => {
  const objects = new Map<string, Uint8Array>();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method;
    expect(url.origin).toBe('https://knzzyqgafdkwzjmdrfea.supabase.co');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + 'k'.repeat(40));
    const prefix = '/storage/v1/object/';
    const path = url.pathname
      .slice(prefix.length)
      .replace(/^authenticated\//u, '')
      .replace(/^student-photos\/?/u, '');
    if (method === 'GET') {
      const value = objects.get(path);
      return value
        ? new Response(new Uint8Array(value).buffer, {
            status: 200,
            headers: { 'content-length': String(value.length) },
          })
        : Response.json(
            {
              statusCode: '404',
              error: 'not_found',
              code: 'NoSuchKey',
              message: 'Object not found',
            },
            { status: 400 },
          );
    }
    if (method === 'POST') {
      if (objects.has(path)) return new Response(null, { status: 400 });
      objects.set(path, new Uint8Array(await new Response(init?.body).arrayBuffer()));
      return new Response('{}', { status: 200 });
    }
    if (method === 'DELETE') {
      const payload = JSON.parse(String(init?.body)) as { prefixes: string[] };
      return Response.json(
        payload.prefixes.filter((value) => objects.delete(value)).map((name) => ({ name })),
      );
    }
    throw new Error('unexpected method');
  });
  const authorize = vi.fn(async () => undefined);
  const storage = new PhotoStorageV1('k'.repeat(40), authorize, fetcher as unknown as typeof fetch);
  const input = {
    context: { studentUid: uid, actorId },
    requestId,
    variant: 'portrait' as const,
    bytes,
    metadata,
    signal,
  };
  const asset = await storage.upload(input);
  expect(asset).toMatchObject({ ...metadata, driveId: 'student-photos', etag: sha256 });
  expect(asset.itemId).toBe(`write/${uid}/${requestId}/portrait-${sha256}.webp`);
  expect(await storage.read(asset, signal)).toEqual(bytes);
  expect(await storage.upload(input)).toEqual(asset);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  objects.set(asset.itemId, new Uint8Array(bytes.length).fill(1));
  await expect(storage.read(asset, signal)).rejects.toThrow('student-photo-storage-integrity');
  objects.set(asset.itemId, new Uint8Array(bytes));
  expect(await storage.remove(asset, signal)).toBe('deleted');
  expect(await storage.remove(asset, signal)).toBe('already-absent');
  expect(authorize).toHaveBeenCalled();
});

it('does not reach Storage when the current application permission is revoked', async () => {
  const fetcher = vi.fn();
  const storage = new PhotoStorageV1(
    'k'.repeat(40),
    async () => {
      throw new Error('revoked');
    },
    fetcher as unknown as typeof fetch,
  );
  await expect(
    storage.upload({
      context: { studentUid: uid, actorId },
      requestId,
      variant: 'portrait',
      bytes,
      metadata,
      signal,
    }),
  ).rejects.toThrow('revoked');
  expect(fetcher).not.toHaveBeenCalled();
});

it('calls the platform fetch without an object receiver', async () => {
  const fetcher = function (this: unknown): Promise<Response> {
    expect(this).toBeUndefined();
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  const storage = new PhotoStorageV1(
    'k'.repeat(40),
    async () => undefined,
    fetcher as typeof fetch,
  );
  await expect(
    storage.read(
      {
        ...metadata,
        driveId: 'student-photos',
        itemId: `write/${uid}/${requestId}/portrait-${sha256}.webp`,
        etag: sha256,
      },
      signal,
    ),
  ).rejects.toThrow('student-photo-storage-absent');
});

it('does not interpret other Storage 400 responses as an absent object', async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      { statusCode: '400', error: 'invalid_request', code: 'InvalidKey' },
      { status: 400 },
    ),
  );
  const storage = new PhotoStorageV1(
    'k'.repeat(40),
    async () => undefined,
    fetcher as unknown as typeof fetch,
  );
  await expect(
    storage.upload({
      context: { studentUid: uid, actorId },
      requestId,
      variant: 'portrait',
      bytes,
      metadata,
      signal,
    }),
  ).rejects.toThrow('student-photo-storage-read-400');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('keeps a verified copy in the Worker cache and drops a copy that fails the check', async () => {
  const store = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: Request) => store.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, value: Response) => {
      store.set(key.url, value);
    }),
    delete: vi.fn(async (key: Request) => store.delete(key.url)),
  };
  const fetcher = vi.fn(async () => new Response(bytes.slice(), { status: 200 }));
  const storage = new PhotoStorageV1(
    'k'.repeat(40),
    async () => undefined,
    fetcher as unknown as typeof fetch,
    cache as unknown as Cache,
  );
  const asset = {
    ...metadata,
    driveId: 'student-photos',
    itemId: `write/${uid}/${requestId}/portrait-${sha256}.webp`,
    etag: sha256,
  };
  expect(await storage.read(asset, signal)).toEqual(bytes);
  expect(await storage.read(asset, signal)).toEqual(bytes);
  // The second read comes from the cache, keyed by content, never by student.
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect([...store.keys()]).toEqual([`https://student-photo-cache.invalid/${sha256}`]);
  // A damaged copy is not served, and leaves the cache.
  store.set(
    `https://student-photo-cache.invalid/${sha256}`,
    new Response(new Uint8Array(bytes.length)),
  );
  await expect(storage.read(asset, signal)).rejects.toThrow('student-photo-storage-integrity');
  expect(store.size).toBe(0);
});
