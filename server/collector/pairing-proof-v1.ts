import {z} from 'zod';
import {decodeBase64Url} from '../auth/base64url';
import {collectorPublicKeyV1,collectorKeyThumbprintV1} from './device-proof-v1';
export const collectorPairingRequestV1=z.object({id:z.string().uuid(),publicKey:collectorPublicKeyV1,
  nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),issuedAt:z.number().int().positive(),expiresAt:z.number().int().positive(),
  signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/u)}).strict();
export async function verifyCollectorPairingV1(value:unknown,now:number){
  const input=collectorPairingRequestV1.parse(value),thumbprint=await collectorKeyThumbprintV1(input.publicKey);
  if(input.issuedAt>now || input.expiresAt<=now || input.expiresAt-input.issuedAt!==120_000) throw new Error('pairing-denied');
  const body=new TextEncoder().encode(JSON.stringify([input.id,thumbprint,input.nonce,'https://admin.escolaieda.com','POST',
    '/api/frequency-collector/pairings','collector-pairing',input.issuedAt,input.expiresAt]));
  const prefix=new TextEncoder().encode('Ecossistema.Coletor.DeviceProof.v1\0'),signed=new Uint8Array(prefix.length+body.length);
  signed.set(prefix);signed.set(body,prefix.length);
  const key=await crypto.subtle.importKey('jwk',input.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Uint8Array.from(decodeBase64Url(input.signature)).buffer,signed.buffer))
    throw new Error('pairing-denied');
  return input;
}
