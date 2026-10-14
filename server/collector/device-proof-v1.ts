import { z } from 'zod';
import { decodeBase64Url, encodeBase64Url } from '../auth/base64url';

const b64Coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const collectorPublicKeyV1 = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'),
  x: b64Coordinate, y: b64Coordinate, ext: z.literal(true) }).strict();
export type CollectorPublicKeyV1 = z.infer<typeof collectorPublicKeyV1>;
export const collectorChallengeSchemaV1 = z.object({
  deviceId: z.string().uuid(), generation: z.number().int().positive(),
  accountKey: b64Coordinate, keyThumbprint: b64Coordinate, nonce: b64Coordinate,
  audience: z.literal('https://admin.escolaieda.com'), method: z.literal('POST'),
  path: z.enum(['/api/frequency-collector/access','/api/frequency-collector/revoke','/api/frequency-collector/frequency']), purpose: z.enum(['collector-access','collector-revoke','collector-frequency']),
  requestHash: b64Coordinate.optional(),
  issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
}).strict().refine(value=>value.path==='/api/frequency-collector/'+(value.purpose==='collector-access'?'access':value.purpose==='collector-revoke'?'revoke':'frequency')
  && (value.purpose==='collector-frequency' ? value.requestHash!==undefined : value.requestHash===undefined));
const challengeSchema = collectorChallengeSchemaV1;
export type CollectorChallengeV1 = z.infer<typeof challengeSchema>;
export type CollectorDeviceProofRecordV1 = Readonly<{
  deviceId: string; generation: number; tenantId: string; actorId: string;
  keyThumbprint: string; publicKey: CollectorPublicKeyV1; revokedAt: number | null;
}>;
export class CollectorDeviceProofErrorV1 extends Error {
  constructor() { super('collector-device-proof-denied'); }
}

async function digest(value: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
export async function collectorKeyThumbprintV1(publicKey: CollectorPublicKeyV1): Promise<string> {
  const key = collectorPublicKeyV1.parse(publicKey);
  // Import also validates the curve point, not only the shape of its coordinates.
  await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return digest(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }));
}
export function collectorAccountKeyV1(tenantId: string, actorId: string): Promise<string> {
  const tenant = z.string().uuid().parse(tenantId).toLowerCase();
  const actor = z.string().uuid().parse(actorId).toLowerCase();
  return digest(JSON.stringify(['Ecossistema.Collector.Account.v1', tenant, actor]));
}
export function collectorChallengeBytesV1(challenge: CollectorChallengeV1): Uint8Array {
  const value = challengeSchema.parse(challenge);
  const fields: (string|number)[] = [value.deviceId, value.generation,
    value.accountKey, value.keyThumbprint, value.nonce, value.audience, value.method,
    value.path, value.purpose, value.issuedAt, value.expiresAt];
  if(value.purpose==='collector-frequency') fields.push(value.requestHash!);
  return new TextEncoder().encode(JSON.stringify(fields));
}

export async function issueCollectorChallengeV1(record: CollectorDeviceProofRecordV1, now: number,
  purpose: 'collector-access'|'collector-revoke'|'collector-frequency'='collector-access', requestHash?: string): Promise<CollectorChallengeV1> {
  if (record.revokedAt !== null || !Number.isSafeInteger(now) || now <= 0)
    throw new CollectorDeviceProofErrorV1();
  const fingerprint = await collectorKeyThumbprintV1(record.publicKey);
  if (fingerprint !== record.keyThumbprint) throw new CollectorDeviceProofErrorV1();
  return challengeSchema.parse({ deviceId: record.deviceId, generation: record.generation,
    accountKey: await collectorAccountKeyV1(record.tenantId, record.actorId), keyThumbprint: fingerprint,
    nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    audience: 'https://admin.escolaieda.com', method: 'POST', path: '/api/frequency-collector/'+(purpose==='collector-access'?'access':purpose==='collector-revoke'?'revoke':'frequency'),
    ...(purpose==='collector-frequency'?{requestHash}:{}),
    purpose, issuedAt: now, expiresAt: now + 60_000 });
}

/** Signature verification is not nonce consumption. The caller must then call
 * consumeAndAuthorize in one DB transaction conditioned on active device,
 * matching account/key/generation, unused nonce, nonce TTL and directory TTL. */
export async function verifyCollectorDeviceProofV1(input: {
  record: CollectorDeviceProofRecordV1; challenge: CollectorChallengeV1; signature: string; now: number;
  purpose?: 'collector-access'|'collector-revoke'|'collector-frequency';
}): Promise<void> {
  try {
    const { record, now } = input, challenge = challengeSchema.parse(input.challenge);
    if (challenge.purpose !== (input.purpose ?? 'collector-access') || !Number.isSafeInteger(now) || now <= 0 || record.revokedAt !== null || challenge.deviceId !== record.deviceId
        || challenge.generation !== record.generation || challenge.keyThumbprint !== record.keyThumbprint
        || challenge.accountKey !== await collectorAccountKeyV1(record.tenantId, record.actorId)
        || challenge.issuedAt > now || challenge.expiresAt <= now
        || challenge.expiresAt - challenge.issuedAt !== 60_000
        || !/^[A-Za-z0-9_-]{86}$/u.test(input.signature)) throw new CollectorDeviceProofErrorV1();
    const signature = decodeBase64Url(input.signature);
    if (signature.byteLength !== 64 || await collectorKeyThumbprintV1(record.publicKey) !== record.keyThumbprint)
      throw new CollectorDeviceProofErrorV1();
    const prefix = new TextEncoder().encode('Ecossistema.Coletor.DeviceProof.v1\0');
    const content = collectorChallengeBytesV1(challenge), data = new Uint8Array(prefix.byteLength + content.byteLength);
    data.set(prefix); data.set(content, prefix.byteLength);
    const key = await crypto.subtle.importKey('jwk', record.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
      Uint8Array.from(signature).buffer, data.buffer)) throw new CollectorDeviceProofErrorV1();
  } catch { throw new CollectorDeviceProofErrorV1(); }
}
