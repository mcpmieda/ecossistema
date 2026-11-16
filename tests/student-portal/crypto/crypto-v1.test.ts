// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PortalCryptoV1, SCRYPT_PARAMETERS_V1 } from '../../../server/student-portal/crypto/crypto-v1';

const pepper = new Map([[1, new Uint8Array(32).fill(1)], [2, new Uint8Array(32).fill(2)]]);
const qrKeys = new Map([[1, new Uint8Array(32).fill(3)], [2, new Uint8Array(32).fill(4)]]);
const cryptoPort = new PortalCryptoV1(pepper, qrKeys);

describe('native memory-hard verifiers and versioned QR HMAC', () => {
  it('uses random per-verifier salt, an accepted cost and no plaintext secret', async () => {
    const first = await cryptoPort.deriveVerifier('123456', 1);
    const second = await cryptoPort.deriveVerifier('123456', 1);
    expect(first.parameters).toEqual(SCRYPT_PARAMETERS_V1);
    expect(first.salt).not.toBe(second.salt);
    expect(first.digest).not.toBe(second.digest);
    expect(JSON.stringify(first)).not.toContain('123456');
    expect(await cryptoPort.verifySecret('123456', first)).toBe(true);
    expect(await cryptoPort.verifySecret('123455', first)).toBe(false);
  });

  it('supports an available old pepper, rejects a wrong pepper, and fails closed when it is missing', async () => {
    const verifier = await cryptoPort.deriveVerifier('2001', 1);
    expect(await cryptoPort.verifySecret('2001', verifier)).toBe(true);
    const wrong = new PortalCryptoV1(new Map([[1, new Uint8Array(32).fill(9)]]), qrKeys);
    expect(await wrong.verifySecret('2001', verifier)).toBe(false);
    const removed = new PortalCryptoV1(new Map([[2, pepper.get(2)!]]), qrKeys);
    await expect(removed.verifySecret('2001', verifier)).rejects.toThrow('student-portal-crypto-pepper-unavailable');
    const current = await cryptoPort.deriveVerifier('2001', 2);
    expect(await removed.verifySecret('2001', current)).toBe(true);
  });

  it('rejects downgraded or abusive verifier parameters before KDF work', async () => {
    const verifier = await cryptoPort.deriveVerifier('123456', 1);
    for (const N of [1, 16384, 1073741824]) {
      await expect(cryptoPort.verifySecret('123456', { ...verifier, parameters: { ...verifier.parameters, N } }))
        .rejects.toThrow('student-portal-crypto-verifier-unavailable');
    }
    await expect(cryptoPort.verifySecret('123456', { ...verifier, algorithm: 'sha256' })).rejects.toThrow();
    await expect(cryptoPort.verifySecret('123456', { ...verifier, digest: 'not-a-digest' })).rejects.toThrow();
  });

  it('recreates the same QR signature and binds the credential and key version', async () => {
    const id = cryptoPort.randomToken(32);
    const signature = await cryptoPort.signQr(id, 1);
    expect(await cryptoPort.signQr(id, 1)).toBe(signature);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await cryptoPort.verifyQr(id, 1, signature)).toBe(true);
    expect(await cryptoPort.verifyQr(cryptoPort.randomToken(32), 1, signature)).toBe(false);
    expect(await cryptoPort.verifyQr(id, 2, signature)).toBe(false);
    expect(await cryptoPort.verifyQr(id, 1, signature + '=')).toBe(false);
    await expect(cryptoPort.signQr(id, 3)).rejects.toThrow('student-portal-crypto-qr-key-unavailable');
  });

  it('generates opaque high-entropy tokens and stores stable one-way hashes', async () => {
    const first = cryptoPort.randomToken(32);
    const second = cryptoPort.randomToken(32);
    expect(first).not.toBe(second);
    expect(first).toHaveLength(43);
    const hash = await cryptoPort.hashOpaqueToken(first);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hash).not.toBe(first);
    expect(await cryptoPort.hashOpaqueToken(first)).toBe(hash);
    expect(() => cryptoPort.randomToken(8)).toThrow();
    expect(() => new PortalCryptoV1(new Map([[1, new Uint8Array(1)]]), qrKeys)).toThrow();
  });
});
