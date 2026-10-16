import { z } from 'zod';
import { decodeBase64Url, encodeBase64Url } from '../auth/base64url';

export const collectorGrantBindingV1 = z.object({
  tenantId: z.string().uuid(), clientId: z.string().uuid(), actorId: z.string().uuid(),
  grantId: z.string().uuid(), generation: z.number().int().nonnegative(), version: z.number().int().nonnegative(),
  originAuthenticatedAt: z.number().int().positive(),
}).strict();
export type CollectorGrantBindingV1 = z.infer<typeof collectorGrantBindingV1>;
const envelopeV1 = z.object({ v: z.literal(1), iv: z.string().max(32), ct: z.string().max(24_000) }).strict();

export class CollectorCredentialErrorV1 extends Error {
  constructor() { super('collector-credential-unavailable'); }
}

function bindingBytes(binding: CollectorGrantBindingV1): Uint8Array {
  const value = collectorGrantBindingV1.parse(binding);
  return new TextEncoder().encode(JSON.stringify(['Ecossistema.Collector.Refresh.v1',
    value.tenantId.toLowerCase(), value.clientId.toLowerCase(), value.actorId.toLowerCase(),
    value.grantId.toLowerCase(), value.generation, value.version, value.originAuthenticatedAt]));
}

/** A dedicated 256-bit server key is required. Never reuse SESSION_SECRET or generate
 * a production key on startup. This ciphertext is server-private, not a cookie/token. */
export class CollectorRefreshCipherV1 {
  private constructor(private readonly key: CryptoKey) {}

  static async fromDedicatedKey(bytes: Uint8Array): Promise<CollectorRefreshCipherV1> {
    if (bytes.byteLength !== 32) throw new CollectorCredentialErrorV1();
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(bytes).buffer,
      { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return new CollectorRefreshCipherV1(key);
  }

  async encrypt(token: string, binding: CollectorGrantBindingV1): Promise<string> {
    try {
      if (typeof token !== 'string' || token.length < 16 || token.length > 16_384)
        throw new CollectorCredentialErrorV1();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
        additionalData: Uint8Array.from(bindingBytes(binding)).buffer }, this.key,
        new TextEncoder().encode(token));
      return JSON.stringify({ v: 1, iv: encodeBase64Url(iv), ct: encodeBase64Url(new Uint8Array(ct)) });
    } catch { throw new CollectorCredentialErrorV1(); }
  }

  async decrypt(encrypted: string, binding: CollectorGrantBindingV1): Promise<string> {
    try {
      if (typeof encrypted !== 'string' || encrypted.length > 25_000) throw new CollectorCredentialErrorV1();
      const value = envelopeV1.parse(JSON.parse(encrypted));
      const iv = decodeBase64Url(value.iv);
      if (iv.byteLength !== 12) throw new CollectorCredentialErrorV1();
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(iv).buffer,
        additionalData: Uint8Array.from(bindingBytes(binding)).buffer }, this.key,
        Uint8Array.from(decodeBase64Url(value.ct)).buffer);
      const token = new TextDecoder('utf-8', { fatal: true }).decode(clear);
      if (token.length < 16 || token.length > 16_384) throw new CollectorCredentialErrorV1();
      return token;
    } catch { throw new CollectorCredentialErrorV1(); }
  }
}
