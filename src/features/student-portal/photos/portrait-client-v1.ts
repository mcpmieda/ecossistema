import {
  portraitMetadataV1,
  portraitContentPathV1,
  STUDENT_PHOTO_META_PATH_V1,
  STUDENT_PHOTO_MAX_BYTES_V1,
  type PortraitMetadataV1,
} from '../../../../shared/student-photos/portrait-v1';

export interface PortraitObjectV1 {
  src: string;
  dispose(): void;
}
export type PortraitClientV1 = (
  accountId: string,
  signal: AbortSignal,
) => Promise<PortraitObjectV1 | undefined>;

async function boundedBody(
  response: Response,
  signal: AbortSignal,
  limit: number,
): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw new Error('student-photo-response-size');
  }
  if (!response.body) throw new Error('student-photo-response-empty');
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('student-photo-response-size');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Decode only the small approved WebP, never an original file or a background-removal model. */
export function decodePortraitObjectV1(
  src: string,
  metadata: PortraitMetadataV1,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (valid: boolean) => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
      image.removeAttribute('src');
      resolve(valid);
    };
    const abort = () => finish(false);
    image.onload = () =>
      finish(
        !signal.aborted &&
          image.naturalWidth === metadata.width &&
          image.naturalHeight === metadata.height,
      );
    image.onerror = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) finish(false);
    else image.src = src;
  });
}

/** One metadata request, then one bounded image request, only on explicit session load.
 * The disposable blob avoids a second authenticated download and broken-image UI in older shells.
 */
export function createPortraitClientV1(
  options: {
    fetch?: typeof fetch;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (src: string) => void;
    decode?: typeof decodePortraitObjectV1;
    timeoutMs?: number;
  } = {},
): PortraitClientV1 {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const create = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
  const revoke = options.revokeObjectURL ?? ((src) => URL.revokeObjectURL(src));
  const decode = options.decode ?? decodePortraitObjectV1;
  return async (accountId, signal) => {
    if (signal.aborted) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 6000);
    let src: string | undefined;
    let retained = false;
    let released = false;
    const dispose = () => {
      if (src && !released) {
        released = true;
        revoke(src);
      }
    };
    const init: RequestInit = {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    };
    const cancel = async (response: Response) => {
      await response.body?.cancel().catch(() => undefined);
    };
    try {
      const response = await send(STUDENT_PHOTO_META_PATH_V1, init);
      if (
        response.status !== 200 ||
        response.redirected ||
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
      ) {
        await cancel(response);
        return undefined;
      }
      const metadata = portraitMetadataV1.parse(
        JSON.parse(new TextDecoder().decode(await boundedBody(response, controller.signal, 1024))),
      );
      // A cookie changed in another tab must not put that account's photo under this profile's name.
      if (metadata.accountId.toLowerCase() !== accountId.toLowerCase()) return undefined;
      const image = await send(portraitContentPathV1(metadata.revision), init);
      if (
        image.status !== 200 ||
        image.redirected ||
        image.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/webp'
      ) {
        await cancel(image);
        return undefined;
      }
      const bytes = await boundedBody(image, controller.signal, STUDENT_PHOTO_MAX_BYTES_V1);
      if (bytes.byteLength < 20) return undefined;
      src = create(new Blob([new Uint8Array(bytes).buffer], { type: 'image/webp' }));
      if (!(await decode(src, metadata, controller.signal)) || controller.signal.aborted)
        return undefined;
      retained = true;
      return { src, dispose };
    } catch {
      // Photos are optional. Do not change session/grades, log private data or retry on a timer.
      return undefined;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (!retained) dispose();
    }
  };
}
