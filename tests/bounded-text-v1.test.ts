// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readBoundedTextV1 } from '../server/http/bounded-text-v1';

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('https://admin.escolaieda.com/x', { method: 'POST', body, headers });

describe('request bodies read with a limit (issue #1450, 102)', () => {
  it('returns the text and its size within the limit', async () => {
    await expect(readBoundedTextV1(post('{"a":1}'), 100)).resolves.toEqual({
      text: '{"a":1}',
      bytes: 7,
    });
  });

  it('refuses a declared size over the limit before reading', async () => {
    await expect(
      readBoundedTextV1(post('x', { 'content-length': '999' }), 100),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('refuses a streamed body as soon as it passes the limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64));
      },
    });
    await expect(
      readBoundedTextV1(
        new Request('https://admin.escolaieda.com/x', {
          method: 'POST',
          body: stream,
          duplex: 'half',
        } as RequestInit),
        100,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
});
