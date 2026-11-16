import { HttpError } from './security';

/**
 * The request body as text, read only up to `maxBytes`: a declared or streamed body over the limit
 * is refused with 413 as soon as it passes it, never held whole in memory.
 */
export async function readBoundedTextV1(
  request: Request,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes))
    throw new HttpError(413, 'Payload too large');
  const reader = request.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'Payload too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), bytes: size };
}
