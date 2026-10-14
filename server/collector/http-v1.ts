import { z } from 'zod';
import { CollectorAccessErrorV1, type CollectorAccessServiceV1 } from './access-service-v1';

export type CollectorAccessPortV1 = Pick<CollectorAccessServiceV1, 'challenge' | 'authorize'> & Partial<Pick<CollectorAccessServiceV1,'revoke'>>;
const uuid = z.string().uuid();
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const challenge = z.object({ deviceId:uuid,generation:z.number().int().positive(),accountKey:opaque,
  keyThumbprint:opaque,nonce:opaque,audience:z.literal('https://admin.escolaieda.com'),method:z.literal('POST'),
  path:z.enum(['/api/frequency-collector/access','/api/frequency-collector/revoke']),purpose:z.enum(['collector-access','collector-revoke']),
  issuedAt:z.number().int().positive(),expiresAt:z.number().int().positive() }).strict();
const receipt = z.object({ contractVersion:z.literal(2),authenticated:z.literal(true),authorized:z.literal(true),
  capability:z.literal('frequency.collector.use'),identityKey:z.string().regex(/^[\x21-\x7e]{1,160}$/u),
  expiresAt:z.string().datetime({offset:true}),checkedAt:z.string().datetime({offset:true}),revocationChecked:z.literal(true),
  directoryCheckedAt:z.string().datetime({offset:true}),directoryValidUntil:z.string().datetime({offset:true}) }).strict();
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});

async function body(request:Request):Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid-body');
  const reader=request.body?.getReader(); if (!reader) throw new Error('invalid-body');
  let count=0; const chunks:Uint8Array[]=[];
  try {
    while (true) { const item=await reader.read();if(item.done) break;
      count+=item.value.byteLength;if(count>2048) throw new Error('invalid-body');chunks.push(item.value); }
  } finally { await reader.cancel().catch(()=>undefined); }
  const bytes=new Uint8Array(count);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

/** No browser cookies, bearer token or /api/me session authorizes these paths.
 * A configured server-owned broker must consume the signed device proof itself.
 * No CORS permission is emitted; browser requests from other origins are denied. */
export async function handleCollectorAccessRequestV1(request:Request,service:CollectorAccessPortV1 | null):Promise<Response|null> {
  const path=new URL(request.url).pathname;
  if(!['/api/frequency-collector/challenge','/api/frequency-collector/access','/api/frequency-collector/revoke'].includes(path)) return null;
  if(request.method!=='POST') return json({error:'Method not allowed'},405);
  if(new URL(request.url).origin!=='https://admin.escolaieda.com'
    || (request.headers.has('Origin') && request.headers.get('Origin')!=='https://admin.escolaieda.com'))
    return json({error:'Collector access denied'},403);
  if(!service) return json({error:'Collector access unavailable',code:'ACCESS_NOT_CONFIGURED'},503);
  try {
    const input=await body(request);
    if(path.endsWith('/challenge')) {
      const parsed=z.object({deviceId:uuid,purpose:z.enum(['collector-access','collector-revoke']).default('collector-access')}).strict().parse(input);
      const reply=challenge.parse(await service.challenge(parsed.deviceId,parsed.purpose));
      if(reply.deviceId!==parsed.deviceId || reply.purpose!==parsed.purpose
        || reply.path!=='/api/frequency-collector/'+(parsed.purpose==='collector-access'?'access':'revoke')
        || reply.expiresAt-reply.issuedAt!==60_000) throw new Error('invalid-result');
      return json(reply);
    }
    const parsed=z.object({deviceId:uuid,nonce:opaque,signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/u)}).strict().parse(input);
    if(path.endsWith('/revoke')){
      if(!service.revoke)throw new Error('unavailable');
      return json(z.object({revoked:z.literal(true)}).strict().parse(await service.revoke(parsed)));
    }
    const reply=receipt.parse(await service.authorize(parsed));
    const checked=Date.parse(reply.directoryCheckedAt),until=Date.parse(reply.directoryValidUntil);
    if(until-checked!==300_000 || Date.parse(reply.expiresAt)>until) throw new Error('invalid-result');
    return json(reply);
  } catch(error) {
    if(error instanceof CollectorAccessErrorV1)
      return json({error:'Collector access denied',code:error.reason==='unavailable'?'ACCESS_UNAVAILABLE':'ACCESS_REQUIRED'},error.reason==='unavailable'?503:403);
    // No input, provider errors or server-private values are returned or logged.
    return json({error:'Collector access denied',code:'INVALID_ACCESS_REQUEST'},400);
  }
}
