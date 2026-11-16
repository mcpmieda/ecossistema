import { z } from 'zod';
import { decodeBase64Url, encodeBase64Url } from './base64url';

/** What a sealed value is for. The purpose is authenticated with the ciphertext (AES-GCM
 * additional data), so a value sealed for one purpose never opens as another — a draft or a
 * confirmation shaped like a session is never accepted as the administrative session. */
export type SealPurposeV1 =
  | 'admin-session'
  | 'admin-auth'
  | 'session-policy'
  | 'collector-auth'
  | 'collector-confirm'
  | 'collector-withdraw'
  | 'reconciliation-cursor'
  | 'portal-admin-cursor'
  | 'portal-bulk-proof'
  | 'portal-bulk-cursor';

/** Values sealed without a purpose (envelope v1) open only until every one issued before the
 * purpose binding has expired: sessions last at most 12 h, the other cookies 10 min, cursors and
 * proofs minutes. A session-length preference sealed before it falls back to the default. */
export const UNBOUND_SEAL_ACCEPTED_UNTIL_V1 = Date.UTC(2026, 10, 23);

const envelopeSchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  iv: z.string(),
  ct: z.string(),
});

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function purposeData(purpose: SealPurposeV1): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`ecossistema-seal-v2:${purpose}`);
}

export async function seal(
  value: unknown,
  secret: string,
  purpose: SealPurposeV1,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: purposeData(purpose) },
    await deriveKey(secret),
    plaintext,
  );
  return encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        v: 2,
        iv: encodeBase64Url(iv),
        ct: encodeBase64Url(new Uint8Array(ciphertext)),
      }),
    ),
  );
}

export async function unseal<T>(
  token: string,
  secret: string,
  purpose: SealPurposeV1,
): Promise<T | null> {
  try {
    const envelope = envelopeSchema.parse(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(token))),
    );
    if (envelope.v === 1 && Date.now() >= UNBOUND_SEAL_ACCEPTED_UNTIL_V1) return null;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Uint8Array.from(decodeBase64Url(envelope.iv)),
        ...(envelope.v === 2 ? { additionalData: purposeData(purpose) } : {}),
      },
      await deriveKey(secret),
      Uint8Array.from(decodeBase64Url(envelope.ct)).buffer,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}
