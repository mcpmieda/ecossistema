import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CryptoPortV1, VerifierV1 } from '../../../shared/student-portal-contracts/ports-v1';

// OWASP scrypt alternative when native Argon2id is unavailable. Proven in remote
// workerd; PBKDF2 600k is rejected there despite succeeding in local workerd.
export const SCRYPT_PARAMETERS_V1 = Object.freeze({ N: 32768, r: 8, p: 3, keyLength: 32 });
export const SCRYPT_MAX_MEMORY_V1 = 64 * 1024 * 1024;
const verifierSchema = z.object({ algorithm: z.literal('scrypt-hmac-sha256-v1'),
  parameters: z.object({ N: z.literal(32768), r: z.literal(8), p: z.literal(3), keyLength: z.literal(32) }).strict(),
  salt: z.string().regex(/^[a-f0-9]{32}$/u), pepperVersion: z.number().int().positive().safe(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const credential = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u);

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (value: string): Uint8Array => Uint8Array.from(value.match(/../gu)!, (pair) => Number.parseInt(pair, 16));
const base64url = (bytes: Uint8Array): string => btoa(String.fromCodePoint(...bytes)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
const fromSignature = (value: string): Uint8Array => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), (char) => char.codePointAt(0)!);

function keys(input: ReadonlyMap<number, Uint8Array>): ReadonlyMap<number, Uint8Array> {
  const result = new Map<number, Uint8Array>();
  for (const [version, value] of input) {
    z.number().int().positive().safe().parse(version);
    if (value.byteLength !== 32) throw new Error('student-portal-crypto-key-invalid');
    result.set(version, Uint8Array.from(value));
  }
  return result;
}

/** Single native KDF implementation shared by birth registration and authentication. */
export class PortalCryptoV1 implements CryptoPortV1 {
  private readonly peppers: ReadonlyMap<number, Uint8Array>;
  private readonly qrKeys: ReadonlyMap<number, Uint8Array>;
  constructor(peppers: ReadonlyMap<number, Uint8Array>, qrKeys: ReadonlyMap<number, Uint8Array>) {
    this.peppers = keys(peppers);
    this.qrKeys = keys(qrKeys);
  }

  randomToken(bytes: number): string {
    z.number().int().min(32).max(64).parse(bytes);
    return base64url(randomBytes(bytes));
  }

  async hashOpaqueToken(token: string): Promise<string> {
    z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/u).parse(token);
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private passwordDigest(secret: string, salt: Uint8Array, pepperVersion: number): Uint8Array {
    z.string().min(1).max(256).parse(secret);
    const pepper = this.peppers.get(pepperVersion);
    if (!pepper) throw new Error('student-portal-crypto-pepper-unavailable');
    const derived = scryptSync(secret, salt, SCRYPT_PARAMETERS_V1.keyLength,
      { N: SCRYPT_PARAMETERS_V1.N, r: SCRYPT_PARAMETERS_V1.r, p: SCRYPT_PARAMETERS_V1.p, maxmem: SCRYPT_MAX_MEMORY_V1 });
    try { return createHmac('sha256', pepper).update('student-portal:verifier:v1\0').update(derived).digest(); }
    finally { derived.fill(0); }
  }

  async deriveVerifier(secret: string, pepperVersion: number): Promise<VerifierV1> {
    z.number().int().positive().safe().parse(pepperVersion);
    const salt = randomBytes(16);
    return { algorithm: 'scrypt-hmac-sha256-v1', parameters: { ...SCRYPT_PARAMETERS_V1 }, salt: hex(salt),
      pepperVersion, digest: hex(this.passwordDigest(secret, salt, pepperVersion)) };
  }

  async verifySecret(secret: string, input: VerifierV1): Promise<boolean> {
    const parsed = verifierSchema.safeParse(input);
    if (!parsed.success) throw new Error('student-portal-crypto-verifier-unavailable');
    const verifier = parsed.data;
    return timingSafeEqual(fromHex(verifier.digest), this.passwordDigest(secret, fromHex(verifier.salt), verifier.pepperVersion));
  }

  async signQr(credentialId: string, keyVersion: number): Promise<string> {
    credential.parse(credentialId);
    z.number().int().positive().max(999999).parse(keyVersion);
    const key = this.qrKeys.get(keyVersion);
    if (!key) throw new Error('student-portal-crypto-qr-key-unavailable');
    return createHmac('sha256', key).update(`student-portal:qr:v1:${keyVersion}:${credentialId}`).digest('base64url');
  }

  async verifyQr(credentialId: string, keyVersion: number, signature: string): Promise<boolean> {
    if (!this.qrKeys.has(keyVersion) || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) return false;
    const actual = fromSignature(signature);
    if (base64url(actual) !== signature) return false;
    const expected = fromSignature(await this.signQr(credentialId, keyVersion));
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }
}
