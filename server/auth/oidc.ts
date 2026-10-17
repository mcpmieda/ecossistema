import { z } from 'zod';
import type { RuntimeEnv } from '../env';
import { decodeBase64Url, decodeJson, encodeBase64Url } from './base64url';
import { createClientAssertion } from './client-assertion';
import { webCredentials, type GraphCredentialSlot } from './technical-identity';

export type AuthTransaction = { state: string; nonce: string; verifier: string; exp: number };

const tokenSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
  expires_in: z.number(),
});
const claimsSchema = z.object({
  aud: z.string(),
  iss: z.string().url(),
  tid: z.string().uuid(),
  oid: z.string().uuid(),
  exp: z.number(),
  nbf: z.number().optional(),
  nonce: z.string(),
  name: z.string(),
  preferred_username: z.string().optional(),
  groups: z.array(z.string().uuid()).default([]),
  _claim_names: z.record(z.string(), z.string()).optional(),
});
export type IdClaims = z.infer<typeof claimsSchema>;

/** Lifetime failure with only clock offsets (seconds relative to validation time). */
export class IdTokenLifetimeError extends Error {
  constructor(
    message: string,
    readonly offsets: Readonly<Record<'exp' | 'nbf' | 'iat', number | null>>,
  ) {
    super(message);
  }
}
const timeOffsetSchema = z.object({ iat: z.number().optional() });

export async function newAuthTransaction(
  now = Date.now(),
): Promise<AuthTransaction & { challenge: string }> {
  const random = (size: number) => encodeBase64Url(crypto.getRandomValues(new Uint8Array(size)));
  const verifier = random(48);
  const challenge = encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  return {
    state: random(32),
    nonce: random(32),
    verifier,
    challenge,
    exp: Math.floor(now / 1000) + 600,
  };
}

export function authorizationUrl(
  env: RuntimeEnv,
  transaction: AuthTransaction & { challenge: string },
): string {
  const url = new URL(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: env.WEB_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${env.OFFICIAL_ORIGIN}/auth/callback`,
    response_mode: 'query',
    scope: 'openid profile email',
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: transaction.challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export async function exchangeCode(
  env: RuntimeEnv,
  code: string,
  verifier: string,
): Promise<z.infer<typeof tokenSchema>> {
  const endpoint = `https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`;
  let lastStatus = 0;
  for (const credential of webCredentials(env)) {
    const assertion = await createClientAssertion({
      clientId: env.WEB_CLIENT_ID,
      tenantId: env.TENANT_ID,
      privateKeyPkcs8: credential.privateKeyPkcs8,
      certificateThumbprint: credential.certificateThumbprint,
    });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.WEB_CLIENT_ID,
        code,
        redirect_uri: `${env.OFFICIAL_ORIGIN}/auth/callback`,
        grant_type: 'authorization_code',
        code_verifier: verifier,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    lastStatus = response.status;
    if (response.ok) return tokenSchema.parse(await response.json());
  }
  throw new Error(`OIDC token exchange failed (${lastStatus})`);
}

export async function validateWebCredential(
  env: RuntimeEnv,
  slot: GraphCredentialSlot,
): Promise<{ status: 'ok'; credentialKeyId: string }> {
  const credential = webCredentials(env, slot)[0]!;
  const endpoint = `https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`;
  const assertion = await createClientAssertion({
    clientId: env.WEB_CLIENT_ID,
    tenantId: env.TENANT_ID,
    privateKeyPkcs8: credential.privateKeyPkcs8,
    certificateThumbprint: credential.certificateThumbprint,
  });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.WEB_CLIENT_ID,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Web credential validation failed (${response.status})`);
  return { status: 'ok', credentialKeyId: credential.keyId };
}

export async function verifyIdToken(
  token: string,
  env: RuntimeEnv,
  expectedNonce: string,
  now = Math.floor(Date.now() / 1000),
): Promise<IdClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2])
    throw new Error('Malformed ID token');
  const header = z.object({ alg: z.literal('RS256'), kid: z.string() }).parse(decodeJson(parts[0]));
  const jwksResponse = await fetch(
    `https://login.microsoftonline.com/${env.TENANT_ID}/discovery/v2.0/keys`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!jwksResponse.ok) throw new Error('Unable to load OIDC signing keys');
  const jwks = z
    .object({
      keys: z.array(
        z.object({
          kid: z.string(),
          kty: z.string(),
          use: z.string().optional(),
          n: z.string(),
          e: z.string(),
          alg: z.string().optional(),
        }),
      ),
    })
    .parse(await jwksResponse.json());
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new Error('Unknown OIDC signing key');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Uint8Array.from(decodeBase64Url(parts[2])).buffer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error('Invalid ID token signature');
  const claims = claimsSchema.parse(decodeJson(parts[1]));
  const issuer = `https://login.microsoftonline.com/${env.TENANT_ID}/v2.0`;
  if (claims.tid !== env.TENANT_ID || claims.iss !== issuer || claims.aud !== env.WEB_CLIENT_ID)
    throw new Error('Invalid token authority');
  if (claims.nonce !== expectedNonce) throw new Error('Invalid token nonce');
  const offsets = () => ({
    exp: claims.exp - now,
    nbf: claims.nbf === undefined ? null : claims.nbf - now,
    iat: ((iat) => (iat === undefined ? null : iat - now))(
      timeOffsetSchema.parse(decodeJson(parts[1]!)).iat,
    ),
  });
  if (claims.exp <= now) throw new IdTokenLifetimeError('Expired ID token', offsets());
  if (claims.nbf !== undefined && claims.nbf > now + 60)
    throw new IdTokenLifetimeError('ID token not yet valid', offsets());
  if (claims._claim_names?.groups)
    throw new Error('Group overage is not supported by the foundation');
  return claims;
}
