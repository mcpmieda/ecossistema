import { PHOTO_ADMIN_BODY_BYTES_V1 } from './admin-http-v1';

export class PhotoTransportReadErrorV1 extends Error {
  constructor(readonly code: 'invalid' | 'too-large' | 'timeout' | 'cancelled') {
    super(`student-photo-transport-${code}`);
  }
}
/** Plain JSON only (no content encoding); the declared length, when sent, must be a whole number
 * within the limit. */
function declaredPhotoBytesV1(headers: Headers): number | null {
  if (headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    throw new PhotoTransportReadErrorV1('invalid');
  const encoding = headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') throw new PhotoTransportReadErrorV1('invalid');
  const header = headers.get('content-length');
  const declared = header === null ? null : Number(header);
  if (header !== null && (!/^\d+$/u.test(header) || !Number.isSafeInteger(declared))) throw new PhotoTransportReadErrorV1('invalid');
  if (declared !== null && declared > PHOTO_ADMIN_BODY_BYTES_V1) throw new PhotoTransportReadErrorV1('too-large');
  return declared;
}
/** Shared browser/Worker reader. Authenticate server requests before calling it.
 * Bounds actual bytes, not just Content-Length, and does not await a stalled cancel(). */
export async function readPhotoJsonV1(message: Pick<Request, 'body' | 'headers'>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new PhotoTransportReadErrorV1('cancelled');
  const declared = declaredPhotoBytesV1(message.headers);
  const reader = message.body?.getReader();
  if (!reader) throw new PhotoTransportReadErrorV1('invalid');
  const storage = new Uint8Array(PHOTO_ADMIN_BODY_BYTES_V1);
  let size = 0, complete = false;
  let fail!: (error: PhotoTransportReadErrorV1) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { fail = reject; });
  const stop = (code: 'timeout' | 'cancelled') => {
    fail(new PhotoTransportReadErrorV1(code));
    void reader.cancel().catch(() => undefined);
  };
  const abort = () => stop('cancelled');
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('timeout'), 10_000);
  try {
    // The signal could have changed while obtaining a custom stream reader.
    if (signal.aborted) throw new PhotoTransportReadErrorV1('cancelled');
    while (true) {
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) { complete = true; break; }
      if (!(part.value instanceof Uint8Array)) throw new PhotoTransportReadErrorV1('invalid');
      if (part.value.length > storage.length - size) throw new PhotoTransportReadErrorV1('too-large');
      storage.set(part.value, size); size += part.value.length;
    }
    if (signal.aborted) throw new PhotoTransportReadErrorV1('cancelled');
    if (size === 0 || (declared !== null && declared !== size)) throw new PhotoTransportReadErrorV1('invalid');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(storage.subarray(0, size))); }
    catch { throw new PhotoTransportReadErrorV1('invalid'); }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    storage.fill(0);
  }
}
