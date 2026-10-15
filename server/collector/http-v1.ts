import { z } from 'zod';
import { CollectorAccessErrorV1, type CollectorAccessServiceV1 } from './access-service-v1';
import { collectorChallengeSchemaV1, collectorProofPathV1 } from './device-proof-v1';

export type CollectorAccessPortV1 = Pick<CollectorAccessServiceV1, 'challenge' | 'authorize'> & Partial<Pick<CollectorAccessServiceV1,'revoke'>>;
const uuid = z.string().uuid();
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const challenge = collectorChallengeSchemaV1;
const receipt = z.object({ contractVersion:z.literal(2),authenticated:z.literal(true),authorized:z.literal(true),
  capability:z.literal('frequency.collector.use'),identityKey:z.string().regex(/^[\x21-\x7e]{1,160}$/u),
  expiresAt:z.string().datetime({offset:true}),checkedAt:z.string().datetime({offset:true}),revocationChecked:z.literal(true),
  directoryCheckedAt:z.string().datetime({offset:true}),directoryValidUntil:z.string().datetime({offset:true}) }).strict();
const challengeRequest = z.object({deviceId:uuid,
  purpose:z.enum(['collector-access','collector-revoke','collector-frequency']).default('collector-access'),
  requestHash:opaque.optional()}).strict()
  .refine(v=>(v.purpose==='collector-frequency')===(v.requestHash!==undefined));
const proofRequest = z.object({deviceId:uuid,nonce:opaque,signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/u)}).strict();
const ACCESS_PATHS = new Set(['/api/frequency-collector/challenge','/api/frequency-collector/access','/api/frequency-collector/revoke']);
const OFFICIAL = 'https://admin.escolaieda.com';
const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});

async function body(request:Request):Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid-body');
  const reader=request.body?.getReader();
  if (!reader) throw new Error('invalid-body');
  let count=0;
  const chunks:Uint8Array[]=[];
  try {
    while (true) {
      const item=await reader.read();
      if(item.done) break;
      count+=item.value.byteLength;
      if(count>2048) throw new Error('invalid-body');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(()=>undefined);
  }
  const bytes=new Uint8Array(count);
  let offset=0;
  for(const chunk of chunks){
    bytes.set(chunk,offset);
    offset+=chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

async function challengeReply(service:CollectorAccessPortV1,input:unknown):Promise<Response> {
  const parsed=challengeRequest.parse(input);
  const issued=parsed.purpose==='collector-frequency'
    ?service.challenge(parsed.deviceId,parsed.purpose,parsed.requestHash)
    :service.challenge(parsed.deviceId,parsed.purpose);
  const reply=challenge.parse(await issued);
  if(reply.deviceId!==parsed.deviceId || reply.purpose!==parsed.purpose
    || reply.requestHash!==parsed.requestHash
    || reply.path!==collectorProofPathV1(parsed.purpose)
    || reply.expiresAt-reply.issuedAt!==60_000) throw new Error('invalid-result');
  return json(reply);
}

async function proofReply(path:string,service:CollectorAccessPortV1,input:unknown):Promise<Response> {
  const parsed=proofRequest.parse(input);
  if(path.endsWith('/revoke')){
    if(!service.revoke)throw new Error('unavailable');
    return json(z.object({revoked:z.literal(true)}).strict().parse(await service.revoke(parsed)));
  }
  const reply=receipt.parse(await service.authorize(parsed));
  const checked=Date.parse(reply.directoryCheckedAt),until=Date.parse(reply.directoryValidUntil);
  if(until-checked!==300_000 || Date.parse(reply.expiresAt)>until) throw new Error('invalid-result');
  return json(reply);
}

function accessFailure(error:unknown):Response {
  // No input, provider errors or server-private values are returned or logged.
  if(!(error instanceof CollectorAccessErrorV1))
    return json({error:'Collector access denied',code:'INVALID_ACCESS_REQUEST'},400);
  const unavailable=error.reason==='unavailable';
  return json({error:'Collector access denied',code:unavailable?'ACCESS_UNAVAILABLE':'ACCESS_REQUIRED'},unavailable?503:403);
}

/** No browser cookies, bearer token or /api/me session authorizes these paths.
 * A configured server-owned broker must consume the signed device proof itself.
 * No CORS permission is emitted; browser requests from other origins are denied. */
export async function handleCollectorAccessRequestV1(request:Request,service:CollectorAccessPortV1 | null):Promise<Response|null> {
  const url=new URL(request.url);
  if(!ACCESS_PATHS.has(url.pathname)) return null;
  if(request.method!=='POST') return json({error:'Method not allowed'},405);
  const foreign=request.headers.has('Origin') && request.headers.get('Origin')!==OFFICIAL;
  if(url.origin!==OFFICIAL || foreign) return json({error:'Collector access denied'},403);
  if(!service) return json({error:'Collector access unavailable',code:'ACCESS_NOT_CONFIGURED'},503);
  try {
    const input=await body(request);
    if(url.pathname.endsWith('/challenge')) return await challengeReply(service,input);
    return await proofReply(url.pathname,service,input);
  } catch(error) {
    return accessFailure(error);
  }
}
