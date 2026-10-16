// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { collectorChallengeBytesV1, collectorKeyThumbprintV1, issueCollectorChallengeV1,
  verifyCollectorDeviceProofV1, type CollectorChallengeV1, type CollectorDeviceProofRecordV1,
  type CollectorPublicKeyV1 } from '../../server/collector/device-proof-v1';
import { encodeBase64Url } from '../../server/auth/base64url';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));
const now = Date.parse('2026-10-13T23:40:35Z');
async function fixture() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKey: CollectorPublicKeyV1 = { kty: 'EC', crv: 'P-256', x: exported.x!, y: exported.y!, ext: true };
  const record: CollectorDeviceProofRecordV1 = { deviceId: '11111111-1111-4111-8111-111111111111', generation: 1,
    tenantId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333',
    publicKey, keyThumbprint: await collectorKeyThumbprintV1(publicKey), revokedAt: null };
  const challenge = await issueCollectorChallengeV1(record, now);
  async function sign(value: CollectorChallengeV1) {
    const prefix = new TextEncoder().encode('Ecossistema.Coletor.DeviceProof.v1\0');
    const body = collectorChallengeBytesV1(value), data = new Uint8Array(prefix.byteLength + body.byteLength);
    data.set(prefix); data.set(body, prefix.byteLength);
    return encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data)));
  }
  return { record, challenge, sign };
}

describe('collector device proof subject and purpose binding', () => {
  it('accepts its own P256 proof, fixed route/purpose, and does not expose raw account UUIDs', async () => {
    const f = await fixture();
    await expect(verifyCollectorDeviceProofV1({ record: f.record, challenge: f.challenge,
      signature: await f.sign(f.challenge), now })).resolves.toBeUndefined();
    expect(JSON.stringify(f.challenge)).not.toContain(f.record.actorId);
    expect(JSON.stringify(f.challenge)).not.toContain(f.record.tenantId);
    expect(collectorChallengeBytesV1(f.challenge).byteLength).toBeLessThan(1024);
  });
  it('rejects account/key/generation swap even with a valid signature of the original challenge', async () => {
    const f = await fixture(), other = await fixture(), signature = await f.sign(f.challenge);
    for (const record of [{ ...f.record, actorId: '99999999-9999-4999-8999-999999999999' },
      { ...f.record, generation: 2 }, { ...f.record, publicKey: other.record.publicKey }, { ...f.record, revokedAt: now }])
      await expect(verifyCollectorDeviceProofV1({ record, challenge: f.challenge, signature, now })).rejects.toThrow('collector-device-proof-denied');
  });
  it('rejects a changed nonce, audience, method, route, purpose and TTL', async () => {
    const f = await fixture(), signature = await f.sign(f.challenge);
    const changed = [{ ...f.challenge, nonce: 'x'.repeat(43) }, { ...f.challenge, audience: 'https://attacker.invalid' },
      { ...f.challenge, method: 'GET' }, { ...f.challenge, path: '/api/platform/settings/session' },
      { ...f.challenge, purpose: 'platform-admin' }, { ...f.challenge, expiresAt: now+300_000 }];
    for (const challenge of changed)
      await expect(verifyCollectorDeviceProofV1({ record: f.record, challenge: challenge as CollectorChallengeV1, signature, now })).rejects.toThrow();
  });
  it('rejects expired/future-issued challenges and malformed signatures', async () => {
    const f = await fixture(), signature = await f.sign(f.challenge);
    await expect(verifyCollectorDeviceProofV1({ record: f.record, challenge: f.challenge, signature, now: now+60_000 })).rejects.toThrow();
    await expect(verifyCollectorDeviceProofV1({ record: f.record, challenge: f.challenge, signature, now: now-1 })).rejects.toThrow();
    await expect(verifyCollectorDeviceProofV1({ record: f.record, challenge: f.challenge, signature: 'secret-not-echoed', now })).rejects.toThrow('collector-device-proof-denied');
  });
  it('rejects registration of private JWK material and wrong public fingerprint', async () => {
    const f = await fixture();
    await expect(collectorKeyThumbprintV1({ ...f.record.publicKey, d: 'private' } as CollectorPublicKeyV1)).rejects.toThrow();
    await expect(issueCollectorChallengeV1({ ...f.record, keyThumbprint: 'x'.repeat(43) }, now)).rejects.toThrow();
  });
});
