import { encodeBase64Url, encodeJson } from './base64url';

function pemToBytes(pem: string): Uint8Array {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, '');
  return Uint8Array.from(atob(base64), (character) => character.codePointAt(0)!);
}

export async function createClientAssertion(input: {
  clientId: string;
  tenantId: string;
  privateKeyPkcs8: string;
  certificateThumbprint: string;
  now?: number;
}): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const audience = `https://login.microsoftonline.com/${input.tenantId}/oauth2/v2.0/token`;
  const header = encodeJson({ alg: 'RS256', typ: 'JWT', x5t: input.certificateThumbprint });
  const payload = encodeJson({
    aud: audience,
    iss: input.clientId,
    sub: input.clientId,
    jti: crypto.randomUUID(),
    nbf: now - 30,
    exp: now + 300,
  });
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(pemToBytes(input.privateKeyPkcs8)).buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
}
