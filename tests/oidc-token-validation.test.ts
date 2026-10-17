import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { verifyIdToken } from '../server/auth/oidc';
import { testEnv } from './fixtures';

let key: webcrypto.CryptoKeyPair;
let publicKey: webcrypto.JsonWebKey;
beforeAll(async () => {
  key = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  publicKey = await webcrypto.subtle.exportKey('jwk', key.publicKey);
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { nonce: 'expected', exp: 2001, nbf: 2060, error: null },
  { nonce: 'different', exp: 2001, nbf: 2000, error: 'Invalid token nonce' },
  { nonce: 'expected', exp: 2000, nbf: 2000, error: 'Expired ID token' },
  { nonce: 'expected', exp: 3000, nbf: 2061, error: 'ID token not yet valid' },
])('keeps signed-token validation boundaries: $error', async ({ nonce, exp, nbf, error }) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', kid: 'synthetic-key' }) + '.' + encode({
    aud: testEnv.WEB_CLIENT_ID, iss: `https://login.microsoftonline.com/${testEnv.TENANT_ID}/v2.0`,
    tid: testEnv.TENANT_ID, oid: '33333333-3333-4333-8333-333333333333', name: 'Synthetic actor',
    nonce, exp, nbf,
  });
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey,
    new TextEncoder().encode(unsigned));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [{ ...publicKey, kid: 'synthetic-key' }] })));
  const result = verifyIdToken(unsigned + '.' + Buffer.from(signature).toString('base64url'), testEnv, 'expected', 2000);
  if (error) await expect(result).rejects.toThrow(error);
  else await expect(result).resolves.toMatchObject({ nonce: 'expected', exp: 2001, nbf: 2060 });
});

it('reports only clock offsets for an expired signed token', async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', kid: 'synthetic-key' }) + '.' + encode({
    aud: testEnv.WEB_CLIENT_ID, iss: `https://login.microsoftonline.com/${testEnv.TENANT_ID}/v2.0`,
    tid: testEnv.TENANT_ID, oid: '33333333-3333-4333-8333-333333333333', name: 'Synthetic actor',
    nonce: 'expected', iat: 1400, nbf: 1400, exp: 1700,
  });
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey,
    new TextEncoder().encode(unsigned));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [{ ...publicKey, kid: 'synthetic-key' }] })));
  const error = await verifyIdToken(unsigned + '.' + Buffer.from(signature).toString('base64url'), testEnv, 'expected', 2000)
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({ message: 'Expired ID token', offsets: { exp: -300, nbf: -600, iat: -600 } });
});
