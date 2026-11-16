// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readPhotoJsonV1,
  PhotoTransportReadErrorV1,
} from '../../shared/student-photos/bounded-json-v1';
import {
  PHOTO_ADMIN_BODY_BYTES_V1,
  decodePhotoBytesV1,
  encodePhotoBytesV1,
} from '../../shared/student-photos/admin-http-v1';
import { images } from './http-fixture-v1';
const signal = () => new AbortController().signal;
function message(bytes: Uint8Array[], headers: Record<string, string> = {}) {
  return {
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        for (const part of bytes) controller.enqueue(new Uint8Array(part));
        controller.close();
      },
    }),
  };
}
afterEach(() => vi.useRealTimers());
describe('bounded photo transport', () => {
  it('reads split UTF-8 and accepts exactly the fixed wire budget', async () => {
    const raw = new TextEncoder().encode('{"label":"á"}');
    expect(
      await readPhotoJsonV1(message([raw.subarray(0, 11), raw.subarray(11)]), signal()),
    ).toEqual({ label: 'á' });
    const atLimit = new TextEncoder().encode(' '.repeat(PHOTO_ADMIN_BODY_BYTES_V1 - 2) + '{}');
    expect(await readPhotoJsonV1(message([atLimit]), signal())).toEqual({});
  });
  it('checks actual length even without Content-Length or with a forged smaller header', async () => {
    const cases: Record<string, string>[] = [{}, { 'content-length': '2' }];
    for (const headers of cases) {
      const data = message([new Uint8Array(PHOTO_ADMIN_BODY_BYTES_V1), new Uint8Array(1)], headers);
      await expect(readPhotoJsonV1(data, signal())).rejects.toMatchObject({ code: 'too-large' });
    }
    await expect(
      readPhotoJsonV1(
        message([new TextEncoder().encode('{}')], { 'content-length': '3' }),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('rejects compressed/non-JSON data, invalid UTF-8 and malformed lengths', async () => {
    const bytes = new TextEncoder().encode('{}');
    const cases: Record<string, string>[] = [
      { 'content-encoding': 'gzip' },
      { 'content-type': 'text/plain' },
      { 'content-length': '-1' },
      { 'content-length': '2.0' },
      { 'content-length': '2e0' },
      { 'content-length': '9007199254740992' },
    ];
    for (const headers of cases) {
      await expect(readPhotoJsonV1(message([bytes], headers), signal())).rejects.toBeInstanceOf(
        PhotoTransportReadErrorV1,
      );
    }
    await expect(
      readPhotoJsonV1(message([Uint8Array.of(255, 254)]), signal()),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('cancels an infinite read without waiting for a stuck underlying cancel', async () => {
    const controller = new AbortController(),
      cancel = vi.fn(() => new Promise<void>(() => undefined));
    const pending = readPhotoJsonV1(
      {
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new ReadableStream({
          pull() {
            return new Promise<void>(() => undefined);
          },
          cancel,
        }),
      },
      controller.signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('has an absolute reading deadline rather than resetting the timer for each chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cancel = vi.fn();
    const pending = readPhotoJsonV1(
      {
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new ReadableStream({
          pull() {
            return new Promise<void>(() => undefined);
          },
          cancel,
        }),
      },
      signal(),
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('round-trips byte data without changing caller arrays and rejects base64 whitespace/padding variants', () => {
    const source = images(),
      before = source.portrait.slice(),
      encoded = encodePhotoBytesV1(source);
    const decoded = decodePhotoBytesV1(encoded);
    expect(decoded.portrait).toEqual(source.portrait);
    expect(decoded.portrait).not.toBe(source.portrait);
    expect(source.portrait).toEqual(before);
    expect(() => decodePhotoBytesV1({ ...encoded, avatar: encoded.avatar + '\n' })).toThrow();
  });
});
