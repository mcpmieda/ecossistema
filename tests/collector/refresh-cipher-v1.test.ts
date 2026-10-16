// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CollectorRefreshCipherV1, type CollectorGrantBindingV1 } from '../../server/collector/refresh-cipher-v1';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));
const binding: CollectorGrantBindingV1 = { tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333',
  grantId: '44444444-4444-4444-8444-444444444444', generation: 1, version: 2, originAuthenticatedAt: 1_700_000_000_000 };

describe('collector server-private credential cipher', () => {
  it('requires a dedicated exact-size key, no implicit key generation', async () => {
    await expect(CollectorRefreshCipherV1.fromDedicatedKey(new Uint8Array(31))).rejects.toThrow('collector-credential-unavailable');
    await expect(CollectorRefreshCipherV1.fromDedicatedKey(new Uint8Array(33))).rejects.toThrow('collector-credential-unavailable');
  });
  it('encrypts without exposing refresh value and randomizes each envelope', async () => {
    const cipher = await CollectorRefreshCipherV1.fromDedicatedKey(new Uint8Array(32).fill(7));
    const token = 'synthetic-refresh-token-never-real';
    const first = await cipher.encrypt(token, binding), second = await cipher.encrypt(token, binding);
    expect(first).not.toContain(token); expect(first).not.toBe(second);
    expect(await cipher.decrypt(first, binding)).toBe(token);
  });
  it.each(['tenantId', 'clientId', 'actorId', 'grantId', 'generation', 'version', 'originAuthenticatedAt'] as const)(
    'rejects ciphertext moved across %s', async field => {
      const cipher = await CollectorRefreshCipherV1.fromDedicatedKey(new Uint8Array(32).fill(7));
      const encrypted = await cipher.encrypt('synthetic-refresh-token', binding);
      const changed = { ...binding, [field]: typeof binding[field] === 'number'
        ? Number(binding[field]) + 1 : '99999999-9999-4999-8999-999999999999' };
      await expect(cipher.decrypt(encrypted, changed)).rejects.toThrow('collector-credential-unavailable');
    });
  it('rejects another key, tampering, malformed and oversized values without echo', async () => {
    const cipher = await CollectorRefreshCipherV1.fromDedicatedKey(new Uint8Array(32).fill(7));
    const other = await CollectorRefreshCipherV1.fromDedicatedKey(new Uint8Array(32).fill(8));
    const encrypted = await cipher.encrypt('synthetic-refresh-token', binding);
    await expect(other.decrypt(encrypted, binding)).rejects.toThrow('collector-credential-unavailable');
    for (const value of [encrypted.replace('"v":1', '"v":2'), '{"private":"secret"}', 'x'.repeat(25_001)])
      await expect(cipher.decrypt(value, binding)).rejects.toThrow('collector-credential-unavailable');
  });
});
