// @vitest-environment node
import { createServer } from 'node:http';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createPhotoAdminClientV1 } from '../../src/features/student-photos/admin-client-v1';
import { PHOTO_ADMIN_BODY_BYTES_V1 } from '../../shared/student-photos/admin-http-v1';
import { subject, command, qualities, images, previewResponse } from './http-fixture-v1';
const signal = () => new AbortController().signal;

describe('decoded Fetch photo response boundaries', () => {
  it.each(['gzip', 'br'] as const)(
    'accepts real local HTTP %s content after Fetch decodes it',
    async (encoding) => {
      const text = await previewResponse().text();
      const compressed = encoding === 'gzip' ? gzipSync(text) : brotliCompressSync(text);
      let requests = 0;
      const server = createServer((request, response) => {
        requests++;
        request.resume();
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': encoding,
          'content-length': compressed.length,
          connection: 'close',
        });
        response.end(compressed);
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('synthetic-loopback-listener-invalid');
        const origin = `http://127.0.0.1:${address.port}`;
        const observed: { encoding: string | null; length: string | null }[] = [];
        const fetcher: typeof fetch = async (path, init) => {
          if (typeof path !== 'string' || path !== '/api/student-photos/admin/preview')
            throw new Error('synthetic-loopback-only');
          const response = await fetch(origin + path, init);
          observed.push({
            encoding: response.headers.get('content-encoding'),
            length: response.headers.get('content-length'),
          });
          return response;
        };
        const result = await createPhotoAdminClientV1(fetcher).preview(
          subject,
          command,
          qualities,
          images(),
          signal(),
        );
        expect(result.images.portrait).toEqual(images().portrait);
        expect(observed).toEqual([{ encoding, length: String(compressed.length) }]);
        expect(compressed.length).toBeLessThan(Buffer.byteLength(text));
        expect(requests).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it('still bounds actual decoded bytes and cancels an oversized response regardless of compressed length', async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(65536).fill(32));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(stream, {
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '1',
          },
        }),
    );
    await expect(
      createPhotoAdminClientV1(fetcher).preview(subject, command, qualities, images(), signal()),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls * 65536).toBeGreaterThan(PHOTO_ADMIN_BODY_BYTES_V1);
    expect(pulls).toBeLessThanOrEqual(7);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
