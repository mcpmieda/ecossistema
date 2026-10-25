import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

type Target = 'web' | 'graph';
type Slot = 'A' | 'B';

type SerializedCredential = {
  privateKeyPkcs8: string;
  certificateThumbprint: string;
  keyId: string;
  createdAt: string;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class ExactRuntimeCredentialError extends Error {
  readonly httpStatus: number;
  readonly aadstsCode: number | null;

  constructor(httpStatus: number, aadstsCode: number | null) {
    super('Exact runtime credential validation failed');
    this.name = 'ExactRuntimeCredentialError';
    this.httpStatus = httpStatus;
    this.aadstsCode = aadstsCode;
  }
}

export class ExactRuntimeLocalError extends Error {
  readonly kind: 'credential' | 'assertion' | 'transport' | 'response-contract';

  constructor(kind: 'credential' | 'assertion' | 'transport' | 'response-contract') {
    super('Exact runtime credential validation failed locally');
    this.name = 'ExactRuntimeLocalError';
    this.kind = kind;
  }
}

function target(value: string): Target {
  if (value !== 'web' && value !== 'graph') throw new ExactRuntimeLocalError('credential');
  return value;
}

function slot(value: string): Slot {
  if (value !== 'A' && value !== 'B') throw new ExactRuntimeLocalError('credential');
  return value;
}

function parseCredential(serialized: string): SerializedCredential {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new ExactRuntimeLocalError('credential');
  }
  if (typeof value !== 'object' || value === null) {
    throw new ExactRuntimeLocalError('credential');
  }
  const record = value as Record<string, unknown>;
  const privateKeyPkcs8 = record.privateKeyPkcs8;
  const certificateThumbprint = record.certificateThumbprint;
  const keyId = record.keyId;
  const createdAt = record.createdAt;
  if (
    typeof privateKeyPkcs8 !== 'string' ||
    privateKeyPkcs8.length < 256 ||
    typeof certificateThumbprint !== 'string' ||
    certificateThumbprint.length < 20 ||
    typeof keyId !== 'string' ||
    !UUID.test(keyId) ||
    typeof createdAt !== 'string' ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new ExactRuntimeLocalError('credential');
  }
  return { privateKeyPkcs8, certificateThumbprint, keyId, createdAt };
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToBytes(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, '');
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length === 0) throw new ExactRuntimeLocalError('assertion');
  return new Uint8Array(decoded);
}

async function createClientAssertion(input: {
  clientId: string;
  tenantId: string;
  credential: SerializedCredential;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const audience =
    `https://login.microsoftonline.com/${input.tenantId}/oauth2/v2.0/token`;
  const header = encodeJson({
    alg: 'RS256',
    typ: 'JWT',
    x5t: input.credential.certificateThumbprint,
  });
  const payload = encodeJson({
    aud: audience,
    iss: input.clientId,
    sub: input.clientId,
    jti: crypto.randomUUID(),
    nbf: now - 30,
    exp: now + 300,
  });
  const unsigned = `${header}.${payload}`;

  try {
    const privateKeyBytes = pemToBytes(input.credential.privateKeyPkcs8);
    const stablePrivateKeyBytes = new Uint8Array(privateKeyBytes.byteLength);
    stablePrivateKeyBytes.set(privateKeyBytes);
    const key = await crypto.subtle.importKey(
      'pkcs8',
      stablePrivateKeyBytes,
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
  } catch (error) {
    if (error instanceof ExactRuntimeLocalError) throw error;
    throw new ExactRuntimeLocalError('assertion');
  }
}

function aadstsCode(payload: unknown): number | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('error_codes' in payload) ||
    !Array.isArray(payload.error_codes)
  ) {
    return null;
  }
  const value = payload.error_codes.find(
    (candidate): candidate is number => Number.isInteger(candidate) && candidate > 0,
  );
  return value ?? null;
}

export async function validateExactRuntimeCredential(input: {
  target: Target;
  slot: Slot;
  tenantId: string;
  clientId: string;
  serializedCredential: string;
  fetcher?: typeof fetch;
}): Promise<{ status: 'ok'; target: Target; slot: Slot; credentialKeyId: string }> {
  const credential = parseCredential(input.serializedCredential);
  const assertion = await createClientAssertion({
    clientId: input.clientId,
    tenantId: input.tenantId,
    credential,
  });

  const fetcher = input.fetcher ?? fetch;
  const endpoint =
    `https://login.microsoftonline.com/${input.tenantId}/oauth2/v2.0/token`;
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: input.clientId,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
        client_assertion_type:
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ExactRuntimeLocalError('transport');
  }

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      await response.body?.cancel().catch(() => undefined);
    }
    throw new ExactRuntimeCredentialError(response.status, aadstsCode(payload));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExactRuntimeLocalError('response-contract');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('access_token' in payload) ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0
  ) {
    throw new ExactRuntimeLocalError('response-contract');
  }

  return {
    status: 'ok',
    target: input.target,
    slot: input.slot,
    credentialKeyId: credential.keyId,
  };
}

async function main(): Promise<void> {
  const credentialPath = process.env.CREDENTIAL_FILE ?? '';
  if (!credentialPath) throw new ExactRuntimeLocalError('credential');
  const result = await validateExactRuntimeCredential({
    target: target(process.env.ROTATION_TARGET ?? ''),
    slot: slot(process.env.ROTATION_SLOT ?? ''),
    tenantId: process.env.ENTRA_TENANT_ID ?? '',
    clientId: process.env.TARGET_CLIENT_ID ?? '',
    serializedCredential: readFileSync(credentialPath, 'utf8'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error: unknown) {
    let safe;
    if (error instanceof ExactRuntimeCredentialError) {
      safe = {
            status: 'error',
            httpStatus: error.httpStatus,
            aadstsCode: error.aadstsCode,
          };
    } else if (error instanceof ExactRuntimeLocalError) {
      safe = { status: 'error', kind: error.kind };
    } else {
      safe = { status: 'error', kind: 'local' };
    }
    process.stdout.write(`${JSON.stringify(safe)}\n`);
    process.exitCode = 1;
  }
}
