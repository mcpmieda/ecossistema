import type { RuntimeEnv } from '../env';

type BoundedBodyRequest = Pick<Request, 'body' | 'headers'>;

// style-src allows exactly one inline <style>: React Aria's pressable touch-action rule, by its
// sha256 (tests/frontend-security/react-aria-style-csp.test.ts keeps it in sync); no unsafe-inline.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; script-src 'self' https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
};

export function withSecurityHeaders(response: Response, protectedRoute = false): Response {
  // A WebSocket upgrade carries a runtime-owned socket. Reconstructing it as a regular
  // Response both drops that socket and is rejected by runtimes whose public constructor
  // accepts only 200-599. The authenticated upgrade route already returns no document body.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (protectedRoute) {
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function enforceOfficialOrigin(request: Request, env: RuntimeEnv): void {
  if (new URL(request.url).origin !== env.OFFICIAL_ORIGIN)
    throw new HttpError(421, 'Misdirected request');
}

export function enforceWriteOrigin(request: Request, env: RuntimeEnv): void {
  const origin = request.headers.get('Origin');
  if (origin !== env.OFFICIAL_ORIGIN) throw new HttpError(403, 'Invalid origin');
}

function mediaType(request: BoundedBodyRequest): string | null {
  const value = request.headers.get('Content-Type');
  return value ? (value.split(';', 1)[0]?.trim().toLowerCase() ?? null) : null;
}

async function readBoundedBody(request: BoundedBodyRequest, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = request.headers.get('Content-Length');
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0) throw new HttpError(400, 'Invalid Content-Length');
    if (length > maxBytes) throw new HttpError(413, 'Request body too large');
  }

  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing request body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(value);
  }
  if (size === 0) throw new HttpError(400, 'Missing request body');

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedBytes(
  request: BoundedBodyRequest,
  options: {
    maxBytes?: number;
    allowedContentTypes?: readonly string[];
  } = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const allowed = options.allowedContentTypes?.map((item) => item.toLowerCase());
  if (allowed && !allowed.includes(mediaType(request) ?? '')) {
    throw new HttpError(415, 'Unsupported content type');
  }
  return readBoundedBody(request, maxBytes);
}

export async function readBoundedJson(
  request: BoundedBodyRequest,
  maxBytes = 16_384,
): Promise<unknown> {
  if (mediaType(request) !== 'application/json')
    throw new HttpError(415, 'Expected application/json');
  const bytes = await readBoundedBody(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
